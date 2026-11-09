/**
 * Expense totals on the phone (3-engineering 3.12, R-59): the TS port of the server's
 * `expenses/calc.py` (`calc.v1`), checked against docs/spec/vectors/calc.json. Money is integer
 * minor units (tiyn) in `bigint`: never a float, so a sum of a thousand entries is exact and equals
 * the server's. An amount is rounded once, when read, ROUND_HALF_UP to 0.01 (Python
 * `Decimal.quantize(CENT, ROUND_HALF_UP)`: a tie goes away from zero); then only additions follow.
 *
 * Rules (same as the server): currencies are never added together (one line each, KZT first, then
 * by code); `refund` subtracts; `transfer_own` and the service category «Переводы» are in nothing;
 * `income` is its own line; a trashed entry is in nothing; periods go by `spent_on` (the day on the
 * person's clock), so a month is a plain date range and no time zone enters here.
 */

export const CALC_VERSION = 'calc.v1';

export type Direction = 'expense' | 'income' | 'refund' | 'transfer_own';

/** What a total looks at, one expense (the server's `Row`). */
export type CalcRow = {
  id: string;
  amount: string;
  currency: string;
  direction: Direction;
  spent_on: string;
  /** The group key of `category` (the phone uses the category key; null = none). */
  category: string | null;
  /** The category is «Переводы». */
  service?: boolean;
  payee?: string | null;
  method?: string | null;
  /** «Проверьте» is still on its amount. */
  review?: boolean;
  deleted?: boolean;
};

/** The hidden service category: own transfers never count as spending. */
export const TRANSFERS_KEY = 'transfers';

/** numeric(14,2): 999 999 999 999.99 at most (`AMOUNT_MAX`). */
export const MAX_MINOR = 10n ** 14n - 1n;

const DECIMAL = /^([+-]?)(\d+)(?:\.(\d*))?$/;

/**
 * A decimal → tiyn, ROUND_HALF_UP to 0.01; null when it is not a plain decimal. Spaces, «,» for
 * the point and a trailing «₸» are allowed (what a person types); the server sends «5000.00».
 */
export function toMinor(input: string): bigint | null {
  const s = input
    .replace(/[\s   ]/g, '')
    .replace(/₸$/u, '')
    .replace(/^−/, '-')
    .replace(',', '.');
  const m = DECIMAL.exec(s);
  if (!m) return null;
  const [, sign = '', int = '0', frac = ''] = m;
  let minor = BigInt(int) * 100n + BigInt((frac + '00').slice(0, 2));
  // The third digit and beyond: half a tiyn or more rounds up (away from zero, like HALF_UP).
  if (frac.length > 2 && frac[2]! >= '5') minor += 1n;
  return sign === '-' ? -minor : minor;
}

