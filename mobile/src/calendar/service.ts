import { ApiError, isRetryable } from '@/api/errors';
import type { CalendarEntryOut, TaskOccurrenceOut, TaskOut, TaskPatchIn, TaskScope, TaskWriteOut } from '@/api/types';
import { getCalendarRepo, getOutbox, type OutboxEntry } from '@/db';
import i18n from '@/i18n';
import { getApi, getSyncEngine, kickSync, syncBlocked } from '@/services';
import { useOnboarding } from '@/store/onboarding';
import { useUndo } from '@/store/undo';
import { undoServerAction } from '@/tasks/actions';
import { addTask, findTask, pageForList, rememberActions, setDone, taskSink, type TaskCreatePayload } from '@/tasks/service';
import { tasksState } from '@/tasks/store';
import { newId } from '@/utils/id';

import type { CalEntry } from './entries';
import { remindEditOf, taskEntryKey } from './entries';
import { calState, type CalFocus } from './store';
import { addDaysIso, atMinutes, hhmm, isoDate, isoWithOffset, minutesOf, phoneTz } from './time';

/**
 * Ф-89 calendar changes by hand (calendar.md): add into empty time, move / resize, done, delete — at once on this phone
 * (offline too), each one outbox row in tap order with its `client_id`, one strip with its undo:
 * still waiting → the row never goes; sent → the undo of its action (POST /actions/{id}/undo), the old state shown at
 * once. The server's copy (/sync `tasks`, `task_occurrences`) never undoes a change it has not seen yet.
 */

export type CalPatchPayload = {
  key: string;
  entryKey: string;
  clientId: string;
  body: Pick<TaskPatchIn, 'start_at' | 'duration_min' | 'rrule' | 'occurrence_at' | 'scope' | 'tz' | 'reminder_offset_min'>;
  before: { startMs: number | null; duration: number | null };
  at: string;
  actionId?: string | null;
};
export type CalDonePayload = { key: string; entryKey: string; clientId: string; done: boolean; occurrenceAt: string; actionId?: string | null };
export type CalDeletePayload = {
  key: string;
  entryKey: string;
  clientId: string;
  occurrenceAt?: string | null;
  scope?: TaskScope | null;
  actionId?: string | null;
};

const nowIso = () => new Date().toISOString();
const canQueue = () => useOnboarding.getState().consent !== null;
const kick = () => {
  if (canQueue() && !syncBlocked()) kickSync();
};

// --- the phone's copy (migration v13) ---

let loading: Promise<void> | null = null;

/** Occurrences and kept server entries from SQLite into the store, once per launch. */
export function ensureCalendarLoaded(): Promise<void> {
  if (!loading) {
    loading = (async () => {
      try {
        const repo = await getCalendarRepo();
        const today = isoDate(Date.now());
        await repo.prune(addDaysIso(today, -60), addDaysIso(today, 60));
        const [occ, entries] = await Promise.all([repo.listOccurrences(), repo.listRange(addDaysIso(today, -60), addDaysIso(today, 60))]);
        const s = calState();
        s.set({
          occurrences: { ...Object.fromEntries(occ.map((o) => [o.id, o])), ...s.occurrences },
          server: { ...Object.fromEntries(entries.map((e) => [e.key, e])), ...s.server },
          loaded: true,
        });
      } catch {
        calState().set({ loaded: true });
      }
    })();
  }
  return loading;
}

/** Test hook. */
export function resetCalendarForTests(): void {
  loading = null;
  calState().reset();
}

function applyOccurrences(list: TaskOccurrenceOut[]): void {
  if (list.length === 0) return;
  const s = calState();
  const occurrences = { ...s.occurrences };
  const occEdits = { ...s.occEdits };
  for (const o of list) {
    const prev = occurrences[o.id];
    if (!prev || prev.seq <= o.seq) occurrences[o.id] = o;
    // The person's change of this occurrence came round: it is the server's now.
    const key = taskEntryKey(o.task_id, Date.parse(o.occurrence_at));
    const e = occEdits[key];
    if (e && (e.done === undefined || e.done === !!o.done_at) && (e.skipped === undefined || e.skipped === o.skipped)) delete occEdits[key];
  }
  s.set({ occurrences, occEdits });
  void getCalendarRepo()
    .then((r) => r.putOccurrences(list))
    .catch(() => undefined);
}

