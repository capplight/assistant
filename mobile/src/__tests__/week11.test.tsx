import { act, fireEvent, renderRouter, screen, within } from 'expo-router/testing-library';
import { Dimensions } from 'react-native';

import { actionOut, customFieldsOf, FEATURE_DEFAULTS, fieldPrefsOf, itemFacetsOf, pagePatchOut, pageViewOut } from '@/api/endpoints';
import { effectiveLayout, resolveView } from '@/components/page/registry';
import type { InMemoryOutboxRepository } from '@/db';
import { useDedup } from '@/dedup/store';
import i18n from '@/i18n';
import { catalogTemplate } from '@/pages/catalog';
import { facetKey, formatMoney, moneyToMinor, useFacets } from '@/pages/facets';
import { applyChange, EMPTY_VIEW, fieldsOf, sortFromServer, viewBody, type Look } from '@/pages/viewModel';
import { getSyncEngine } from '@/services';
import { usePages, type Page } from '@/store/pages';
import { useUndo } from '@/store/undo';
import { useFeatureStore } from '@/store/features';
import { FEATURES_BODY, happyServer, itemOut, linkOut, pageOut, type FakeServer, type SseEvent } from '@/testing/fakeServer';
import { APP_DIR, finishOnboarding, resetApp, settle, testPages, testRecords } from '@/testing/helpers';

/**
 * Week 11 (template-screens 2.6, 2.8, 3, 6; docs/api/views.md, stacks.md, duplicates.md as of
 * 2026-11-09): `PageFrame` + the view registry, S38 «Настроить страницу» through `POST
 * /pages/{id}/view`, the notebook of «Своя страница», «Простой список», the assistant's view
 * change with «Что изменилось» / «Отменить» (`keys`), «Сделать стопку страницей», and the week 10
 * alignment (batch merge, «Это разные» with «Отменить», the strip on S30).
 * Fake server only: nothing here ran against the real server or on a phone.
 */

const iso = (ms: number) => new Date(ms).toISOString();
const t = i18n.t.bind(i18n);

function action(id: string, summary: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    kind: 'screen_view_change',
    scope: 'internal',
    initiated_by: 'user',
    summary: { ru: summary, kk: null },
    page: null,
    changes: [],
    changed_item_ids: [],
    created_page_id: null,
    undoable: true,
    undoable_until: iso(Date.now() + 30 * 86_400_000),
    undone_at: null,
    undo_of: null,
    message_id: null,
    seq: 10,
    created_at: iso(Date.now()),
    ...extra,
  };
}

const undoBody = (id: string) => ({
  action: { ...action(id, 'x'), undoable: false, undone_at: iso(Date.now()) },
  undo: null,
  partial: false,
  repeated: false,
  message_ru: null,
  page_patches: [],
});

/** S38 in full (fields, sort, reset) is behind `page_settings_full` (Ф-40); the S38 tests turn it on. */
let fullSettings = false;

function server(): FakeServer {
  const s = happyServer();
  if (fullSettings) s.on('GET /features', () => ({ status: 200, body: { ...FEATURES_BODY, page_settings_full: true } }));
  s.on('POST /actions/*/undo', (c) => ({ status: 200, body: undoBody(c.path.split('/')[2]!) }))
    .on('GET /actions', () => ({ status: 200, body: { actions: [], has_more: false } }))
    .on('GET /page-templates', () => ({ status: 200, body: { templates: [] } }))
    .on('GET /collections', () => ({ status: 200, body: { collections: [] } }))
    .on('GET /duplicates/groups', () => ({ status: 200, body: { groups: [] } }))
    .on('POST /duplicates/cleanup/plan', () => ({ status: 200, body: { pending_action: null, near_groups: [] } }));
  return s;
}

async function online(s: FakeServer): Promise<InMemoryOutboxRepository> {
  const outbox = resetApp({ fetch: s.fetch });
  if (fullSettings) useFeatureStore.getState().set({ ...FEATURE_DEFAULTS, page_settings_full: true });
  finishOnboarding('full');
  await (await getSyncEngine()).run();
  return outbox;
}

/** «Ремонт» (Своя страница) on the server with two records. */
async function customPage(layout = 'list'): Promise<Page> {
  const page = usePages.getState().addPage('custom', 'Ремонт')!;
  const synced: Page = { ...page, serverId: 'srv-rem', syncState: 'synced', layout: layout as Page['layout'] };
  usePages.setState((st) => ({ pages: st.pages.map((p) => (p.id === page.id ? synced : p)) }));
  await testPages.insertLocal(synced);
  for (const [i, id] of ['r1', 'r2'].entries()) {
    await testRecords.applyRemote(itemOut(id, 50 + i, { text: i === 0 ? 'Плитка' : 'Грунтовка', status: 'ready' }));
    await testPages.applyLink(linkOut('srv-rem', `srv-${id}`, 60 + i, { position: i === 0 ? 'U' : 'W' }));
  }
  return synced;
}

