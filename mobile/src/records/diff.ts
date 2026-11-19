/** A segment of a word diff: kept, removed (struck in `ink3`) or added (under the terracotta marker). */
export type DiffPart = { kind: 'same' | 'del' | 'ins'; text: string };

/** Words and the spaces after them, so the pieces glue back into the text («Паром идёт 40 минут» → 4 tokens). */
const tokens = (s: string) => s.match(/\S+\s*|\s+/gu) ?? [];

/**
 * items.md «Inline edit»: `before` → `after` by words (LCS). Long texts (> 1200 tokens a side) fall back to «all old
 * struck, all new marked» so a phone never stalls on it.
 */
export function wordDiff(before: string, after: string): DiffPart[] {
  const a = tokens(before);
  const b = tokens(after);
  if (a.length * b.length > 1_440_000) {
    return [
      ...(before ? [{ kind: 'del' as const, text: before }] : []),
      ...(after ? [{ kind: 'ins' as const, text: after }] : []),
    ];
  }
  const n = a.length;
  const m = b.length;
  const L: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1)
    for (let j = m - 1; j >= 0; j -= 1)
      L[i]![j] = a[i]!.trim() === b[j]!.trim() ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  const out: DiffPart[] = [];
  const push = (kind: DiffPart['kind'], text: string) => {
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text;
    else out.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i]!.trim() === b[j]!.trim()) {
      push('same', b[j]!);
      i += 1;
      j += 1;
    } else if (L[i + 1]![j]! >= L[i]![j + 1]!) {
      push('del', a[i]!);
      i += 1;
    } else {
      push('ins', b[j]!);
      j += 1;
    }
  }
  while (i < n) push('del', a[i++]!);
  while (j < m) push('ins', b[j++]!);
  return out;
}
