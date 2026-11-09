import fs from 'fs';
import path from 'path';

import { fireEvent, renderRouter, screen, within } from 'expo-router/testing-library';
import { Dimensions } from 'react-native';

import { expenseCategoryOut, expenseOut, expensesOf, taskOut } from '@/api/endpoints';
import type { ExpenseCategoryOut, ExpenseOut } from '@/api/types';
import { resolveView } from '@/components/page/registry';
import type { InMemoryOutboxRepository } from '@/db';
import { aggregate, formatAmount, minorToDecimal, periodOf, toMinor, type CalcRow, type Period } from '@/expenses/calc';
import { chipCategories, orderedCategories } from '@/expenses/categories';
import { evaluate, press, storedExpression, type Key } from '@/expenses/expression';
import { board, feed } from '@/expenses/feed';
import { applyServer } from '@/expenses/service';
import { useExpenses } from '@/expenses/store';
import { getSyncEngine } from '@/services';
import { usePages } from '@/store/pages';
import { useUndo } from '@/store/undo';
import { changeTask, shownTask } from '@/tasks/edit';
import { localDate } from '@/tasks/rows';
import { taskSink } from '@/tasks/service';
import { useTasks } from '@/tasks/store';
import { happyServer, itemOut, linkOut, type FakeServer, type SseEvent } from '@/testing/fakeServer';
import { APP_DIR, finishOnboarding, resetApp, settle, testPages, testRecords } from '@/testing/helpers';

/**
 * Week 12 «Расходы» (template-screens 2.2, docs/api/expenses.md, docs/spec/vectors/calc.json as of
 * 2026-11-09): the expense calculator. Fake server only: nothing here ran against the real server
 * or on a phone.
 */

type Vectors = {
  expressions: { expr: string; expect: string | { error: string }; canonical?: string }[];
  aggregates: {
    name: string;
    group_by: 'category' | 'month' | 'payee' | 'method' | null;
    rows: { id: string; amount: string; currency: string; direction: CalcRow['direction']; spent_on: string; category?: string; service?: boolean; review?: boolean; deleted?: boolean; method?: string; payee?: string }[];
    expect: {
      totals: { currency: string; total: string; expense: string; refund: string; income: string; count: number }[];
      groups: { key: string | null; currency: string; total: string; count: number }[];
      review_count: number;
      basis: string[];
    };
  }[];
  periods: { kind: Period['kind']; date: string; from: string | null; to: string | null }[];
  format: { amount: string; currency: string; text: string }[];
};

const vectors = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../docs/spec/vectors/calc.json'), 'utf8')) as Vectors;

const today = () => localDate(Date.now());
const iso = () => new Date().toISOString();

function expense(id: string, extra: Partial<ExpenseOut> = {}): ExpenseOut {
  return expenseOut({
    id,
    client_id: `c-${id}`,
    item_id: `srv-${id}`,
    amount: '1000.00',
    currency: 'KZT',
    spent_on: today(),
    category_key: 'groceries',
    category_id: 'cat-groceries',
    direction: 'expense',
    source: 'form',
    review_fields: [],
    version: 1,
    seq: 1,
    created_at: iso(),
    updated_at: iso(),
    deleted_at: null,
    ...extra,
  })!;
}

const KEYS = ['groceries', 'home', 'transport', 'health', 'family', 'cafe_gifts', 'utilities', 'other'];
function category(key: string, i: number, extra: Record<string, unknown> = {}): ExpenseCategoryOut {
  return expenseCategoryOut({ id: `cat-${key}`, key, title: key, title_kk: null, system: true, service: false, position: String.fromCharCode(97 + i), manual: false, pinned: false, hidden: false, version: 1, seq: 1, ...extra })!;
}
const serverCategories = () => [...KEYS.map((k, i) => category(k, i)), category('transfers', 9, { service: true })];

