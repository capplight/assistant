import type { TaskListKey, TaskOut, TaskPatchIn, TaskWriteOut } from '@/api/types';
import { getOutbox } from '@/db';
import { getSyncEngine, kickSync, syncBlocked } from '@/services';
import { useOnboarding } from '@/store/onboarding';
import { useUndo } from '@/store/undo';
import { newId } from '@/utils/id';

import { undoServerAction } from './actions';
import { rememberActions, taskSink } from './service';
import { tasksState, type TaskEdit } from './store';

/**
 * Week 11а (template-screens 2.3, 2.4; today.md `PATCH /tasks/{id}`): «− 2 +» of «Сколько» on
 * «Покупки» and «На завтра» of a to-do on «Дела». By hand, so at once, offline and in «Без ИИ» too:
 * the change is shown from `edits` (it wins over /sync until its outbox row is answered), one tap =
 * one `task.patch` row in tap order (with its `client_id`: a retry returns the first action).
 * «Отменить»: still waiting → dropped; sent → the undo of its action on the server (actions.md), the
 * old value shown at once; an older answer without an action → the old value goes as a change of its own.
 */

export type TaskChange = Pick<TaskPatchIn, 'qty' | 'due_date'>;
export type TaskPatchPayload = { key: string; clientId: string; body: TaskChange; before: TaskChange; at: string; actionId?: string | null };

const nowIso = () => new Date().toISOString();

/** The task as the person sees it: their changes still on the way on top of the server's copy. */
export function shownTask(t: TaskOut, edits: Record<string, TaskEdit>): TaskOut {
  const e = edits[t.id];
  if (!e) return t;
  return { ...t, ...('qty' in e ? { qty: e.qty ?? null } : {}), ...('due_date' in e ? { due_date: e.due_date ?? null } : {}) };
}

/** «Сколько» as a count for «− +»: empty = 1, «3» / «3 шт» = 3; anything else (``1 кг``) has no buttons. */
export function qtyCount(qty: string | null | undefined): number | null {
  const q = (qty ?? '').trim();
  if (!q) return 1;
  const m = /^(\d{1,3})\s*(шт\.?|дана)?$/i.exec(q);
  return m ? Number(m[1]) : null;
}

/** The count back as «Сколько»: 1 = empty (nobody writes «1 шт» for bread). */
export const qtyText = (n: number): string | null => (n <= 1 ? null : String(n));

function findTask(key: string): TaskOut | undefined {
  const s = tasksState();
  return s.tasks[taskSink.serverId(key) ?? key] ?? s.tasks[key];
}

function setEdit(id: string, edit: TaskEdit | null): void {
  const s = tasksState();
  const edits = { ...s.edits };
  if (edit) edits[id] = edit;
  else delete edits[id];
  s.set({ edits });
}

/** One change by hand; returns the outbox row id (null: nothing changed or before consent). */
export async function changeTask(key: string, change: TaskChange, stripText: string): Promise<string | null> {
  const t = findTask(key);
  if (!t) return null;
  const now = shownTask(t, tasksState().edits);
  const before: TaskChange = {};
  if ('qty' in change) before.qty = now.qty;
  if ('due_date' in change) before.due_date = now.due_date;
  if (Object.keys(change).every((k) => (before as Record<string, unknown>)[k] === (change as Record<string, unknown>)[k])) return null;
  const clientId = newId();
  setEdit(t.id, { ...tasksState().edits[t.id], ...change, clientId });
  if (useOnboarding.getState().consent === null) return null; // the phone only: nothing to send to
  const payload: TaskPatchPayload = { key: t.id, clientId, body: change, before, at: nowIso() };
  const row = await (await getOutbox()).enqueue('task.patch', payload);
  useUndo.getState().showCustom(stripText, () => void undoChange(row.id));
  if (!syncBlocked()) kickSync();
  return row.id;
}

