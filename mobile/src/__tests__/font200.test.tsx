import { act, renderRouter, screen } from 'expo-router/testing-library';
import fs from 'fs';
import path from 'path';

import { documentOut, expenseOut, statementOut } from '@/api/endpoints';
import type { DocumentOut } from '@/api/types';
import { resolveView, registeredViewKeys } from '@/components/page/registry';
import { setMediaForTests, type MediaPort } from '@/expenses/media';
import { useExpenses } from '@/expenses/store';
import i18n from '@/i18n';
import { kpSink } from '@/kp/service';
import { EMPTY_VIEW } from '@/pages/viewModel';
import { localDate } from '@/tasks/rows';
import { useOnboarding } from '@/store/onboarding';
import { usePages, type Page } from '@/store/pages';
import { happyServer, itemOut, linkOut, type FakeServer } from '@/testing/fakeServer';
import { APP_DIR, finishOnboarding, resetApp, testPages, testRecords } from '@/testing/helpers';
import { auditLayout, NARROW, resetWindow, setWindow, type Allow } from '@/testing/layoutAudit';

/**
 * Week 17 (3-engineering §11.2, F-22): every screen at system font 200% on a 320 × 568 phone, in RU
 * and KK. Structural checks only (`testing/layoutAudit.ts`); Jest has no text layout, so a real
 * device still has the last word (README «200% on a device»). A new route under `src/app` or a new
 * tool in the view registry fails «every screen is covered» until it gets a case here.
 */

const iso = () => new Date().toISOString();
const today = () => localDate(Date.now());
const LONG =
  'Позвонить Ерлану насчёт плитки и замера в ванной, взять с собой рулетку, договор и чек Technodom на 389 990 ₸ — до пятницы';

/** Known, reasoned exceptions. Each says why it is not a 200% problem. */
const ALLOW: Allow[] = [
  { rule: 'no-scale', testID: /^exp-keypad/, why: 'keys are 64 pt (2-design §2.3); labels capped at 150% so a digit never wraps' },
  { rule: 'no-scale', testID: /^kp-keypad|^kp-keys/, why: 'same 64 pt keys as «Расходы»' },
  { rule: 'row-of-buttons', testID: /^exp-keypad|^kp-keypad|^kp-keys/, why: 'a 4×4 keypad of single digits, not words' },
  { rule: 'fixed-height', testID: /^board-sticker|^board-canvas|^board-/, why: 'the free board draws 140 pt stickers at width/360; at ≥150% the board shows as rows' },
  { rule: 'too-wide', testID: /^board-/, why: 'the board is 360 board pt drawn at width/360' },
];

function criticalTexts(): string[] {
  return ['ru', 'kk'].flatMap((lng) => [i18n.t('ai.label', { lng }), i18n.t('answer.ai_label', { lng, defaultValue: '' })]).filter(Boolean);
}

async function serverPage(key: Page['templateKey'], texts: string[]): Promise<Page> {
  const local = usePages.getState().pages.find((p) => p.templateKey === key) ?? usePages.getState().addPage(key)!;
  const synced: Page = { ...local, serverId: `srv-${key}`, syncState: 'synced' };
  usePages.setState((st) => ({ pages: st.pages.map((p) => (p.id === local.id ? synced : p)) }));
  await testPages.insertLocal(synced);
  for (const [i, text] of texts.entries()) {
    await testRecords.applyRemote(itemOut(`${key}-r${i}`, 50 + i, { text, status: 'ready' }));
    await testPages.applyLink(linkOut(`srv-${key}`, `srv-${key}-r${i}`, 60 + i, { position: String.fromCharCode(85 + i) }));
  }
  return synced;
}

function expense(id: string, amount: string, extra: Record<string, unknown> = {}) {
  return expenseOut({
    id, client_id: `c-${id}`, item_id: `srv-${id}`, amount, currency: 'KZT', spent_on: today(), category_key: 'home',
    category_id: 'cat-home', direction: 'expense', source: 'form', review_fields: [], version: 1, seq: 1,
    created_at: iso(), updated_at: iso(), deleted_at: null, payee: 'Technodom Алматы, ТРЦ Mega Silk Way', ...extra,
  })!;
}

