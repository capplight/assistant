import { act, fireEvent, renderRouter, screen } from 'expo-router/testing-library';
import { StyleSheet } from 'react-native';

import { expenseCategoryOut, expenseOut, FEATURE_DEFAULTS, kpFullOut } from '@/api/endpoints';
import type { ExpenseCategoryOut, ExpenseOut } from '@/api/types';
import { applyServer } from '@/expenses/service';
import i18n from '@/i18n';
import { putFull } from '@/kp/service';
import { useFeatureStore } from '@/store/features';
import { useOnboarding } from '@/store/onboarding';
import { usePages } from '@/store/pages';
import { localDate } from '@/tasks/rows';
import { APP_DIR, finishOnboarding, resetApp, settle, testRecords } from '@/testing/helpers';
import { itemOut } from '@/testing/fakeServer';
import { auditLayout, AUDIT_MATRIX, resetWindow, setWindow, type Allow } from '@/testing/layoutAudit';

/**
 * The «Мята / Глубина» restyle of «Расходы», КП and search (research/expenses-documents.md patterns 1–8,
 * screens.html): one total and one «Требует внимания» card, the keys in a sheet, statements / QR behind their
 * switches (Ф-37), the КП editor with «Правка | Просмотр», the one send sheet; every screen at 320–840 × 1.0–2.0.
 */

const today = () => localDate(Date.now());
const iso = () => new Date().toISOString();

const ALLOW: Allow[] = [
  { rule: 'no-scale', testID: /^exp-keypad|^exp-sheet-keypad|^kp-edit-keys/, why: 'keys are 56 pt; labels capped at 150% so a digit never wraps' },
  { rule: 'row-of-buttons', testID: /^exp-keypad|^exp-sheet-keypad|^kp-edit-keys/, why: 'a 4×4 keypad of single digits, not words' },
];

function expense(id: string, extra: Partial<ExpenseOut> = {}): ExpenseOut {
  return expenseOut({
    id, client_id: `c-${id}`, item_id: `srv-${id}`, amount: '1000.00', currency: 'KZT', spent_on: today(), category_key: 'groceries',
    category_id: 'cat-groceries', direction: 'expense', source: 'form', review_fields: [], version: 1, seq: 1, created_at: iso(),
    updated_at: iso(), deleted_at: null, ...extra,
  })!;
}
const KEYS = ['groceries', 'home', 'transport', 'health', 'family', 'cafe_gifts', 'utilities', 'other'];
const category = (key: string, i: number): ExpenseCategoryOut =>
  expenseCategoryOut({ id: `cat-${key}`, key, title: key, title_kk: null, system: true, service: false, position: String.fromCharCode(97 + i), manual: false, pinned: false, hidden: false, version: 1, seq: 1 })!;
const categories = () => KEYS.map((k, i) => category(k, i));
const expensesPage = () => usePages.getState().pages.find((p) => p.templateKey === 'expenses')!;
const text = (id: string) => {
  const c = screen.getByTestId(id).props.children;
  return Array.isArray(c) ? c.join('') : String(c);
};
const flat = (id: string) => StyleSheet.flatten(screen.getByTestId(id).props.style);

const KP_ROW = {
  id: 'doc-1', client_id: 'c-doc-1', item_id: 'srv-kp-1', kind: 'kp', title: 'КП № 14', number: 'КП-2026-014', date: '2026-11-10',
  client: { name: 'ТОО «АлмаСтрой»' }, currency: 'KZT', total: '519400.00', vat_mode: 'none', missing_prices: 0, lines: 2, status: 'draft',
  deal_status: 'draft', deal_status_text: 'Черновик', current_version_n: 1, sent_version_n: null, progress: { state: 'done', done: 2, total: 2 },
  error: null, ai_generated: true, version: 1, seq: 10, created_at: iso(), updated_at: iso(), deleted_at: null,
};
const KP_VERSION = {
  n: 1, author: 'initial', created_at: iso(), calc_version: 'kp-calc.v1', vat_rate: null, vat_mode: 'none', changed_paths: [],
  data: { number: 'КП-2026-014', date: '2026-11-10', currency: 'KZT', vat: { mode: 'none' }, discount_total_pct: '0', terms: {} },
  client: { name: 'ТОО «АлмаСтрой»', bin: null, contact: 'Б. Ахметов · +7 777 210 33 45', review: [] },
  items: [
    { id: 'i1', name: 'Монтаж гипсокартона', unit: 'м²', qty: '48', unit_price: '4500.00', discount_pct: '0', price_source: 'manual', price_review: false, matched_name: null, review_fields: [], price_label: '', amount: '216000.00' },
    { id: 'i2', name: 'Материалы', unit: null, qty: '1', unit_price: '303400.00', discount_pct: '0', price_source: 'manual', price_review: false, matched_name: null, review_fields: [], price_label: '', amount: '303400.00' },
  ],
  totals: { calc_version: 'kp-calc.v1', lines_sum: '519400.00', discount_total: '0.00', amount: '519400.00', net: '519400.00', vat: '0.00', total: '519400.00', vat_mode: 'none', vat_rate: null, rounding: 'on_total', priced: 2, missing: 0, complete: true },
  valid_until: '2026-11-20', price_summary: { price_list: 0, past_kp: 0, manual: 2, missing: 0 }, missing_required: [], sent_at: null, ai_generated: true,
};
const putKp = () => putFull(kpFullOut({ document: KP_ROW, version: KP_VERSION, needs_profile: false })!);

