import i18n from '@/i18n';

/** «7:00» on the phone's clock. */
export function timeText(ms: number): string {
  const d = new Date(ms);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 0 = today, 1 = tomorrow, … (by the phone's calendar, not by 24 h). */
export function dayOffset(ms: number, now: number): number {
  return Math.round((startOfDay(ms) - startOfDay(now)) / 86_400_000);
}

/** «Завтра, среда, 4 ноября» — the day of the week always (2-design S13). */
export function dayText(ms: number, now: number): string {
  const d = new Date(ms);
  let rest: string;
  try {
    rest = d.toLocaleDateString(i18n.language, { weekday: 'long', day: 'numeric', month: 'long' });
  } catch {
    rest = d.toDateString();
  }
  const off = dayOffset(ms, now);
  const first = off === 0 ? i18n.t('rem.today') : off === 1 ? i18n.t('rem.tomorrow') : null;
  return first ? `${first}, ${rest}` : rest.charAt(0).toUpperCase() + rest.slice(1);
}

/** For «Напомню {когда} в {время}»: «сегодня» / «завтра» / «4 ноября». */
export function whenWord(ms: number, now: number): string {
  const off = dayOffset(ms, now);
  if (off === 0) return i18n.t('rem.when_today');
  if (off === 1) return i18n.t('rem.when_tomorrow');
  try {
    return new Date(ms).toLocaleDateString(i18n.language, { day: 'numeric', month: 'long' });
  } catch {
    return new Date(ms).toDateString();
  }
}

/** A phone number in the text → «Позвонить» on S14. */
export function phoneIn(text: string): string | null {
  const m = /(\+?\d[\d\s()-]{8,}\d)/.exec(text);
  return m ? m[1]!.trim() : null;
}

/** «разбуди», «обязательно», «не дай забыть» → «Будильник» by default (R-11). */
export function wantsAlarm(text: string): boolean {
  return /(разбуди|обязательно|не дай забыть|будильник|оят|міндетті)/i.test(text);
}

/**
 * The line's guess that a phrase asks for a reminder (only for routing: the server reads it).
 * Russian and Kazakh starts: «напомни…», «разбуди…», «не дай забыть…», «поставь будильник…»,
 * «еске сал…», «ескерт…», «оят…».
 */
export function looksLikeReminder(text: string): boolean {
  const t = text.trim().toLowerCase();
  return /^(напомни|напомнить|разбуди|не дай забыть|поставь будильник|поставь напоминание|еске сал|ескерт|оят)/.test(t) ||
    /(^|\s)(напомни|разбуди)(\s|$)/.test(t);
}