describe('calc.json vectors (the phone equals calc.py)', () => {
  it.each(vectors.expressions.map((v) => [v.expr, v] as const))('evaluate(%j)', (_e, v) => {
    const r = evaluate(v.expr);
    if (typeof v.expect === 'string') {
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(minorToDecimal(r.minor)).toBe(v.expect);
        expect(r.canonical).toBe(v.canonical);
      }
    } else {
      expect(r).toMatchObject({ ok: false, error: v.expect.error });
    }
  });

  it.each(vectors.aggregates.map((v) => [v.name, v] as const))('aggregate: %s', (_n, v) => {
    const rows: CalcRow[] = v.rows.map((r) => ({ ...r, category: r.category ?? null }));
    const a = aggregate(rows, v.group_by);
    expect(
      a.totals.map((x) => ({ currency: x.currency, total: minorToDecimal(x.total), expense: minorToDecimal(x.expense), refund: minorToDecimal(x.refund), income: minorToDecimal(x.income), count: x.count })),
    ).toEqual(v.expect.totals);
    expect(a.groups.map((g) => ({ key: g.key, currency: g.currency, total: minorToDecimal(g.total), count: g.count }))).toEqual(v.expect.groups);
    expect(a.review_count).toBe(v.expect.review_count);
    expect(a.basis).toEqual(v.expect.basis);
    expect(a.calc_version).toBe('calc.v1');
  });

  it.each(vectors.periods.map((v) => [v.kind, v.date, v] as const))('period %s of %s', (_k, _d, v) => {
    const p = periodOf(v.kind as 'week', v.date);
    expect({ from: p.from, to: p.to }).toEqual({ from: v.from, to: v.to });
  });

  it.each(vectors.format.map((v) => [v.amount, v.currency, v.text] as const))('format %s %s = %s', (amount, currency, text) => {
    expect(formatAmount(amount, currency)).toBe(text);
  });

  it('ROUND_HALF_UP to 0.01 when an amount has more places; never a float', () => {
    expect(toMinor('0.005')).toBe(1n);
    expect(toMinor('0.004')).toBe(0n);
    expect(toMinor('-0.005')).toBe(-1n);
    expect(toMinor('1 200,5')).toBe(120050n);
    expect(toMinor('1e5')).toBeNull();
    expect(expenseOut({ ...expense('x'), amount: 5000 })).toBeNull(); // money is text
  });

  it('1 000 random sets: Σ of rows = total, groups add up, the order of rows does not matter', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let n = 0; n < 1000; n++) {
      const rows: CalcRow[] = Array.from({ length: 1 + Math.floor(rnd() * 20) }, (_, i) => ({
        id: `r${i}`,
        amount: `${Math.floor(rnd() * 1e7)}.${String(Math.floor(rnd() * 100)).padStart(2, '0')}`,
        currency: rnd() < 0.1 ? 'USD' : 'KZT',
        direction: rnd() < 0.15 ? 'refund' : 'expense',
        spent_on: '2026-11-09',
        category: rnd() < 0.2 ? null : KEYS[Math.floor(rnd() * 8)]!,
      }));
      const a = aggregate(rows, 'category');
      for (const t of a.totals) {
        const mine = rows.filter((r) => r.currency === t.currency);
        const sum = mine.reduce((s, r) => s + (r.direction === 'refund' ? -1n : 1n) * toMinor(r.amount)!, 0n);
        expect(t.total).toBe(sum);
        expect(a.groups.filter((g) => g.currency === t.currency).reduce((s, g) => s + g.total, 0n)).toBe(sum);
      }
      const back = aggregate([...rows].reverse(), 'category');
      expect(back.totals).toEqual(a.totals);
    }
  });
});