async function undoChange(rowId: string): Promise<void> {
  const engine = await getSyncEngine();
  await engine.hold(rowId);
  try {
    const outbox = await getOutbox();
    const row = await outbox.get(rowId);
    if (!row || row.status === 'failed') return;
    const p = row.payload as TaskPatchPayload;
    const t = findTask(p.key);
    if (row.status === 'pending') {
      await outbox.markFailed(row.id, 'undone'); // never sent: it does not go
      if (t) setEdit(t.id, tasksState().edits[t.id]?.clientId === p.clientId ? null : { ...tasksState().edits[t.id]!, ...p.before });
      return;
    }
    if (!t) return;
    const clientId = newId();
    setEdit(t.id, { ...tasksState().edits[t.id], ...p.before, clientId });
    if (p.actionId) {
      // The server's undo (week 12, PATCH has `client_id`): the old value stays shown until /sync brings it.
      const r = await undoServerAction(p.actionId);
      if ((r.result === 'expired' || r.result === 'failed') && tasksState().edits[t.id]?.clientId === clientId) setEdit(t.id, null);
      return;
    }
    const back: TaskPatchPayload = { key: t.id, clientId, body: p.before, before: p.body, at: nowIso() };
    await outbox.enqueue('task.patch', back);
  } finally {
    engine.release(rowId);
    if (!syncBlocked()) kickSync();
  }
}

/** An edit whose values the server's task now has is done (e.g. after the undo of its action). */
export function settleMatchingEdits(tasks: TaskOut[]): void {
  for (const x of tasks) {
    const e = tasksState().edits[x.id];
    if (!e) continue;
    const same = (['qty', 'due_date'] as const).every((k) => !(k in e) || (e[k] ?? null) === (x[k] ?? null));
    if (same) setEdit(x.id, null);
  }
}

/** The sync engine's side of `task.patch`. */
export const taskPatchSink = {
  applyServer: (tasks: TaskOut[]) => {
    taskSink.applyServer(tasks);
    settleMatchingEdits(tasks);
  },
  version: (key: string): number | null => findTask(key)?.version ?? null,
  /** Answered: the server's task is the truth; the edit goes when no newer tap is waiting. */
  patched: (key: string, out: TaskWriteOut, clientId: string) => {
    if (out.task) taskSink.applyServer([out.task]);
    if (out.action) rememberActions([out.action]);
    const t = findTask(key);
    if (t && tasksState().edits[t.id]?.clientId === clientId) setEdit(t.id, null);
  },
  /** Refused for good: the server's copy is shown again. */
  patchFailed: (key: string, clientId: string) => {
    const t = findTask(key);
    if (t && tasksState().edits[t.id]?.clientId === clientId) setEdit(t.id, null);
  },
};

/** `task.clear_done`: the keys the person saw as bought (local keys wait for the server id). */
export type ClearDonePayload = { clientId: string; listKey: TaskListKey; keys: string[]; at: string; actionId?: string | null };

/**
 * «Убрать все купленные» (template-screens 2.4; today.md `POST /tasks/clear-done`): the bought lines
 * the person saw go to «Удалённые записи» in one action. Gone from the list at once (offline too),
 * one strip, one «Отменить»: still waiting → dropped; sent → the undo of its one action.
 */
export async function clearBought(keys: string[], stripText: string, listKey: TaskListKey = 'shopping'): Promise<string | null> {
  const s = tasksState();
  const at = nowIso();
  const list = keys.map((k) => findTask(k)).filter((x): x is TaskOut => !!x && !x.deleted_at);
  if (list.length === 0) return null;
  const tasks = { ...s.tasks };
  for (const x of list) tasks[x.id] = { ...x, deleted_at: at };
  s.set({ tasks });
  const back = () => {
    const now = { ...tasksState().tasks };
    for (const x of list) if (now[x.id]) now[x.id] = { ...now[x.id]!, deleted_at: null };
    tasksState().set({ tasks: now });
  };
  if (useOnboarding.getState().consent === null) {
    useUndo.getState().showCustom(stripText, back);
    return null;
  }
  const payload: ClearDonePayload = { clientId: newId(), listKey, keys: list.map((x) => x.id), at };
  const row = await (await getOutbox()).enqueue('task.clear_done', payload);
  useUndo.getState().showCustom(stripText, () => void undoClear(row.id, back));
  if (!syncBlocked()) kickSync();
  return row.id;
}

async function undoClear(rowId: string, back: () => void): Promise<void> {
  const engine = await getSyncEngine();
  await engine.hold(rowId);
  try {
    const outbox = await getOutbox();
    const row = await outbox.get(rowId);
    back();
    if (!row || row.status === 'failed') return;
    if (row.status === 'pending') {
      await outbox.markFailed(row.id, 'undone'); // never sent: it does not go
      return;
    }
    const actionId = (row.payload as ClearDonePayload).actionId;
    if (actionId) await outbox.enqueue('action.undo', { actionId, clientId: newId() });
  } finally {
    engine.release(rowId);
    if (!syncBlocked()) kickSync();
  }
}