const KP_ROW = {
  id: 'doc-1', client_id: 'c-doc-1', item_id: 'srv-kp-1', kind: 'kp', title: 'КП № 14 · ТОО «Строительная компания Алматы»',
  number: 'КП-2026-014', date: '2026-11-10', client: { name: 'ТОО «Строительная компания Алматы»' }, currency: 'KZT',
  total: '124560000.00', vat_mode: 'included', missing_prices: 0, lines: 2, status: 'draft', deal_status: 'draft',
  deal_status_text: 'Черновик', current_version_n: 1, sent_version_n: null, progress: { state: 'done', done: 2, total: 2 },
  error: null, ai_generated: true, version: 1, seq: 10, created_at: iso(), updated_at: iso(), deleted_at: null,
};
const KP_VERSION = {
  n: 1, author: 'initial', created_at: iso(), calc_version: 'kp-calc.v1', vat_rate: '16.00', vat_mode: 'included', changed_paths: [],
  data: { number: 'КП-2026-014', date: '2026-11-10', currency: 'KZT', vat: { mode: 'included' }, discount_total_pct: '0', terms: { validity_days: 10 } },
  client: { name: 'ТОО «Строительная компания Алматы»', bin: '140540012345', contact: 'Ерлан', review: ['client.bin'] },
  items: [
    { id: 'i1', name: 'Кабель силовой медный ВВГнг-LS 3х2,5 ГОСТ, бухта 100 м', unit: 'м', qty: '50000', unit_price: '2450.00', discount_pct: '0', price_source: 'manual', price_review: false, matched_name: null, review_fields: [], price_label: '', amount: '122500000.00' },
    { id: 'i2', name: 'Автомат 16А', unit: 'шт', qty: '40', unit_price: '51500.00', discount_pct: '0', price_source: 'price_list:pl#p2', price_review: true, matched_name: 'Автомат ВА47-29 16А', review_fields: ['qty'], price_label: 'из прайса: «Автомат ВА47-29 16А» — та ли позиция?', amount: '2060000.00' },
  ],
  totals: { calc_version: 'kp-calc.v1', lines_sum: '124560000.00', discount_total: '0.00', amount: '124560000.00', net: '0', vat: '17180689.66', total: '124560000.00', vat_mode: 'included', vat_rate: '16.00', rounding: 'on_total', priced: 2, missing: 0, complete: true },
  valid_until: '2026-11-20', price_summary: { price_list: 1, past_kp: 0, manual: 1, missing: 0 }, missing_required: [], sent_at: null, ai_generated: true,
};

/** The camera explained first; nothing is taken (week 13 `MediaPort`). */
const fakeMedia: MediaPort = {
  cameraPermission: async () => 'undetermined',
  requestCamera: async () => 'granted',
  takePhoto: async () => null,
  pickPhoto: async () => null,
  pickPdf: async () => null,
  openSettings: () => undefined,
};

function server(): FakeServer {
  const full = { document: KP_ROW, version: KP_VERSION, needs_profile: false };
  return happyServer()
    .on('GET /documents', () => ({ status: 200, body: { documents: [KP_ROW], next_before: null } }))
    .on('GET /documents/doc-1', () => ({ status: 200, body: full }))
    .on('GET /documents/doc-1/versions', () => ({ status: 200, body: { versions: [{ n: 1, author: 'initial', created_at: iso(), total: '124560000.00', sent: false }] } }))
    .on('GET /documents/doc-1/versions/1', () => ({ status: 200, body: { version: KP_VERSION } }))
    .on('GET /company-profile', () => ({ status: 200, body: { profile: { name: null, bin_iin: null, version: 0, complete: false, bank: {}, contacts: {} } } }))
    .on('GET /price-lists/items', () => ({ status: 200, body: { items: [], next_offset: null } }))
    .on('GET /price-lists/history', () => ({ status: 200, body: { items: [] } }))
    .on('GET /page-templates', () => ({ status: 200, body: { templates: [] } }))
    .on('GET /collections', () => ({ status: 200, body: { collections: [] } }))
    .on('GET /duplicates/groups', () => ({ status: 200, body: { groups: [] } }));
}