function removeOccurrence(id: string): void {
  const s = calState();
  if (!s.occurrences[id]) return;
  const occurrences = { ...s.occurrences };
  delete occurrences[id];
  s.set({ occurrences });
  void getCalendarRepo()
    .then((r) => r.removeOccurrence(id))
    .catch(() => undefined);
}

/** The server's tasks came: a move by hand whose values it now has is done. */
export function settleTimeEdits(tasks: TaskOut[]): void {
  const s = calState();
  let changed = false;
  const timeEdits = { ...s.timeEdits };
  const remindEdits = { ...s.remindEdits };
  for (const t of tasks) {
    // «Напомнить» by hand: the server's task has that alert now.
    const r = remindEditOf(remindEdits, t);
    if (r && t.reminder_offset_min !== undefined && t.reminder_offset_min === r.offset) {
      delete remindEdits[t.id];
      if (t.client_id) delete remindEdits[`local:${t.client_id}`];
      changed = true;
    }
    const key = taskEntryKey(t.id, null);
    const e = timeEdits[key];
    if (!e || !t.start_at) continue;
    if (Date.parse(t.start_at) === e.startMs && (t.duration_min ?? null) === e.duration) {
      delete timeEdits[key];
      changed = true;
    }
  }
  if (changed) s.set({ timeEdits, remindEdits });
}

/** GET /v1/calendar of a range (≤ 61 days): plan steps and a check of what the phone counts; kept for offline. */
export async function refreshRange(from: string, to: string): Promise<void> {
  if (!canQueue() || syncBlocked()) return;
  try {
    const out = await getApi().calendar(from, to);
    const s = calState();
    const server = { ...s.server };
    for (const [k, e] of Object.entries(server)) if (e.date >= from && e.date <= to) delete server[k];
    for (const e of out.entries) server[e.key] = e;
    s.set({ server });
    await (await getCalendarRepo()).putRange(from, to, out.entries, Date.now());
  } catch {
    // offline or an older server: the phone's own copy is shown
  }
}

// --- the sync engine's side ---

async function waitingCreate(key: string): Promise<boolean> {
  const clientId = key.replace(/^local:/, '');
  return (await (await getOutbox()).listPending(500)).some(
    (row) => row.kind === 'task.create' && (row.payload as TaskCreatePayload).body.client_id === clientId,
  );
}

function dropTimeEdit(entryKey: string, clientId?: string): void {
  const s = calState();
  const e = s.timeEdits[entryKey];
  if (!e || (clientId && e.clientId !== clientId)) return;
  const timeEdits = { ...s.timeEdits };
  delete timeEdits[entryKey];
  s.set({ timeEdits });
}

/** By the key the change was made on (a local key, or the server id) and by the server id it has now. */
function dropRemindEdit(key: string, clientId?: string): void {
  const s = calState();
  const keys = [key, taskSink.serverId(key)].filter((k): k is string => !!k && !!s.remindEdits[k]);
  const mine = keys.filter((k) => !clientId || s.remindEdits[k]!.clientId === clientId);
  if (mine.length === 0) return;
  const remindEdits = { ...s.remindEdits };
  for (const k of mine) delete remindEdits[k];
  s.set({ remindEdits });
}

function dropOccEdit(entryKey: string, clientId?: string): void {
  const s = calState();
  const e = s.occEdits[entryKey];
  if (!e || (clientId && e.clientId !== clientId)) return;
  const occEdits = { ...s.occEdits };
  delete occEdits[entryKey];
  s.set({ occEdits });
}

function dropSeriesEnd(taskId: string, clientId?: string): void {
  const s = calState();
  const e = s.seriesEnds[taskId];
  if (!e || (clientId && e.clientId !== clientId)) return;
  const seriesEnds = { ...s.seriesEnds };
  delete seriesEnds[taskId];
  s.set({ seriesEnds });
}

function written(out: TaskWriteOut): void {
  const tasks = [out.task, out.previous_task].filter((x): x is TaskOut => !!x);
  if (tasks.length > 0) taskSink.applyServer(tasks);
  if (out.occurrence) applyOccurrences([out.occurrence]);
  if (out.action) rememberActions([out.action]);
}

