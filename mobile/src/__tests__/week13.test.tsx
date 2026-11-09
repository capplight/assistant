import { act, fireEvent, renderRouter, screen } from 'expo-router/testing-library';
import { Dimensions, Pressable } from 'react-native';

import {
  expenseCategoryOut,
  expenseDuplicateOut,
  expenseOut,
  receiptOut,
  statementOut,
  statementRowOut,
} from '@/api/endpoints';
import type { ExpenseCategoryOut, ExpenseOut, StatementRowOut } from '@/api/types';
import { setQrCameraForTests } from '@/components/page/QrCamera';
import type { InMemoryOutboxRepository } from '@/db';
import { formatMinor, minorToDecimal, periodOf, toMinor } from '@/expenses/calc';
import { board, liveEntries, planTitle } from '@/expenses/feed';
import { setMediaForTests, type MediaPort, type Permission } from '@/expenses/media';
import { countRows, planNumbers, qrLink, qrPreview, readAsStatement } from '@/expenses/receipts';
import { applyServer } from '@/expenses/service';
import { useExpenses } from '@/expenses/store';
import i18n from '@/i18n';
import { getCapture, getSyncEngine, kickSync } from '@/services';
import { askFor, useShareAsk } from '@/share/ask';
import { usePages } from '@/store/pages';
import { useToast } from '@/store/toast';
import { useUndo } from '@/store/undo';
import { localDate } from '@/tasks/rows';
import { happyServer, type FakeServer } from '@/testing/fakeServer';
import { APP_DIR, finishOnboarding, resetApp, settle } from '@/testing/helpers';

/**
 * Week 13 «Расходы 2» (docs/api/expenses.md «Week 13» and routes/expense_docs.py as of 2026-11-09
 * 20:30): receipt photo, fiscal QR, a shared statement → plan → one «Да» → one «Отменить»,
 * «Проверьте сумму», «Объединить?». Synthetic data only (no real bank data). Fake server only:
 * nothing here ran against the real server or on a phone.
 */

const iso = () => new Date().toISOString();
const today = () => localDate(Date.now());

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
const category = (key: string, i: number, extra: Record<string, unknown> = {}): ExpenseCategoryOut =>
  expenseCategoryOut({ id: `cat-${key}`, key, title: key, system: true, position: String.fromCharCode(97 + i), version: 1, seq: 1, ...extra })!;
const serverCategories = () => [...KEYS.map((k, i) => category(k, i)), category('transfers', 9, { service: true })];

function action(id: string, kind: string, summary: string) {
  return {
    id,
    kind,
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

// --- a synthetic Kaspi Gold month (October 2026): 86 operations, 4 already typed by hand ---

type Op = { n: number; date: string; tiyn: bigint; kind: string; direction: ExpenseOut['direction']; category: string | null; description: string };

function october(): Op[] {
  const ops: Op[] = [];
  let seed = 13;
  const rnd = (max: number) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed % max;
  };
  const day = (n: number) => `2026-10-${String(1 + (n % 31)).padStart(2, '0')}`;
  for (let n = 1; n <= 86; n++) {
    const tiyn = BigInt(100 + rnd(4_000_000)); // 1,00 … 40 000,99 ₸, with tiyn
    if (n <= 68) ops.push({ n, date: day(n), tiyn, kind: 'purchase', direction: 'expense', category: null, description: `SHOP ${n}` });
    else if (n <= 72) ops.push({ n, date: day(n), tiyn, kind: 'transfer', direction: 'expense', category: 'transfers', description: `Перевод ${n}` });
    else if (n <= 75) ops.push({ n, date: day(n), tiyn, kind: 'withdrawal', direction: 'transfer_own', category: null, description: 'Снятие' });
    else if (n <= 79) ops.push({ n, date: day(n), tiyn, kind: 'topup', direction: 'income', category: null, description: 'Пополнение' });
    else if (n <= 81) ops.push({ n, date: day(n), tiyn: tiyn / 10n, kind: 'refund', direction: 'refund', category: null, description: `Возврат ${n}` });
    else ops.push({ n, date: day(n), tiyn: 199n + BigInt(n), kind: 'fee', direction: 'expense', category: null, description: 'Комиссия банка' });
  }
  return ops;
}

const OPS = october();
/** Rows 1–4 are already on the phone (typed by hand), row 5 looks like a receipt already there. */
const EXISTING = new Set([1, 2, 3, 4]);
const SIMILAR = 5;
const money = (tiyn: bigint) => minorToDecimal(tiyn);

/** What the bank's own summary says (a separate count, by kind, in tiyn). */
function bankSummary(ops: Op[]) {
  const by = (k: string) => ops.filter((o) => o.kind === k).reduce((s, o) => s + o.tiyn, 0n);
  return { purchases: by('purchase'), fees: by('fee'), refunds: by('refund'), transfers: by('transfer'), withdrawals: by('withdrawal'), topups: by('topup') };
}

function rowsJson(ops: Op[]) {
  return ops.map((o) => ({
    n: o.n,
    date: o.date,
    amount: money(o.tiyn),
    currency: 'KZT',
    sign: o.direction === 'income' || o.direction === 'refund' ? '+' : '-',
    kind: o.kind,
    direction: o.direction,
    description: o.description,
    method: o.kind === 'withdrawal' ? 'cash' : 'kaspi',
    category_key: o.category,
    note: null,
    state: EXISTING.has(o.n) ? 'existing' : o.n === SIMILAR ? 'similar' : 'new',
    existing_expense_id: EXISTING.has(o.n) ? `hand-${o.n}` : o.n === SIMILAR ? 'rcpt-5' : null,
    review_fields: [],
  }));
}

/** The server's `_adds` (imports.py), counted here in tiyn the way the server does. */
function addsOf(ops: Op[]) {
  const out = { expense: 0n, refund: 0n, income: 0n, transfers: 0n, transfer_own: 0n };
  for (const o of ops) {
    if (EXISTING.has(o.n)) continue;
    if (o.category === 'transfers') out.transfers += o.tiyn;
    else out[o.direction] += o.tiyn;
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, money(v)]));
}

