import { endOf, type CalEntry } from '@/calendar/entries';
import { dayPeriod, type DayPeriod } from '@/calendar/period';
import { hmShort } from '@/calendar/time';

/**
 * calendar-time.md §9 «Сегодня» by the time of day: the frame stays (the 2-line phrase, the week, the paper, the line);
 * only the phrase and the first block of the paper change. The phrase is the sum (how many, free until when), the paper
 * only what to act on — no number or time in both. The phrase is ALWAYS two lines (our own `\n`), so the sheet has one
 * height in every period (QA-3 J8). Templates only (i18n plural forms): code never makes up a phrase. Pure.
 */
type T = (k: string, o?: Record<string, unknown>) => string;

export type TodInput = {
  /** Minutes from midnight. */
  now: number;
  /** Timed things of today (to-dos with a time, reminders). */
  today: readonly Pick<CalEntry, 'title' | 'start' | 'duration' | 'done' | 'kind'>[];
  /** Things of tomorrow (timed or not), for the night. */
  tomorrowCount: number;
  quiet?: { from: number; to: number } | null;
};

export function todPeriod(i: TodInput): DayPeriod {
  const timed = i.today.filter((e) => e.start !== null).map((e) => ({ start: e.start!, end: endOf(e) }));
  return dayPeriod({ now: i.now, timed, quiet: i.quiet ?? null });
}

/** The two lines of the phrase for this period, or null when the period has nothing to say (the Ф-84 «Сводка» speaks). */
export function todPhrase(period: DayPeriod, i: TodInput, t: T): string | null {
  const timed = i.today.filter((e) => e.start !== null).sort((a, b) => a.start! - b.start!);
  // §9.2: with nothing timed, the Ф-84 «Сводка» speaks (also at night when tomorrow is empty).
  if (period === 'night') {
    if (timed.length === 0 && i.tomorrowCount === 0) return null;
    return `${t('todayTime.night_1')}\n${i.tomorrowCount > 0 ? t('todayTime.night_tomorrow', { count: i.tomorrowCount }) : t('todayTime.night_free')}`;
  }
  if (timed.length === 0) return null;
  if (period === 'morning') {
    const first = timed[0]!;
    return `${t('todayTime.morning_1')}\n${t('todayTime.morning_first', { tasks: t('today.phrase_tasks', { count: timed.length }), time: hmShort(first.start!) })}`;
  }
  if (period === 'evening') {
    const done = timed.filter((e) => e.done).length;
    return `${t('todayTime.evening_1')}\n${t('todayTime.evening_done', { done, all: timed.length })}`;
  }
  const current = timed.find((e) => !e.done && e.start! <= i.now && endOf(e) > i.now);
  const ahead = timed.filter((e) => !e.done && e.start! > i.now);
  const first = current
    ? t('todayTime.day_now', { title: current.title })
    : ahead[0]
      ? t('todayTime.day_free_until', { time: hmShort(ahead[0].start!) })
      : null;
  if (!first) return null;
  const left = ahead.length;
  return `${first}\n${left > 0 ? t('todayTime.day_left', { count: left }) : t('todayTime.day_left_none')}`;
}
