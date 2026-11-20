/**
 * Ф-89 calendar: the one local clock of the calendar and of «Сегодня» by time of day (QA v5-device-3 п. 11: one function
 * of local time). Dates are `YYYY-MM-DD` on the phone's clock, times are minutes from midnight. Pure.
 */

export const MIN_MS = 60_000;
export const DAY_MS = 86_400_000;

const pad = (n: number) => String(n).padStart(2, '0');

/** `YYYY-MM-DD` of a moment on the phone's clock. */
export function isoDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local midnight of a date (ms). */
export function dayStart(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1, 0, 0, 0, 0).getTime();
}

/** The moment of `minutes` after the local midnight of `date` (DST-safe: by the clock, not by adding ms). */
export function atMinutes(date: string, minutes: number): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1, 0, minutes, 0, 0).getTime();
}

export function addDaysIso(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return isoDate(new Date(y!, (m ?? 1) - 1, (d ?? 1) + n, 12).getTime());
}

/** Whole days from `a` to `b` (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((dayStart(b) - dayStart(a)) / DAY_MS);
}

/** Minutes from the local midnight of the moment's own day. */
export function minutesOf(ms: number): number {
  const d = new Date(ms);
  return d.getHours() * 60 + d.getMinutes();
}

/** «08:00» — the grid and the blocks (calendar-time.html: always two digits). */
export function hhmm(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/** «9:41» — the «сейчас» tag of «Сегодня» (as the plan of the day). */
export function hmShort(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${Math.floor(m / 60)}:${pad(m % 60)}`;
}

/** «9:00» / «15:30» of the contract → minutes; null when not a time. */
export function parseHm(s: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s ?? '');
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  return h < 24 && mm < 60 ? h * 60 + mm : null;
}

/** Monday of the week that holds `date`. */
export function weekStart(date: string): string {
  const wd = (new Date(dayStart(date)).getDay() + 6) % 7;
  return addDaysIso(date, -wd);
}

/** The 7 days Monday → Sunday of the week that holds `date`. */
export function weekDays(date: string): string[] {
  const s = weekStart(date);
  return Array.from({ length: 7 }, (_, i) => addDaysIso(s, i));
}

/** The 6 × 7 grid of a month (Monday first), as the server's Month range (calendar.md: 42 days). */
export function monthGrid(date: string): string[] {
  const first = `${date.slice(0, 7)}-01`;
  const s = weekStart(first);
  return Array.from({ length: 42 }, (_, i) => addDaysIso(s, i));
}

/** First day of the month `n` months after the month of `date`. */
export function addMonths(date: string, n: number): string {
  const [y, m] = date.split('-').map(Number);
  const d = new Date(y!, (m ?? 1) - 1 + n, 1, 12);
  return isoDate(d.getTime());
}

/** ISO with the phone's offset («2026-11-21T10:00:00+05:00»): what POST /tasks takes for `start_at`. */
export function isoWithOffset(ms: number): string {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${isoDate(ms)}T${pad(d.getHours())}:${pad(d.getMinutes())}:00${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** The phone's IANA zone (the contract's `tz`), the person's default when unknown. */
export function phoneTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Almaty';
  } catch {
    return 'Asia/Almaty';
  }
}
