import { addDays } from '@/expenses/calc';

type T = (key: string, opts?: Record<string, unknown>) => string;

/**
 * Ф-84 «Пустое „Сегодня“» (`docs/design/system/today-empty-options.html`, «Итог»): the summary + the week on the
 * yellow sheet. Pure helpers, so the phrase table and the week are tested without a screen.
 */

/** Monday … Sunday of the week of `today` (ISO dates). */
export function weekOf(today: string): string[] {
  const dow = new Date(`${today}T00:00:00`).getDay(); // 0 = Sunday
  const monday = addDays(today, -((dow + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

/** The nearest day after today (1…7 days ahead) with something on it, or null. */
export function nearestDay(today: string, load: Record<string, number>): string | null {
  for (let i = 1; i <= 7; i += 1) {
    const d = addDays(today, i);
    if ((load[d] ?? 0) > 0) return d;
  }
  return null;
}

export type EmptyPhraseInput = {
  today: string;
  /** First 7 days and nothing saved yet. */
  blank: boolean;
  /** Open «Не забыть» to-dos (overdue, today, without a day). */
  notForget: number;
  /** Things (to-dos + reminders) per future day. */
  load: Record<string, number>;
  /** «пятница» for an ISO date. */
  weekday: (date: string) => string;
};

/**
 * The phrase of an empty day (no plan today), two short sentences, the second one with a number or a day, no «…»:
 * «Чистый лист. / Скажите первое.», «Свободный день. / Не забыть 2 дела.», «Сегодня свободно. / Завтра 3 дела.»,
 * «Свободный день. / Ближайшее — пятница.», «Свободный день. / Неделя пустая.».
 */
export function emptyPhrase(i: EmptyPhraseInput, t: T): string {
  if (i.blank) return t('today.e_blank');
  if (i.notForget > 0) return `${t('today.e_free')}\n${t('today.e_not_forget', { count: i.notForget })}`;
  const tomorrow = i.load[addDays(i.today, 1)] ?? 0;
  if (tomorrow > 0) return `${t('today.e_free_today')}\n${t('today.e_tomorrow', { count: tomorrow })}`;
  const near = nearestDay(i.today, i.load);
  if (near) return `${t('today.e_free')}\n${t('today.e_nearest', { day: i.weekday(near) })}`;
  return `${t('today.e_free')}\n${t('today.e_week_empty')}`;
}

/**
 * «Три первые фразы»: a step is done only when such a record really exists. The block shows in the first 7 days
 * until all three are done, then it is gone.
 */
export function firstSteps(i: { ageDays: number; note: boolean; reminder: boolean; expense: boolean }): {
  show: boolean;
  done: number;
} {
  const done = [i.note, i.reminder, i.expense].filter(Boolean).length;
  return { show: i.ageDays < 7 && done < 3, done };
}

/** A step's phrase goes into the assistant strip without its last word: the person finishes it. */
export function withoutLastWord(phrase: string): string {
  const cut = phrase.trimEnd().replace(/\S+$/u, '');
  return cut.length > 0 ? cut : phrase;
}