/** Pages of every template with long rows, big spendings, a КП, a statement and a draft. */
async function seed(): Promise<Record<string, Page>> {
  const pages: Record<string, Page> = {};
  for (const key of ['notes', 'tasks', 'shopping', 'documents', 'expenses', 'custom'] as const) {
    pages[key] = await serverPage(key, [LONG, 'Молоко 2 л', `${LONG} ${LONG}`]);
  }
  useExpenses.getState().set({
    entries: {
      e1: expense('e1', '389990.00', { review_fields: ['amount'] }),
      e2: expense('e2', '999999999.99'),
      e3: expense('e3', '1240000.00', { currency: 'USD' }),
    },
    statements: {
      'st-1': statementOut({
        id: 'st-1', client_id: null, item_id: 'srv-pdf', status: 'proposed', bank: 'kaspi_gold', parser: 'template', currency: 'KZT',
        period: { from: '2026-10-01', to: '2026-10-31' }, rows_found: 86, rows_new: 82, rows_existing: 4, rows_similar: 1,
        check: { ok: true, lines: [{ key: 'purchases', title: 'Покупки', bank: '-12450990.00', ours: '-12450990.00', ok: true }] },
        adds: { count: 82, spent: '12450990.00', income: '0', refund: '0' }, summary_ru: 'Нашёл 86 операций за октябрь, 4 уже есть',
        error: null, pending_action_id: 'pa-1', action_id: null, created_at: iso(), decided_at: null,
      })!,
    },
  });
  kpSink.apply({
    documents: [documentOut(KP_ROW) as DocumentOut],
    prices: [],
    drafts: [{ id: 'dr-1', client_id: null, channel: 'whatsapp', recipient_name: 'Ерлан Сейткалиевич', subject: null, text: LONG, request_text: null, document_id: 'doc-1', status: 'draft', review_fields: ['text'], pending_action_id: 'pa-1', ai_generated: true, sent_at: null, version: 1, seq: 5, created_at: null, updated_at: null, deleted_at: null }],
  });
  return pages;
}

type Case = { route: string; url: (p: Record<string, Page>) => string; onboarding?: boolean; prepare?: (p: Record<string, Page>) => void };

/** Every file under src/app (except layouts and +native-intent): the URL that shows it with data. */
const SCREENS: Case[] = [
  { route: '(main)/index', url: () => '/' },
  { route: '(main)/page/[id]', url: (p) => `/page/${p.notes!.id}` },
  { route: '(main)/record/[id]', url: (p) => `/record/notes-r0?from=${p.notes!.id}` },
  { route: '(main)/records', url: () => '/records' },
  { route: '(main)/more', url: () => '/more' },
  { route: '(main)/search', url: () => '/search?q=плитка' },
  { route: '(main)/trash', url: () => '/trash' },
  { route: '(main)/my-pages', url: () => '/my-pages' },
  { route: '(main)/stack/[id]', url: (p) => `/stack/col-1?from=${p.notes!.id}` },
  { route: '(main)/duplicates', url: () => '/duplicates' },
  { route: '(main)/import', url: () => '/import' },
  { route: '(onboarding)/welcome', url: () => '/welcome', onboarding: true },
  { route: '(onboarding)/consent', url: () => '/consent', onboarding: true },
  { route: '(onboarding)/start', url: () => '/start', onboarding: true },
  { route: '(onboarding)/phrase', url: () => '/phrase', onboarding: true },
  { route: '(onboarding)/gallery', url: () => '/gallery', onboarding: true },
  { route: 'account-consent', url: () => '/account-consent' },
  { route: 'account-deleting', url: () => '/account-deleting' },
  { route: 'alarm-setup', url: () => '/alarm-setup' },
  { route: 'alarm', url: () => '/alarm?group=g1' },
  { route: 'chat', url: () => '/chat' },
  { route: 'company', url: () => '/company' },
  { route: 'delete-account', url: () => '/delete-account' },
  { route: 'did', url: () => '/did' },
  { route: 'draft/new', url: () => '/draft/new?doc=doc-1' },
  { route: 'draft/[id]', url: () => '/draft/dr-1' },
  { route: 'habits', url: () => '/habits' },
  { route: 'kp/new', url: () => '/kp/new' },
  { route: 'kp/prices', url: () => '/kp/prices?doc=doc-1' },
  { route: 'kp/send', url: () => '/kp/send?doc=doc-1' },
  { route: 'kp/version', url: () => '/kp/version?doc=doc-1&n=1' },
  { route: 'kp/versions', url: () => '/kp/versions?doc=doc-1' },
  { route: 'kp/[id]', url: () => '/kp/doc-1' },
  { route: 'my-data', url: () => '/my-data' },
  { route: 'notify', url: () => '/notify' },
  { route: 'page-settings/[id]', url: (p) => `/page-settings/${p.custom!.id}` },
  { route: 'pages-gallery', url: () => '/pages-gallery' },
  { route: 'phone', url: () => '/phone' },
  { route: 'price-list', url: () => '/price-list' },
  { route: 'receipt', prepare: () => setMediaForTests(fakeMedia), url: (p) => `/receipt?page=${p.expenses!.id}` },
  { route: 'reminder-new', url: () => `/reminder-new?text=${encodeURIComponent(LONG)}` },
  { route: 'statement/[id]', url: () => '/statement/st-1' },
];