describe('keys, categories, contract', () => {
  const type = (keys: Key[]) => keys.reduce((s, k) => press(s, k), '');

  it('the keys build only sums code can read', () => {
    expect(type(['1', '2', '0', '0', '+', '3', '5', '0'])).toBe('1200+350');
    expect(type(['+', '5'])).toBe('5');
    expect(type(['5', '+', '−', '3'])).toBe('5−3');
    expect(type([',', '5', ',', '1', '2', '3'])).toBe('0,51');
    expect(type(['0', '0', '5'])).toBe('5');
    expect(type(['5', '000', ',', '000'])).toBe('5000,00');
    expect(type(['9', '9', '⌫'])).toBe('9');
    expect(storedExpression('1200+350')).toBe('1200+350');
    expect(storedExpression('5000')).toBeNull();
    expect(storedExpression('1200,50−200')).toBe('1200.5-200');
  });

  it('chips: 8 at once; by use until the person orders them; own after the 8; service never', () => {
    const local = chipCategories({});
    expect(local.map((c) => c.key)).toEqual(KEYS);
    const server = Object.fromEntries(serverCategories().map((c) => [c.key, c]));
    server['own:1'] = category('own:1', 20, { system: false, title: 'Одежда' });
    const chips = chipCategories(server);
    expect(chips.map((c) => c.key)).not.toContain('transfers');
    const used = [expense('a', { category_key: 'health' }), expense('b', { category_key: 'health' }), expense('c', { category_key: 'own:1' }), expense('d', { category_key: 'own:1' }), expense('e', { category_key: 'own:1' })];
    const byUse = orderedCategories(chips, used, today(), null).map((c) => c.key);
    expect(byUse[0]).toBe('health');
    expect(byUse.at(-1)).toBe('own:1');
    const manual = Object.fromEntries(Object.entries(server).map(([k, c]) => [k, { ...c, manual: true, position: k === 'other' ? '0' : c.position }]));
    expect(orderedCategories(chipCategories(manual), used, today(), null)[0]!.key).toBe('other');
    expect(orderedCategories(chips, used, today(), ['utilities'])[0]!.key).toBe('utilities');
  });

  it('decoders: expenses, categories, the tool is registered', () => {
    expect(expensesOf([expense('a'), { id: 'bad' }])).toHaveLength(1);
    expect(expenseCategoryOut({ id: 'x', key: 'transfers', title: 'Переводы' })!.service).toBe(true);
    resetApp();
    finishOnboarding('full');
    const page = usePages.getState().pages.find((p) => p.templateKey === 'expenses')!;
    expect(resolveView(page).key).toBe('expenses:builtin:expenses');
  });

  it('board and feed: KZT apart from other currencies, «Итого за день», «проверить»', () => {
    const list = [
      expense('a', { amount: '5000.00' }),
      expense('b', { amount: '48500.00', review_fields: ['amount'], category_key: 'home' }),
      expense('c', { amount: '120.00', currency: 'USD' }),
      expense('d', { amount: '500.00', direction: 'refund' }),
    ];
    const b = board(list, periodOf('month', today()));
    expect(minorToDecimal(b.main!.total)).toBe('53000.00');
    expect(b.apart.map((x) => x.currency)).toEqual(['USD']);
    expect(b.review).toBe(1);
    expect(b.groups[0]!.key).toBe('home');
    const days = feed(list, periodOf('month', today()));
    expect(days).toHaveLength(1);
    expect(minorToDecimal(days[0]!.total)).toBe('53000.00');
  });
});

// --- the screen ---

const CREATED = 'e1';

function action(id: string, summary: string) {
  return {
    id,
    kind: 'create_expense',
    scope: 'internal',
    initiated_by: 'user',
    summary: { ru: summary, kk: null },
    page: null,
    changes: [],
    changed_item_ids: [],
    created_page_id: null,
    undoable: true,
    undoable_until: iso(),
    undone_at: null,
    undo_of: null,
    message_id: null,
    seq: 10,
    created_at: iso(),
  };
}

