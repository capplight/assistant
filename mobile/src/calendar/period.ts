/**
 * calendar-time.md §9.1 (Ф-91): «Сегодня» by the time of day, on the person's clock. Morning 05:00–11:00, day
 * 11:00–18:00, evening 18:00–23:00, night 23:00–05:00; quiet hours move the night. Two more rules: the morning ends
 * early once the first timed thing has passed after 10:00 and more are ahead; the evening starts early once every timed
 * thing of today has passed and less than 2 h are left to 18:00. Pure, for tests.
 */
export type DayPeriod = 'morning' | 'day' | 'evening' | 'night';

export const PERIOD_BOUNDS = { morning: 5 * 60, day: 11 * 60, evening: 18 * 60, night: 23 * 60 } as const;

export type PeriodInput = {
  /** Minutes from midnight. */
  now: number;
  /** Timed things of today: start and end (minutes). */
  timed?: readonly { start: number; end: number }[];
  /** The person's quiet hours (minutes), when set. */
  quiet?: { from: number; to: number } | null;
};

export function dayPeriod(i: PeriodInput): DayPeriod {
  const n = i.now;
  const nightFrom = i.quiet?.from ?? PERIOD_BOUNDS.night;
  const morningFrom = i.quiet?.to ?? PERIOD_BOUNDS.morning;
  const inNight = nightFrom > morningFrom ? n >= nightFrom || n < morningFrom : n >= nightFrom && n < morningFrom;
  if (inNight) return 'night';
  const timed = i.timed ?? [];
  if (n >= morningFrom && n < PERIOD_BOUNDS.day) {
    const first = timed.length > 0 ? Math.min(...timed.map((x) => x.start)) : null;
    const ahead = timed.some((x) => x.start > n);
    if (n >= 10 * 60 && first !== null && first < n && ahead) return 'day';
    return 'morning';
  }
  if (n >= PERIOD_BOUNDS.evening) return 'evening';
  // Day: the evening may start early (all timed things passed, < 2 h to 18:00).
  if (n >= PERIOD_BOUNDS.evening - 120 && timed.length > 0 && timed.every((x) => x.end <= n)) return 'evening';
  if (n < morningFrom) return 'night';
  return 'day';
}