const pageNow = (id: string) => usePages.getState().pages.find((p) => p.id === id)!;
const stripText = () => {
  const s = useUndo.getState().strip;
  return s?.kind === 'custom' ? s.text : null;
};

describe('contract decoding (views.md, stacks.md, duplicates.md)', () => {
  it('a view answer, prefs and own fields, page_view in a patch, item_facets, a change row with a key', () => {
    const out = pageViewOut({
      page: pageOut('c', 3, { layout: 'table', field_prefs: [{ field_id: 'date', visible: false }], custom_fields: [{ id: 'c_1', title: 'Мастер', type: 'text' }] }),
      changed: true,
      repeated: false,
      action: action('a1', 'Вид: Список → Таблица.'),
      page_patch: { page_id: 'srv-c', view_version: 4, rows: [], removed_item_ids: [], page_view: { layout: 'table' } },
    });
    expect(out.page?.layout).toBe('table');
    expect(out.page?.field_prefs).toEqual([{ field_id: 'date', visible: false, order: 0 }]);
    expect(out.page?.custom_fields?.[0]).toMatchObject({ id: 'c_1', title: 'Мастер', type: 'text' });
    expect(out.page_patch?.layout).toBe('table');
    expect(fieldPrefsOf([{ id: 'x' }, null])).toEqual([{ field_id: 'x', visible: true, order: 0 }]);
    expect(customFieldsOf([{ id: 'c', title: 'Т', type: 'weird' }])[0]?.type).toBe('text');
    expect(pagePatchOut({ page_id: 'p', page_view: { field_prefs: [], custom_fields: [] } })?.custom_fields).toEqual([]);
    expect(itemFacetsOf([{ id: 'f', page_id: 'p', item_id: 'i', data: { c_1: 'Сергей' }, seq: 3 }])).toEqual([
      { id: 'f', page_id: 'p', item_id: 'i', data: { c_1: 'Сергей' }, seq: 3 },
    ]);
    const a = actionOut(action('a2', 's', { changes: [{ item_id: null, key: 'p:layout', kind: 'view', text: 'Вид: Список → Таблица', page_id: 'p', reverted: false }] }));
    expect(a?.changes[0]?.key).toBe('p:layout');
  });
});

describe('the view model: one rule for S38 and the assistant', () => {
  const tpl = catalogTemplate('custom');
  const look: Look = { layout: 'list', icon: 'other', view: EMPTY_VIEW };

  it('the field order of views.md: prefs first, the rest after; ★ always shown', () => {
    const view = { ...EMPTY_VIEW, fieldPrefs: [{ field_id: 'date', visible: true, order: 0 }, { field_id: 'title', visible: false, order: 1 }] };
    expect(fieldsOf(tpl, view).map((f) => [f.id, f.visible])).toEqual([
      ['date', true],
      ['title', true],
      ['text', true],
    ]);
  });

  it('★ cannot be hidden; at most 5 own fields; the body has only what changed', () => {
    expect(applyChange(tpl, look, { kind: 'field_visible', fieldId: 'title', visible: false }, 'other')).toEqual({ error: 'field_required' });
    let l = look;
    for (let i = 0; i < 5; i++) {
      const r = applyChange(tpl, l, { kind: 'custom_add', field: { id: `c${i}`, title: `П${i}`, type: 'text' } }, 'other');
      if ('error' in r) throw new Error(r.error);
      l = r.look;
    }
    expect(applyChange(tpl, l, { kind: 'custom_add', field: { id: 'c6', title: 'Шестое', type: 'text' } }, 'other')).toEqual({ error: 'custom_limit' });
    const hidden = applyChange(tpl, look, { kind: 'field_visible', fieldId: 'date', visible: false }, 'other');
    if ('error' in hidden) throw new Error(hidden.error);
    expect(viewBody({ kind: 'field_visible', fieldId: 'date', visible: false }, hidden.look)).toEqual({
      fields: [
        { field_id: 'title', visible: true },
        { field_id: 'text', visible: true },
        { field_id: 'date', visible: false },
      ],
    });
    expect(viewBody({ kind: 'custom_add', field: { id: 'x', title: ' Мастер ', type: 'money' } }, look)).toEqual({ add_fields: [{ id: 'x', title: 'Мастер', type: 'money' }] });
    expect(viewBody({ kind: 'sort', sort: 'oldest' }, { ...look, view: { ...EMPTY_VIEW, sort: 'oldest' } })).toEqual({ sort: 'date', sort_dir: 'asc' });
    expect(viewBody({ kind: 'reset' }, look)).toEqual({ reset: true });
    expect(sortFromServer('date', undefined)).toBe('newest');
    expect(sortFromServer('position', 'asc')).toBeNull();
  });

  it('«Сумма ₸» is counted by code in tiyn', () => {
    expect(moneyToMinor('48 500')).toBe(4_850_000);
    expect(moneyToMinor('6200,5')).toBe(620_050);
    expect(moneyToMinor('abc')).toBeNull();
    expect(formatMoney(5_470_000)).toBe('54 700 ₸');
  });
});

