import type { LocalRecord } from '@/db/records';

/** A «Проверьте» field as the card shows it: server state + «Верно» still on its way. */
export type ReviewRow = { key: string; kind: string; value: string | null; verified: boolean };

export function reviewRows(rec: LocalRecord): ReviewRow[] {
  const pending = rec.pending.verify ?? {};
  return Object.entries(rec.reviewFields).map(([key, f]) => ({
    key,
    kind: f.kind,
    value: f.value,
    // A value that changed after «Верно» has to be confirmed again.
    verified: f.state === 'verified' || (key in pending && pending[key] === f.value),
  }));
}

export const unverifiedCount = (rec: LocalRecord): number => reviewRows(rec).filter((r) => !r.verified).length;

/** Russian plural category of a count (no Intl dependency; Kazakh has one form). */
export function pluralForm(n: number): 'one' | 'few' | 'many' {
  const d = n % 10;
  const dd = n % 100;
  if (d === 1 && dd !== 11) return 'one';
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return 'few';
  return 'many';
}