function statementJson(status: string, extra: Record<string, unknown> = {}) {
  return {
    id: 'st-1',
    client_id: null,
    item_id: 'srv-pdf',
    status,
    bank: 'kaspi_gold',
    parser: 'template',
    currency: 'KZT',
    period: { from: '2026-10-01', to: '2026-10-31' },
    rows_found: 86,
    rows_new: 82,
    rows_existing: 4,
    rows_similar: 1,
    check: { ok: true, lines: [{ key: 'purchases', title: 'Покупки', bank: '-1.00', ours: '-1.00', ok: true }] },
    adds: addsOf(OPS),
    summary_ru: 'Нашёл 86 операций за октябрь, 4 уже есть',
    error: null,
    pending_action_id: 'pa-1',
    action_id: status === 'confirmed' ? 'a-bulk' : null,
    created_at: iso(),
    decided_at: null,
    ...extra,
  };
}

/** The spendings «Да» makes (82: every new and similar row), as /sync brings them. */
function createdExpenses(): ExpenseOut[] {
  return OPS.filter((o) => !EXISTING.has(o.n)).map((o) =>
    expense(`sx-${o.n}`, {
      client_id: null,
      amount: money(o.tiyn),
      spent_on: o.date,
      direction: o.direction,
      category_key: o.category,
      category_id: o.category ? 'cat-transfers' : null,
      payee: o.description,
      source: 'statement_pdf',
      statement_id: 'st-1',
      seq: 100 + o.n,
    }),
  );
}

/** The 4 typed by hand earlier (each the same payment as rows 1–4). */
const handTyped = () => OPS.filter((o) => EXISTING.has(o.n)).map((o) => expense(`hand-${o.n}`, { amount: money(o.tiyn), spent_on: o.date, category_key: null, category_id: null }));

const fakeMedia = (perm: Permission, granted: Permission = 'granted') => {
  const calls: string[] = [];
  const m: MediaPort = {
    cameraPermission: async () => perm,
    requestCamera: async () => {
      calls.push('request');
      return granted;
    },
    takePhoto: async () => {
      calls.push('takePhoto');
      return { uri: 'file:///tmp/receipt.jpg', mime: 'image/jpeg', name: 'receipt.jpg' };
    },
    pickPhoto: async () => {
      calls.push('pickPhoto');
      return { uri: 'file:///tmp/photo.jpg', mime: 'image/jpeg', name: 'photo.jpg' };
    },
    pickPdf: async () => {
      calls.push('pickPdf');
      return { uri: 'file:///tmp/vypiska.pdf', mime: 'application/pdf', name: 'vypiska.pdf' };
    },
    openSettings: () => calls.push('settings'),
  };
  return { m, calls };
};

const QR = 'https://consumer.oofd.kz/?i=1234567890&f=010101012345&s=3400.50&t=20261104T191520';

