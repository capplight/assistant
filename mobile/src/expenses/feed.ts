import type { ExpenseCategoryOut, ExpenseOut } from '@/api/types';

import { addDays, aggregate, inPeriod, sumOf, toMinor, TRANSFERS_KEY, type CalcRow, type Period, type Total } from './calc';
import { categoryByKey, categoryTitle } from './categories';
import { shownExpense, type ExpenseEdit } from './store';

/**
 * What «Расходы» shows, as plain data (template-screens 2.2): the board of a period, the bars by
 * category and the receipt-like feed by day. Pure, and always through `calc.aggregate`, so the
 * screen, the tests and the server count the same way.
 */

const MONTHS = {
  ru: ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'],
  ru_of: ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'],
  // KK: drafts.
  kk: ['Қаңтар', 'Ақпан', 'Наурыз', 'Сәуір', 'Мамыр', 'Маусым', 'Шілде', 'Тамыз', 'Қыркүйек', 'Қазан', 'Қараша', 'Желтоқсан'],
};

const ymd = (date: string) => date.split('-').map(Number) as [number, number, number];

/** «9 ноября» / «9 қараша». */
export function dayName(date: string, lang: string): string {
  const [, m, d] = ymd(date);
  return lang === 'kk' ? `${d} ${MONTHS.kk[m - 1]!.toLowerCase()}` : `${d} ${MONTHS.ru_of[m - 1]}`;
}

/** «Сегодня», «Вчера», else the date. */
export function dayLabel(date: string, today: string, lang: string, t: (k: string) => string): string {
  if (date === today) return t('exp.day_today');
  if (date === addDays(today, -1)) return t('exp.day_yesterday');
  return dayName(date, lang);
}

/** The board's title: «Ноябрь 2026», «2026», «3 – 9 ноября». */
export function periodTitle(p: Period, lang: string): string {
  if (!p.from || !p.to) return '';
  const [y, m] = ymd(p.from);
  if (p.kind === 'year') return String(y);
  if (p.kind === 'month') return `${(lang === 'kk' ? MONTHS.kk : MONTHS.ru)[m - 1]} ${y}`;
  const from = ymd(p.to)[1] === m ? String(ymd(p.from)[2]) : dayName(p.from, lang);
  return `${from} – ${dayName(p.to, lang)}`;
}

/** What the person sees of the entries: their changes on top; trashed ones (or with a trashed record) gone. */
export function liveEntries(
  entries: Record<string, ExpenseOut>,
  edits: Record<string, ExpenseEdit>,
  deadItems: ReadonlySet<string> = new Set(),
): ExpenseOut[] {
  return Object.values(entries)
    .map((e) => shownExpense(e, edits))
    .filter((e) => !e.deleted_at && !(e.item_id && deadItems.has(e.item_id)));
}

/** An entry as `calc` sees it (the server's `Row`). */
export function calcRow(e: ExpenseOut, server: Record<string, ExpenseCategoryOut> = {}): CalcRow {
  const cat = e.category_key ? server[e.category_key] : undefined;
  return {
    id: e.id,
    amount: e.amount,
    currency: e.currency,
    direction: e.direction,
    spent_on: e.spent_on,
    category: e.category_key,
    service: cat?.service === true || e.category_key === TRANSFERS_KEY,
    payee: e.payee,
    method: e.method,
    review: e.review_fields.includes('amount'),
    deleted: !!e.deleted_at,
  };
}

export type Board = {
  /** The main line: KZT, or the only currency there is; null when nothing counts in the period. */
  main: Total | null;
  /** Other currencies, never added to the main one. */
  apart: Total[];
  review: number;
  /** «По категориям» of the main currency. */
  groups: { key: string | null; total: bigint }[];
};

export function board(entries: readonly ExpenseOut[], period: Pick<Period, 'from' | 'to'>, server: Record<string, ExpenseCategoryOut> = {}): Board {
  const rows = entries.filter((e) => inPeriod(e.spent_on, period)).map((e) => calcRow(e, server));
  const a = aggregate(rows, 'category');
  const main = a.totals.find((t) => t.currency === 'KZT') ?? a.totals[0] ?? null;
  return {
    main,
    apart: a.totals.filter((t) => t !== main && (t.count > 0 || t.income > 0n)),
    review: a.review_count,
    groups: main ? a.groups.filter((g) => g.currency === main.currency).map((g) => ({ key: g.key, total: g.total })) : [],
  };
}

export type Bar = { key: string | null; title: string; minor: bigint; share: number };

/** The bars: biggest first (the server's group order), the share for the bar; the number is always shown too. */
export function bars(b: Board, server: Record<string, ExpenseCategoryOut>, lang: string, noCategory: string): Bar[] {
  const spent = b.main?.total ?? 0n;
  if (spent <= 0n) return [];
  return b.groups
    .filter((g) => g.total > 0n)
    .map((g) => {
      const c = categoryByKey(server, g.key);
      return { key: g.key, title: c ? categoryTitle(c, lang) : noCategory, minor: g.total, share: Number((g.total * 1000n) / spent) / 10 };
    });
}

export type FeedDay = { date: string; entries: ExpenseOut[]; total: bigint };

/** The feed of a period: newest day first, newest entry first inside a day, «Итого за день» in KZT. */
export function feed(
  entries: readonly ExpenseOut[],
  period: Pick<Period, 'from' | 'to'>,
  o: { onlyToCheck?: boolean; server?: Record<string, ExpenseCategoryOut> } = {},
): FeedDay[] {
  const days = new Map<string, ExpenseOut[]>();
  for (const e of entries) {
    if (!inPeriod(e.spent_on, period)) continue;
    if (o.onlyToCheck && !e.review_fields.includes('amount')) continue;
    const list = days.get(e.spent_on) ?? [];
    list.push(e);
    days.set(e.spent_on, list);
  }
  return [...days.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([date, list]) => {
      const sorted = [...list].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
      return { date, entries: sorted, total: sumOf(sorted.map((e) => calcRow(e, o.server))) };
    });
}

/** The line title (expenses.md): `note` → `payee` → the category's title. */
export function lineTitle(e: ExpenseOut, server: Record<string, ExpenseCategoryOut>, lang: string, noCategory: string): string {
  const note = e.note?.trim();
  if (note) return note.charAt(0).toUpperCase() + note.slice(1);
  if (e.payee?.trim()) return e.payee.trim();
  const c = categoryByKey(server, e.category_key);
  return c ? categoryTitle(c, lang) : noCategory;
}

/** An amount for a screen reader: digits without groups («5000 тенге»), so it is read as one number. */
export function spokenAmount(amount: string, currency: string): string {
  const minor = toMinor(amount) ?? 0n;
  const abs = minor < 0n ? -minor : minor;
  const frac = abs % 100n;
  const unit = currency === 'KZT' ? 'тенге' : currency;
  return `${minor < 0n ? '−' : ''}${abs / 100n}${frac ? `,${String(frac).padStart(2, '0')}` : ''} ${unit}`;
}