function server(): FakeServer {
  const s = happyServer();
  s.on('GET /expense-categories', () => ({ status: 200, body: { order: 'frequency', categories: serverCategories() } }))
    .on('POST /expenses', (c) => {
      const b = c.body as { client_id: string; expression?: string; amount?: string; category_id: string | null; spent_on: string };
      const amount = b.amount ?? minorToDecimal((evaluate(b.expression!) as { minor: bigint }).minor);
      return {
        status: 201,
        body: {
          expense: expense('e1', { client_id: b.client_id, amount, expression: b.expression ?? null, spent_on: b.spent_on, category_id: b.category_id, category_key: 'groceries', seq: 20 }),
          action: action('a-create', `Записал ${amount}`),
          page_patches: [],
          repeated: false,
        },
      };
    })
    .on('PATCH /expenses/*', (c) => ({
      status: 200,
      body: { expense: expense('e1', { seq: 30, category_key: 'transport', category_id: 'cat-transport' }), action: action('a-edit', 'x'), repeated: false },
    }))
    .on('PATCH /expense-categories/reorder', () => ({ status: 200, body: { categories: [], action: action('a-order', 'x'), repeated: false } }))
    .on('POST /actions/*/undo', (c) => ({
      status: 200,
      body: { action: { ...action(c.path.split('/')[2]!, 'x'), undoable: false, undone_at: iso() }, undo: null, partial: false, repeated: false, message_ru: null, page_patches: [] },
    }))
    .on('GET /actions', () => ({ status: 200, body: { actions: [], has_more: false } }))
    .on('GET /page-templates', () => ({ status: 200, body: { templates: [] } }))
    .on('GET /collections', () => ({ status: 200, body: { collections: [] } }))
    .on('GET /duplicates/groups', () => ({ status: 200, body: { groups: [] } }));
  return s;
}

const expensesPage = () => usePages.getState().pages.find((p) => p.templateKey === 'expenses')!;
const stripText = () => {
  const st = useUndo.getState().strip;
  return st?.kind === 'custom' ? st.text : null;
};
const text = (id: string) => {
  const c = screen.getByTestId(id).props.children;
  return Array.isArray(c) ? c.join('') : String(c);
};

/** The record of an expense on the «Расходы» page (each expense has one, expenses.md). */
async function withPageRecord(id: string) {
  const local = expensesPage();
  const synced = { ...local, serverId: 'srv-expenses', syncState: 'synced' as const };
  usePages.setState((st) => ({ pages: st.pages.map((p) => (p.id === local.id ? synced : p)) }));
  await testPages.insertLocal(synced);
  await testRecords.applyRemote(itemOut(id, 50, { text: 'Трата', status: 'ready' }));
  await testPages.applyLink(linkOut('srv-expenses', `srv-${id}`, 60));
}

async function typeSum(keys: string[]) {
  for (const k of keys) await fireEvent.press(screen.getByTestId(`exp-keypad-${k}`));
}

afterEach(() => {
  Dimensions.set({ window: { width: 390, height: 844, scale: 3, fontScale: 1 }, screen: { width: 390, height: 844, scale: 3, fontScale: 1 } });
});

