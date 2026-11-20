import { endOf, type CalEntry } from '@/calendar/entries';
import type { DayPeriod } from '@/calendar/period';
import { addDaysIso, isoDate, minutesOf } from '@/calendar/time';
import { expandedSheetHeight } from '@/components/ui/PlaceScreen';
import { nextUp, todayListBottom, todayPlan, type LayoutMetrics } from '@/theme';

/**
 * «Сегодня» v6 (today-v6.md §3 option A, today-v6-acceptance.md §1–§3, Ф-92…Ф-94): what the screen shows, counted
 * from what the phone holds (calendar entries, to-dos, missed rings) before the first frame. Pure, for tests: the
 * screen only draws what these return.
 */

/** A row of «План»: a timed entry of the calendar, or a to-do without a time (`todo`). */
export type PlanRow = {
  key: string;
  kind: CalEntry['kind'] | 'todo';
  title: string;
  /** Minutes from midnight; null without a time. */
  start: number | null;
  duration: number | null;
  done: boolean;
  /** The calendar entry (a timed thing, or the card of a to-do without a time). */
  entry: CalEntry;
  /** A reminder that rang and was not answered: its missed row ([Сделано] = a late «acked»). */
  missedKey?: string | null;
  /** A caption instead of the kind's own («вчера» for a missed reminder of yesterday, review 1 Р2). */
  meta?: string;
};

/** A missed ring as «План» needs it (`useMissed`). */
export type MissedRing = { key: string; reminderId: string; title: string; at: number };

/** To-dos without a time as the plan needs them. */
export type UntimedTodo = { id: string; title: string; due_date: string | null; done: boolean; created_at: string };

/** The day the night looks at: after midnight it is today (the person has not slept yet), else tomorrow. */
export function comingDay(today: string, nowMin: number, period: DayPeriod): string {
  return afterMidnight(period, nowMin) ? today : addDaysIso(today, 1);
}

/** The night after midnight (the person has not slept yet: «завтра» is today's date). */
export const afterMidnight = (period: DayPeriod, nowMin: number) => period === 'night' && nowMin < 12 * 60;

/** Р1: the evening or the night before midnight with timed things still ahead today. */
export const lateWithAhead = (period: DayPeriod, nowMin: number, ahead: number) =>
  (period === 'evening' || period === 'night') && !afterMidnight(period, nowMin) && ahead > 0;

const timedOf = (entries: readonly CalEntry[], date: string) =>
  entries
    .filter((e) => e.date === date && !e.allDay && e.start !== null)
    .sort((a, b) => a.start! - b.start! || a.title.localeCompare(b.title));

/** Entries of a day for the read-only «Завтра, суббота» rows: timed ones by time, then the ones without a time. */
export function dayRows(entries: readonly CalEntry[], date: string): CalEntry[] {
  const day = entries.filter((e) => e.date === date);
  return [...timedOf(day, date), ...day.filter((e) => e.allDay || e.start === null)];
}

// ---------------- «Дальше» (NextUp) ----------------

export type NextKind = 'first' | 'now' | 'next' | 'tomorrow' | 'nearest' | 'none';

export type NextUpState = {
  kind: NextKind;
  entry: CalEntry | null;
  /** The date on the calendar leaf; a tap opens the calendar «День» on it. */
  date: string;
  /** Minutes until the start (`first` / `next`) or left until the end (`now`); null otherwise. */
  minutes: number | null;
};

/**
 * §3.2 + review 1 Р1: in the card go timed to-dos AND reminders (never to-dos without a time). In any period (but the
 * night after midnight): the one going on («Сейчас · ещё 20 мин»), else the next one today («Первое» only in the
 * morning while nothing is ticked and nothing has started, else «Дальше»). Nothing timed left today: the first of the
 * coming day («Завтра первое»), else the first in the next 7 days («Ближайшее»), else «Дел пока нет» on today's leaf.
 */
