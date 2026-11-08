import type { ActionOut, TaskCreateIn, TaskListKey, TaskOut, TaskWriteOut } from '@/api/types';
import { getOutbox } from '@/db';
import i18n from '@/i18n';
import { getSyncEngine, kickSync, syncBlocked } from '@/services';
import { useOnboarding } from '@/store/onboarding';
import { usePages, type Page } from '@/store/pages';
import { useUndo } from '@/store/undo';
import type { ActionUndoPayload } from '@/sync/engine';
import { newId } from '@/utils/id';

import { LOCAL_TASK, tasksState, type Tick } from './store';

/**
 * Week 9 (docs/api/today.md «Tasks»): «Дела» and «Покупки» on this phone. Nothing here needs the
 * assistant: a box ticked, a row added by hand or typed in the line without a connection or in
 * «Без ИИ», «Вернуть» — all of it is shown at once and goes to the server through the outbox
 * (`task.create` → POST /tasks, `task.update` → POST /tasks/{id}/done or DELETE, idempotent by
 * `client_id`, in tap order). The server's copy (`/sync` `tasks`, `/today`) never undoes a tick it
 * has not seen yet.
 *
 * «Отменить» of a row added here: still in the outbox → it never goes; on the server → the undo
 * of its action (POST /actions/{id}/undo: the task and its record go to the trash), never a
 * delete the phone made up (actions.md).
 */

export type TaskCreatePayload = { body: TaskCreateIn; actionId?: string | null };
export type TaskUpdatePayload = {
  key: string;
  clientId: string;
  done?: boolean;
  at: string;
  deleted?: boolean;
  /** Set when the server answered: the tick's action («Отменить» after it went). */
  actionId?: string | null;
};

/** A tick shown while its «Отменить» (the action's undo) is on its way. */
export const UNDO_TICK = 'undo:';

const nowIso = () => new Date().toISOString();

/** The tick wins over the server's `done` until it was sent. */
export function isDone(t: TaskOut, ticks: Record<string, Tick>): boolean {
  const tick = ticks[t.id];
  return tick ? tick.done : t.done;
}

/** When it was ticked (the newest «Куплено» goes first under the line). */
export function doneAt(t: TaskOut, ticks: Record<string, Tick>): number {
  const tick = ticks[t.id];
  const at = tick ? (tick.done ? tick.at : null) : t.done ? (t.done_at ?? t.updated_at) : null;
  return at ? Date.parse(at) || 0 : 0;
}

export const liveTasks = (tasks: Record<string, TaskOut>, list: TaskListKey) =>
  Object.values(tasks).filter((t) => t.list_key === list && !t.deleted_at);

/**
 * The page of a list on this phone: «Покупки» for shopping, «Дела и напоминания» for to-dos; a
 * shopping task goes to «Дела и напоминания» when there is no «Покупки» (today.md, US-10).
 */
export function pageForList(list: TaskListKey): Page | undefined {
  const pages = usePages.getState().pages;
  const tasks = pages.find((p) => p.templateKey === 'tasks');
  if (list === 'todo') return tasks;
  return pages.find((p) => p.templateKey === 'shopping') ?? tasks;
}

/** The lists a page shows (empty: not a list page). */
export function listsForPage(p: Pick<Page, 'templateKey'> | undefined): TaskListKey[] {
  if (p?.templateKey === 'shopping') return ['shopping'];
  if (p?.templateKey !== 'tasks') return [];
  const hasShopping = usePages.getState().pages.some((x) => x.templateKey === 'shopping');
  return hasShopping ? ['todo'] : ['todo', 'shopping'];
}

/** Which list a phrase typed on this page goes to without the assistant. */
export const listForPage = (p: Pick<Page, 'templateKey'> | undefined): TaskListKey | null =>
  p?.templateKey === 'shopping' ? 'shopping' : p?.templateKey === 'tasks' ? 'todo' : null;

// --- the server's copy ---

