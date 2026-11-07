import type { LocalRecord } from '@/db/records';

/** One local answer is about one screen of a phone; more says nothing new to the person. */
export const MAX_LOCAL_RESULTS = 100;

const SNIPPET_CHARS = 120;

/** Kazakh letters typed on a Russian keyboard, ё: the same letter (as on the server, docs/api/search.md). */
const SAME_LETTER: Record<string, string> = {
  ё: 'е',
  ә: 'а',
  ғ: 'г',
  қ: 'к',
  ң: 'н',
  ө: 'о',
  ұ: 'у',
  ү: 'у',
  һ: 'х',
  і: 'и',
};

/** Keeps the string's length, so a place found in the folded text is the same place in the original. */
export function fold(s: string): string {
  return s
    .toLowerCase()
    .replace(/[ёәғқңөұүһі]/g, (c) => SAME_LETTER[c] ?? c);
}

/** Numbers as one: «+7 701 123-45-67» is 77011234567. Different numbers do not run together. */
const digitRuns = (s: string) => (s.match(/\d[\d \-()]*\d/g) ?? []).map((run) => run.replace(/\D/g, '')).join('|');

/** «где мой чек за холодильник» looks for a check and a fridge. Folded, as the text is. */
const QUESTION_WORDS = new Set(
  (
    'где куда откуда когда сколько кто кому кого какой какая какое какие какую каких что найди найти покажи есть ли ' +
    'мой моя мое мои мою моего у меня я за на в во с по для и а ' +
    'қайда қашан қанша кім кімге қандай тап тауып бер көрсет менің'
  )
    .split(' ')
    .map(fold),
);

export function searchTerms(q: string): string[] {
  const words = fold(q)
    .replace(/[?!.,;:«»"()]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const meaningful = words.filter((w) => !QUESTION_WORDS.has(w));
  return meaningful.length > 0 ? meaningful : words;
}

function haystack(r: LocalRecord): string {
  const reviewValues = Object.keys(r.reviewFields).map((k) => r.pending.corrected?.[k] ?? r.reviewFields[k]?.value ?? '');
  return fold([r.title, r.summary, r.text, r.url, ...r.files.map((f) => f.name), ...reviewValues].filter(Boolean).join('\n'));
}

function matches(text: string, digits: string, term: string): boolean {
  if (text.includes(term)) return true;
  // +7 701 123 45 67 is found by 7011234567.
  return /^\d+$/.test(term) && digits.includes(term);
}

/** Words on the phone, instantly, online or not: every word of the query, anywhere in the record. */
export function searchRecords(records: readonly LocalRecord[], q: string, limit = MAX_LOCAL_RESULTS): LocalRecord[] {
  const terms = searchTerms(q);
  if (terms.length === 0) return [];
  const out: LocalRecord[] = [];
  for (const r of records) {
    const text = haystack(r);
    const digits = digitRuns(text);
    if (terms.every((t) => matches(text, digits, t))) {
      out.push(r);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** The place in the text that matched, when the card's first lines would not show it. */
export function snippetFor(r: LocalRecord, q: string): string | null {
  const terms = searchTerms(q);
  const body = r.text;
  const first = terms[0];
  if (!body || !first) return null;
  const at = fold(body).indexOf(first);
  if (at < SNIPPET_CHARS / 2) return null;
  const start = Math.max(0, at - 30);
  const end = Math.min(body.length, start + SNIPPET_CHARS);
  return `…${body.slice(start, end).trim()}${end < body.length ? '…' : ''}`;
}

const QUESTION_START =
  /^(где|куда|откуда|когда|сколько|кто|кому|кого|какой|какая|какое|какие|какую|каких|что я|что у меня|найди|найти|покажи|есть ли|қайда|қашан|қанша|кім|кімге|қандай|тап|тауып бер|көрсет)(\s|$)/;

/**
 * v0 of R-53, until the server decides in week 5: a question looks through what is saved, everything
 * else is saved. A guess, so the results screen offers to save the phrase after all.
 */
export function looksLikeQuestion(text: string): boolean {
  const t = text.trim().toLowerCase();
  return t.endsWith('?') || QUESTION_START.test(t);
}