async function sendPatch(e: OutboxEntry): Promise<void> {
  const p = e.payload as CalPatchPayload;
  const id = taskSink.serverId(p.key);
  if (!id) {
    if (await waitingCreate(p.key)) throw new Error('task_not_synced');
    dropTimeEdit(p.entryKey, p.clientId);
    dropRemindEdit(p.key, p.clientId);
    return; // lives on this phone only
  }
  const call = (version: number) => getApi().patchTask(id, { version, client_id: p.clientId, ...p.body });
  try {
    let out: TaskWriteOut;
    try {
      out = await call(findTask(id)?.version ?? 0);
    } catch (err) {
      // calendar.md `409 conflict {version}`: the person's change wins, as with every change by hand.
      const v = err instanceof ApiError && err.status === 409 ? Number(err.details?.version) : NaN;
      if (!Number.isFinite(v)) throw err;
      out = await call(v);
    }
    await (await getOutbox()).updatePayload(e.id, { ...p, actionId: out.action?.id ?? null } satisfies CalPatchPayload);
    written(out);
    // A `following` change ends the series and starts a new task: this key is gone, so is its edit.
    dropTimeEdit(p.entryKey, p.clientId);
    dropRemindEdit(p.key, p.clientId);
  } catch (err) {
    if (!isRetryable(err)) {
      dropTimeEdit(p.entryKey, p.clientId);
      dropRemindEdit(p.key, p.clientId);
    }
    throw err;
  }
}

async function sendDone(e: OutboxEntry): Promise<void> {
  const p = e.payload as CalDonePayload;
  const id = taskSink.serverId(p.key);
  if (!id) {
    if (await waitingCreate(p.key)) throw new Error('task_not_synced');
    dropOccEdit(p.entryKey, p.clientId);
    return;
  }
  try {
    const out = await getApi().taskDone(id, { client_id: p.clientId, done: p.done, occurrence_at: p.occurrenceAt });
    await (await getOutbox()).updatePayload(e.id, { ...p, actionId: out.action?.id ?? null } satisfies CalDonePayload);
    written(out);
    if (!out.occurrence) dropOccEdit(p.entryKey, p.clientId);
  } catch (err) {
    if (!isRetryable(err)) dropOccEdit(p.entryKey, p.clientId);
    throw err;
  }
}

async function sendDelete(e: OutboxEntry): Promise<void> {
  const p = e.payload as CalDeletePayload;
  const id = taskSink.serverId(p.key);
  const local = () => {
    dropOccEdit(p.entryKey, p.clientId);
    dropSeriesEnd(p.key, p.clientId);
  };
  if (!id) {
    if (await waitingCreate(p.key)) throw new Error('task_not_synced');
    local();
    return;
  }
  try {
    const out = await getApi().deleteTask(id, p.clientId, {
      ...(p.occurrenceAt ? { occurrence_at: p.occurrenceAt } : {}),
      ...(p.scope ? { scope: p.scope } : {}),
    });
    await (await getOutbox()).updatePayload(e.id, { ...p, actionId: out.action?.id ?? null } satisfies CalDeletePayload);
    written(out);
    if (p.scope === 'following') dropSeriesEnd(p.key, p.clientId);
  } catch (err) {
    if (!isRetryable(err)) {
      local();
      const t = findTask(p.key);
      if (t && !p.occurrenceAt) tasksState().set({ tasks: { ...tasksState().tasks, [t.id]: { ...t, deleted_at: null } } });
    }
    throw err;
  }
}

/** What the sync engine needs of the calendar (src/sync/engine.ts `calendar`). */
export const calendarSink = {
  send: (e: OutboxEntry): Promise<void> =>
    e.kind === 'calendar.patch' ? sendPatch(e) : e.kind === 'calendar.done' ? sendDone(e) : sendDelete(e),
  occurrences: applyOccurrences,
  tombstone: removeOccurrence,
};

// --- by hand ---

/** «15:00–16:00» / «15:00» of a block. */
export function rangeText(start: number, duration: number | null): string {
  return duration ? `${hhmm(start)}–${hhmm(start + duration)}` : hhmm(start);
}

function dayWords(date: string): string {
  const today = isoDate(Date.now());
  if (date === today) return i18n.t('cal.today_word');
  if (date === addDaysIso(today, 1)) return i18n.t('cal.tomorrow_word');
  try {
    return new Date(`${date}T12:00:00`).toLocaleDateString(i18n.language, { weekday: 'short', day: 'numeric', month: 'short' });
  } catch {
    return date;
  }
}