const expensesPage = () => usePages.getState().pages.find((p) => p.templateKey === 'expenses')!;
const stripText = () => {
  const st = useUndo.getState().strip;
  return st?.kind === 'custom' ? st.text : null;
};
const text = (id: string) => {
  const c = screen.getByTestId(id).props.children;
  return Array.isArray(c) ? c.join('') : String(c);
};
const live = () => liveEntries(useExpenses.getState().entries, useExpenses.getState().edits);
const octoberTotal = () => board(live(), periodOf('month', '2026-10-15')).main?.total ?? 0n;

afterEach(() => {
  setMediaForTests(null);
  setQrCameraForTests(null);
  useShareAsk.getState().set(null);
  Dimensions.set({ window: { width: 390, height: 844, scale: 3, fontScale: 1 }, screen: { width: 390, height: 844, scale: 3, fontScale: 1 } });
});

describe('week 13 contract and code', () => {
  it('decoders follow expenses.md «Week 13»; money stays text', () => {
    const r = receiptOut({ status: 'waiting', expense: null, action: null, page_patches: [], draft: null, duplicate: null, reader: null, message: null, retry_after: 2, repeated: false });
    expect(r).toMatchObject({ status: 'waiting', retry_after: 2 });
    const form = receiptOut({ status: 'form', draft: { amount: null, currency: 'KZT', spent_on: '2026-11-04', payee: 'Магнум', review_fields: ['spent_on'] }, message: 'Не разобрал сумму на чеке — наберите её на клавишах.' });
    expect(form.draft).toMatchObject({ spent_on: '2026-11-04', payee: 'Магнум' });
    expect(form.message).toMatch(/наберите/);
    const st = statementOut(statementJson('proposed'))!;
    expect(st).toMatchObject({ rows_found: 86, rows_existing: 4, period_from: '2026-10-01', period_to: '2026-10-31', bank: 'kaspi_gold', pending_action_id: 'pa-1' });
    expect(st.adds!.expense).toBe(addsOf(OPS).expense);
    expect(statementRowOut({ n: 1, date: '2026-10-02', amount: 2500, currency: 'KZT' })).toBeNull(); // a float amount is refused
    const dup = expenseDuplicateOut({ id: 'd1', status: 'suggested', keep: expense('a'), other: expense('b'), text_ru: 'Похоже, эта трата уже есть (из выписки)' });
    expect(dup).toMatchObject({ id: 'd1', keep: { id: 'a' }, other: { id: 'b' } });
    expect(expenseOut({ ...expense('x'), line_items: [{ name: 'Молоко', qty: '2', total: '1100.00' }], statement_id: 'st-1' })).toMatchObject({
      line_items: [{ name: 'Молоко', qty: '2', total: '1100.00' }],
      statement_id: 'st-1',
    });
  });

  it('QR: only an http(s) link goes; its sum and day are read here by code (offline preview)', () => {
    expect(qrLink(QR)).toBe(QR);
    expect(qrLink('ftp://x.kz/a')).toBeNull();
    expect(qrLink('just some text')).toBeNull();
    expect(qrLink('https://user:pass@oofd.kz/?s=1')).toBeNull();
    expect(qrPreview(QR)).toEqual({ amount: '3400.50', day: '2026-11-04' });
    expect(qrPreview('https://oofd.kz/?i=1')).toBeNull();
  });

  it('the plan: «Нашёл 86 операций за октябрь, 4 уже есть»; the phone counts the rows to the tiyn as the server', () => {
    const st = statementOut(statementJson('proposed'))!;
    const rows = rowsJson(OPS).map(statementRowOut).filter((x): x is StatementRowOut => x !== null);
    expect(rows).toHaveLength(86);
    const n = planNumbers(st, rows);
    expect(n).toMatchObject({ found: 86, already: 4, add: 82, matches: true });
    expect(planTitle(st, n.found, n.already, 'ru', i18n.t.bind(i18n))).toBe('Нашёл 86 операций за октябрь, 4 уже есть');
    expect(planTitle({ period_from: null, period_to: null }, 1, 0, 'ru', i18n.t.bind(i18n))).toBe('Нашёл 1 операцию');
    // A server count one tiyn off is caught.
    const off = statementOut(statementJson('proposed', { adds: { ...addsOf(OPS), expense: money(toMinor(addsOf(OPS).expense!)! + 1n) } }))!;
    expect(planNumbers(off, rows).matches).toBe(false);
    // «Потрачено» = purchases + fees of the new rows − refunds; transfers and withdrawals are in no total.
    const bank = bankSummary(OPS.filter((o) => !EXISTING.has(o.n)));
    expect(n.spent).toBe(bank.purchases + bank.fees - bank.refunds);
    expect(countRows(rows).transfers).toBe(bank.transfers);
    expect(countRows(rows).transfer_own).toBe(bank.withdrawals);
    expect(countRows(rows).income).toBe(bank.topups);
  });

  it('«Поделиться»: one PDF or one picture asks what it is; text or several files do not', () => {
    const rec = (kind: string) => ({ id: `r-${kind}`, kind }) as never;
    expect(askFor([rec('pdf')])).toEqual({ recordId: 'r-pdf', pdf: true });
    expect(askFor([rec('image')])).toEqual({ recordId: 'r-image', pdf: false });
    expect(askFor([rec('note')])).toBeNull();
    expect(askFor([rec('pdf'), rec('pdf')])).toBeNull();
  });
});