function merge(list: TaskOut[]): void {
  if (list.length === 0) return;
  const s = tasksState();
  const tasks = { ...s.tasks };
  const aliases = { ...s.aliases };
  for (const t of list) {
    const prev = tasks[t.id];
    if (!prev || prev.seq <= t.seq) tasks[t.id] = t;
    // An undone tick: the server's copy has come round to it.
    const tick = tasksState().ticks[t.id];
    if (tick?.clientId?.startsWith(UNDO_TICK) && tasks[t.id] === t && tick.done === t.done) {
      const ticks = { ...tasksState().ticks };
      delete ticks[t.id];
      tasksState().set({ ticks });
    }
    // A row added here offline goes once the server's one is here (the tick moves with it).
    const local = t.client_id ? LOCAL_TASK + t.client_id : null;
    if (local && tasks[local]) {
      delete tasks[local];
      aliases[local] = t.id;
      moveTick(local, t.id);
    }
  }
  tasksState().set({ tasks, aliases });
}

function moveTick(from: string, to: string): void {
  const s = tasksState();
  if (!s.ticks[from]) return;
  const ticks = { ...s.ticks, [to]: s.ticks[from]! };
  delete ticks[from];
  s.set({ ticks });
}

function settleTick(key: string, clientId: string): void {
  const s = tasksState();
  const real = taskSink.serverId(key) ?? key;
  const tick = s.ticks[real] ?? s.ticks[key];
  // Only the tick this row carried is settled: a newer tap stays.
  if (!tick || tick.clientId !== clientId) return;
  const ticks = { ...s.ticks };
  delete ticks[real];
  delete ticks[key];
  s.set({ ticks });
}

export const taskSink = {
  applyServer: (list: TaskOut[]) => merge(list),
  /** POST /tasks answered: the local row becomes the server's. */
  created: (clientId: string, out: TaskWriteOut) => {
    const local = LOCAL_TASK + clientId;
    if (!out.task) return;
    const s = tasksState();
    s.set({
      aliases: { ...s.aliases, [local]: out.task.id },
      ...(out.action ? { createdBy: { ...s.createdBy, [out.task.id]: out.action.id } } : {}),
    });
    moveTick(local, out.task.id);
    merge([out.task]);
    if (out.action) rememberActions([out.action]);
  },
  /** Refused for good: the row goes (it never reached the server). */
  createFailed: (clientId: string) => {
    const s = tasksState();
    const t = s.tasks[LOCAL_TASK + clientId];
    if (t) s.set({ tasks: { ...s.tasks, [t.id]: { ...t, deleted_at: nowIso() } } });
  },
  /** Server id of a task, or null while it is still on its way. */
  serverId: (key: string): string | null => {
    if (!key.startsWith(LOCAL_TASK)) return key;
    return tasksState().aliases[key] ?? null;
  },
  /** The tick went: from now on the server's `done` is the truth. */
  updated: (key: string, out: TaskWriteOut, clientId: string) => {
    settleTick(key, clientId);
    if (out.task) merge([out.task]);
    if (out.action) rememberActions([out.action]);
  },
  /** The server refused the tick for good: its own copy is shown again. */
  updateFailed: (key: string, clientId: string) => settleTick(key, clientId),
};

/** Actions from /sync, /today and the answers: «Что я сделал», «Я сделал за вас». */
export function rememberActions(list: ActionOut[]): void {
  if (list.length === 0) return;
  const s = tasksState();
  const actions = { ...s.actions };
  for (const a of list) {
    const prev = actions[a.id];
    if (!prev || (prev.seq ?? 0) <= (a.seq ?? 0)) actions[a.id] = a;
  }
  // 30 days are kept (actions.md «Sync»).
  const horizon = Date.now() - 31 * 86_400_000;
  for (const [id, a] of Object.entries(actions)) {
    if (a.created_at && Date.parse(a.created_at) < horizon) delete actions[id];
  }
  s.set({ actions });
}

// --- by hand ---

const canQueue = () => useOnboarding.getState().consent !== null;

function kick(): void {
  if (canQueue() && !syncBlocked()) kickSync();
}

function findTask(key: string): TaskOut | undefined {
  const s = tasksState();
  return s.tasks[taskSink.serverId(key) ?? key] ?? s.tasks[key];
}

/**
 * A row added by hand or from the line without the assistant (offline, «Без ИИ»): one phrase = one
 * row, as typed. The phone does not split «хлеб и молоко» into two: that reading is the
 * assistant's (or code's, if Ф-1 is taken on the server, `TASKS_RULES_FIRST`).
 */
