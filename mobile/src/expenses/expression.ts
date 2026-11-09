import { groupDigits, MAX_MINOR, toMinor } from './calc';

/**
 * The calculator keys of «Расходы» (template-screens 2.2): «1200+350» is added by code — a
 * tokenizer and a fold over «+» / «−», never `eval`, never a float. `evaluate` is the TS port of
 * the server's `expenses/calc.py` `evaluate` and reproduces docs/spec/vectors/calc.json
 * («expressions»): the amount, the stored `canonical` form, or the same error code.
 */

export type Key = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '000' | ',' | '+' | '−' | '⌫';

const isOp = (c: string | undefined) => c === '+' || c === '−';

/** 12 digits before the comma (numeric(14,2)), 2 after: the keys never type more. */
const MAX_INT_DIGITS = 12;
const MAX_CHARS = 200;
const MAX_TERMS = 50;

/** The number being typed: what is after the last operator. */
const lastNumber = (s: string) => s.slice(Math.max(s.lastIndexOf('+'), s.lastIndexOf('−')) + 1);

/** One key on the keypad text (its own form: «1200,5+350−30»). */
export function press(text: string, key: Key): string {
  if (key === '⌫') return text.slice(0, -1);
  const last = text.at(-1);
  const num = lastNumber(text);
  const [int = '', frac] = num.split(',');
  if (isOp(key)) {
    if (text === '') return text; // a sum starts with a number
    if (isOp(last) || last === ',') return text.slice(0, -1) + key; // «+» then «−»: the last one counts
    return text + key;
  }
  if (text.length >= MAX_CHARS) return text;
  if (key === ',') {
    if (frac !== undefined || (num === '' && text.split(/[+−]/).length > MAX_TERMS)) return text;
    return text + (num === '' ? '0,' : ',');
  }
  if (frac !== undefined) {
    const room = 2 - frac.length;
    return room <= 0 ? text : text + (key === '000' ? '0'.repeat(room) : key);
  }
  if (int === '0') return key === '000' || key === '0' ? text : text.slice(0, -1) + key; // «0» then «5» → «5»
  if (int === '' && text.split(/[+−]/).length > MAX_TERMS) return text;
  if (int === '' && key === '000') return text + '0';
  return text + key.slice(0, Math.max(0, MAX_INT_DIGITS - int.length));
}

export type CalcErrorCode = 'expression_invalid' | 'amount_not_positive' | 'amount_too_large';

export type Evaluated =
  | { ok: true; minor: bigint; canonical: string; terms: number }
  | { ok: false; error: CalcErrorCode; terms: number };

const SPACES = /[\s   ]+/g;
const TOKEN = /^(?:(\d+(?:[.,]\d*)?|[.,]\d+)|([+\-−–]))/;

/** «0050» → «50», «1550.50» → «1550.5», «5.» → «5» (the server's `_canon_number`). */
function canonNumber(text: string): string {
  const [int = '', frac = ''] = text.split('.');
  const i = int.replace(/^0+(?=\d)/, '') || '0';
  const f = frac.replace(/0+$/, '');
  return f ? `${i}.${f}` : i;
}

/**
 * The keypad sum: digits, one «,» or «.» per number (at most 2 decimals), «+» and «-» / «−»
 * between numbers; spaces ignored; a trailing operator ignored (the person pressed «+» then
 * «Записать»). The result must be > 0 and fit numeric(14,2).
 */
export function evaluate(expression: string): Evaluated {
  let raw = (expression ?? '').replace(SPACES, '');
  if (!raw || raw.length > MAX_CHARS) return { ok: false, error: 'expression_invalid', terms: 0 };
  while (raw && '+-−–'.includes(raw.at(-1)!)) raw = raw.slice(0, -1);
  let total = 0n;
  let sign = 1n;
  let wantNumber = true;
  let terms = 0;
  const parts: string[] = [];
  let rest = raw;
  while (rest.length > 0) {
    const m = TOKEN.exec(rest);
    if (!m) return { ok: false, error: 'expression_invalid', terms };
    const [whole, number, op] = m;
    if (wantNumber) {
      if (number === undefined) return { ok: false, error: 'expression_invalid', terms }; // «+5», «5++3»
      let text = number.replace(',', '.');
      if (text.endsWith('.')) text = text.slice(0, -1);
      if (text.startsWith('.')) text = `0${text}`;
      if (text.includes('.') && text.split('.')[1]!.length > 2) return { ok: false, error: 'expression_invalid', terms };
      const minor = toMinor(text);
      if (minor === null) return { ok: false, error: 'expression_invalid', terms };
      total += sign * minor;
      terms += 1;
      if (terms > MAX_TERMS) return { ok: false, error: 'expression_invalid', terms };
      parts.push(canonNumber(text));
      wantNumber = false;
    } else {
      if (op === undefined) return { ok: false, error: 'expression_invalid', terms };
      sign = op === '+' ? 1n : -1n;
      parts.push(op === '+' ? '+' : '-');
      wantNumber = true;
    }
    rest = rest.slice(whole.length);
  }
  if (terms === 0) return { ok: false, error: 'expression_invalid', terms };
  if (total <= 0n) return { ok: false, error: 'amount_not_positive', terms };
  if (total > MAX_MINOR) return { ok: false, error: 'amount_too_large', terms };
  return { ok: true, minor: total, canonical: parts.join(''), terms };
}

/** «1200,5+350» → «1 200,5 + 350» for the keys' board (thousands grouped, spaced operators). */
export function display(text: string): string {
  return text
    .split(/([+−])/)
    .map((part) => {
      if (isOp(part)) return ` ${part} `;
      const [int = '', frac] = part.split(',');
      return groupDigits(int) + (frac !== undefined ? `,${frac}` : '');
    })
    .join('');
}

/** What goes as `expression` (and is kept for S09): the canonical form of a sum of more than one number. */
export function storedExpression(text: string): string | null {
  const e = evaluate(text);
  return e.ok && e.terms > 1 ? e.canonical : null;
}