describe('PageFrame and the registry', () => {
  it('each template gets its middle; «Простой список» everywhere; an unknown layout falls back to the tool', () => {
    resetApp();
    const base = usePages.getState().pages[0]!;
    const as = (templateKey: Page['templateKey'], layout: string) => ({ ...base, templateKey, layout: layout as Page['layout'] });
    expect(resolveView(as('custom', 'table')).key).toBe('custom:table');
    expect(resolveView(as('notes', 'stacks')).key).toBe('notes:stacks');
    expect(resolveView(as('tasks', 'list')).key).toBe('tasks:list');
    expect(effectiveLayout(as('expenses', 'checklist'))).toBe('builtin:expenses');
  });

  it('the same edges on every page: title, «Порядок», «Настроить», «Найти»; «Простой список» drops the tool parts', async () => {
    const s = server();
    await online(s);
    const notes = usePages.getState().pages.find((p) => p.templateKey === 'notes')!;
    await testRecords.applyRemote(itemOut('n1', 70, { text: 'Код домофона 4512', status: 'ready' }));
    await renderRouter(APP_DIR, { initialUrl: `/page/${notes.id}` });
    await settle(() => screen.queryByTestId('record-n1') !== null);
    // One header line (ux-audit P0-2): the title, 🔍 and ⋯; «Порядок» and «Настроить» are in ⋯; the field opens on 🔍.
    for (const id of ['page-title', 'page-search', 'page-menu']) expect(screen.getByTestId(id)).toBeTruthy();
    for (const id of ['page-order', 'page-settings', 'page-find']) expect(screen.queryByTestId(id)).toBeNull();
    await fireEvent.press(screen.getByTestId('page-menu'));
    expect(screen.getByTestId('page-order')).toBeTruthy();
    expect(screen.getByTestId('page-settings')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('page-menu-sheet-close'));
    await fireEvent.press(screen.getByTestId('page-search'));
    expect(screen.getByTestId('page-find')).toBeTruthy();
    // Week 11а: the sticker wall is the default of «Заметки».
    expect(screen.getByTestId('page-view-notes:builtin:notes_board')).toBeTruthy();
    expect(screen.getByTestId('sticker-n1')).toBeTruthy();
    await act(async () => usePages.getState().setLook(notes.id, { layout: 'list', icon: notes.icon, view: EMPTY_VIEW }));
    await settle(() => screen.queryByTestId('page-view-notes:list') !== null);
    expect(screen.queryByTestId('sticker-n1')).toBeNull();
    expect(screen.getByTestId('record-n1')).toBeTruthy();
  });
});

