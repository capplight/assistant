import type { CalendarEntryOut, FireOut, ReminderOut, TaskOccurrenceOut, TaskOut } from '@/api/types';

import { occurrences } from './rrule';
import type { OccEdit, RemindEdit, TimeEdit } from './store';
import { atMinutes, dayStart, isoDate, minutesOf, addDaysIso } from './time';

/**
 * Ф-89: what the calendar draws, built on the phone from what it holds (offline, «Без ИИ»), so a move or a new block
 * shows at once: timed to-dos (repeats expanded by the same rule as the server, occurrences applied), all-day to-dos
 * (`due_date`), reminders that are not a to-do's alert, and plan steps from the last GET /v1/calendar. Pure.
 */
export type CalEntry = {
  /** Stable: `task:{id}:` · `task:{id}:{occurrence ms}` · `reminder:{id}:{ms}` · the server's key of a plan step. */
  key: string;
  kind: 'task' | 'reminder' | 'plan_step';
  /** Task key (server id or `local:…`), reminder id, plan step id. */
  id: string;
  /** Original start of this occurrence (ISO) for a repeat; null for a single one. */
  occurrenceAt: string | null;
  title: string;
  date: string;
  allDay: boolean;
  /** Minutes from midnight; null when all-day. */
  start: number | null;
  duration: number | null;
  startMs: number | null;
  rrule: string | null;
  done: boolean;
  source: 'assistant' | 'user' | null;
  itemId: string | null;
  /** The assistant changed it within 24 h (`assistant_changed_at`). */
  changedAt: string | null;
  changedBy: string | null;
  plan: { id: string; title: string } | null;
  /** A change by hand is still on its way (the waiting mark). */
  pending: boolean;
  version: number;
  /** The record's linked reminder (the card's «Напомнить»). */
  remind: { id: string; offsets: number[] } | null;
  /**
   * calendar.md «Reminder of a to-do»: the task's alert in minutes before the start as the person sees it (a change
   * by hand wins), null = none. The whole series' for an occurrence (one occurrence has no alert of its own).
   */
  offset?: number | null;
};

export type EntrySources = {
  tasks: Record<string, TaskOut>;
  /** done of a task as the person sees it (ticks win). */
  isDone: (t: TaskOut) => boolean;
  /** due_date as the person sees it (edits win). */
  dueOf?: (t: TaskOut) => string | null;
  reminders: Record<string, ReminderOut>;
  fires: Record<string, FireOut>;
  acked: (fireKey: string) => boolean;
  occurrences: Record<string, TaskOccurrenceOut>;
  timeEdits: Record<string, TimeEdit>;
  occEdits: Record<string, OccEdit>;
  seriesEnds: Record<string, { from: number }>;
  /** «Напомнить» by hand on its way, by task key (server id, or `local:<client_id>` until it came). */
  remindEdits?: Record<string, RemindEdit>;
  server: Record<string, CalendarEntryOut>;
};

/** The edit of «Напомнить» of a task: by its key, or by the local key it had before the server answered. */
export function remindEditOf(edits: Record<string, RemindEdit> | undefined, t: Pick<TaskOut, 'id' | 'client_id'>): RemindEdit | undefined {
  if (!edits) return undefined;
  return edits[t.id] ?? (t.client_id ? edits[`local:${t.client_id}`] : undefined);
}

/** The alert of a timed task in minutes before its start, null = none (an older copy: its linked reminder). */
export function offsetOf(t: TaskOut, edit: RemindEdit | undefined, linked: ReminderOut | undefined): number | null {
  if (edit) return edit.offset;
  if (t.reminder_offset_min !== undefined) return t.reminder_offset_min;
  return linked && linked.offsets.length > 0 ? Math.max(...linked.offsets) : null;
}

export const taskEntryKey = (taskId: string, occMs: number | null) => `task:${taskId}:${occMs ?? ''}`;

const liveReminder = (r: ReminderOut | undefined): r is ReminderOut =>
  !!r && r.kind === 'normal' && !r.deleted_at && r.status !== 'cancelled';

