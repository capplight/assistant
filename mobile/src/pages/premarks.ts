import type { TemplateKey } from './templates';

/**
 * Path-3 premarks from the first phrase — by words, in code, no AI call (3-engineering §3.11).
 * Notes + Tasks are added by the caller (DEFAULT_PREMARKED).
 */
export function premarksFromPhrase(phrase: string): TemplateKey[] {
  const s = phrase.toLowerCase();
  const out: TemplateKey[] = [];
  if (/(^|[^\p{L}])(кп|кұ)([^\p{L}]|$)|клиент|коммерческ/u.test(s)) out.push('documents');
  if (/потратил|потратила|тенге|₸|расход|жұмсад|шығын|теңге/u.test(s)) out.push('expenses');
  return out;
}