/** A4 «Добавить»: a timed to-do (or an all-day one without a time), one strip «Записал в Дела: …» · «Отменить». */
export async function addTimed(i: {
  title: string;
  date: string;
  start: number | null;
  duration: number | null;
  rrule?: string | null;
  /** «Напомнить»: minutes before the start, null = no alert (only with a time). */
  reminderOffset?: number | null;
}): Promise<TaskOut | null> {
  if (i.start === null) {
    return addTask({ list: 'todo', title: i.title, dueDate: i.date, stripText: i18n.t('cal.added_day', { day: dayWords(i.date), title: i.title.trim() }) });
  }
  const at = atMinutes(i.date, i.start);
  return addTask({
    list: 'todo',
    title: i.title,
    dueDate: i.date,
    time: { start_at: isoWithOffset(at), duration_min: i.duration, tz: phoneTz(), rrule: i.rrule ?? null, reminder_offset_min: i.reminderOffset ?? null },
    stripText: i18n.t('cal.added', { day: dayWords(i.date), time: rangeText(i.start, i.duration), title: i.title.trim() }),
  });
}

/**
 * A block moved or resized (or its repeat changed). `scope` for an occurrence of a repeat («Только это / Это и
 * следующие»). The strip «{Название}: 10:00 → 11:00 · Вернуть».
 */
export async function moveEntry(
  e: CalEntry,
  to: { date: string; start: number; duration: number | null },
  scope: TaskScope = 'this',
  o: { rrule?: string | null; strip?: boolean } = {},
): Promise<string | null> {
  if (e.kind !== 'task') return null;
  const startMs = atMinutes(to.date, to.start);
  const same = e.startMs === startMs && e.duration === to.duration && o.rrule === undefined;
  if (same) return null;
  const clientId = newId();
  const s = calState();
  const occurrence = !!e.occurrenceAt;
  // `following` moves the rest of the series: shown after /sync; this occurrence moves at once. A repeat change
  // shows on the task itself (setRepeat).
  if (o.rrule === undefined) s.set({ timeEdits: { ...s.timeEdits, [e.key]: { startMs, duration: to.duration, clientId } } });
  const body: CalPatchPayload['body'] = {
    start_at: isoWithOffset(startMs),
    duration_min: to.duration,
    tz: phoneTz(),
    ...(o.rrule !== undefined ? { rrule: o.rrule } : {}),
    ...(occurrence ? { occurrence_at: e.occurrenceAt!, scope } : {}),
  };
  const before = { startMs: e.startMs, duration: e.duration };
  let rowId: string | null = null;
  if (canQueue()) {
    const payload: CalPatchPayload = { key: e.id, entryKey: e.key, clientId, body, before, at: nowIso() };
    rowId = (await (await getOutbox()).enqueue('calendar.patch', payload)).id;
    kick();
  }
  if (o.strip !== false) {
    const from = e.start !== null ? hhmm(e.start) : i18n.t('cal.all_day_short');
    const text = e.date === to.date
      ? i18n.t('cal.moved', { title: e.title, from, to: hhmm(to.start) })
      : i18n.t('cal.moved_day', { title: e.title, day: dayWords(to.date), to: hhmm(to.start) });
    useUndo.getState().showCustom(text, () => void undoMove(e, rowId, clientId), pageForList('todo')?.id ?? null, i18n.t('cal.undo_move'));
  }
  return rowId;
}

async function undoMove(e: CalEntry, rowId: string | null, clientId: string): Promise<void> {
  if (!rowId) {
    dropTimeEdit(e.key, clientId);
    return;
  }
  const engine = await getSyncEngine();
  await engine.hold(rowId);
  try {
    const outbox = await getOutbox();
    const row = await outbox.get(rowId);
    if (!row || row.status === 'failed') return dropTimeEdit(e.key, clientId);
    const p = row.payload as CalPatchPayload;
    if (row.status === 'pending') {
      await outbox.markFailed(row.id, 'undone'); // never sent: it does not go
      dropTimeEdit(e.key, clientId);
      return;
    }
    // Sent: the old time shown at once, the server's undo puts it back there.
    const back = newId();
    if (p.before.startMs !== null) {
      const s = calState();
      s.set({ timeEdits: { ...s.timeEdits, [e.key]: { startMs: p.before.startMs, duration: p.before.duration, clientId: back } } });
    }
    if (p.actionId) {
      const r = await undoServerAction(p.actionId);
      if (r.result === 'expired' || r.result === 'failed') dropTimeEdit(e.key, back);
      return;
    }
    if (p.before.startMs === null) return;
    const payload: CalPatchPayload = {
      ...p,
      clientId: back,
      body: { ...p.body, start_at: isoWithOffset(p.before.startMs), duration_min: p.before.duration },
      before: { startMs: e.startMs, duration: e.duration },
      at: nowIso(),
      actionId: null,
    };
    await outbox.enqueue('calendar.patch', payload);
  } finally {
    engine.release(rowId);
    kick();
  }
}

