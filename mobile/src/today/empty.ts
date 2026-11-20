/**
 * Ф-84 «Пустое „Сегодня“»: pure helpers of «Три первые фразы» (the phrase of an empty day is today-v6 §3.1 in
 * `today/timeOfDay.ts`).
 */
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
