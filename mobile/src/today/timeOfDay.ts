import { endOf, type CalEntry } from '@/calendar/entries';
import { dayPeriod, type DayPeriod } from '@/calendar/period';

import type { PhraseCounts } from './v6';

/**
 * calendar-time.md §9 «Сегодня» by the time of day. The period comes from the person's clock (§9.1); the phrase
 * (today-v6-acceptance.md §3.1) is ALWAYS two lines of templates (our own `\n`), so the yellow sheet has one height in
 * every period (QA-3 J8). Plural forms come from i18n: code never makes up a phrase, it only picks the template. Pure.
 */
type T = (k: string, o?: Record<string, unknown>) => string;

export type TodInput = {
  /** Minutes from midnight. */
  now: number;
  /** Timed things of today (to-dos with a time, reminders). */
  today: readonly Pick<CalEntry, 'start' | 'duration'>[];
  quiet?: { from: number; to: number } | null;
};

export function todPeriod(i: TodInput): DayPeriod {
  const timed = i.today.filter((e) => e.start !== null).map((e) => ({ start: e.start!, end: endOf(e) }));
  return dayPeriod({ now: i.now, timed, quiet: i.quiet ?? null });
}

/**
 * §3.1: morning «Доброе утро. / Сегодня {n} дел.», day «Добрый день. / Ещё {n} дел сегодня.», evening «День позади. /
 * Сделано {done} из {all}.», night «Спокойной ночи. / Завтра {n} дел.»; an empty today (not at night) «Свободный день. /
 * Ближайшее — {день}.» or, with nothing in 7 days, «Свободный день. / Дел пока нет.»; the evening / night with timed
 * things still ahead today «Добрый вечер. / Ещё {n} дел сегодня.» (review 1 Р1). No time here: it is in the card.
 */
export function todPhrase(period: DayPeriod, c: PhraseCounts, t: T): string {
  const free = () => (c.nearest ? t('today6.phrase_free_near', { day: c.nearest }) : t('today6.phrase_free_none'));
  // Review 1 Р1: the evening (or the night before midnight) still has timed things today — «Добрый вечер. / Ещё N дел сегодня.»
  if ((period === 'evening' || period === 'night') && c.lateAhead && c.ahead > 0) return t('today6.phrase_evening_ahead', { count: c.ahead });
  if (period === 'night') {
    if (c.coming === 0 && c.emptyToday && !c.nearest) return free();
    return c.coming > 0 ? t('today6.phrase_night', { count: c.coming }) : t('today6.phrase_night_none');
  }
  if (c.emptyToday) return free();
  if (period === 'morning') return t('today6.phrase_morning', { count: c.all });
  if (period === 'day') return c.ahead > 0 ? t('today6.phrase_day', { count: c.ahead }) : t('today6.phrase_day_none');
  return t('today6.phrase_evening', { done: c.done, all: c.all });
}