export async function addTask(i: { list: TaskListKey; title: string }): Promise<TaskOut | null> {
  const title = i.title.trim().slice(0, 200);
  if (!title) return null;
  const clientId = newId();
  const at = nowIso();
  const task: TaskOut = {
    id: LOCAL_TASK + clientId,
    client_id: clientId,
    item_id: null,
    list_key: i.list,
    title,
    qty: null,
    where: null,
    due_date: null,
    done: false,
    done_at: null,
    version: 0,
    seq: 0,
    created_at: at,
    updated_at: at,
    deleted_at: null,
  };
  const s = tasksState();
  s.set({ tasks: { ...s.tasks, [task.id]: task } });
  let rowId: string | null = null;
  if (canQueue()) {
    const payload: TaskCreatePayload = { body: { client_id: clientId, list_key: i.list, title } };
    rowId = (await (await getOutbox()).enqueue('task.create', payload)).id;
    kick();
  }
  const page = pageForList(i.list);
  const text = page
    ? i18n.t(page.templateKey === 'shopping' ? 'tasks.added_shop' : 'tasks.added_todo', { title })
    : i18n.t('tasks.added', { title });
  useUndo.getState().showCustom(text, () => void takeBackAdded(task.id, rowId), page?.id ?? null);
  return task;
}

/** «Отменить» of a row added here. */
async function takeBackAdded(key: string, rowId: string | null): Promise<void> {
  const t = findTask(key);
  if (!t) return;
  const s = tasksState();
  s.set({ tasks: { ...s.tasks, [t.id]: { ...t, deleted_at: nowIso() } } });
  if (!rowId) return;
  const outbox = await getOutbox();
  const engine = await getSyncEngine();
  await engine.hold(rowId);
  try {
    const row = await outbox.get(rowId);
    if (row?.status === 'pending') {
      await outbox.markFailed(row.id, 'undone'); // never sent: it does not go
      return;
    }
    const actionId = tasksState().createdBy[t.id] ?? null;
    if (actionId) {
      const payload: ActionUndoPayload = { actionId, clientId: newId() };
      await outbox.enqueue('action.undo', payload);
    } else {
      const payload: TaskUpdatePayload = { key: t.id, clientId: newId(), at: nowIso(), deleted: true };
      await outbox.enqueue('task.update', payload);
    }
  } finally {
    engine.release(rowId);
  }
  kick();
}

/**
 * A box ticked or unticked («Сделано», «Куплено», «Вернуть»): at once, offline too; one tap = one
 * outbox row. The strip says what happened; its «Отменить» is the undo of this tick (tasks/actions).
 * Tapping the box again is a change of its own (a new tick, its own action).
 */
export async function setDone(key: string, done: boolean, o: { strip?: boolean } = {}): Promise<string | null> {
  const t = findTask(key);
  if (!t) return null;
  const s = tasksState();
  if (isDone(t, s.ticks) === done) return null;
  const clientId = newId();
  const at = nowIso();
  s.set({ ticks: { ...s.ticks, [t.id]: { done, at, clientId } } });
  let rowId: string | null = null;
  if (canQueue()) {
    const payload: TaskUpdatePayload = { key: t.id, clientId, done, at };
    rowId = (await (await getOutbox()).enqueue('task.update', payload)).id;
    kick();
  }
  if (o.strip !== false) {
    const k = done ? (t.list_key === 'shopping' ? 'tasks.ticked_shop' : 'tasks.ticked_todo') : 'tasks.unticked';
    useUndo.getState().showCustom(i18n.t(k, { title: t.title }), () => void tickUndo.run(t.id, rowId, done, clientId));
  }
  return rowId;
}

/** Filled by tasks/actions.ts (it needs the API): the undo of one tick. */
export const tickUndo: { run: (taskId: string, rowId: string | null, done: boolean, clientId: string) => Promise<void> } = {
  run: async () => undefined,
};

/** Show the box in this state here until the server's copy agrees. */
export function showTick(taskId: string, done: boolean): void {
  const s = tasksState();
  s.set({ ticks: { ...s.ticks, [taskId]: { done, at: nowIso(), clientId: UNDO_TICK + newId() } } });
}

/** The tick never went: as if it was not made. Without `clientId`: an undo tick that failed. */
export function dropTick(taskId: string, clientId?: string): void {
  if (clientId !== undefined) return settleTick(taskId, clientId);
  const s = tasksState();
  if (!s.ticks[taskId]?.clientId?.startsWith(UNDO_TICK)) return;
  const ticks = { ...s.ticks };
  delete ticks[taskId];
  s.set({ ticks });
}