describe('S38 «Настроить страницу»', () => {
  beforeEach(() => {
    fullSettings = true;
  });
  afterEach(() => {
    fullSettings = false;
  });

  it('Ф-40: with `page_settings_full` off only the name, the icon and the view', async () => {
    fullSettings = false;
    await online(server());
    const page = await customPage('table');
    await renderRouter(APP_DIR, { initialUrl: `/page-settings/${page.id}` });
    await settle(() => screen.queryByTestId('settings-name') !== null);
    expect(screen.getByTestId('settings-icon-home')).toBeTruthy();
    expect(screen.getByTestId('settings-layout-list')).toBeTruthy();
    for (const id of ['settings-example', 'settings-field-title', 'settings-add-field', 'settings-sort', 'settings-group', 'settings-reset'])
      expect(screen.queryByTestId(id)).toBeNull();
  });

  it('★ has a lock; hiding a field is at once, offline, with «Отменить» that drops it from the outbox', async () => {
    const s = server();
    const outbox = await online(s);
    const page = await customPage();
    s.offline = true;
    await renderRouter(APP_DIR, { initialUrl: `/page-settings/${page.id}` });
    await settle(() => screen.queryByTestId('settings-field-title') !== null);
    expect(screen.getByTestId('settings-field-lock-title')).toHaveTextContent('Нужно для работы — скрыть нельзя');
    expect(screen.queryByTestId('settings-field-toggle-title')).toBeNull();
    await fireEvent.press(screen.getByTestId('settings-field-toggle-date'));
    await settle(() => outbox.all().some((e) => e.kind === 'page.view'));
    expect(fieldsOf(catalogTemplate('custom'), pageNow(page.id).view).find((f) => f.id === 'date')?.visible).toBe(false);
    expect(screen.queryByTestId('settings-example-date')).toBeNull();
    await settle(() => screen.queryByTestId('undo-strip-text') !== null);
    expect(screen.getByTestId('undo-strip-text')).toHaveTextContent('Скрыл поле «Дата»');
    await fireEvent.press(screen.getByTestId('undo-strip-undo'));
    await settle(() => outbox.all().find((e) => e.kind === 'page.view')?.status === 'failed');
    await settle(() => fieldsOf(catalogTemplate('custom'), pageNow(page.id).view).find((f) => f.id === 'date')?.visible === true);
    expect(s.callsTo('POST /pages/srv-rem/view')).toHaveLength(0);
  });

  it('online: an own field goes as `add_fields`, the server page wins, «Отменить» is the undo of its action', async () => {
    const s = server();
    s.on('POST /pages/*/view', (c) => ({
      status: 200,
      body: {
        page: pageOut(null, 90, { id: 'srv-rem', title: 'Ремонт', custom_fields: [{ id: 'c_9f', title: 'Мастер', type: 'text', set_by: 'user' }], view_version: 4 }),
        changed: true,
        repeated: false,
        action: action('av1', 'Новое поле «Мастер» (Текст).'),
        page_patch: { page_id: 'srv-rem', view_version: 4, rows: [], removed_item_ids: [] },
        _body: c.body,
      },
    }));
    const outbox = await online(s);
    const page = await customPage();
    await renderRouter(APP_DIR, { initialUrl: `/page-settings/${page.id}` });
    await settle(() => screen.queryByTestId('settings-add-field') !== null);
    expect(screen.getByTestId('settings-own-count')).toHaveTextContent('Своих полей: 0 из 5');
    await fireEvent.press(screen.getByTestId('settings-add-field'));
    await fireEvent.changeText(screen.getByTestId('add-field-name'), 'Мастер');
    await fireEvent.press(screen.getByTestId('add-field-add'));
    await settle(() => s.callsTo('POST /pages/srv-rem/view').length === 1);
    const sent = s.callsTo('POST /pages/srv-rem/view')[0]!.body as { add_fields: { id: string }[] };
    expect(sent).toMatchObject({ client_id: expect.any(String), add_fields: [{ title: 'Мастер', type: 'text' }] });
    // The phone names the field itself, so values typed offline map to it (views.md).
    expect(sent.add_fields[0]!.id).toMatch(/^c_[0-9a-f]{32}$/);
    await settle(() => pageNow(page.id).view?.customFields[0]?.id === 'c_9f');
    await settle(() => (outbox.all().find((e) => e.kind === 'page.view')?.payload as { actionId?: string }).actionId === 'av1');
    await fireEvent.press(screen.getByTestId('undo-strip-undo'));
    await settle(() => s.callsTo('POST /actions/av1/undo').length === 1);
  });

  it('«Вернуть как было» asks first (S25, «Нет» first), then `reset: true`', async () => {
    const s = server();
    s.on('POST /pages/*/view', () => ({ status: 200, body: { page: pageOut(null, 91, { id: 'srv-rem', title: 'Ремонт' }), changed: true, repeated: false, action: action('ar', 'Вернул страницу «Ремонт» как было.', { kind: 'screen_reset' }), page_patch: null } }));
    await online(s);
    const page = await customPage('table');
    await renderRouter(APP_DIR, { initialUrl: `/page-settings/${page.id}` });
    await settle(() => screen.queryByTestId('settings-reset') !== null);
    await fireEvent.press(screen.getByTestId('settings-reset'));
    const sheet = screen.getByTestId('confirm-sheet');
    expect(within(sheet).getByText('Вернуть страницу как было?')).toBeTruthy();
    expect(s.callsTo('POST /pages/srv-rem/view')).toHaveLength(0);
    await fireEvent.press(screen.getByTestId('confirm-yes'));
    await settle(() => s.callsTo('POST /pages/srv-rem/view').length === 1);
    expect(s.callsTo('POST /pages/srv-rem/view')[0]!.body).toMatchObject({ reset: true });
    expect(pageNow(page.id).layout).toBe('list');
  });

  it('the views offered: the tool (week 11а: the planner), the older view, «Простой список»', async () => {
    const s = server();
    await online(s);
    const tasks = usePages.getState().pages.find((p) => p.templateKey === 'tasks')!;
    await renderRouter(APP_DIR, { initialUrl: `/page-settings/${tasks.id}` });
    await settle(() => screen.queryByTestId('settings-layout-list') !== null);
    expect(screen.getByTestId('settings-layout-builtin:planner')).toHaveTextContent(/Ежедневник/);
    expect(screen.getByTestId('settings-layout-builtin:planner').props.accessibilityState).toMatchObject({ checked: true });
    expect(screen.getByTestId('settings-layout-builtin:tasks')).toBeTruthy();
    expect(screen.getByTestId('settings-layout-list')).toHaveTextContent(/Простой список/);
  });
});

