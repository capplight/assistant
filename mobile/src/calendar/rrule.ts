import { addDaysIso, atMinutes, dayStart, isoDate, minutesOf } from './time';

/**
 * calendar.md «Repeat»: the phone expands repeats with the same rule as the server (FREQ=DAILY|WEEKLY|MONTHLY,
 * INTERVAL 1–12, BYDAY with WEEKLY, BYMONTHDAY with MONTHLY, UNTIL=YYYYMMDDTHHMMSSZ), counted from `start_at` on the
 * local clock, so the calendar works offline for the ±60 days it keeps. Pure.
 */
export type Rule = {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY';
  interval: number;
  byDay: number[] | null;
  byMonthDay: number | null;
  until: number | null;
};

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

export function parseRule(rrule: string | null | undefined): Rule | null {
  if (!rrule) return null;
  const parts = Object.fromEntries(
    rrule
      .replace(/^RRULE:/i, '')
      .split(';')
      .map((p) => p.split('='))
      .filter((p) => p.length === 2)
      .map(([k, v]) => [k!.toUpperCase(), v!.toUpperCase()]),
  );
  const freq = parts.FREQ;
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY') return null;
  const interval = Math.min(12, Math.max(1, Number(parts.INTERVAL ?? 1) || 1));
  const byDay = parts.BYDAY
    ? parts.BYDAY.split(',')
        .map((d: string) => DAYS.indexOf(d.slice(-2)))
        .filter((d: number) => d >= 0)
    : null;
  const byMonthDay = parts.BYMONTHDAY ? Number(parts.BYMONTHDAY) || null : null;
  let until: number | null = null;
  const u = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(parts.UNTIL ?? '');
  if (u) until = Date.UTC(+u[1]!, +u[2]! - 1, +u[3]!, +(u[4] ?? 23), +(u[5] ?? 59), +(u[6] ?? 59));
  return { freq, interval, byDay: byDay && byDay.length > 0 ? byDay : null, byMonthDay, until };
}

/** Starts (ms) of the occurrences of a series that fall in [from, to), never before `start`. */
export function occurrences(rrule: string | null | undefined, start: number, from: number, to: number, cap = 400): number[] {
  const rule = parseRule(rrule);
  if (!rule) return start >= from && start < to ? [start] : [];
  const out: number[] = [];
  const t = minutesOf(start);
  const first = isoDate(start);
  const ok = (ms: number) => ms >= start && ms >= from && ms < to && (rule.until === null || ms <= rule.until);
  const end = Math.min(to, rule.until !== null ? rule.until + 1 : to);
  if (rule.freq === 'DAILY') {
    // Jump close to `from` instead of walking every day of a long series.
    const skip = Math.max(0, Math.floor((from - dayStart(first)) / 86_400_000 / rule.interval) - 1);
    for (let k = skip; out.length < cap; k += 1) {
      const ms = atMinutes(addDaysIso(first, k * rule.interval), t);
      if (ms >= end) break;
      if (ok(ms)) out.push(ms);
    }
    return out;
  }
  if (rule.freq === 'WEEKLY') {
    const days = rule.byDay ?? [new Date(start).getDay()];
    const monday = addDaysIso(first, -((new Date(dayStart(first)).getDay() + 6) % 7));
    const skip = Math.max(0, Math.floor((from - dayStart(monday)) / (7 * 86_400_000) / rule.interval) - 1);
    for (let w = skip; out.length < cap; w += 1) {
      const wk = addDaysIso(monday, w * 7 * rule.interval);
      if (dayStart(wk) >= end) break;
      const list = days
        .map((d) => atMinutes(addDaysIso(wk, (d + 6) % 7), t))
        .sort((a, b) => a - b);
      for (const ms of list) if (ok(ms)) out.push(ms);
    }
    return out;
  }
  const dom = rule.byMonthDay ?? new Date(start).getDate();
  const [y0, m0] = first.split('-').map(Number);
  for (let k = 0; out.length < cap && k < 1200; k += rule.interval) {
    const d = new Date(y0!, m0! - 1 + k, dom, 0, t);
    if (d.getDate() !== dom) continue; // the month has no such day
    const ms = d.getTime();
    if (ms >= end) break;
    if (ok(ms)) out.push(ms);
  }
  return out;
}

/** A short repeat label key: none / daily / weekly / monthly (the card's «Повтор» row). */
export function repeatKind(rrule: string | null | undefined): 'none' | 'daily' | 'weekly' | 'monthly' {
  const r = parseRule(rrule);
  if (!r) return 'none';
  return r.freq === 'DAILY' ? 'daily' : r.freq === 'WEEKLY' ? 'weekly' : 'monthly';
}

export function ruleFor(kind: 'none' | 'daily' | 'weekly' | 'monthly'): string | null {
  return kind === 'none' ? null : `FREQ=${kind.toUpperCase()}`;
}
