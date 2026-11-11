import vectors from './fixtures/kp-calc.json';

import { minorToDecimal } from '@/expenses/calc';
import { computeTotals, KpCalcError, priceText, qtyText } from '@/kp/calc';

/**
 * Week 14: the phone's КП totals equal the server's. `fixtures/kp-calc.json` was written by the
 * server's own `src/assistant/kp/calc.py` — v1's 608 seeded synthetic sets, and since week 15
 * (kp-calc.v2) 221 more with lump-sum lines (`kind: "lump"`: the given amount, «Объём» as text).
 * Every total, VAT, discount and line amount must match to the tiyn.
 */

type Case = {
  lines: { id: string; qty: string; unit_price: string | null; discount_pct: string; kind?: 'qty' | 'lump'; volume?: string }[];
  vat_mode: 'included' | 'on_top' | 'none';
  vat_rate: string | null;
  rounding: 'on_total' | 'per_line';
  discount_total_pct: string;
  expect?: {
    lines_sum: string;
    discount_total: string;
    amount: string;
    net: string;
    vat: string;
    total: string;
    priced: number;
    missing: number;
    complete: boolean;
    lines: { id: string; amount: string | null }[];
  };
  error?: string;
};

const cases = (vectors as { cases: Case[] }).cases;
const d = (m: bigint) => minorToDecimal(m);

describe('КП calc = server kp/calc.py', () => {
  it(`all ${cases.length} vectors`, () => {
    expect(cases.length).toBeGreaterThan(800);
    expect(cases.some((c) => c.lines.some((l) => l.kind === 'lump'))).toBe(true);
    for (const c of cases) {
      const run = () =>
        computeTotals(c.lines, { vatMode: c.vat_mode, vatRate: c.vat_rate, rounding: c.rounding, discountTotalPct: c.discount_total_pct });
      if (c.error) {
        expect(run).toThrow(KpCalcError);
        continue;
      }
      const t = run();
      const e = c.expect!;
      expect({
        lines_sum: d(t.linesSum),
        discount_total: d(t.discountTotal),
        amount: d(t.amount),
        net: d(t.net),
        vat: d(t.vat),
        total: d(t.total),
        priced: t.priced,
        missing: t.missing,
        complete: t.complete,
        lines: t.lines.map((l) => ({ id: l.id, amount: l.amount === null ? null : d(l.amount) })),
      }).toEqual(e);
    }
  });

  it('a missing price is never guessed: no amount, not complete', () => {
    const t = computeTotals([{ id: 'a', qty: '4', unit_price: null }], { vatMode: 'included', vatRate: '16' });
    expect(t.lines[0]!.amount).toBeNull();
    expect(t.total).toBe(0n);
    expect(t.complete).toBe(false);
  });

  it('typed numbers', () => {
    expect(priceText('18 500')).toBe('18500.00');
    expect(priceText('427,5')).toBe('427.50');
    expect(priceText('0,005')).toBe('0.01');
    expect(priceText('abc')).toBeNull();
    expect(qtyText('2,5')).toBe('2.5');
    expect(qtyText('500')).toBe('500');
    expect(qtyText('0')).toBeNull();
    expect(qtyText('1,2345')).toBeNull();
  });
});