describe('«Своя страница» — the notebook', () => {
  it('[Список | Чек-лист | Таблица] on the page; a table with an own column, «Итого» by code; a cell is edited in a sheet', async () => {
    const s = server();
    s.on('POST /pages/*/view', () => ({ status: 200, body: { page: null, changed: true, repeated: false, action: action('al', 'Вид: Список → Таблица.'), page_patch: null } }))
      .on('PATCH /pages/*/items/*', () => ({ status: 200, body: { values: { c_sum: 48500 }, repeated: false, action: action('af', 'Записал', { kind: 'facet_edit' }), page_patch: null } }));
    const outbox = await online(s);
    const page = await customPage();
    const look = { layout: 'list' as const, icon: 'home' as const, view: { ...EMPTY_VIEW, customFields: [{ id: 'c_sum', title: 'Сумма', type: 'money' as const, order: 0, visible: true }] } };
    usePages.getState().setLook(page.id, look);
    await testPages.setLook(page.id, look, false);
    useFacets.getState().set(facetKey(page.id, 'r2'), { c_sum: '6 200' });
    await renderRouter(APP_DIR, { initialUrl: `/page/${page.id}` });
    await settle(() => screen.queryByTestId('notebook-mode-table') !== null);
    expect(screen.getByTestId('page-view-custom:list')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('notebook-mode-table'));
    await settle(() => screen.queryByTestId('notebook-table-head') !== null);
    expect(screen.getByTestId('undo-strip-text')).toHaveTextContent('Вид: Таблица');
    await settle(() => s.callsTo('POST /pages/srv-rem/view').length === 1);
    expect(s.callsTo('POST /pages/srv-rem/view')[0]!.body).toMatchObject({ layout: 'table' });
    expect(screen.getByTestId('notebook-total-c_sum')).toHaveTextContent('Итого «Сумма»: 6 200 ₸');
    await fireEvent.press(screen.getByTestId('notebook-cell-r1-c_sum'));
    await fireEvent.changeText(screen.getByTestId('field-value-input'), '48 500');
    await fireEvent.press(screen.getByTestId('field-value-save'));
    await settle(() => screen.getByTestId('notebook-total-c_sum').props.children === `Итого «Сумма»: ${formatMoney(5_470_000)}`);
    await settle(() => s.callsTo('PATCH /pages/srv-rem/items/srv-r1').length === 1);
    expect(s.callsTo('PATCH /pages/srv-rem/items/srv-r1')[0]!.body).toMatchObject({ values: { c_sum: '48 500' } });
    expect(outbox.all().some((e) => e.kind === 'page.item_fields')).toBe(true);
  });

  it('the checklist tick: at once, through the outbox as `done`, «Отменить» while waiting drops it; ticks come from sync', async () => {
    const s = server();
    const outbox = await online(s);
    const page = await customPage('checklist');
    s.offline = true;
    await renderRouter(APP_DIR, { initialUrl: `/page/${page.id}` });
    await settle(() => screen.queryByTestId('notebook-check-r1') !== null);
    await fireEvent.press(screen.getByTestId('notebook-check-r1'));
    await settle(() => outbox.all().some((e) => e.kind === 'page.item_fields'));
    expect(screen.getByTestId('notebook-check-r1').props.accessibilityState).toMatchObject({ checked: true });
    expect(stripText()).toBe('Отметил: Плитка');
    await act(async () => {
      const st = useUndo.getState().strip;
      if (st?.kind === 'custom') st.onUndo();
    });
    expect(screen.getByTestId('notebook-check-r1').props.accessibilityState).toMatchObject({ checked: false });
    await settle(() => outbox.all().find((e) => e.kind === 'page.item_fields')?.status === 'failed');
    // Online: the tick goes as `done` on the row.
    s.offline = false;
    s.on('PATCH /pages/*/items/*', () => ({ status: 200, body: { link: linkOut('srv-rem', 'srv-r2', 80, { done_at: iso(Date.now()) }), values: {}, repeated: false, action: action('at', 'Отметил: Грунтовка', { kind: 'facet_edit' }), page_patch: null } }));
    await fireEvent.press(screen.getByTestId('notebook-check-r2'));
    await settle(() => s.callsTo('PATCH /pages/srv-rem/items/srv-r2').length === 1);
    expect(s.callsTo('PATCH /pages/srv-rem/items/srv-r2')[0]!.body).toEqual({ client_id: expect.any(String), done: true });
    // Another phone ticked r1: it comes as `done_at` on the row in /sync.
    s.on('GET /sync', () => ({ status: 200, body: { items: [], screen_items: [linkOut('srv-rem', 'srv-r1', 95, { position: 'U', done_at: iso(Date.now()) })], tombstones: [], next_since: 95, has_more: false } }));
    await act(async () => {
      await (await getSyncEngine()).run();
    });
    await settle(() => screen.getByTestId('notebook-check-r1').props.accessibilityState?.checked === true);
  });

  it('a rename in S38 has «Отменить»: `PATCH /pages/{id}` with `client_id`, then the undo of its action', async () => {
    const s = server();
    s.on('PATCH /pages/*', () => ({ status: 200, body: { ...pageOut(null, 97, { id: 'srv-rem', title: 'Дача' }), action: action('arn', 'Переименовал страницу в «Дача»', { kind: 'screen_customize' }) } }));
    const outbox = await online(s);
    const page = await customPage();
    await renderRouter(APP_DIR, { initialUrl: `/page-settings/${page.id}` });
    await settle(() => screen.queryByTestId('settings-name') !== null);
    await fireEvent.changeText(screen.getByTestId('settings-name'), 'Дача');
    await fireEvent(screen.getByTestId('settings-name'), 'submitEditing');
    await settle(() => screen.queryByTestId('undo-strip-text') !== null);
    expect(screen.getByTestId('undo-strip-text')).toHaveTextContent('Переименовал страницу в «Дача»');
    await settle(() => s.callsTo('PATCH /pages/srv-rem').length === 1);
    expect(s.callsTo('PATCH /pages/srv-rem')[0]!.body).toEqual({ title: 'Дача', client_id: expect.any(String) });
    await settle(() => (outbox.all().find((e) => e.kind === 'pages.update')?.payload as { actionId?: string }).actionId === 'arn');
    await fireEvent.press(screen.getByTestId('undo-strip-undo'));
    await settle(() => s.callsTo('POST /actions/arn/undo').length === 1);
    expect(pageNow(page.id).title).toBe('Ремонт');
  });

  it('at a large font (≥150%) the table is cards, one field per line, and the switch is «Вид ▾»', async () => {
    const spy = jest.spyOn(Dimensions, 'get').mockImplementation(() => ({ width: 360, height: 640, scale: 2, fontScale: 2 }));
    try {
      const s = server();
      await online(s);
      const page = await customPage('table');
      await renderRouter(APP_DIR, { initialUrl: `/page/${page.id}` });
      await settle(() => screen.queryByTestId('notebook-card-r1') !== null);
      expect(screen.queryByTestId('notebook-table-head')).toBeNull();
      expect(screen.queryByTestId('notebook-row-r1')).toBeNull();
      expect(within(screen.getByTestId('notebook-card-r1')).getByTestId('notebook-cell-r1-date')).toBeTruthy();
      expect(screen.queryByTestId('notebook-mode-table')).toBeNull();
      await fireEvent.press(screen.getByTestId('notebook-mode-menu'));
      await fireEvent.press(screen.getByTestId('notebook-mode-sheet-list'));
      await settle(() => pageNow(page.id).layout === 'list');
    } finally {
      spy.mockRestore();
    }
  });

  it('an empty notebook says what it is for, with three examples', async () => {
    resetApp();
    finishOnboarding('full');
    const page = usePages.getState().addPage('custom', 'Дача')!;
    await renderRouter(APP_DIR, { initialUrl: `/page/${page.id}` });
    await settle(() => screen.queryByTestId('page-empty') !== null);
    expect(within(screen.getByTestId('page-empty')).getByText('Чистая тетрадь')).toBeTruthy();
    expect(within(screen.getByTestId('page-empty')).getByText('«Сделай чек-лист»')).toBeTruthy();
  });
});