/** tiyn → the contract's decimal text «5000.00». */
export function minorToDecimal(minor: bigint): string {
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  return `${neg ? '-' : ''}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
}

/** The server's `SYMBOLS`; any other currency is shown by its code («10 GBP»). */
const SYMBOL: Record<string, string> = { KZT: '₸', USD: '$', RUB: '₽', EUR: '€', KGS: 'сом' };
export const currencySymbol = (c: string) => SYMBOL[c] ?? c;

/** Digits in groups of three: «1 240 000». Plain spaces, like the server: a long number may wrap by groups. */
export function groupDigits(int: string): string {
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

/** 155050n → «1 550,50 ₸» (`format_money`); decimals only when there are some; a real minus sign. */
export function formatMinor(minor: bigint, currency = 'KZT'): string {
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  const frac = abs % 100n;
  return `${neg ? '−' : ''}${groupDigits(String(abs / 100n))}${frac ? `,${String(frac).padStart(2, '0')}` : ''} ${currencySymbol(currency)}`;
}

export const formatAmount = (amount: string, currency = 'KZT') => formatMinor(toMinor(amount) ?? 0n, currency);

export type GroupBy = 'category' | 'month' | 'payee' | 'method';

export type Total = { currency: string; expense: bigint; refund: bigint; income: bigint; count: number; total: bigint };
export type Group = { key: string | null; currency: string; total: bigint; count: number };
export type Aggregate = { totals: Total[]; groups: Group[]; review_count: number; basis: string[]; calc_version: string };

const currencyRank = (c: string): [number, string] => [c === 'KZT' ? 0 : 1, c];
const byCurrency = (a: string, b: string) => {
  const [ra, ca] = currencyRank(a);
  const [rb, cb] = currencyRank(b);
  return ra - rb || (ca < cb ? -1 : ca > cb ? 1 : 0);
};

function groupKey(row: CalcRow, by: GroupBy): string | null {
  if (by === 'category') return row.category;
  if (by === 'month') return row.spent_on.slice(0, 7);
  if (by === 'payee') return row.payee ? row.payee.split(/\s+/).filter(Boolean).join(' ') || null : null;
  return row.method ?? null;
}

const isService = (r: CalcRow) => r.service === true || r.category === TRANSFERS_KEY;

/** The server's `aggregate`, the same order of totals and groups. Rows outside the period must be left out first (`inPeriod`). */
export function aggregate(rows: readonly CalcRow[], groupBy: GroupBy | null = null): Aggregate {
  const totals = new Map<string, Total>();
  const groups = new Map<string, Group>();
  const out: Aggregate = { totals: [], groups: [], review_count: 0, basis: [], calc_version: CALC_VERSION };
  for (const row of rows) {
    if (row.deleted || isService(row) || row.direction === 'transfer_own') continue;
    const amount = toMinor(row.amount);
    if (amount === null) continue; // never guessed
    const currency = (row.currency || 'KZT').toUpperCase();
    let t = totals.get(currency);
    if (!t) totals.set(currency, (t = { currency, expense: 0n, refund: 0n, income: 0n, count: 0, total: 0n }));
    if (row.direction === 'income') {
      t.income += amount;
      continue;
    }
    if (row.direction === 'refund') t.refund += amount;
    else if (row.direction === 'expense') t.expense += amount;
    else continue;
    t.count += 1;
    out.basis.push(row.id);
    if (row.review) out.review_count += 1;
    if (groupBy) {
      const key = groupKey(row, groupBy);
      const id = `${key === null ? '-' : `k:${key}`}|${currency}`;
      let g = groups.get(id);
      if (!g) groups.set(id, (g = { key, currency, total: 0n, count: 0 }));
      g.total += row.direction === 'expense' ? amount : -amount;
      g.count += 1;
    }
  }
  for (const t of totals.values()) t.total = t.expense - t.refund;
  out.totals = [...totals.values()].sort((a, b) => byCurrency(a.currency, b.currency));
  out.groups = [...groups.values()].sort(
    (a, b) =>
      byCurrency(a.currency, b.currency) ||
      (a.total === b.total ? 0 : a.total > b.total ? -1 : 1) ||
      Number(a.key === null) - Number(b.key === null) ||
      ((a.key ?? '') < (b.key ?? '') ? -1 : (a.key ?? '') > (b.key ?? '') ? 1 : 0),
  );
  return out;
}

/** Σ of a day of the feed in one currency, by the same rules. */
export function sumOf(rows: readonly CalcRow[], currency = 'KZT'): bigint {
  return aggregate(rows).totals.find((t) => t.currency === currency)?.total ?? 0n;
}

// --- periods: plain dates «YYYY-MM-DD» on the person's clock (`period_bounds`) ---

export type PeriodKind = 'week' | 'month' | 'year' | 'all' | 'custom';
export type Period = { kind: PeriodKind; from: string | null; to: string | null };

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const parts = (date: string) => date.split('-').map(Number) as [number, number, number];
/** `Date.UTC` only counts days here: no zone is involved. */
const fromUtc = (t: Date) => ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());

export function addDays(date: string, n: number): string {
  const [y, m, d] = parts(date);
  return fromUtc(new Date(Date.UTC(y, m - 1, d + n)));
}

/** The period of this kind that holds `date`; weeks are Monday to Sunday. */
export function periodOf(kind: Exclude<PeriodKind, 'custom'>, date: string): Period {
  const [y, m, d] = parts(date);
  if (kind === 'all') return { kind, from: null, to: null };
  if (kind === 'year') return { kind, from: ymd(y, 1, 1), to: ymd(y, 12, 31) };
  if (kind === 'month') return { kind, from: ymd(y, m, 1), to: fromUtc(new Date(Date.UTC(y, m, 0))) };
  const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // Monday = 0
  const from = addDays(date, -dow);
  return { kind, from, to: addDays(from, 6) };
}

/** ‹ › : the period before or after (a week, a month, a year). */
export function shiftPeriod(p: Period, step: -1 | 1): Period {
  if (!p.from || p.kind === 'all' || p.kind === 'custom') return p;
  if (p.kind === 'week') return periodOf('week', addDays(p.from, 7 * step));
  const [y, m] = parts(p.from);
  if (p.kind === 'year') return periodOf('year', ymd(y + step, 1, 1));
  return periodOf('month', fromUtc(new Date(Date.UTC(y, m - 1 + step, 1))));
}

export const inPeriod = (spentOn: string, p: Pick<Period, 'from' | 'to'>) =>
  (p.from === null || spentOn >= p.from) && (p.to === null || spentOn <= p.to);