describe('«Расходы» — the calculator', () => {
  it('offline: «1200+350» → Продукты → Записать: total by code at once, the line, «Отменить» drops it', async () => {
    const outbox: InMemoryOutboxRepository = resetApp();
    finishOnboarding('full');
    await renderRouter(APP_DIR, { initialUrl: `/page/${expensesPage().id}` });
    await settle(() => screen.queryByTestId('exp-board') !== null);
    expect(screen.getByTestId('page-view-expenses:builtin:expenses')).toBeTruthy();
    for (const id of ['page-title', 'page-settings', 'page-find']) expect(screen.getByTestId(id)).toBeTruthy();
    expect(text('exp-total')).toBe('0 ₸');
    expect(screen.getByTestId('exp-empty-total')).toBeTruthy();
    // Empty: the keys are open, with the hint.
    expect(screen.getByTestId('exp-or-say')).toBeTruthy();
    await typeSum(['1', '2', '0', '0', 'plus', '3', '5', '0']);
    expect(text('exp-sum-text')).toBe('1 200 + 350 ₸');
    expect(text('exp-sum-total')).toBe('= 1 550 ₸');
    expect(screen.getByTestId('exp-sum').props.accessibilityLabel).toBe('Сумма: 1200 плюс 350, всего 1 550 ₸');
    expect(screen.getByTestId('exp-keypad-plus').props.accessibilityLabel).toBe('плюс');
    await fireEvent.press(screen.getByTestId('exp-cat-groceries'));
    await fireEvent.press(screen.getByTestId('exp-keypad-save'));
    await settle(() => text('exp-total') === '1 550 ₸');
    expect(stripText()).toBe('Записал 1 550 ₸ · Продукты');
    const row = outbox.all().find((r) => r.kind === 'expense.create')!;
    expect(row.payload).toMatchObject({ body: { expression: '1200+350', category_id: null, source: 'form' }, categoryKey: 'groceries' });
    expect(text('exp-count')).toBe('1 трата');
    expect(screen.getByTestId(`exp-day-total-${today()}`)).toBeTruthy();
    expect(screen.getByTestId('exp-bar-groceries')).toBeTruthy();
    const key = Object.keys(useExpenses.getState().entries)[0]!;
    expect(screen.getByTestId(`exp-row-${key}`)).toBeTruthy();
    expect(within(screen.getByTestId(`exp-row-${key}`)).getByText('Продукты · Ждёт связи')).toBeTruthy();
    // «Отменить» while it waits: nothing goes, the total is back.
    await fireEvent.press(screen.getByTestId('undo-strip-undo'));
    await settle(() => text('exp-total') === '0 ₸');
    expect(outbox.all().find((r) => r.kind === 'expense.create')!.status).toBe('failed');
  });

  it('«Без ИИ»: the keys and a change of category work, each with «Отменить»', async () => {
    const outbox = resetApp();
    finishOnboarding('no_ai');
    applyServer([expense('e9', { amount: '5000.00', note: 'бензин', category_key: 'groceries' })], serverCategories());
    await renderRouter(APP_DIR, { initialUrl: `/page/${expensesPage().id}` });
    await settle(() => screen.queryByTestId('exp-row-e9') !== null);
    expect(screen.getByTestId('exp-row-label-e9').props.accessibilityLabel).toBe('Трата. 5000 тенге. Бензин. groceries. Сегодня');
    await fireEvent.press(screen.getByTestId('exp-row-menu-e9'));
    await settle(() => screen.queryByTestId('exp-sheet') !== null);
    await fireEvent.press(screen.getByTestId('exp-sheet-cat-transport'));
    await settle(() => outbox.all().some((r) => r.kind === 'expense.patch'));
    expect(stripText()).toBe('Бензин → transport');
    expect(useExpenses.getState().edits.e9!.fields).toMatchObject({ category_key: 'transport', category_id: 'cat-transport' });
    await fireEvent.press(screen.getByTestId('undo-strip-undo'));
    await settle(() => !useExpenses.getState().edits.e9);
  });

  it('online: POST /expenses with the person\'s category id; «Отменить» = the undo of its action', async () => {
    const s = server();
    resetApp({ fetch: s.fetch });
    finishOnboarding('full');
    await (await getSyncEngine()).run();
    await renderRouter(APP_DIR, { initialUrl: `/page/${expensesPage().id}` });
    await settle(() => screen.queryByTestId('exp-board') !== null);
    await typeSum(['5', '000']);
    await fireEvent.press(screen.getByTestId('exp-cat-groceries'));
    await fireEvent.press(screen.getByTestId('exp-keypad-save'));
    await settle(() => s.callsTo('POST /expenses').length === 1 && !!useExpenses.getState().entries[CREATED]);
    expect(s.callsTo('POST /expenses')[0]!.body).toMatchObject({ amount: '5000.00', category_id: 'cat-groceries', currency: 'KZT' });
    expect(text('exp-total')).toBe('5 000 ₸');
    await fireEvent.press(screen.getByTestId('undo-strip-undo'));
    await settle(() => s.callsTo('POST /actions/a-create/undo').length === 1);
    await settle(() => text('exp-total') === '0 ₸');
  });

  it('US-31: «потратил 5000 на бензин» from the line → the month total by code', async () => {
    const s = server();
    const seqd = (events: Omit<SseEvent, 'id'>[]): SseEvent[] => events.map((e, i) => ({ ...e, id: i + 1 }));
    const saved = expense('e5', { amount: '5000.00', note: 'бензин', category_key: 'transport', source: 'typed', parse_source: 'llm', seq: 40 });
    s.on('POST /chat/messages', () => ({
      status: 200,
      sse: seqd([
        { event: 'accepted', data: { message_id: 'u1', reply_id: 'r1', created_at: iso() } },
        { event: 'action', data: { reply_id: 'r1', action: action('a-chat', 'Записал 5 000 ₸ · Транспорт'), changed_item_ids: [], expenses: [saved] } },
        { event: 'done', data: { reply_id: 'r1', state: 'done', answer_kind: 'action', action_id: 'a-chat', delivery: 'streamed', limited: false } },
      ]),
    }));
    resetApp({ fetch: s.fetch });
    finishOnboarding('full');
    applyServer([expense('old', { amount: '1200.50' })], serverCategories());
    await (await getSyncEngine()).run();
    await renderRouter(APP_DIR, { initialUrl: `/page/${expensesPage().id}` });
    await settle(() => text('exp-total') === '1 200,50 ₸');
    await fireEvent.changeText(screen.getByTestId('assistant-input'), 'потратил 5000 на бензин');
    await fireEvent.press(screen.getByTestId('assistant-send'));
    await settle(() => text('exp-total') === '6 200,50 ₸');
    expect(screen.getByTestId('exp-row-e5')).toBeTruthy();
    expect(text('exp-count')).toBe('2 траты');
  });

  it('/sync: `expenses` and `expense_categories`; a trashed one is in no total; tombstone `expense`', async () => {
    const s = server();
    let purged = false;
    s.on('GET /sync', () => {
      return {
        status: 200,
        body:
          !purged
            ? { expenses: [expense('s1', { amount: '700.00', seq: 5 }), expense('s2', { amount: '300.00', seq: 6, deleted_at: iso() })], expense_categories: serverCategories(), tombstones: [], next_since: 6, has_more: false }
            : { expenses: [], tombstones: [{ entity: 'expense', id: 's1' }], next_since: 7, has_more: false },
      };
    });
    resetApp({ fetch: s.fetch });
    finishOnboarding('full');
    await (await getSyncEngine()).run();
    expect(useExpenses.getState().categories.transport!.id).toBe('cat-transport');
    const b = board(Object.values(useExpenses.getState().entries).filter((e) => !e.deleted_at), periodOf('month', today()));
    expect(minorToDecimal(b.main!.total)).toBe('700.00');
    purged = true;
    await (await getSyncEngine()).run();
    expect(useExpenses.getState().entries.s1).toBeUndefined();
  });

  it('«Порядок»: ↑ on a chip → PATCH /expense-categories/reorder with ids; the chips follow at once', async () => {
    const s = server();
    const outbox = resetApp({ fetch: s.fetch });
    finishOnboarding('full');
    applyServer([expense('e1', { amount: '10.00' })], serverCategories());
    await (await getSyncEngine()).run();
    await withPageRecord('e1');
    await renderRouter(APP_DIR, { initialUrl: `/page/${expensesPage().id}` });
    await settle(() => screen.queryByTestId('exp-row-e1') !== null);
    await fireEvent.press(screen.getByTestId('page-order'));
    await settle(() => screen.queryByTestId('exp-cat-order') !== null);
    await fireEvent.press(screen.getByTestId('exp-order-up-home'));
    await settle(() => s.callsTo('PATCH /expense-categories/reorder').length === 1);
    const ids = (s.callsTo('PATCH /expense-categories/reorder')[0]!.body as { ids: string[] }).ids;
    expect(ids.indexOf('cat-home')).toBeLessThan(ids.indexOf('cat-groceries'));
    expect(stripText()).toBe('Переставил категории');
    expect(outbox.all().find((r) => r.kind === 'expense.categories')!.payload).toMatchObject({ before: null });
  });

  it('«Верно» sends `confirm: ["amount"]`', async () => {
    const s = server();
    resetApp({ fetch: s.fetch });
    finishOnboarding('full');
    applyServer([expense('e1', { amount: '48500.00', review_fields: ['amount'], source: 'voice' })], serverCategories());
    await (await getSyncEngine()).run();
    await renderRouter(APP_DIR, { initialUrl: `/page/${expensesPage().id}` });
    await settle(() => screen.queryByTestId('exp-to-check') !== null);
    expect(screen.getByTestId('exp-row-label-e1').props.accessibilityLabel).toMatch(/проверьте сумму/);
    await fireEvent.press(screen.getByTestId('exp-row-menu-e1'));
    await settle(() => screen.queryByTestId('exp-sheet-verify') !== null);
    await fireEvent.press(screen.getByTestId('exp-sheet-verify'));
    await settle(() => s.callsTo('PATCH /expenses/e1').length === 1);
    expect(s.callsTo('PATCH /expenses/e1')[0]!.body).toMatchObject({ confirm: ['amount'], version: 1 });
  });

  it('200%: «Ввести трату» opens the keys on the whole screen; the chips are one column', async () => {
    Dimensions.set({ window: { width: 390, height: 844, scale: 3, fontScale: 2 }, screen: { width: 390, height: 844, scale: 3, fontScale: 2 } });
    resetApp();
    finishOnboarding('full');
    await renderRouter(APP_DIR, { initialUrl: `/page/${expensesPage().id}` });
    await settle(() => screen.queryByTestId('exp-enter') !== null);
    expect(screen.queryByTestId('exp-keypad')).toBeNull();
    await fireEvent.press(screen.getByTestId('exp-enter'));
    await settle(() => screen.queryByTestId('exp-full-entry') !== null);
    expect(screen.getByTestId('exp-total').props.maxFontSizeMultiplier).toBe(1.6);
    const group = screen.getByTestId('exp-cat-group');
    const style = Array.isArray(group.props.style) ? Object.assign({}, ...group.props.style) : group.props.style;
    expect(style.flexDirection).toBe('column');
    await typeSum(['7']);
    await fireEvent.press(screen.getByTestId('exp-keypad-save'));
    await settle(() => text('exp-total') === '7 ₸');
    expect(screen.queryByTestId('exp-full-entry')).toBeNull();
  });
});