function server(): FakeServer {
  const s = happyServer();
  s.on('GET /expense-categories', () => ({ status: 200, body: { order: 'frequency', categories: serverCategories() } }))
    .on('GET /expenses/duplicates', () => ({ status: 200, body: { duplicates: [] } }))
    .on('GET /expenses/statements', () => ({ status: 200, body: { statements: [] } }))
    .on('POST /actions/*/undo', (c) => ({
      status: 200,
      body: { action: { ...action(c.path.split('/')[2]!, 'x', 'x'), undoable: false, undone_at: iso() }, undo: null, partial: false, repeated: false, message_ru: null, page_patches: [] },
    }))
    .on('GET /actions', () => ({ status: 200, body: { actions: [], has_more: false } }))
    .on('GET /page-templates', () => ({ status: 200, body: { templates: [] } }))
    .on('GET /collections', () => ({ status: 200, body: { collections: [] } }))
    .on('GET /duplicates/groups', () => ({ status: 200, body: { groups: [] } }));
  return s;
}

describe('the founder\'s month: a shared statement → plan → one «Да» → totals equal the bank to the tiyn → one «Отменить»', () => {
  it('nothing is saved before «Да»; after it October = the hand-typed 4 + the plan, equal to the bank\'s own summary', async () => {
    const s = server();
    let confirmed = false;
    let undone = false;
    s.on('POST /expenses/statements', (c) => ({
      status: 201,
      body: { statement: statementJson('proposed', { client_id: (c.body as { client_id: string }).client_id }), pending_action: { id: 'pa-1', kind: 'import_statement', status: 'proposed', preview: {} }, repeated: false },
    }))
      .on('GET /expenses/statements/st-1', () => ({ status: 200, body: { statement: statementJson(confirmed ? 'confirmed' : 'proposed'), rows: confirmed ? [] : rowsJson(OPS) } }))
      .on('POST /expenses/statements/st-1/confirm', () => {
        confirmed = true;
        return {
          status: 200,
          body: { statement: statementJson('confirmed'), pending_action: { id: 'pa-1', status: 'executed' }, action: action('a-bulk', 'bulk_create_expenses', 'Записал 82 операции из выписки'), created: 82, duplicates: [], repeated: false },
        };
      })
      .on('GET /sync', () => ({
        status: 200,
        body: { items: [], tombstones: [], expenses: confirmed && !undone ? createdExpenses() : [], next_since: confirmed ? 500 : 1, has_more: false },
      }));
    const outbox: InMemoryOutboxRepository = resetApp({ fetch: s.fetch });
    finishOnboarding('full');
    applyServer(handTyped(), serverCategories());
    await (await getSyncEngine()).run();
    const handTotal = octoberTotal();

    // Kaspi → «Поделиться» → this app: the PDF is a record; then «Что это?» → «Выписка из банка».
    const rec = await (await getCapture()).saveFile({ uri: 'file:///share/vypiska.pdf', mime: 'application/pdf', name: 'vypiska.pdf', source: 'share' });
    useShareAsk.getState().set(askFor([rec]));
    await renderRouter(APP_DIR, { initialUrl: '/' });
    await settle(() => screen.queryByTestId('share-ask') !== null);
    await fireEvent.press(screen.getByTestId('share-ask-statement'));
    await settle(() => screen.queryByTestId('plan-title') !== null);
    expect(text('plan-title')).toBe('Нашёл 86 операций за октябрь, 4 уже есть');
    expect(s.callsTo('POST /expenses/statements')[0]!.body).toMatchObject({ item_id: `srv-${rec.id}` });
    expect(outbox.all().some((r) => r.kind === 'expense.statement')).toBe(true);
    // Nothing is saved before «Да».
    expect(octoberTotal()).toBe(handTotal);
    expect(s.callsTo('POST /expenses/statements/st-1/confirm')).toHaveLength(0);
    expect(screen.getByTestId('plan-check-ok')).toBeTruthy();
    const bank = bankSummary(OPS.filter((o) => !EXISTING.has(o.n)));
    expect(text('plan-spent')).toBe(formatMinor(bank.purchases + bank.fees - bank.refunds));
    expect(screen.queryByTestId('plan-mismatch')).toBeNull();
    await settle(() => screen.queryByTestId('plan-rows') !== null);
    await fireEvent.press(screen.getByTestId('plan-rows'));
    expect(screen.getByTestId('plan-row-1')).toBeTruthy();

    // The one «Да».
    expect(screen.getByTestId('plan-yes').props.accessibilityLabel).toBe('Да, записать 82');
    await fireEvent.press(screen.getByTestId('plan-yes'));
    await settle(() => screen.queryByTestId('plan-confirmed') !== null);
    expect(s.callsTo('POST /expenses/statements/st-1/confirm')).toHaveLength(1);
    expect(stripText()).toBe('Записал 82 операции из выписки');
    await (await getSyncEngine()).run();
    // The bank's month: every purchase and fee of October minus the refunds (the 4 typed by hand are the same payments).
    const all = bankSummary(OPS);
    expect(octoberTotal()).toBe(all.purchases + all.fees - all.refunds);
    expect(minorToDecimal(octoberTotal())).toBe(minorToDecimal(handTotal + bank.purchases + bank.fees - bank.refunds));

    // The one «Отменить»: the whole batch at once.
    undone = true;
    await fireEvent.press(screen.getByTestId('plan-undo'));
    await settle(() => s.callsTo('POST /actions/a-bulk/undo').length === 1);
    expect(octoberTotal()).toBe(handTotal);
    await settle(() => screen.queryByTestId('plan-undone') !== null);
  });

  it('«Не сейчас»: nothing written; offline «Да» says so and changes nothing', async () => {
    const s = server();
    s.on('POST /expenses/statements', () => ({ status: 201, body: { statement: statementJson('proposed'), pending_action: null, repeated: false } }))
      .on('GET /expenses/statements/st-1', () => ({ status: 200, body: { statement: statementJson('proposed'), rows: rowsJson(OPS) } }))
      .on('POST /expenses/statements/st-1/reject', () => ({ status: 200, body: { statement: statementJson('rejected'), pending_action: null } }));
    resetApp({ fetch: s.fetch });
    finishOnboarding('full');
    await (await getSyncEngine()).run();
    const rec = await (await getCapture()).saveFile({ uri: 'file:///share/v.pdf', mime: 'application/pdf', name: 'v.pdf', source: 'share' });
    const job = await readAsStatement(rec.id);
    await (await getSyncEngine()).run();
    await renderRouter(APP_DIR, { initialUrl: `/statement/${job.id}` });
    await settle(() => screen.queryByTestId('plan-yes') !== null);
    s.offline = true;
    await fireEvent.press(screen.getByTestId('plan-yes'));
    await settle(() => screen.queryByTestId('plan-note') !== null);
    expect(text('plan-note')).toBe('Нужен интернет — сейчас ничего не изменилось.');
    expect(useExpenses.getState().statements['st-1']!.status).toBe('proposed');
    s.offline = false;
    await fireEvent.press(screen.getByTestId('plan-no'));
    await settle(() => screen.queryByTestId('plan-rejected') !== null);
    expect(s.callsTo('POST /expenses/statements/st-1/confirm')).toHaveLength(0);
    expect(Object.values(useExpenses.getState().entries)).toHaveLength(0);
  });

  it('an unreadable statement: the server\'s words, nothing saved', async () => {
    const s = server();
    s.on('POST /expenses/statements', () => ({
      status: 422,
      body: { code: 'statement_unknown_format', message_ru: 'Не знаю такую выписку. Пришлите PDF из приложения банка.', message_kk: '' },
    }));
    resetApp({ fetch: s.fetch });
    finishOnboarding('no_ai');
    await (await getSyncEngine()).run();
    const rec = await (await getCapture()).saveFile({ uri: 'file:///share/v.pdf', mime: 'application/pdf', name: 'v.pdf', source: 'share' });
    const job = await readAsStatement(rec.id);
    await (await getSyncEngine()).run();
    expect(useExpenses.getState().jobs[job.id]).toMatchObject({ state: 'failed', message: 'Не знаю такую выписку. Пришлите PDF из приложения банка.' });
  });
});