afterEach(() => resetWindow());

describe('«Расходы»: one total, the keys in a sheet, one «Требует внимания»', () => {
  it('«Записать трату» → the sheet (sum, chips, day, flat 56 keys) → «Записать» closes it; a category row opens it with that category', async () => {
    resetApp();
    finishOnboarding('full');
    applyServer([expense('a', { amount: '3000.00', category_key: 'transport', category_id: 'cat-transport' })], categories());
    await renderRouter(APP_DIR, { initialUrl: `/page/${expensesPage().id}` });
    await settle(() => screen.queryByTestId('exp-board') !== null);
    // The total has no box (pattern 1).
    expect(flat('exp-board').borderWidth).toBeUndefined();
    expect(screen.queryByTestId('exp-keypad')).toBeNull();
    await fireEvent.press(screen.getByTestId('exp-enter'));
    await settle(() => screen.queryByTestId('exp-entry-sheet') !== null);
    const key = flat('exp-keypad-7');
    expect(key.minHeight).toBe(56);
    expect(key.borderWidth).toBeUndefined();
    for (const k of ['4', '0', '0']) await fireEvent.press(screen.getByTestId(`exp-keypad-${k}`));
    await fireEvent.press(screen.getByTestId('exp-cat-cafe_gifts'));
    await fireEvent.press(screen.getByTestId('exp-keypad-save'));
    await settle(() => text('exp-total') === '3 400 ₸');
    expect(screen.queryByTestId('exp-entry-sheet')).toBeNull();
    // Category colours: the row's bar is the category's own colour, not the brand.
    expect(screen.getByTestId('exp-bar-transport')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('exp-bar-transport'));
    await settle(() => screen.queryByTestId('exp-entry-sheet') !== null);
    expect(screen.getByTestId('exp-cat-transport').props.accessibilityState).toMatchObject({ checked: true });
  });

  it('checks, a repeat and a receipt on its way are ONE card with a count; the queue shows one at a time', async () => {
    resetApp();
    finishOnboarding('full');
    applyServer(
      [expense('v1', { amount: '700.00', source: 'voice', review_fields: ['amount'] }), expense('v2', { amount: '900.00', source: 'voice', review_fields: ['amount'] })],
      categories(),
    );
    await renderRouter(APP_DIR, { initialUrl: `/page/${expensesPage().id}` });
    await settle(() => screen.queryByTestId('exp-attention') !== null);
    expect(screen.getAllByTestId('exp-attention')).toHaveLength(1);
    expect(text('exp-attention-count')).toBe('2');
    expect(screen.queryByTestId('exp-check-v1')).toBeNull(); // not on the page itself
    await fireEvent.press(screen.getByTestId('exp-attention'));
    await settle(() => screen.queryByTestId('exp-attention-sheet') !== null);
    const first = screen.queryByTestId('exp-check-v1') ? 'v1' : 'v2';
    expect(screen.queryAllByTestId(/^exp-check-v\d$/)).toHaveLength(1);
    await fireEvent.press(screen.getByTestId('exp-attention-skip'));
    await settle(() => screen.queryByTestId(`exp-check-${first}`) === null);
    expect(screen.queryAllByTestId(/^exp-check-v\d$/)).toHaveLength(1);
  });

  it('Ф-37: statements PDF and receipt QR are hidden while their switches are off, back when on', async () => {
    resetApp();
    finishOnboarding('full');
    await renderRouter(APP_DIR, { initialUrl: `/page/${expensesPage().id}` });
    await settle(() => screen.queryByTestId('exp-bring') !== null);
    expect(screen.queryByTestId('exp-kaspi')).toBeNull();
    await fireEvent.press(screen.getByTestId('exp-bring'));
    await settle(() => screen.queryByTestId('exp-bring-sheet') !== null);
    expect(screen.getByTestId('exp-bring-camera')).toBeTruthy();
    expect(screen.getByTestId('exp-bring-photo')).toBeTruthy();
    expect(screen.queryByTestId('exp-bring-qr')).toBeNull();
    expect(screen.queryByTestId('exp-bring-statement')).toBeNull();
    await act(async () => useFeatureStore.getState().set({ ...FEATURE_DEFAULTS, statements_pdf: true, receipt_qr: true }));
    await settle(() => screen.queryByTestId('exp-bring-qr') !== null);
    expect(screen.getByTestId('exp-bring-statement')).toBeTruthy();
  });
});

