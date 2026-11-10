import type { DealStatus, KpDataOut, KpItemOut, KpTotalsOut, KpVersionOut } from '@/api/types';
import { formatMinor } from '@/expenses/calc';

import { computeTotals, decToMinor, showQty, type KpTotals, type LineTotal } from './calc';

/**
 * Week 14: what the КП screens show. The label under every price comes from its `price_source`
 * (kp.md): the server's `price_label` («из прайса», «из КП ТОО Арман, 3 окт», «укажите цену»); a
 * price the person typed says «вы указали» (never «цену поставил я»).
 *
 * Totals: the server's `totals` as given while the phone holds no unsent change (kp.md: the phone
 * does not add them up itself). While a tap-edit waits (offline, «Без ИИ»), the same rules run here
 * (`calc.ts`, the port checked against `kp/calc.py`) so the person sees the new total at once.
 */

type T = (k: string, o?: Record<string, unknown>) => string;

export type SourceKind = 'price_list' | 'past_kp' | 'manual' | 'missing';

export function sourceKind(ps: string): SourceKind {
  if (ps.startsWith('price_list')) return 'price_list';
  if (ps.startsWith('past_kp')) return 'past_kp';
  if (ps === 'manual') return 'manual';
  return 'missing';
}

/** The words under a price; `check`: «та ли позиция?» (a similar position the model picked). */
export function priceLabel(it: KpItemOut, t: T): { text: string; check: boolean; kind: SourceKind } {
  const kind = it.unit_price === null ? 'missing' : sourceKind(it.price_source);
  if (kind === 'missing') return { text: t('kp.src_missing'), check: false, kind };
  if (kind === 'manual') return { text: t('kp.src_manual'), check: false, kind };
  if (it.price_review) {
    return { text: it.price_label || t('kp.src_list_named', { name: it.matched_name ?? '' }), check: true, kind };
  }
  return { text: it.price_label || t(kind === 'price_list' ? 'kp.src_list' : 'kp.src_past'), check: false, kind };
}

export const money = (minor: bigint) => formatMinor(minor);
/** «427,5» → «427,50 ₸»; a price as the person reads it. */
export const priceMoney = (p: string | null) => (p === null ? '' : formatMinor(decToMinor(p) ?? 0n));
export const qtyShown = (q: string | null) => showQty(q) || '1';

const m = (s: string | null | undefined) => (s ? decToMinor(s) : null);

/** The server's `totals` in the phone's shape (tiyn). */
function fromServer(t: KpTotalsOut, items: KpItemOut[]): KpTotals {
  const lines: LineTotal[] = items.map((it) => ({ id: it.id, gross: null, discount: null, amount: m(it.amount), vat: null }));
  return {
    lines,
    linesSum: m(t.lines_sum) ?? 0n,
    discountTotal: m(t.discount_total) ?? 0n,
    amount: m(t.amount) ?? 0n,
    net: m(t.net) ?? 0n,
    vat: m(t.vat) ?? 0n,
    total: m(t.total) ?? 0n,
    priced: t.priced,
    missing: t.missing,
    complete: t.complete,
  };
}

export type KpView = {
  data: KpDataOut;
  /** null when a number in the data is not valid (the server would refuse it too). */
  totals: KpTotals | null;
  /** `server`: the server's totals; `phone`: counted here while a change waits. */
  counted: 'server' | 'phone';
  counts: Record<SourceKind, number>;
  vatRate: string | null;
};

export function kpView(data: KpDataOut, version: KpVersionOut | null | undefined, edited: boolean): KpView {
  const vatRate = data.vat.rate ?? version?.totals?.vat_rate ?? null;
  let totals: KpTotals | null = null;
  let counted: KpView['counted'] = 'phone';
  if (!edited && version?.totals) {
    totals = fromServer(version.totals, data.items);
    counted = 'server';
  } else {
    try {
      totals = computeTotals(
        data.items.map((i) => ({ id: i.id, qty: i.qty ?? '1', unit_price: i.unit_price, discount_pct: i.discount_pct })),
        { vatMode: data.vat.mode, vatRate, rounding: data.vat.rounding, discountTotalPct: data.discount_total_pct },
      );
    } catch {
      totals = null;
    }
  }
  const counts: Record<SourceKind, number> = { price_list: 0, past_kp: 0, manual: 0, missing: 0 };
  for (const it of data.items) counts[it.unit_price === null ? 'missing' : sourceKind(it.price_source)] += 1;
  return { data, totals, counted, counts, vatRate };
}

/** «16%» without trailing zeros: «16.00» → «16», «12.50» → «12,5». */
export const rateText = (r: string | null) => (r ? (r.includes('.') ? r.replace(/0+$/, '').replace(/\.$/, '') : r).replace('.', ',') : '0');

export function vatText(mode: KpDataOut['vat']['mode'], rate: string | null, t: T): string {
  if (mode === 'none') return t('kp.vat_none');
  if (!rate) return t(`kp.vat_mode_${mode}`);
  return t(mode === 'included' ? 'kp.vat_included' : 'kp.vat_on_top', { rate: rateText(rate) });
}

/** The title of a КП on its card: «КП № 17» or its own title. */
export function kpTitle(doc: { number: string | null; title: string | null }, t: T): string {
  const number = doc.number?.replace(/^КП[-\s№]*(\d{4}-)?0*/i, '') ?? '';
  return number ? t('kp.kp_number', { number }) : doc.title ?? t('kp.kp_plain');
}

/** «3 ноя» — a short day on the card. */
export function shortDate(iso: string | null, lang: string): string {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(lang === 'kk' ? 'kk-KZ' : 'ru-RU', { day: 'numeric', month: 'short' }).replace('.', '');
}

/** The status strip: Черновик · Отправлено · Видел · Принято; the steps that are done. */
export type Step = 'draft' | 'sent' | 'seen' | 'accepted';
export const STEPS: Step[] = ['draft', 'sent', 'seen', 'accepted'];

export function stepsDone(deal: DealStatus): Set<Step> {
  const done = new Set<Step>(['draft']);
  if (deal !== 'draft') done.add('sent');
  if (deal === 'seen' || deal === 'accepted' || deal === 'declined') done.add('seen');
  if (deal === 'accepted') done.add('accepted');
  return done;
}

/** The step's word as shown now; «Не принято» for `declined`. */
export const statusWord = (deal: DealStatus, t: T) => t(`kp.step_${deal}`);