/** «Сделано» of a block (§4: `notificationSuccess`, the block becomes an outline). */
export async function setEntryDone(e: CalEntry, done: boolean): Promise<void> {
  if (e.kind !== 'task') return;
  if (!e.occurrenceAt) {
    await setDone(e.id, done);
    return;
  }
  const clientId = newId();
  const s = calState();
  s.set({ occEdits: { ...s.occEdits, [e.key]: { ...s.occEdits[e.key], done, clientId } } });
  let rowId: string | null = null;
  if (canQueue()) {
    const payload: CalDonePayload = { key: e.id, entryKey: e.key, clientId, done, occurrenceAt: e.occurrenceAt };
    rowId = (await (await getOutbox()).enqueue('calendar.done', payload)).id;
    kick();
  }
  const text = done ? i18n.t('tasks.ticked_todo', { title: e.title }) : i18n.t('tasks.unticked', { title: e.title });
  useUndo.getState().showCustom(text, () => void undoDone(e, rowId, clientId, done));
}

async function undoDone(e: CalEntry, rowId: string | null, clientId: string, done: boolean): Promise<void> {
  if (!rowId) return dropOccEdit(e.key, clientId);
  const engine = await getSyncEngine();
  await engine.hold(rowId);
  try {
    const outbox = await getOutbox();
    const row = await outbox.get(rowId);
    if (!row || row.status === 'failed') return dropOccEdit(e.key, clientId);
    if (row.status === 'pending') {
      await outbox.markFailed(row.id, 'undone');
      dropOccEdit(e.key, clientId);
      return;
    }
    const p = row.payload as CalDonePayload;
    const back = newId();
    const s = calState();
    s.set({ occEdits: { ...s.occEdits, [e.key]: { ...s.occEdits[e.key], done: !done, clientId: back } } });
    if (p.actionId) {
      const r = await undoServerAction(p.actionId);
      if (r.result === 'expired' || r.result === 'failed') dropOccEdit(e.key, back);
      return;
    }
    await outbox.enqueue('calendar.done', { ...p, clientId: back, done: !done, actionId: null } satisfies CalDonePayload);
  } finally {
    engine.release(rowId);
    kick();
  }
}

/**
 * «Удалить» without «Да» (Ф-75): the block goes at once, «Удалено: «…» · Восстановить» for 3 s, the to-do goes to the
 * trash. A repeat: `this` skips one occurrence, `following` ends the series before it (§4: «Все» is not offered).
 */
export async function deleteEntry(e: CalEntry, scope: TaskScope = 'this'): Promise<void> {
  if (e.kind !== 'task') return;
  const clientId = newId();
  const occurrence = !!e.occurrenceAt;
  const restoreLocal = () => {
    if (occurrence) {
      if (scope === 'following') dropSeriesEnd(e.id, clientId);
      else dropOccEdit(e.key, clientId);
      return;
    }
    const t = findTask(e.id);
    if (t) tasksState().set({ tasks: { ...tasksState().tasks, [t.id]: { ...t, deleted_at: null } } });
  };
  if (occurrence) {
    const s = calState();
    if (scope === 'following' && e.occurrenceAt) {
      s.set({ seriesEnds: { ...s.seriesEnds, [e.id]: { from: Date.parse(e.occurrenceAt), clientId } } });
    } else s.set({ occEdits: { ...s.occEdits, [e.key]: { ...s.occEdits[e.key], skipped: true, clientId } } });
  } else {
    const t = findTask(e.id);
    if (t) tasksState().set({ tasks: { ...tasksState().tasks, [t.id]: { ...t, deleted_at: nowIso() } } });
  }
  let rowId: string | null = null;
  if (canQueue()) {
    const payload: CalDeletePayload = {
      key: e.id,
      entryKey: e.key,
      clientId,
      ...(occurrence ? { occurrenceAt: e.occurrenceAt, scope } : {}),
    };
    rowId = (await (await getOutbox()).enqueue('calendar.delete', payload)).id;
    kick();
  }
  useUndo.getState().showCustom(
    i18n.t('cal.deleted', { title: e.title }),
    () => void undoDelete(rowId, restoreLocal),
    pageForList('todo')?.id ?? null,
    i18n.t('notice.restore'),
  );
}