describe('КП: compact lines, «Правка | Просмотр», the send sheet', () => {
  it('a line is one row (≥60); a tap opens its sheet; «Просмотр» shows the A4 sheet; «Отправить» is one confirmation sheet', async () => {
    resetApp();
    finishOnboarding('full');
    putKp();
    await renderRouter(APP_DIR, { initialUrl: '/kp/doc-1' });
    await settle(() => screen.queryByTestId('kp-line-0') !== null);
    expect(text('kp-line-0-calc')).toBe('48 м² × 4 500 ₸');
    expect(text('kp-line-0-sum')).toBe('216 000 ₸');
    expect(screen.getByTestId('kp-total').props.accessibilityLabel).toBe('Итого: 519 400 ₸');
    expect(screen.getByTestId('kp-ai-label')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('kp-line-0'));
    await settle(() => screen.queryByTestId('kp-line-sheet') !== null);
    expect(screen.getByTestId('kp-line-0-price')).toBeTruthy();
    expect(screen.getByTestId('kp-line-0-qty')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('kp-line-sheet-close'));
    await settle(() => screen.queryByTestId('kp-line-sheet') === null);

    expect(screen.queryByTestId('kp-preview')).toBeNull();
    await fireEvent.press(screen.getByTestId('kp-mode-preview'));
    await settle(() => screen.queryByTestId('kp-preview') !== null);
    expect(screen.queryByTestId('kp-editor')).toBeNull();
    expect(screen.getByTestId('kp-preview').props.accessibilityLabel).toMatch(/519 400 ₸/);
    expect(StyleSheet.flatten(screen.getByTestId('kp-preview').props.style).aspectRatio).toBeCloseTo(210 / 297);
    await fireEvent.press(screen.getByTestId('kp-bar-toggle'));
    await settle(() => screen.queryByTestId('kp-editor') !== null);

    await fireEvent.press(screen.getByTestId('kp-send'));
    await settle(() => screen.queryByTestId('kp-send-sheet') !== null);
    expect(screen.getByTestId('kp-send-panel')).toBeTruthy();
    for (const c of ['whatsapp', 'email', 'share']) expect(screen.getByTestId(`kp-send-channel-${c}`)).toBeTruthy();
    expect(screen.getAllByTestId('kp-send-open')).toHaveLength(1);
    await fireEvent.press(screen.getByTestId('kp-send-channel-email'));
    await settle(() => screen.queryByTestId('kp-send-email') !== null);
  });

  it('≥840: the editor and the A4 sheet side by side, no segment', async () => {
    setWindow({ fontScale: 1, width: 1024, height: 1180 });
    resetApp();
    finishOnboarding('full');
    putKp();
    await renderRouter(APP_DIR, { initialUrl: '/kp/doc-1' });
    await settle(() => screen.queryByTestId('kp-editor') !== null);
    expect(screen.getByTestId('kp-preview')).toBeTruthy();
    expect(screen.queryByTestId('kp-mode')).toBeNull();
  });
});

describe('search: grouped by source, the match lit', () => {
  it('records found on the phone sit under their page; the matched word is marked', async () => {
    resetApp();
    finishOnboarding('no_ai');
    await testRecords.applyRemote(itemOut('a', 2, { text: 'Плитка в ванную, 12 м²' }));
    await renderRouter(APP_DIR, { initialUrl: '/search?q=плитка' });
    await settle(() => screen.queryByText('Нашёл сразу: 1') !== null);
    expect(screen.getAllByTestId(/^search-group-/)).toHaveLength(1);
    expect(screen.getByText('Плитка')).toBeTruthy(); // the lit part is its own nested text
  });
});

const SCREENS: { name: string; url: () => string; seed: () => void }[] = [
  {
    name: 'expenses',
    url: () => `/page/${expensesPage().id}`,
    seed: () => {
      applyServer(
        [
          expense('e1', { amount: '389990.00', review_fields: ['amount'], payee: 'Technodom Алматы, ТРЦ Mega Silk Way' }),
          expense('e2', { amount: '12100.00', category_key: 'transport', category_id: 'cat-transport' }),
        ],
        categories(),
      );
    },
  },
  { name: 'kp editor', url: () => '/kp/doc-1', seed: putKp },
  { name: 'kp send', url: () => '/kp/send?doc=doc-1', seed: putKp },
  { name: 'search', url: () => '/search?q=плитка', seed: () => void testRecords.applyRemote(itemOut('a', 2, { text: 'Плитка в ванную' })) },
];

describe.each(SCREENS.map((s) => [s.name, s] as const))('%s at every width and font (AUDIT_MATRIX)', (_n, c) => {
  it.each(AUDIT_MATRIX.map((w) => [`${w.width} @ ${w.fontScale}`, w] as const))('%s', async (_w, w) => {
    setWindow(w);
    resetApp();
    finishOnboarding('full');
    useOnboarding.getState().setLanguage('ru');
    await act(async () => void (await i18n.changeLanguage('ru')));
    c.seed();
    await renderRouter(APP_DIR, { initialUrl: c.url() });
    for (let i = 0; i < 15; i++) await act(async () => void (await jest.advanceTimersByTimeAsync(40)));
    expect(auditLayout(screen.toJSON(), { allow: ALLOW, windowWidth: w.width }).map((v) => `${v.rule} @ ${v.where}: ${v.detail}`)).toEqual([]);
  });
});
