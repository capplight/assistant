import type { TemplateKey } from './templates';

/**
 * S35 ticks after the first phrase (onboarding.md `suggested-pages`, 3-engineering 3.11) — by words,
 * in code, no model call. A port of the server's `onboarding/marks.py`; the shared vectors
 * (`docs/spec/vectors/onboarding-marks.json`) run in Jest, so offline the phone ticks the same.
 */

export const MAX_MARKED = 3;

/** Welcome frame 2 lines (S02) as the server names them (`intro_marks`). */
export type IntroMark = 'remind' | 'photo_receipt' | 'find' | 'kp' | 'expenses';
const INTRO: Record<IntroMark, TemplateKey | null> = {
  remind: null,
  find: null,
  kp: 'documents',
  expenses: 'expenses',
  photo_receipt: 'expenses',
};

const EXACT_DOCUMENTS = new Set(['кп', 'кұ']);
const DOCUMENTS = ['коммерческ', 'клиент', 'смет', 'коммерциялық'];
const EXACT_EXPENSES = new Set(['тг']);
const EXPENSES = ['тенге', 'теңге', 'потрат', 'заплатил', 'расход', 'жұмса'];
const CURRENCY = /\d[\d\s.,]*\s*(?:к|тыс\.?|тысяч[0-9a-zа-яәғқңөұүһі_]*|млн)?\s*(?:тг|тенге|теңге)|₸/u;
const EXACT_SHOPPING = new Set(['купи', 'купить', 'куплю', 'купите', 'купим', 'докупить', 'докупи', 'прикупить', 'закупить']);
const SHOPPING = ['покупк', 'покупок'];
const SHOPPING_PHRASE = /(?:^|\s)(?:в|до) магазин|сатып ал|дүкен(?:ге|нен)/u;
const WORD = /[0-9a-zа-яәғқңөұүһі.]+/gu;

const words = (phrase: string) => phrase.toLowerCase().replace(/ё/g, 'е').match(WORD) ?? [];

const trimDots = (w: string) => w.replace(/^\.+|\.+$/g, '');

function has(ws: string[], exact: Set<string>, stems: string[]): boolean {
  return ws.some((w) => exact.has(w.replace(/\./g, '')) || stems.some((s) => trimDots(w).startsWith(s)));
}

/** The keys to tick, in order: Заметки + Дела, then by the phrase, then by the welcome ticks; ≤3. */
export function suggestedPages(phrase: string | null, introMarks: readonly string[] | null = [], maxMarked = MAX_MARKED): TemplateKey[] {
  const keys: TemplateKey[] = ['notes', 'tasks'];
  const add = (k: TemplateKey) => {
    if (!keys.includes(k) && keys.length < maxMarked) keys.push(k);
  };
  const text = (phrase ?? '').slice(0, 2000);
  const lower = text.toLowerCase();
  const ws = words(text);
  if (has(ws, EXACT_DOCUMENTS, DOCUMENTS)) add('documents');
  if (has(ws, EXACT_SHOPPING, SHOPPING) || SHOPPING_PHRASE.test(lower)) add('shopping');
  if (has(ws, EXACT_EXPENSES, EXPENSES) || CURRENCY.test(lower)) add('expenses');
  for (const m of introMarks ?? []) {
    const k = INTRO[m as IntroMark];
    if (k) add(k);
  }
  return keys;
}

/** Kept for the week-3 callers: only what the phrase adds (Заметки + Дела come from the caller). */
export function premarksFromPhrase(phrase: string): TemplateKey[] {
  return suggestedPages(phrase).filter((k) => k !== 'notes' && k !== 'tasks');
}
