/**
 * КП totals on the phone: the TS port of the server's `kp/calc.py` (`kp-calc.v1`, 3-engineering
 * 6.7 п. 4). Money is integer tiyn in `bigint`, never a float; every printed number is rounded
 * ROUND_HALF_UP to 0.01 (a tie goes away from zero, like Python `Decimal.quantize`).
 *
 * The same rules as the server:
 * - a line: `gross = qty × unit_price`, `discount = gross × discount_pct / 100`, `amount = gross −
 *   discount` (each rounded); a line without a price has no amount, counts in nothing and makes the
 *   КП incomplete (no PDF until it gets a price) — a price is never guessed;
 * - `lines_sum = Σ amount`; `discount_total = lines_sum × pct / 100`; `amount = lines_sum − discount_total`;
 * - VAT: `none` → 0; `on_top` → `amount × r / 100`, total = amount + vat; `included` →
 *   `amount × r / (100 + r)`, net = amount − vat, total = amount; `per_line` rounds each line's VAT
 *   and takes the VAT share of the КП's own discount off once.
 *
 * The phone shows these at once (offline tap-edits); the server's `totals` come with its version.
 * The words «сумма прописью» are the server's (in the PDF).
 */

export const KP_CALC_VERSION = 'kp-calc.v2';

export type VatMode = 'included' | 'on_top' | 'none';
export type VatRounding = 'per_line' | 'on_total';

/** `kind: 'lump'` (v2, the father's КП): `unit_price` is the line's whole cost, «Объём» is text, nothing is multiplied. */
export type CalcLine = { id: string; qty: string | null; unit_price: string | null; discount_pct?: string | null; kind?: 'qty' | 'lump' | null };

export type LineTotal = { id: string; gross: bigint | null; discount: bigint | null; amount: bigint | null; vat: bigint | null };

export type KpTotals = {
  lines: LineTotal[];
  linesSum: bigint;
  discountTotal: bigint;
  amount: bigint;
  net: bigint;
  vat: bigint;
  total: bigint;
  priced: number;
  missing: number;
  complete: boolean;
};

/** numeric(14,2) and the server's QTY_MAX. */
export const MONEY_MAX_MINOR = 99_999_999_999_999n;
const QTY_MAX = { n: 99_999_999_999n, scale: 3 };

/** A decimal string as an exact fraction: n / 10^scale. */
type Dec = { n: bigint; scale: number };

const DEC = /^([+-]?)(\d+)(?:[.,](\d*))?$/;

export function parseDecimal(input: string | null | undefined): Dec | null {
  if (input === null || input === undefined) return null;
  const s = String(input)
    .replace(/[\s   ]/g, '')
    .replace(/₸$/u, '')
    .replace(/^−/, '-');
  const m = DEC.exec(s);
  if (!m) return null;
  const [, sign = '', int = '0', frac = ''] = m;
  const n = BigInt(int + frac);
  return { n: sign === '-' ? -n : n, scale: frac.length };
}

const pow10 = (k: number) => 10n ** BigInt(k);

/** num / den rounded HALF_UP to an integer (den > 0). */
function divHalfUp(num: bigint, den: bigint): bigint {
  const neg = num < 0n;
  const a = neg ? -num : num;
  const q = (a * 2n + den) / (den * 2n);
  return neg ? -q : q;
}

/** A plain decimal → tiyn, HALF_UP. */
export function decToMinor(input: string | null | undefined): bigint | null {
  const d = parseDecimal(input);
  if (!d) return null;
  return d.scale <= 2 ? d.n * pow10(2 - d.scale) : divHalfUp(d.n, pow10(d.scale - 2));
}

/** tiyn × pct / 100, HALF_UP (pct a decimal). */
const pctOf = (minor: bigint, pct: Dec) => divHalfUp(minor * pct.n, 100n * pow10(pct.scale));

function vatPart(amount: bigint, mode: VatMode, rate: Dec): bigint {
  if (mode === 'on_top') return pctOf(amount, rate);
  if (mode === 'included') return divHalfUp(amount * rate.n, 100n * pow10(rate.scale) + rate.n);
  return 0n;
}

const cmp = (a: Dec, b: Dec) => {
  const s = Math.max(a.scale, b.scale);
  const x = a.n * pow10(s - a.scale);
  const y = b.n * pow10(s - b.scale);
  return x < y ? -1 : x > y ? 1 : 0;
};
const validPct = (d: Dec | null) => !!d && d.n >= 0n && cmp(d, { n: 100n, scale: 0 }) <= 0;