describe('the assistant changes a view (Ф-31): at once, «Что изменилось», «Отменить», «Вернуть» one setting', () => {
  const seqd = (events: Omit<SseEvent, 'id'>[]): SseEvent[] => events.map((e, i) => ({ ...e, id: i + 1 }));

  it('page_view in the patch changes the page; «Вернуть» on the setting row is `keys`', async () => {
    const s = server();
    const act1 = action('ag', 'Вид: Список → Таблица.', {
      initiated_by: 'agent',
      page: { id: 'srv-rem', title: 'Ремонт', icon: 'home' },
      changes: [{ item_id: null, key: 'srv-rem:layout', kind: 'view', title: 'Ремонт', text: 'Вид: Список → Таблица', page_id: 'srv-rem', reverted: false }],
    });
    s.on('POST /chat/messages', () => ({
      status: 200,
      sse: seqd([
        { event: 'accepted', data: { message_id: 'u1', reply_id: 'r1', created_at: iso(Date.now()) } },
        { event: 'action', data: { reply_id: 'r1', action: act1, changed_item_ids: [], page_id: 'srv-rem' } },
        { event: 'page_patch', data: { page_id: 'srv-rem', view_version: 5, view_state: {}, rows: [], removed_item_ids: [], page_view: { layout: 'table', icon: 'home', field_prefs: [], custom_fields: [] } } },
        { event: 'done', data: { reply_id: 'r1', state: 'done', answer_kind: 'action', action_id: 'ag', delivery: 'streamed', limited: false } },
      ]),
    }));
    await online(s);
    const page = await customPage();
    await renderRouter(APP_DIR, { initialUrl: `/page/${page.id}` });
    await settle(() => screen.queryByTestId('record-r1') !== null);
    await fireEvent.changeText(screen.getByTestId('assistant-input'), 'покажи таблицей');
    await fireEvent.press(screen.getByTestId('assistant-send'));
    await settle(() => screen.queryByTestId('page-view-custom:table') !== null);
    expect(within(screen.getByTestId('undo-strip')).getByText('Вид: Список → Таблица.')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('undo-strip-changes'));
    await fireEvent.press(screen.getByTestId('change-revert-key-0'));
    await settle(() => s.callsTo('POST /actions/ag/undo').length === 1);
    expect(s.callsTo('POST /actions/ag/undo')[0]!.body).toMatchObject({ keys: ['srv-rem:layout'] });
  });
});