/** Every tool of the view registry, on its page (the board as `notes` in board mode). */
const TOOLS: { view: string; template: Page['templateKey']; layout: string; board?: boolean }[] = [
  { view: 'custom:list', template: 'custom', layout: 'list' },
  { view: 'custom:checklist', template: 'custom', layout: 'checklist' },
  { view: 'custom:table', template: 'custom', layout: 'table' },
  { view: 'notes:builtin:notes_board', template: 'notes', layout: 'builtin:notes_board' },
  { view: 'notes:builtin:notes_board', template: 'notes', layout: 'builtin:notes_board', board: true },
  { view: 'tasks:builtin:planner', template: 'tasks', layout: 'builtin:planner' },
  { view: 'shopping:builtin:shopping', template: 'shopping', layout: 'builtin:shopping' },
  { view: 'expenses:builtin:expenses', template: 'expenses', layout: 'builtin:expenses' },
  { view: 'documents:builtin:kp', template: 'documents', layout: 'builtin:kp' },
  { view: 'notes:stacks', template: 'notes', layout: 'stacks' },
  { view: 'tasks:builtin:tasks', template: 'tasks', layout: 'builtin:tasks' },
  { view: 'shopping:checklist', template: 'shopping', layout: 'checklist' },
  { view: 'list', template: 'notes', layout: 'list' },
];

function routeFiles(dir = APP_DIR, base = ''): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) return routeFiles(path.join(dir, e.name), rel);
    if (!/\.tsx$/.test(e.name) || e.name === '_layout.tsx' || e.name.startsWith('+')) return [];
    return [rel.replace(/\.tsx$/, '')];
  });
}

async function show(url: string, onboarding = false): Promise<Record<string, Page>> {
  const s = server();
  resetApp({ fetch: s.fetch });
  if (onboarding) {
    useOnboarding.getState().markWelcomeSeen(false);
    if (!url.startsWith('/welcome') && !url.startsWith('/consent')) useOnboarding.getState().acceptConsent('full');
  } else finishOnboarding('full');
  const pages = await seed();
  return pages;
}

async function audit(): Promise<string[]> {
  // Let fetches, the outbox and the first sync answer (fake timers under renderRouter).
  for (let i = 0; i < 25; i++) await act(async () => void (await jest.advanceTimersByTimeAsync(40)));
  return auditLayout(screen.toJSON(), { critical: criticalTexts(), allow: ALLOW, windowWidth: NARROW.width }).map(
    (v) => `${v.rule} @ ${v.where}: ${v.detail}`,
  );
}

afterEach(() => {
  resetWindow();
  setMediaForTests(null);
});

describe('every screen is covered', () => {
  it('each route under src/app has a 200% case', () => {
    expect(routeFiles().sort()).toEqual(SCREENS.map((c) => c.route).sort());
  });
  it('each tool of the view registry has a 200% case', () => {
    expect([...new Set(TOOLS.map((t) => t.view))].sort()).toEqual(registeredViewKeys().sort());
  });
});

describe.each(['ru', 'kk'] as const)('200%, 320 pt, %s', (lang) => {
  it.each(SCREENS.map((c) => [c.route, c] as const))('screen %s', async (_r, c) => {
    setWindow({ fontScale: 2, ...NARROW });
    const pages = await show(c.onboarding ? c.url({}) : '/', c.onboarding);
    useOnboarding.getState().setLanguage(lang);
    await act(async () => void (await i18n.changeLanguage(lang)));
    c.prepare?.(pages);
    await renderRouter(APP_DIR, { initialUrl: c.url(pages) });
    expect(await audit()).toEqual([]);
  });

  it.each(TOOLS.map((t) => [`${t.view}${t.board ? ' (board)' : ''}`, t] as const))('tool %s', async (_n, tool) => {
    setWindow({ fontScale: 2, ...NARROW });
    const pages = await show('/');
    useOnboarding.getState().setLanguage(lang);
    await act(async () => void (await i18n.changeLanguage(lang)));
    const page = pages[tool.template]!;
    const look = { ...page, layout: tool.layout as Page['layout'], view: { ...EMPTY_VIEW, ...page.view, ...(tool.board ? { mode: 'board' } : {}) } } as Page;
    const lookSet = { layout: look.layout, icon: look.icon, view: look.view ?? EMPTY_VIEW };
    usePages.getState().setLook(page.id, lookSet);
    await testPages.setLook(page.id, lookSet, false);
    const key = resolveView(look).key;
    expect(key === tool.view || key === `${tool.template}:${tool.view}`).toBe(true);
    await renderRouter(APP_DIR, { initialUrl: `/page/${page.id}` });
    const found = await audit();
    expect(screen.queryByTestId(`page-view-${key}`)).toBeTruthy();
    expect(found).toEqual([]);
  });
});
