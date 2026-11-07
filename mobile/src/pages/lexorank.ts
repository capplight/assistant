/**
 * LexoRank keys (3-engineering §3.10): same algorithm as `src/assistant/pages/lexorank.py`, both
 * checked against `docs/spec/vectors/lexorank.json`. A key is a base-62 fraction that never ends
 * in "0". Compare with `<` on strings, never `localeCompare`.
 */
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = ALPHABET.length;
const MID = 'V';
const LAST = BASE - 1;

export class RankError extends Error {}

const digit = (ch: string): number => ALPHABET.indexOf(ch);
const char = (d: number): string => ALPHABET.charAt(d);

export function isValidRank(key: string): boolean {
  return key.length > 0 && !key.endsWith('0') && [...key].every((ch) => digit(ch) >= 0);
}

function check(key: string): void {
  if (!isValidRank(key)) throw new RankError(`bad rank key: ${key}`);
}

function after(a: string): string {
  for (let i = 0; i < a.length; i++) {
    const d = digit(a.charAt(i));
    if (d < LAST) return a.slice(0, i) + char(d + 1);
  }
  return a + MID;
}

function before(b: string): string {
  for (let i = 0; i < b.length; i++) {
    const d = digit(b.charAt(i));
    if (d > 1) return b.slice(0, i) + char(d - 1);
    if (d === 1) return `${b.slice(0, i)}0${MID}`;
  }
  throw new RankError(`bad rank key: ${b}`);
}

function midpoint(a: string, b: string): string {
  let prefix = '';
  let tight = true; // still on b's digits; once false the upper bound no longer limits us
  for (let i = 0; ; i++) {
    const low = i < a.length ? digit(a.charAt(i)) : 0;
    const high = tight && i < b.length ? digit(b.charAt(i)) : BASE;
    if (high - low > 1) return prefix + char(Math.floor((low + high) / 2));
    prefix += char(low);
    if (high - low === 1) tight = false;
  }
}

/** A key strictly between `a` and `b`; null means no bound on that side. */
export function between(a: string | null, b: string | null): string {
  if (a !== null) check(a);
  if (b !== null) check(b);
  if (a === null && b === null) return MID;
  if (b === null) return after(a as string);
  if (a === null) return before(b);
  if (a >= b) throw new RankError(`bounds out of order: ${a} >= ${b}`);
  return midpoint(a, b);
}

/** `n` evenly spaced keys in ascending order, with room between neighbours. */
export function sequence(n: number): string[] {
  if (n < 0) throw new RankError('negative count');
  // Plain numbers: exact up to 62^8, far beyond any page (a page holds thousands of rows at most).
  let width = 1;
  let span = BASE;
  while (span < (n + 1) * BASE) {
    width++;
    span *= BASE;
  }
  const step = Math.floor(span / (n + 1));
  const out: string[] = [];
  for (let i = 1; i <= n; i++) {
    let value = i * step;
    let digits = '';
    for (let w = 0; w < width; w++) {
      digits = char(value % BASE) + digits;
      value = Math.floor(value / BASE);
    }
    out.push(digits.replace(/0+$/, ''));
  }
  return out;
}

/** Bytewise order of keys; null last. */
export function compareRank(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}