describe('«Сделать стопку страницей» (founder addition)', () => {
  it('S11 → POST /collections/{id}/to-page → the new page opens; «Отменить» = the undo of its action', async () => {
    const s = server();
    const stack = { id: 'c1', title: 'Ремонт', title_kk: null, icon: 'home', page_id: 'srv-notes', group_key: 'Ремонт', item_count: 2, kind: 'smart', created_by: 'agent', seq: 4, updated_at: iso(Date.now()) };
    s.on('GET /collections', () => ({ status: 200, body: { collections: [stack] } })).on('POST /collections/*/to-page', () => ({
      status: 200,
      body: {
        page: pageOut(null, 99, { id: 'srv-new', template_key: 'custom', title: 'Ремонт', icon: 'home', position: 'z' }),
        records: 2,
        action: action('atp', 'Сделал страницу «Ремонт» из стопки', { kind: 'create_screen', created_page_id: 'srv-new' }),
        repeated: false,
      },
    }));
    await online(s);
    useDedup.getState().set({ collections: { c1: stack as never } });
    const r = await renderRouter(APP_DIR, { initialUrl: '/stack/c1' });
    await settle(() => screen.queryByTestId('stack-to-page') !== null);
    await fireEvent.press(screen.getByTestId('stack-to-page'));
    await settle(() => s.callsTo('POST /collections/c1/to-page').length === 1);
    await settle(() => usePages.getState().pages.some((p) => p.serverId === 'srv-new'));
    const made = usePages.getState().pages.find((p) => p.serverId === 'srv-new')!;
    await settle(() => r.getPathname() === `/page/${made.id}`);
    expect(stripText()).toBe('Сделал страницу «Ремонт» из стопки');
    await act(async () => {
      const st = useUndo.getState().strip;
      if (st?.kind === 'custom') st.onUndo();
    });
    await settle(() => s.callsTo('POST /actions/atp/undo').length === 1);
  });
});