export function nextUpOf(i: {
  nowMin: number;
  today: string;
  period: DayPeriod;
  /** Calendar entries of [today, today + 7]. */
  entries: readonly CalEntry[];
  /** Something of today is ticked already (the morning then says «Дальше», not «Первое»). */
  anyDoneToday: boolean;
}): NextUpState {
  const { nowMin, today, period } = i;
  const todays = timedOf(i.entries, today).filter((e) => !e.done);
  // Review 1 Р1: what is going on / next today counts in every period (an evening dinner at 19:00 is «Дальше»). Only
  // after midnight the night looks at the coming day, which is today's date: its things are «Завтра первое».
  if (!afterMidnight(period, nowMin)) {
    const current = todays.find((e) => e.start! <= nowMin && endOf(e) > nowMin);
    if (current) return { kind: 'now', entry: current, date: today, minutes: endOf(current) - nowMin };
    const ahead = todays.find((e) => e.start! > nowMin);
    if (ahead) {
      const started = timedOf(i.entries, today).some((e) => e.start! <= nowMin);
      const first = period === 'morning' && !i.anyDoneToday && !started;
      return { kind: first ? 'first' : 'next', entry: ahead, date: today, minutes: ahead.start! - nowMin };
    }
  }
  const coming = comingDay(today, nowMin, period);
  const onComing = timedOf(i.entries, coming).filter((e) => !e.done && (coming !== today || e.start! > nowMin));
  if (onComing[0]) return { kind: 'tomorrow', entry: onComing[0], date: coming, minutes: null };
  const last = addDaysIso(today, 7);
  for (let d = addDaysIso(coming, 1); d <= last; d = addDaysIso(d, 1)) {
    const first = timedOf(i.entries, d).find((e) => !e.done);
    if (first) return { kind: 'nearest', entry: first, date: d, minutes: null };
  }
  return { kind: 'none', entry: null, date: today, minutes: null };
}

/** The card's fixed height: 64, 88 with large text (the title may wrap). Never measured (QA-3 §4 п. 1). */
export function nextUpHeight(m: Pick<LayoutMetrics, 'largeText'>): number {
  return m.largeText ? nextUp.heightLargeMax : nextUp.height;
}

/** What the card adds to the yellow sheet: the gap 14 + the card. The same in every period and state. */
export const nextUpExtra = (m: Pick<LayoutMetrics, 'largeText'>) => nextUp.gap + nextUpHeight(m);

/**
 * §1.2: the height of the expanded yellow sheet from the tokens only: the top row (the date button), the 2-line
 * phrase (or the title at ≤ 340 dp / large text) and the card. It takes no period and no data on purpose.
 */
export function todaySheetHeight(m: LayoutMetrics): number {
  return expandedSheetHeight({ m, meta: true, phraseLines: m.titleOnly ? 0 : 2, title: m.titleOnly, extra: nextUpExtra(m) });
}

/** §5.1–5.2: the paper's bottom room above the tabs. */
export const todayBottom = (m: Pick<LayoutMetrics, 'largeText'>) => (m.largeText ? todayListBottom.large : todayListBottom.regular);

/** §3.4 п. 4: visible rows of «План»: 4 under 400 dp, 5 from 400. */
export const planLimit = (width: number) => (width < todayPlan.regularFrom ? todayPlan.maxRows.compact : todayPlan.maxRows.regular);

// ---------------- «План» (TodayPlan) ----------------

/** A to-do without a time as a calendar entry (its card is the same `EntryCard`). */
export function todoEntry(x: UntimedTodo, today: string): CalEntry {
  return {
    key: `task:${x.id}:`,
    kind: 'task',
    id: x.id,
    occurrenceAt: null,
    title: x.title,
    date: x.due_date ?? today,
    allDay: true,
    start: null,
    duration: null,
    startMs: null,
    rrule: null,
    done: x.done,
    source: null,
    itemId: null,
    changedAt: null,
    changedBy: null,
    plan: null,
    pending: false,
    version: 1,
    remind: null,
  };
}

const rowOf = (e: CalEntry, missedKey?: string | null): PlanRow => ({
  key: e.key,
  kind: e.kind,
  title: e.title,
  start: e.start,
  duration: e.duration,
  done: e.done,
  entry: e,
  missedKey: missedKey ?? null,
});

const todoRow = (x: UntimedTodo, today: string): PlanRow => ({
  key: `todo:${x.id}`,
  kind: 'todo',
  title: x.title,
  start: null,
  duration: null,
  done: x.done,
  entry: todoEntry(x, today),
});

/**
 * To-dos without a time of «План»: a day ≤ today or no day; open ones, and the ones ticked today (they go to
 * «Прошло»). Overdue first, then today's, then the ones without a day; inside — the order they were made in.
 */