async function undoDelete(rowId: string | null, restoreLocal: () => void): Promise<void> {
  restoreLocal();
  if (!rowId) return;
  const engine = await getSyncEngine();
  await engine.hold(rowId);
  try {
    const outbox = await getOutbox();
    const row = await outbox.get(rowId);
    if (!row || row.status === 'failed') return;
    if (row.status === 'pending') {
      await outbox.markFailed(row.id, 'undone');
      return;
    }
    const actionId = (row.payload as CalDeletePayload).actionId;
    if (actionId) await undoServerAction(actionId);
  } finally {
    engine.release(rowId);
    kick();
  }
}

// --- the assistant line (§5) ---

let focusSeq = 0;

/**
 * A chat action made or moved timed to-dos: the calendar goes to that day (unless the person is browsing another one)
 * and rings the block in terracotta for 1.5 s (`newItemRing`). The words «Записал… · Отменить» are the action's own
 * notice (UndoStrip).
 */
export function focusFromAssistant(tasks: TaskOut[], now: number = Date.now()): CalFocus | null {
  const timed = tasks.filter((t) => t.list_key === 'todo' && !t.deleted_at && (t.start_at || t.due_date));
  const t = timed[timed.length - 1];
  if (!t) return null;
  const ms = t.start_at ? Date.parse(t.start_at) : NaN;
  const date = Number.isFinite(ms) ? isoDate(ms) : (t.due_date as string);
  const focus: CalFocus = { taskId: t.id, date, startMin: Number.isFinite(ms) ? minutesOf(ms) : null, until: now + 1500, seq: ++focusSeq };
  calState().set({ focus });
  return focus;
}

/** Whether the calendar should go to the focused day: it shows today, or that day already (§5 п. 5). */
export function followsFocus(shownDate: string, focus: CalFocus, today: string): boolean {
  return shownDate === today || shownDate === focus.date;
}

export type { CalendarEntryOut };

/**
 * The card's «Повтор»: the whole series (calendar.md: `rrule` cannot change for one occurrence), from the series'
 * own start. Shown at once on the task, the server's answer settles it.
 */
export async function setRepeat(e: CalEntry, rrule: string | null): Promise<string | null> {
  const t = findTask(e.id);
  if (!t || e.kind !== 'task') return null;
  const startMs = t.start_at ? Date.parse(t.start_at) : e.startMs;
  if (startMs === null || !Number.isFinite(startMs) || (t.rrule ?? null) === rrule) return null;
  const series: CalEntry = { ...e, key: taskEntryKey(t.id, null), occurrenceAt: null, startMs, start: minutesOf(startMs), date: isoDate(startMs), rrule: t.rrule ?? null };
  tasksState().set({ tasks: { ...tasksState().tasks, [t.id]: { ...t, rrule } } });
  return moveEntry(series, { date: series.date, start: series.start!, duration: t.duration_min ?? e.duration }, 'all', { rrule, strip: false });
}

/** «Напомнить» of the add sheet and the card (calendar.md «Reminder of a to-do»): 10 · 30 · 60 · 1440 min, null = none. */
export const REMIND_OFFSETS = [10, 30, 60, 1440, null] as const;

/**
 * The card's «Напомнить»: the task's one alert, `offset` minutes before its start (null = none). The whole task — for an
 * occurrence of a repeat the series' (one occurrence cannot have its own: the server answers 422), so never with
 * `occurrence_at` / `scope`. Shown at once (offline too), one `calendar.patch` row; its answer or /sync settles it.
 * A to-do without a time has no alert. Returns the outbox row id (null: nothing changed or before consent).
 */
export async function setReminderOffset(e: CalEntry, offset: number | null): Promise<string | null> {
  if (e.kind !== 'task') return null;
  const t = findTask(e.id);
  if (!t || !t.start_at) return null;
  const edit = remindEditOf(calState().remindEdits, t);
  const now = edit ? edit.offset : t.reminder_offset_min !== undefined ? t.reminder_offset_min : (e.offset ?? null);
  if (now === offset) return null;
  const clientId = newId();
  const s = calState();
  s.set({ remindEdits: { ...s.remindEdits, [t.id]: { offset, clientId } } });
  if (!canQueue()) return null; // the phone only: nothing to send to
  const payload: CalPatchPayload = {
    key: t.id,
    entryKey: taskEntryKey(t.id, null),
    clientId,
    body: { reminder_offset_min: offset },
    before: { startMs: null, duration: null },
    at: nowIso(),
  };
  const rowId = (await (await getOutbox()).enqueue('calendar.patch', payload)).id;
  kick();
  return rowId;
}