describe('week 10 alignment', () => {
  const group = (id: string, a: string, b: string) => ({
    id,
    kind: 'near',
    status: 'suggested',
    keep_item_id: `srv-${a}`,
    keep_rule: 'most_complete',
    member_count: 2,
    members: [a, b].map((m, i) => ({ item_id: `srv-${m}`, role: i === 0 ? 'keep' : 'merge', score: 0.9, title: null, preview: `Текст ${m}`, kind: 'note', occurred_at: iso(Date.now()), visible: true })),
    seq: 5,
    created_at: iso(Date.now()),
  });

  it('«Объединить все отмеченные (N)»: one POST /duplicates/merge, one «Отменить»', async () => {
    const s = server();
    s.on('GET /duplicates/groups', () => ({ status: 200, body: { groups: [group('g1', 'a', 'b'), group('g2', 'c', 'd')] } })).on('POST /duplicates/merge', () => ({
      status: 200,
      body: { groups: [], action: action('am', 'Объединил повторы: 2 группы, убрал 2 повтора', { kind: 'merge_group' }), skipped_group_ids: [], repeated: false },
    }));
    await online(s);
    await renderRouter(APP_DIR, { initialUrl: '/duplicates' });
    await settle(() => screen.queryByTestId('dup-group-g2') !== null);
    expect(screen.queryByTestId('dup-merge-marked')).toBeNull();
    await fireEvent.press(screen.getByTestId('dup-mark-g1'));
    await fireEvent.press(screen.getByTestId('dup-keep-this-srv-d'));
    await fireEvent.press(screen.getByTestId('dup-mark-g2'));
    expect(screen.getByTestId('dup-merge-marked')).toHaveTextContent('Объединить все отмеченные (2)');
    await fireEvent.press(screen.getByTestId('dup-merge-marked'));
    await settle(() => s.callsTo('POST /duplicates/merge').length === 1);
    expect(s.callsTo('POST /duplicates/merge')[0]!.body).toMatchObject({ client_id: expect.any(String), groups: [{ id: 'g1' }, { id: 'g2', keep_item_id: 'srv-d' }] });
    expect(s.callsTo('POST /duplicates/groups/g1/merge')).toHaveLength(0);
    await settle(() => screen.queryByTestId('dup-group-g1') === null);
    expect(screen.getByTestId('undo-strip-text')).toHaveTextContent('Объединил повторы: 2 группы, убрал 2 повтора');
    await fireEvent.press(screen.getByTestId('undo-strip-undo'));
    await settle(() => s.callsTo('POST /actions/am/undo').length === 1);
  });

  it('«Это разные» is `dismiss_group` with «Отменить»', async () => {
    const s = server();
    s.on('GET /duplicates/groups', () => ({ status: 200, body: { groups: [group('g3', 'e', 'f')] } })).on('POST /duplicates/groups/*/dismiss', () => ({
      status: 200,
      body: { group: { ...group('g3', 'e', 'f'), status: 'dismissed', seq: 9 }, action: action('ad', 'Оставил 2 записи отдельно — это разные', { kind: 'dismiss_group' }), repeated: false },
    }));
    await online(s);
    await renderRouter(APP_DIR, { initialUrl: '/duplicates' });
    await settle(() => screen.queryByTestId('dup-group-g3') !== null);
    await fireEvent.press(screen.getByTestId('dup-different-g3'));
    await settle(() => screen.queryByTestId('undo-strip-text') !== null);
    expect(screen.getByTestId('undo-strip-text')).toHaveTextContent('Оставил 2 записи отдельно — это разные');
    await fireEvent.press(screen.getByTestId('undo-strip-undo'));
    await settle(() => s.callsTo('POST /actions/ad/undo').length === 1);
  });

  it('S30 sits outside the main area and shows its own «Отменить» strip now', async () => {
    const s = server();
    s.on('GET /habits', () => ({
      status: 200,
      body: { habits: [{ id: 'h1', kind: 'placement_rule', text_ru: 'Чеки кладу на страницу «Расходы»', page: null, envelope_type: 'receipt', evidence_count: 2, updated_at: iso(Date.now()) }] },
    })).on('DELETE /habits/*', () => ({ status: 200, body: { removed: true, repeated: false, action: action('ah', 'Больше не кладу чеки в «Расходы»', { kind: 'habit_change' }) } }));
    await online(s);
    await renderRouter(APP_DIR, { initialUrl: '/habits' });
    await settle(() => screen.queryByTestId('habit-h1') !== null);
    await fireEvent.press(screen.getByTestId('habit-remove-h1'));
    await settle(() => screen.queryByTestId('undo-strip-text') !== null);
    expect(screen.getByTestId('undo-strip-text')).toHaveTextContent('Больше не кладу чеки в «Расходы»');
    await fireEvent.press(screen.getByTestId('undo-strip-undo'));
    await settle(() => s.callsTo('POST /actions/ah/undo').length === 1);
    expect(t('view.settings')).toBe('Настроить');
  });
});