describe('receipt photo, QR, «Проверьте сумму», «Объединить?»', () => {
  it('the camera is explained first; «Разрешить» → the photo → «Читаю чек…» → «Проверьте сумму» → «Верно»', async () => {
    const s = server();
    let reads = 0;
    s.on('POST /expenses/from-item', (c) => {
      reads++;
      const b = c.body as { client_id: string; item_id: string; kind: string };
      if (reads === 1) return { status: 200, body: { status: 'waiting', retry_after: 2 } };
      return {
        status: 201,
        body: {
          status: 'ok',
          expense: expense('r1', { client_id: b.client_id, item_id: b.item_id, amount: '12400.00', payee: 'Магнум', source: 'receipt_ocr', review_fields: ['amount'], seq: 30 }),
          action: action('a-r1', 'create_expense', 'Записал 12 400 ₸'),
          page_patches: [],
          duplicate: null,
          repeated: false,
        },
      };
    }).on('PATCH /expenses/r1', () => ({ status: 200, body: { expense: expense('r1', { amount: '12400.00', payee: 'Магнум', source: 'receipt_ocr', seq: 31 }), action: action('a-v', 'edit_expense', 'x'), repeated: false } }));
    const outbox = resetApp({ fetch: s.fetch });
    finishOnboarding('full');
    applyServer([], serverCategories());
    // The engine is made after renderRouter turned on fake timers (its clock is then the fake one).
    const { m, calls } = fakeMedia('undetermined');
    setMediaForTests(m);
    await renderRouter(APP_DIR, { initialUrl: `/page/${expensesPage().id}` });
    await settle(() => screen.queryByTestId('exp-bring') !== null);
    await fireEvent.press(screen.getByTestId('exp-bring'));
    await settle(() => screen.queryByTestId('exp-bring-sheet') !== null);
    await fireEvent.press(screen.getByTestId('exp-bring-camera'));
    await settle(() => screen.queryByTestId('receipt-camera-why') !== null);
    expect(text('receipt-camera-why')).toMatch(/Снимок делаете вы сами/);
    expect(calls).toEqual([]); // nothing asked before the person read why
    await fireEvent.press(screen.getByTestId('receipt-allow'));
    await settle(() => calls.includes('takePhoto'));
    expect(calls).toEqual(['request', 'takePhoto']);
    await settle(() => outbox.all().some((r) => r.kind === 'expense.receipt'));
    expect(stripText()).toBe('Сохранил чек. Прочитаю сумму и запишу в Расходы');
    await settle(() => screen.queryByTestId('exp-board') !== null && reads >= 1);
    // The server reads it: «Читаю чек…», then the spending with «Проверьте сумму».
    await settle(() => screen.queryByTestId('exp-check-r1') !== null);
    expect(s.callsTo('POST /expenses/from-item')[0]!.body).toMatchObject({ kind: 'receipt', save: true });
    expect(text('exp-check-amount-r1')).toBe('12 400 ₸');
    expect(screen.getByTestId('exp-check-ok-r1')).toBeTruthy();
    expect(screen.getByTestId('exp-check-edit-r1')).toBeTruthy();
    expect(text('exp-total')).toBe('12 400 ₸');
    await fireEvent.press(screen.getByTestId('exp-check-ok-r1'));
    await settle(() => s.callsTo('PATCH /expenses/r1').length === 1);
    expect(s.callsTo('PATCH /expenses/r1')[0]!.body).toMatchObject({ confirm: ['amount'] });
    expect(stripText()).toBe('Сумма верна: 12 400 ₸');
    await settle(() => screen.queryByTestId('exp-check-r1') === null);
  });

  it('the camera off in settings: said in plain words, «Открыть настройки», the gallery instead', async () => {
    resetApp();
    finishOnboarding('full');
    const { m, calls } = fakeMedia('blocked');
    setMediaForTests(m);
    await renderRouter(APP_DIR, { initialUrl: `/receipt?kind=camera&page=${expensesPage().id}` });
    await settle(() => screen.queryByTestId('receipt-camera-blocked') !== null);
    expect(screen.queryByTestId('receipt-allow')).toBeNull();
    await fireEvent.press(screen.getByTestId('receipt-settings'));
    expect(calls).toContain('settings');
    await fireEvent.press(screen.getByTestId('receipt-gallery'));
    await settle(() => calls.includes('pickPhoto'));
  });

  it('offline QR: decoded here, the line says the sum and «Ждёт связи», not in the total; online → the spending with «Проверьте», «Изменить» opens its keys', async () => {
    const s = server();
    s.on('POST /expenses/from-qr', (c) => ({
      status: 201,
      body: {
        status: 'ok',
        expense: expense('q1', { client_id: (c.body as { client_id: string }).client_id, amount: '3400.50', spent_on: '2026-11-04', source: 'receipt_qr', review_fields: ['amount'], seq: 40 }),
        action: action('a-q1', 'create_expense', 'x'),
        page_patches: [],
        duplicate: null,
        fiscal: { domain: 'consumer.oofd.kz', amount: '3400.50', page: 'skipped' },
        repeated: false,
      },
    }));
    const outbox = resetApp({ fetch: s.fetch });
    finishOnboarding('full');
    applyServer([], serverCategories());
    // The engine is made after renderRouter turned on fake timers (its clock is then the fake one).
    s.offline = true;
    const { m } = fakeMedia('granted');
    setMediaForTests(m);
    setQrCameraForTests(({ onCode }) => <Pressable testID="fake-qr" onPress={() => onCode(QR)} />);
    await renderRouter(APP_DIR, { initialUrl: `/receipt?kind=qr&page=${expensesPage().id}` });
    await settle(() => screen.queryByTestId('fake-qr') !== null);
    await fireEvent.press(screen.getByTestId('fake-qr'));
    await settle(() => outbox.all().some((r) => r.kind === 'expense.receipt'));
    expect(stripText()).toBe('QR-код прочитал. Запишу трату');
    const job = Object.values(useExpenses.getState().jobs)[0]!;
    expect(job).toMatchObject({ kind: 'qr', qr: QR, state: 'waiting' });
    expect(live()).toHaveLength(0); // not a spending until the server makes it
    s.offline = false;
    // Back online: the outbox tries again after its backoff.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(31_000);
    });
    await settle(() => {
      kickSync();
      return s.callsTo('POST /expenses/from-qr').length === 1 && useExpenses.getState().jobs[job.id]!.state === 'done';
    });
    expect(s.callsTo('POST /expenses/from-qr')[0]!.body).toMatchObject({ url: QR, item_id: null });
    expect(useExpenses.getState().jobs[job.id]!.state).toBe('done');
    expect(useExpenses.getState().entries.q1!.review_fields).toEqual(['amount']);
  });

  it('a QR that is not a link: «Это не кассовый чек», scan again', async () => {
    resetApp();
    finishOnboarding('full');
    const { m } = fakeMedia('granted');
    setMediaForTests(m);
    setQrCameraForTests(({ onCode }) => <Pressable testID="fake-qr" onPress={() => onCode('WIFI:S:home;P:1234;;')} />);
    await renderRouter(APP_DIR, { initialUrl: `/receipt?kind=qr` });
    await settle(() => screen.queryByTestId('fake-qr') !== null);
    await fireEvent.press(screen.getByTestId('fake-qr'));
    await settle(() => screen.queryByTestId('receipt-qr-bad') !== null);
    await fireEvent.press(screen.getByTestId('receipt-qr-again'));
    await settle(() => screen.queryByTestId('fake-qr') !== null);
  });

  it('«Изменить» on «Проверьте сумму» opens the keys of that spending; the new amount goes without `confirm`', async () => {
    const s = server();
    s.on('PATCH /expenses/v1', () => ({ status: 200, body: { expense: expense('v1', { amount: '4500.00', source: 'voice', seq: 9 }), action: action('a-e', 'edit_expense', 'x'), repeated: false } }));
    resetApp({ fetch: s.fetch });
    finishOnboarding('full');
    applyServer([expense('v1', { amount: '5400.00', source: 'voice', review_fields: ['amount'] })], serverCategories());
    await (await getSyncEngine()).run();
    await renderRouter(APP_DIR, { initialUrl: `/page/${expensesPage().id}` });
    await settle(() => screen.queryByTestId('exp-check-edit-v1') !== null);
    await fireEvent.press(screen.getByTestId('exp-check-edit-v1'));
    await settle(() => screen.queryByTestId('exp-sheet-keypad') !== null);
    for (const k of ['4', '5', '0', '0']) await fireEvent.press(screen.getByTestId(`exp-sheet-keypad-${k}`));
    await fireEvent.press(screen.getByTestId('exp-sheet-keypad-save'));
    await settle(() => s.callsTo('PATCH /expenses/v1').length === 1);
    const body = s.callsTo('PATCH /expenses/v1')[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({ amount: '4500.00' });
    expect(body.confirm).toBeUndefined();
  });

  it('«Объединить?»: a receipt and the same payment from a statement; [Объединить] → one «Отменить»; offline nothing changes', async () => {
    const s = server();
    const keep = expense('rc', { amount: '2500.00', payee: 'Магнум', source: 'receipt_ocr', spent_on: today(), seq: 5 });
    const other = expense('sp', { amount: '2500.00', payee: 'MAGNUM CASH&CARRY', source: 'statement_pdf', spent_on: today(), seq: 6, category_key: null });
    const dup = { id: 'd1', status: 'suggested', keep, other, text_ru: 'Похоже, эта трата уже есть (из выписки)', action_id: null, created_at: iso(), decided_at: null };
    s.on('GET /expenses/duplicates', () => ({ status: 200, body: { duplicates: [dup] } }))
      .on('POST /expenses/duplicates/d1/merge', () => ({
        status: 200,
        body: { duplicate: { ...dup, status: 'merged' }, expense: { ...keep, seq: 7 }, action: action('a-m', 'merge_expenses', 'Объединил траты: 2 500 ₸ · Магнум'), repeated: false },
      }));
    resetApp({ fetch: s.fetch });
    finishOnboarding('full');
    applyServer([keep, other], serverCategories());
    await (await getSyncEngine()).run();
    await renderRouter(APP_DIR, { initialUrl: `/page/${expensesPage().id}` });
    await settle(() => screen.queryByTestId('exp-dup-d1') !== null);
    expect(text('exp-total')).toBe('5 000 ₸');
    expect(text('exp-dup-other-d1')).toMatch(/MAGNUM CASH&CARRY · 2 500 ₸ · Сегодня · выписка/);
    s.offline = true;
    await fireEvent.press(screen.getByTestId('exp-dup-merge-d1'));
    await settle(() => useToast.getState().toast?.text === 'Нужен интернет — сейчас ничего не изменилось.');
    expect(text('exp-total')).toBe('5 000 ₸');
    expect(screen.getByTestId('exp-dup-d1')).toBeTruthy();
    s.offline = false;
    await fireEvent.press(screen.getByTestId('exp-dup-merge-d1'));
    await settle(() => s.callsTo('POST /expenses/duplicates/d1/merge').length === 1 && screen.queryByTestId('exp-dup-d1') === null);
    await settle(() => text('exp-total') === '2 500 ₸');
    expect(stripText()).toBe('Объединил траты: 2 500 ₸');
    const strip = useUndo.getState().strip;
    if (strip?.kind === 'custom') strip.onUndo();
    await settle(() => s.callsTo('POST /actions/a-m/undo').length === 1);
    await settle(() => text('exp-total') === '5 000 ₸');
  });

  it('200%: the «Проверьте сумму» buttons stack, the amount keeps its 1.6× cap, the bring sheet rows are ≥56 pt', async () => {
    Dimensions.set({ window: { width: 390, height: 844, scale: 3, fontScale: 2 }, screen: { width: 390, height: 844, scale: 3, fontScale: 2 } });
    resetApp();
    finishOnboarding('full');
    applyServer([expense('v2', { amount: '700.00', source: 'voice', review_fields: ['amount', 'spent_on'] })], serverCategories());
    await renderRouter(APP_DIR, { initialUrl: `/page/${expensesPage().id}` });
    await settle(() => screen.queryByTestId('exp-check-v2') !== null);
    expect(screen.getByTestId('exp-check-amount-v2').props.maxFontSizeMultiplier).toBe(1.6);
    expect(screen.getByTestId('exp-check-ok-v2').props.accessibilityLabel).toBe('Верно, 700 ₸');
    await fireEvent.press(screen.getByTestId('exp-bring'));
    await settle(() => screen.queryByTestId('exp-bring-camera') !== null);
    const style = screen.getByTestId('exp-bring-camera').props.style;
    const flat = Array.isArray(style) ? Object.assign({}, ...style) : style;
    expect(flat.minHeight).toBeGreaterThanOrEqual(56);
  });
});