/** Entries of the dates [from, to] (inclusive), sorted by date, all-day first, then start, then title. */
export function buildEntries(src: EntrySources, from: string, to: string): CalEntry[] {
  const lo = dayStart(from);
  const hi = dayStart(addDaysIso(to, 1));
  const out: CalEntry[] = [];
  const tasks = Object.values(src.tasks).filter((t) => t.list_key === 'todo' && !t.deleted_at);
  // A record with a live reminder and no time of its own: the reminder stands for it in its hour (today.md).
  const remByItem = new Map<string, ReminderOut>();
  for (const r of Object.values(src.reminders)) if (liveReminder(r) && r.item_id) remByItem.set(r.item_id, r);
  const timedItems = new Set(tasks.filter((t) => t.start_at && t.item_id).map((t) => t.item_id!));
  const occByTask = new Map<string, Map<number, TaskOccurrenceOut>>();
  for (const o of Object.values(src.occurrences)) {
    const ms = Date.parse(o.occurrence_at);
    if (!Number.isFinite(ms)) continue;
    const m = occByTask.get(o.task_id) ?? new Map<number, TaskOccurrenceOut>();
    m.set(ms, o);
    occByTask.set(o.task_id, m);
  }
  const doneOfTask = new Map<string, boolean>();

  for (const t of tasks) {
    const linked = t.item_id ? remByItem.get(t.item_id) : undefined;
    const base = {
      kind: 'task' as const,
      id: t.id,
      title: t.title,
      source: t.source ?? null,
      itemId: t.item_id,
      changedAt: t.assistant_changed_at ?? null,
      changedBy: t.assistant_action_id ?? null,
      plan: null,
      version: t.version,
      remind: linked && t.start_at ? { id: linked.id, offsets: linked.offsets } : null,
      offset: offsetOf(t, remindEditOf(src.remindEdits, t), linked),
    };
    const startMs = t.start_at ? Date.parse(t.start_at) : NaN;
    if (Number.isFinite(startMs)) {
      if (t.rrule) {
        const occs = occByTask.get(t.id);
        const end = src.seriesEnds[t.id]?.from ?? null;
        // Look a day around the range: a moved occurrence may land inside it from just outside.
        for (const ms of occurrences(t.rrule, startMs, lo - 86_400_000, hi + 86_400_000)) {
          if (end !== null && ms >= end) break;
          const key = taskEntryKey(t.id, ms);
          const own = occs?.get(ms);
          const edit = src.occEdits[key];
          if ((edit?.skipped ?? own?.skipped) === true) continue;
          const time = src.timeEdits[key];
          const at = time ? time.startMs : own?.start_at ? Date.parse(own.start_at) : ms;
          if (!Number.isFinite(at) || at < lo || at >= hi) continue;
          out.push({
            ...base,
            key,
            occurrenceAt: new Date(ms).toISOString(),
            date: isoDate(at),
            allDay: false,
            start: minutesOf(at),
            duration: time ? time.duration : (own?.duration_min ?? t.duration_min ?? null),
            startMs: at,
            rrule: t.rrule,
            done: edit?.done ?? !!own?.done_at,
            pending: !!time || !!edit,
          });
        }
        continue;
      }
      const key = taskEntryKey(t.id, null);
      const time = src.timeEdits[key];
      const at = time ? time.startMs : startMs;
      if (at < lo || at >= hi) continue;
      out.push({
        ...base,
        key,
        occurrenceAt: null,
        date: isoDate(at),
        allDay: false,
        start: minutesOf(at),
        duration: time ? time.duration : (t.duration_min ?? null),
        startMs: at,
        rrule: null,
        done: src.isDone(t),
        pending: !!time,
      });
      continue;
    }
    const key = taskEntryKey(t.id, null);
    const time = src.timeEdits[key];
    if (time) {
      // An all-day to-do drawn into the grid by hand (its PATCH is on the way).
      if (time.startMs < lo || time.startMs >= hi) continue;
      out.push({ ...base, key, occurrenceAt: null, date: isoDate(time.startMs), allDay: false, start: minutesOf(time.startMs), duration: time.duration, startMs: time.startMs, rrule: null, done: src.isDone(t), pending: true });
      continue;
    }
    if (t.item_id && remByItem.has(t.item_id)) {
      doneOfTask.set(t.item_id, src.isDone(t));
      continue;
    }
    const due = src.dueOf ? src.dueOf(t) : t.due_date;
    if (!due || due < from || due > to) continue;
    out.push({ ...base, key, occurrenceAt: null, date: due, allDay: true, start: null, duration: null, startMs: null, rrule: null, done: src.isDone(t), pending: false });
  }

  // Reminders that are not a timed to-do's alert: a point in time (the capsule).
  const acked = new Map<string, boolean>();
  for (const f of Object.values(src.fires)) {
    const k = `${f.reminder_id}|${Date.parse(f.occurrence_at)}`;
    if (f.state === 'acked' || src.acked(f.key)) acked.set(k, true);
  }
  for (const r of Object.values(src.reminders)) {
    if (!liveReminder(r)) continue;
    if (r.item_id && timedItems.has(r.item_id)) continue;
    const due = Date.parse(r.due_at);
    if (!Number.isFinite(due)) continue;
    for (const ms of occurrences(r.rrule, due, lo, hi)) {
      out.push({
        key: `reminder:${r.id}:${ms}`,
        kind: 'reminder',
        id: r.id,
        occurrenceAt: r.rrule ? new Date(ms).toISOString() : null,
        title: r.title,
        date: isoDate(ms),
        allDay: false,
        start: minutesOf(ms),
        duration: r.duration_min ?? null,
        startMs: ms,
        rrule: r.rrule,
        done: acked.get(`${r.id}|${ms}`) === true || (r.item_id ? doneOfTask.get(r.item_id) === true : false),
        source: null,
        itemId: r.item_id,
        changedAt: null,
        changedBy: null,
        plan: null,
        pending: r.id.startsWith('local:'),
        version: r.version,
        remind: null,
      });
    }
  }

  // Plan steps: only the server knows them (calendar.md `kind: "plan_step"`).
  for (const e of Object.values(src.server)) {
    if (e.kind !== 'plan_step' || e.date < from || e.date > to) continue;
    const start = e.start ? hm(e.start) : null;
    out.push({
      key: e.key,
      kind: 'plan_step',
      id: e.id,
      occurrenceAt: e.occurrence_at,
      title: e.title,
      date: e.date,
      allDay: start === null,
      start,
      duration: e.duration_min,
      startMs: start === null ? null : atMinutes(e.date, start),
      rrule: null,
      done: e.done,
      source: e.source,
      itemId: e.item_id,
      changedAt: null,
      changedBy: null,
      plan: e.plan,
      pending: false,
      version: e.version,
      remind: null,
    });
  }
  return sortEntries(out);
}