/** `kp_qty_invalid` | `kp_price_invalid` | `kp_discount_invalid` | `kp_vat_invalid` — the server's codes. */
export class KpCalcError extends Error {
  constructor(
    readonly code: string,
    readonly line: string | null = null,
  ) {
    super(code);
  }
}

/** One line in tiyn; `amount` null when its price is not known. */
export function lineTotal(l: CalcLine): LineTotal {
  const lump = l.kind === 'lump';
  const q = lump ? { n: 1n, scale: 0 } : parseDecimal(l.qty ?? '1');
  if (!q || q.n <= 0n || cmp(q, QTY_MAX) > 0) throw new KpCalcError('kp_qty_invalid', l.id);
  const pct = parseDecimal(l.discount_pct || '0');
  if (!validPct(pct)) throw new KpCalcError('kp_discount_invalid', l.id);
  if (l.unit_price === null || l.unit_price === '') return { id: l.id, gross: null, discount: null, amount: null, vat: null };
  const p = parseDecimal(l.unit_price);
  if (!p || p.n < 0n) throw new KpCalcError('kp_price_invalid', l.id);
  // qty × price in tiyn: q.n × p.n / 10^(qs+ps) × 100; a lump line: its price, rounded to the tiyn.
  const gross = divHalfUp(q.n * p.n * 100n, pow10(q.scale + p.scale));
  if (gross > MONEY_MAX_MINOR) throw new KpCalcError('kp_price_invalid', l.id);
  const discount = pctOf(gross, pct!);
  return { id: l.id, gross, discount, amount: gross - discount, vat: null };
}

export function computeTotals(
  lines: readonly CalcLine[],
  o: { vatMode: VatMode; vatRate: string | null; rounding?: VatRounding; discountTotalPct?: string | null },
): KpTotals {
  const rounding = o.rounding ?? 'on_total';
  let rate: Dec | null = null;
  if (o.vatMode !== 'none') {
    rate = parseDecimal(o.vatRate);
    if (!validPct(rate)) throw new KpCalcError('kp_vat_invalid');
  }
  const docPct = parseDecimal(o.discountTotalPct || '0');
  if (!validPct(docPct)) throw new KpCalcError('kp_discount_invalid');
  const out: LineTotal[] = [];
  let linesSum = 0n;
  let lineVat = 0n;
  let priced = 0;
  let missing = 0;
  for (const l of lines) {
    const lt = lineTotal(l);
    if (lt.amount === null) {
      missing += 1;
      out.push(lt);
      continue;
    }
    if (rounding === 'per_line' && rate) {
      lt.vat = vatPart(lt.amount, o.vatMode, rate);
      lineVat += lt.vat;
    }
    linesSum += lt.amount;
    priced += 1;
    out.push(lt);
  }
  const discountTotal = pctOf(linesSum, docPct!);
  const amount = linesSum - discountTotal;
  const vat = !rate ? 0n : rounding === 'per_line' ? lineVat - vatPart(discountTotal, o.vatMode, rate) : vatPart(amount, o.vatMode, rate);
  const [net, total] = o.vatMode === 'on_top' ? [amount, amount + vat] : o.vatMode === 'included' ? [amount - vat, amount] : [amount, amount];
  return { lines: out, linesSum, discountTotal, amount, net, vat, total, priced, missing, complete: missing === 0 && priced > 0 };
}

/** A typed price («18 500», «427,5») → the contract's «18500.00»; null when not a price. */
export function priceText(input: string): string | null {
  const m = decToMinor(input);
  if (m === null || m < 0n || m > MONEY_MAX_MINOR) return null;
  return `${m / 100n}.${String(m % 100n).padStart(2, '0')}`;
}

/** A typed quantity («500», «2,5») → «500», «2.5»; null when not a positive number (≤3 decimals). */
export function qtyText(input: string): string | null {
  const d = parseDecimal(input);
  if (!d || d.n <= 0n || d.scale > 3 || cmp(d, QTY_MAX) > 0) return null;
  if (d.scale === 0) return String(d.n);
  const s = String(d.n).padStart(d.scale + 1, '0');
  return `${s.slice(0, -d.scale)}.${s.slice(-d.scale)}`.replace(/0+$/, '').replace(/\.$/, '');
}

/** «2.5» → «2,5» for the screen. */
export const showQty = (q: string | null) => (q ?? '').replace('.', ',');
