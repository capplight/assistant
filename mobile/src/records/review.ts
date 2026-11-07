import type { LocalRecord } from '@/db/records';

/** A «Проверьте» field as the card shows it: server state + «Верно» / «Исправить» still on their way. */
export type ReviewRow = { key: string; kind: string; value: string | null; verified: boolean };

export function reviewRows(rec: LocalRecord): ReviewRow[] {
  const pending = rec.pending.verify ?? {};
  const corrected = rec.pending.corrected ?? {};
  return Object.entries(rec.reviewFields).map(([key, f]) => {
    const typed = corrected[key];
    return {
      key,
      kind: f.kind,
      value: typed ?? f.value,
      // What the person typed needs no checking. A value that changed after «Верно» is asked again.
      verified: typed !== undefined || f.state === 'verified' || (key in pending && pending[key] === f.value),
    };
  });
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