export function untimedOrder(list: readonly UntimedTodo[]): UntimedTodo[] {
  const rank = (x: UntimedTodo) => (x.due_date === null ? '9999-99-99' : x.due_date);
  return [...list].sort((a, b) => rank(a).localeCompare(rank(b)) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}

export type DayPlanParts = {
  /** Passed (ended) or done: under «Прошло {n} · не отмечено {m}». */
  past: PlanRow[];
  /** Past and not answered: a to-do not ticked, a reminder still missed. */
  unmarked: PlanRow[];
  /** Ahead, the one going on included (an ordinary row in option A). */
  ahead: PlanRow[];
  /** Open to-dos without a time. */
  untimed: PlanRow[];
};

/** §3.4 morning and day. `missed`: missed rings by `reminderId|ms`. */
export function dayPlanParts(i: {
  nowMin: number;
  today: string;
  entries: readonly CalEntry[];
  untimed: readonly UntimedTodo[];
  missed: ReadonlyMap<string, string>;
  /** Review 1 Р2: missed rings of the last 24 h with an earlier date (shown first in «Прошло», «вчера», [Сделано]). */
  earlier?: readonly MissedRing[];
  /** «вчера». */
  yesterday?: string;
}): DayPlanParts {
  const timed = timedOf(i.entries, i.today);
  const missedOf = (e: CalEntry) => (e.kind === 'reminder' && e.startMs !== null ? (i.missed.get(`${e.id}|${e.startMs}`) ?? null) : null);
  const pastTimed = timed.filter((e) => e.done || endOf(e) <= i.nowMin).map((e) => rowOf(e, missedOf(e)));
  const todos = untimedOrder(i.untimed);
  const earlier = (i.earlier ?? [])
    .filter((r) => isoDate(r.at) < i.today)
    .sort((a, b) => a.at - b.at)
    .map((r): PlanRow => ({ ...rowOf(missedEntry(r), r.key), meta: i.yesterday }));
  const past = [...earlier, ...pastTimed, ...todos.filter((x) => x.done).map((x) => todoRow(x, i.today))];
  const unmarked = past.filter((r) => !r.done && (r.kind === 'reminder' ? !!r.missedKey : true));
  const ahead = timed.filter((e) => !e.done && endOf(e) > i.nowMin).map((e) => rowOf(e));
  const untimed = todos.filter((x) => !x.done).map((x) => todoRow(x, i.today));
  return { past, unmarked, ahead, untimed };
}

/** A missed ring of an earlier day as a reminder entry of the calendar (its card is the reminder's own screen). */
function missedEntry(r: MissedRing): CalEntry {
  return {
    key: `reminder:${r.reminderId}:${r.at}`,
    kind: 'reminder',
    id: r.reminderId,
    occurrenceAt: null,
    title: r.title,
    date: isoDate(r.at),
    allDay: false,
    start: minutesOf(r.at),
    duration: null,
    startMs: r.at,
    rrule: null,
    done: false,
    source: null,
    itemId: null,
    changedAt: null,
    changedBy: null,
    plan: null,
    pending: false,
    version: 1,
    remind: null,
  };
}

/** §3.4 evening «Осталось с сегодня»: open to-dos without a time of today (or overdue) and past timed to-dos not ticked. */
export function leftToday(i: { nowMin: number; today: string; entries: readonly CalEntry[]; untimed: readonly UntimedTodo[] }): PlanRow[] {
  const todos = untimedOrder(i.untimed)
    .filter((x) => !x.done && x.due_date !== null && x.due_date <= i.today)
    .map((x) => todoRow(x, i.today));
  const timed = timedOf(i.entries, i.today)
    .filter((e) => e.kind === 'task' && !e.done && endOf(e) <= i.nowMin)
    .map((e) => rowOf(e));
  return [...todos, ...timed];
}

// ---------------- the phrase (§3.1) ----------------

export type PhraseCounts = {
  /** Timed things of today (to-dos, reminders) and to-dos without a time (open or ticked today). */
  all: number;
  done: number;
  /** Not done and not over yet (timed) + open without a time. */
  ahead: number;
  /** Things of the coming day (for the night). */
  coming: number;
  /** Today has nothing at all. */
  emptyToday: boolean;
  /** The nearest day 1…7 days ahead with something on it, as words («завтра», «пятница»); null = none. */
  nearest: string | null;
  /** Review 1 Р1: evening / night before midnight with timed things still ahead today (`lateWithAhead`). */
  lateAhead?: boolean;
};