describe('«Покупки» «− +»: PATCH /tasks with `client_id`, «Отменить» = the server action undo', () => {
  it('sent → POST /actions/{id}/undo; the old count shows at once', async () => {
    const s = server();
    s.on('PATCH /tasks/t1', () => ({
      status: 200,
      body: { task: taskOut({ id: 't1', list_key: 'shopping', title: 'Хлеб', qty: '2', version: 4, seq: 9 }), action: action('a-qty', 'Хлеб: 2'), repeated: false },
    }));
    resetApp({ fetch: s.fetch });
    finishOnboarding('full');
    await (await getSyncEngine()).run();
    taskSink.applyServer([taskOut({ id: 't1', list_key: 'shopping', title: 'Хлеб', qty: null, version: 3, seq: 1 })!]);
    await changeTask('t1', { qty: '2' }, 'Хлеб: 2');
    await settle(() => s.callsTo('PATCH /tasks/t1').length === 1);
    await (await getSyncEngine()).whenIdle();
    expect(s.callsTo('PATCH /tasks/t1')[0]!.body).toMatchObject({ version: 3, qty: '2', client_id: expect.any(String) });
    const strip = useUndo.getState().strip;
    if (strip?.kind === 'custom') strip.onUndo();
    await settle(() => s.callsTo('POST /actions/a-qty/undo').length === 1);
    expect(s.callsTo('PATCH /tasks/t1')).toHaveLength(1);
    expect(shownTask(useTasks.getState().tasks.t1!, useTasks.getState().edits).qty).toBeNull();
  });
});