function hm(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function sortEntries(list: CalEntry[]): CalEntry[] {
  return [...list].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      Number(b.allDay) - Number(a.allDay) ||
      (a.start ?? 0) - (b.start ?? 0) ||
      a.title.localeCompare(b.title),
  );
}

/** The end of a block in minutes (a point counts as 30 min). */
export const endOf = (e: Pick<CalEntry, 'start' | 'duration'>) => (e.start ?? 0) + (e.duration ?? 30);

export type BlockState = 'current' | 'next' | 'past' | 'done' | 'plain';

/**
 * §3 / §9.4: done = outline + struck; past not done = outline «прошло · не отмечено»; the one going on = ink; the next
 * one ahead today = outlined 2 with «через …». `now` in ms.
 */
export function blockStates(entries: readonly CalEntry[], now: number): Map<string, BlockState> {
  const today = isoDate(now);
  const nowMin = minutesOf(now);
  const out = new Map<string, BlockState>();
  let nextKey: string | null = null;
  let nextStart = Infinity;
  for (const e of entries) {
    if (e.allDay || e.start === null) continue;
    if (e.done) {
      out.set(e.key, 'done');
      continue;
    }
    const pastDay = e.date < today;
    const futureDay = e.date > today;
    if (pastDay || (!futureDay && endOf(e) <= nowMin)) out.set(e.key, 'past');
    else if (!futureDay && e.start <= nowMin) out.set(e.key, 'current');
    else {
      out.set(e.key, 'plain');
      if (!futureDay && e.kind !== 'reminder' && e.start < nextStart) {
        nextStart = e.start;
        nextKey = e.key;
      }
    }
  }
  if (nextKey) out.set(nextKey, 'next');
  return out;
}

/** Free time from now to the next timed thing of today (≥ 30 min), for the hatched window (§3, §9.4). */
export function windowAhead(entries: readonly CalEntry[], now: number, min = 30): { start: number; end: number } | null {
  const today = isoDate(now);
  const nowMin = minutesOf(now);
  const timed = entries.filter((e) => e.date === today && !e.allDay && e.start !== null && !e.done);
  if (timed.some((e) => e.start! <= nowMin && endOf(e) > nowMin)) return null;
  const next = timed.filter((e) => e.start! > nowMin).sort((a, b) => a.start! - b.start!)[0];
  if (!next || next.start! - nowMin < min) return null;
  return { start: nowMin, end: next.start! };
}
