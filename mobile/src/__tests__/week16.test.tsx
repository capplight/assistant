import { fireEvent, renderRouter, screen } from 'expo-router/testing-library';
import fs from 'fs';
import path from 'path';

import { useAccount } from '@/account/data';
import { setSharePortForTests } from '@/kp/share';
import { suggestedPages } from '@/pages/premarks';
import { useOnboarding } from '@/store/onboarding';
import { usePages } from '@/store/pages';
import { useTasks } from '@/tasks/store';
import { todayTiles } from '@/today/tiles';
import { happyServer, pageOut, tokenPair, type FakeServer } from '@/testing/fakeServer';
import { APP_DIR, fileWipes, finishOnboarding, resetApp, settle, testPages, testRecords } from '@/testing/helpers';
import { useUndo } from '@/store/undo';
import { setTodayTile } from '@/today/tileService';

/**
 * Week 16: first launch (onboarding.md), «Сегодня» tear-off sheet and tiles, «Скачать мои данные»
 * and account deletion (account.md), as of routes/onboarding.py, account.py, today.py 2026-11-12.
 * Fake server and synthetic data only: nothing here ran against the real server or on a phone.
 */

const iso = () => new Date().toISOString();
const DAY = 86_400_000;

type MarkCase = { phrase: string | null; intro_marks: string[] | null; template_keys: string[] };
const vectors = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../../docs/spec/vectors/onboarding-marks.json'), 'utf-8'),
) as { max_marked: number; cases: MarkCase[] };

describe('S35 ticks: the server rule run on the phone', () => {
  it.each(vectors.cases.map((c) => [c.phrase, c] as const))('%s', (_p, c) => {
    expect(suggestedPages(c.phrase, c.intro_marks, vectors.max_marked)).toEqual(c.template_keys);
  });
});

function batchServer(): FakeServer {
  const s = happyServer();
  let n = 0;
  s.on('POST /pages/batch', (c) => {
    const body = c.body as { path: string; template_keys: string[] };
    const keys = body.path === 'blank' ? ['custom'] : body.path === 'skipped' ? ['notes', 'tasks'] : body.template_keys;
    return {
      status: 201,
      body: {
        pages: keys.map((k) => pageOut(`b-${k}`, ++n, { id: `srv-page-${k}`, template_key: k, title: k })),
        existing: [],
        action: {
          id: 'act-batch', kind: 'create_screen', initiated_by: 'user', summary: { ru: `Добавил ${keys.length} страницы`, kk: null },
          changes: [], undoable: true, undone_at: null, created_at: iso(),
        },
        repeated: false,
      },
    };
  });
  s.on('GET /onboarding', () => ({
    status: 200,
    body: { default_path: 'phrase_first', paths_enabled: ['gallery', 'blank', 'phrase_first'], path: null, done_at: null, default_templates: ['notes', 'tasks'], max_marked: 3 },
  }));
  return s;
}

describe('first launch: S35 and the three paths', () => {
  let s: FakeServer;
  beforeEach(() => {
    s = batchServer();
    resetApp({ fetch: s.fetch });
    const o = useOnboarding.getState();
    o.markWelcomeSeen(false);
    o.acceptConsent('full');
  });

  it('path 3: the phrase ticks pages, «Сегодня» is locked on, «Подходит» needs ≥1, one POST /pages/batch', async () => {
    const r = await renderRouter(APP_DIR, { initialUrl: '/start' });
    await fireEvent.press(screen.getByTestId('start-phrase'));
    await fireEvent.changeText(screen.getByTestId('phrase-input'), 'Купить лекарства маме');
    await fireEvent.press(screen.getByTestId('phrase-send'));
    await fireEvent.press(screen.getByTestId('notify-next'));
    expect(r.getPathname()).toBe('/gallery');
    expect(screen.getByTestId('gallery-today')).toBeDisabled();
    expect(screen.getByTestId('gallery-notes')).toBeChecked();
    expect(screen.getByTestId('gallery-tasks')).toBeChecked();
    expect(screen.getByTestId('gallery-shopping')).toBeChecked();
    for (const k of ['notes', 'tasks', 'shopping']) await fireEvent.press(screen.getByTestId(`gallery-${k}`));
    expect(screen.getByTestId('gallery-ok')).toBeDisabled();
    await fireEvent.press(screen.getByTestId('gallery-notes'));
    await fireEvent.press(screen.getByTestId('gallery-ok'));
    expect(usePages.getState().pages.map((p) => p.templateKey)).toEqual(['notes']);
    await settle(() => s.callsTo('POST /pages/batch').length === 1);
    expect(s.callsTo('POST /pages/batch')[0]?.body).toMatchObject({ path: 'phrase_first', template_keys: ['notes'] });
    await settle(() => s.callsTo('POST /pages/batch').length === 1);
    expect((await testPages.listAll()).find((p) => p.templateKey === 'notes')?.serverId).toBe('srv-page-notes');
  });

  it('«Пропустить» on path 1 gives the default set (Заметки + Дела)', async () => {
    const r = await renderRouter(APP_DIR, { initialUrl: '/start' });
    await fireEvent.press(screen.getByTestId('start-all'));
    expect(screen.getByTestId('gallery-ok')).toBeDisabled(); // «Все шаблоны»: nothing ticked
    await fireEvent.press(screen.getByTestId('gallery-skip'));
    expect(usePages.getState().pages.map((p) => p.templateKey)).toEqual(['notes', 'tasks']);
    expect(r.getPathname()).toBe(`/page/${usePages.getState().pages[0]?.id}`);
    await settle(() => s.callsTo('POST /pages/batch').length === 1);
    expect(s.callsTo('POST /pages/batch')[0]?.body).toMatchObject({ path: 'gallery', template_keys: ['notes', 'tasks'] });
  });

  it('the team flag: «Все шаблоны» is the big card on top; a path switched off is not shown', async () => {
    useOnboarding.getState().setStartConfig({ defaultPath: 'gallery', pathsEnabled: ['gallery', 'phrase_first'] });
    s.on('GET /onboarding', () => ({ status: 200, body: { default_path: 'gallery', paths_enabled: ['gallery', 'phrase_first'] } }));
    await renderRouter(APP_DIR, { initialUrl: '/start' });
    expect(screen.getByTestId('start-all')).toBeTruthy();
    expect(screen.getByTestId('start-phrase')).toBeTruthy();
    expect(screen.queryByTestId('start-blank')).toBeNull();
  });

  it('US-33: closed on S41 without a choice → next launch opens «Сегодня» with the default set', async () => {
    useOnboarding.setState({ startShownAt: new Date(Date.now() - 60_000).toISOString() });
    const r = await renderRouter(APP_DIR, { initialUrl: '/' });
    expect(r.getPathname()).toBe('/');
    expect(useOnboarding.getState().doneAt).not.toBeNull();
    expect(usePages.getState().pages.map((p) => p.templateKey)).toEqual(['notes', 'tasks']);
    await settle(() => s.callsTo('POST /pages/batch').length === 1);
    expect(s.callsTo('POST /pages/batch')[0]?.body).toMatchObject({ path: 'skipped' });
  });

  it('a server without /pages/batch gets one POST /pages per page', async () => {
    const old = happyServer();
    resetApp({ fetch: old.fetch });
    const o = useOnboarding.getState();
    o.markWelcomeSeen(false);
    o.acceptConsent('no_ai');
    old.on('POST /pages', (c) => ({ status: 201, body: { page: pageOut((c.body as { client_id: string }).client_id, 1), created: true } }));
    await renderRouter(APP_DIR, { initialUrl: '/start' });
    await fireEvent.press(screen.getByTestId('start-blank'));
    await settle(() => old.callsTo('POST /pages').length === 1);
    expect(old.callsTo('POST /pages/batch')).toHaveLength(1);
  });
});

describe('S35 later: «Готовые страницы»', () => {
  it('pages the person has are «Уже есть»; «Добавить (N)» is one batch with path catalog', async () => {
    const s = batchServer();
    resetApp({ fetch: s.fetch });
    finishOnboarding();
    const r = await renderRouter(APP_DIR, { initialUrl: '/my-pages' });
    // «+ Добавить страницу» itself still makes one «Своя страница»; the ready pages are a separate link.
    await fireEvent.press(screen.getByTestId('my-pages-templates'));
    expect(r.getPathname()).toBe('/pages-gallery');
    expect(screen.getByTestId('gallery-notes')).toBeDisabled();
    expect(screen.getByText('Добавить (0)')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('gallery-shopping'));
    expect(screen.getByText('Добавить (1)')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('gallery-ok'));
    expect(usePages.getState().pages.map((p) => p.templateKey)).toContain('shopping');
    await settle(() => s.callsTo('POST /pages/batch').length === 1);
    expect(s.callsTo('POST /pages/batch')[0]?.body).toMatchObject({ path: 'catalog', template_keys: ['shopping'] });
  });
});

describe('«Сегодня» — the tear-off sheet', () => {
  beforeEach(() => {
    resetApp();
    finishOnboarding();
  });

  it('the date above «Сегодня», «Сегодня свободно…» when nothing', async () => {
    await renderRouter(APP_DIR, { initialUrl: '/' });
    expect(screen.getByTestId('today-header')).toHaveTextContent(new RegExp(`${new Date().getDate()}`));
    expect(screen.getByTestId('today-empty')).toHaveTextContent('Сегодня свободно. Скажите: «Напомни в пятницу оплатить свет»');
    expect(screen.queryByTestId('today-next')).toBeNull();
  });

  it('«Дальше» is the first open to-do of today with [Сделано]', async () => {
    const today = new Date();
    const d = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    useTasks.setState({
      tasks: {
        t1: { id: 't1', client_id: 't1', item_id: 'i1', list_key: 'todo', title: 'Позвонить маме', qty: null, where: null, due_date: d, done: false, done_at: null, version: 1, seq: 1, created_at: iso(), updated_at: iso(), deleted_at: null },
      },
    });
    await renderRouter(APP_DIR, { initialUrl: '/' });
    expect(screen.getByTestId('today-next')).toHaveTextContent(/Позвонить маме/);
    expect(screen.queryByTestId('today-next-snooze')).toBeNull();
    expect(screen.getByTestId('today-rest-empty')).toBeTruthy();
  });
});

describe('«Сегодня» tiles by code', () => {
  const base = { now: Date.now(), today: '2026-11-12', toBuy: [], expenses: [], t: (k: string, o?: Record<string, unknown>) => `${k}${o ? JSON.stringify(o) : ''}` };
  const page = (id: string, templateKey: string, tile?: 'auto' | 'pinned' | 'hidden') =>
    ({ id, serverId: `srv-${id}`, templateKey, view: tile ? { todayTile: tile } : undefined }) as never;

  it('no tiles in the first 7 days, ≤2 later, pinned first, hidden never', () => {
    const tiles = [
      { page_id: 'srv-a', template_key: 'shopping', title: 'Покупки', icon: null, text_ru: 'Осталось 5', pinned: false },
      { page_id: 'srv-b', template_key: 'expenses', title: 'Расходы', icon: null, text_ru: 'Сегодня 7 500 ₸', pinned: true },
    ];
    const pages = [page('a', 'shopping'), page('b', 'expenses')];
    expect(todayTiles({ ...base, pages, startedAt: new Date(Date.now() - 2 * DAY).toISOString(), server: tiles })).toEqual([]);
    const old = new Date(Date.now() - 30 * DAY).toISOString();
    expect(todayTiles({ ...base, pages, startedAt: old, server: tiles }).map((x) => x.text)).toEqual(['Осталось 5', 'Сегодня 7 500 ₸']);
    // offline: the phone's rule — «Дела» never by itself, a hidden page never, pinned first
    const local = todayTiles({
      ...base,
      startedAt: old,
      server: null,
      toBuy: [{ id: 'x' }] as never,
      pages: [page('t', 'tasks'), page('s', 'shopping'), page('n', 'notes', 'pinned'), page('e', 'expenses', 'hidden')],
    });
    expect(local.map((x) => x.pageId)).toEqual(['n', 's']);
    // the first 7 days: only what the person pinned by hand
    const youngLocal = todayTiles({ ...base, startedAt: iso(), server: tiles, toBuy: [{ id: 'x' }] as never, pages: [page('a', 'shopping'), page('n', 'notes', 'pinned')] });
    expect(youngLocal.map((x) => x.pageId)).toEqual(['n']);
  });
});
describe('tiles by hand: PUT /pages/{id}/today-tile', () => {
  it('pinned shows from the first day; «Не показывать» goes through the outbox with «Отменить»', async () => {
    const s = happyServer();
    s.on('PUT /pages/*/today-tile', (c) => ({
      status: 200,
      body: { ...pageOut('p', 9, { id: c.path.split('/')[2], template_key: 'shopping', title: 'Покупки', view_state: { today_tile: (c.body as { mode: string }).mode } }), action: null },
    }));
    resetApp({ fetch: s.fetch });
    finishOnboarding(); // the account is new: the rule gives no tiles yet
    const shop = usePages.getState().addPage('shopping')!;
    await testPages.insertLocal(shop);
    await testPages.markSynced(shop.id, pageOut(shop.id, 1, { id: 'srv-shop', template_key: 'shopping', title: 'Покупки' }));
    usePages.setState((st) => ({ pages: st.pages.map((p) => (p.id === shop.id ? { ...p, serverId: 'srv-shop' } : p)) }));
    const young = (pages = usePages.getState().pages) =>
      todayTiles({ pages, startedAt: iso(), now: Date.now(), today: '2026-11-12', server: [], toBuy: [], expenses: [], t: (k) => k });
    expect(young()).toEqual([]);

    const page = usePages.getState().pages.find((p) => p.id === shop.id)!;
    await setTodayTile(page, 'pinned');
    expect(young().map((x) => x.pageId)).toEqual([shop.id]); // at once, offline too
    await settle(() => s.callsTo('PUT /pages/srv-shop/today-tile').length === 1);
    expect(s.callsTo('PUT /pages/srv-shop/today-tile')[0]?.body).toMatchObject({ mode: 'pinned' });

    s.offline = true;
    await setTodayTile(usePages.getState().pages.find((p) => p.id === shop.id)!, 'hidden');
    expect(young()).toEqual([]);
    const strip = useUndo.getState().strip;
    expect(strip?.kind === 'custom' ? strip.text : '').toBe('Не показываю «Покупки» на Сегодня');
    if (strip?.kind === 'custom') strip.onUndo();
    await settle(() => young().length === 1); // back to pinned; the waiting row is dropped
  });
});

describe('welcome_seen', () => {
  it('goes after S05 through the outbox: PATCH /onboarding', async () => {
    const s = happyServer();
    s.on('PATCH /onboarding', () => ({ status: 200, body: {} }));
    resetApp({ fetch: s.fetch });
    useOnboarding.getState().markWelcomeSeen(true);
    await renderRouter(APP_DIR, { initialUrl: '/consent' });
    await fireEvent.press(screen.getByTestId('consent-storage'));
    await fireEvent.press(screen.getByTestId('consent-no-ai'));
    await settle(() => s.callsTo('PATCH /onboarding').length === 1);
    expect(s.callsTo('PATCH /onboarding')[0]?.body).toEqual({ welcome_seen: true });
  });
});


describe('«Скачать мои данные»', () => {
  it('starts the archive, polls, then hands the link to the share sheet', async () => {
    jest.useFakeTimers();
    const s = happyServer();
    let status = 'queued';
    const exp = () => ({
      export: {
        id: 'ex-1', status, requested_at: iso(), ready_at: status === 'ready' ? iso() : null,
        expires_at: status === 'ready' ? new Date(Date.now() + DAY).toISOString() : null, bytes: 1000,
        download_url: status === 'ready' ? 'https://api.test/v1/export/ex-1/file?token=t' : null, error: null,
      },
    });
    s.on('POST /export', () => ({ status: 202, body: exp() })).on('GET /export/ex-1', () => ({ status: 200, body: exp() }));
    resetApp({ fetch: s.fetch });
    finishOnboarding();
    const shared: string[] = [];
    setSharePortForTests({ download: async () => '', share: async () => undefined, shareLink: async (url) => void shared.push(url) });
    await renderRouter(APP_DIR, { initialUrl: '/more' });
    await fireEvent.press(screen.getByTestId('more-settings'));
    await fireEvent.press(screen.getByTestId('settings-my_data'));
    await fireEvent.press(screen.getByTestId('export-start'));
    await settle(() => useAccount.getState().exportJob?.status === 'queued');
    expect(screen.getByTestId('export-status')).toHaveTextContent('Готовлю архив…');
    status = 'ready';
    await settle(() => s.callsTo('GET /export/ex-1').length > 0 && useAccount.getState().exportJob?.status === 'ready');
    await fireEvent.press(screen.getByTestId('export-share'));
    await settle(() => shared.length === 1);
    expect(shared[0]).toBe('https://api.test/v1/export/ex-1/file?token=t');
  });
});

describe('account deletion', () => {
  const state = (needsSms: boolean) => ({
    status: 'active', needs_sms: needsSms, grace_days: 7, delete_after: null,
    points_ru: ['Вход закроется сразу.', needsSms ? '7 дней можно передумать — войдите по SMS.' : '7 дней можно передумать — откройте приложение.', 'Потом удалю всё за сутки.', 'Копии на резервных серверах исчезнут не позже 30 дней.', 'Через поддержку вернуть нельзя.'],
  });
  const accepted = { status: 'deletion_pending', requested_at: iso(), delete_after: new Date(Date.now() + 7 * DAY).toISOString(), grace_days: 7, message_ru: 'Аккаунт удаляется. До 19 ноября можно передумать: откройте приложение.' };

  it('anonymous: the points, «Да, удалить всё», the phone forgets its copy; «Восстановить» brings the account back', async () => {
    const s = happyServer();
    s.on('GET /me/deletion', () => ({ status: 200, body: state(false) })).on('POST /me/deletion', () => ({ status: 202, body: accepted }));
    const outbox = resetApp({ fetch: s.fetch });
    finishOnboarding();
    useOnboarding.getState().setDisplayName('Тест');
    fileWipes.count = 0;
    await testRecords.insertLocal({ id: 'r1', kind: 'note', source: 'typed', text: 'Код 4512', occurredAt: Date.now() } as never);
    const r = await renderRouter(APP_DIR, { initialUrl: '/more' });
    await fireEvent.press(screen.getByTestId('more-settings'));
    await fireEvent.press(screen.getByTestId('settings-delete_account'));
    await settle(() => screen.queryByText('• Через поддержку вернуть нельзя.') !== null);
    expect(screen.getByTestId('delete-irreversible')).toHaveTextContent(/Через 7 дней это уже не отменить/);
    await fireEvent.press(screen.getByTestId('delete-confirm'));
    await settle(() => r.getPathname() === '/account-deleting');
    expect(s.callsTo('POST /me/deletion')[0]?.body).toEqual({ confirm: true });
    expect(screen.getByTestId('deleting-message')).toHaveTextContent('Аккаунт удаляется. До 19 ноября можно передумать: откройте приложение.');
    expect(await testRecords.list(10)).toEqual([]);
    expect(await outbox.listPending()).toEqual([]);
    expect(usePages.getState().pages).toEqual([]);
    // the files on the phone go too (shares, photos, voice, КП files, the cache); only the restore token stays
    expect(fileWipes.count).toBe(1);
    expect(useOnboarding.getState().displayName).toBeNull();
    expect(useAccount.getState().deleting?.restoreToken ?? null).toBeNull();

    // «Восстановить»: the device key sign-in is refused with a restore token → cancel → a session
    s.on('POST /auth/anonymous', () => ({
      status: 403,
      body: { code: 'account_deletion_pending', message_ru: 'Аккаунт удаляется. Восстановить?', message_kk: '', details: { delete_after: accepted.delete_after, restore_token: 'restore-token-1', restore_expires_at: iso() } },
    })).on('POST /me/deletion/cancel', () => ({ status: 200, body: tokenPair('back') }));
    await fireEvent.press(screen.getByTestId('deleting-restore'));
    await settle(() => useAccount.getState().deleting === null);
    expect(s.callsTo('POST /me/deletion/cancel')[0]?.body).toEqual({ restore_token: 'restore-token-1' });
    expect(r.getPathname()).toBe('/');
  });

  it('with a number: the SMS code confirms', async () => {
    const s = happyServer();
    s.on('GET /me/deletion', () => ({ status: 200, body: state(true) }))
      .on('POST /me/deletion/otp', () => ({ status: 200, body: { challenge_id: 'ch-1', expires_at: iso(), dev_code: '123456' } }))
      .on('POST /me/deletion', () => ({ status: 202, body: { ...accepted, message_ru: 'Аккаунт удаляется. До 19 ноября можно передумать: войдите по SMS.' } }));
    resetApp({ fetch: s.fetch });
    finishOnboarding();
    const r = await renderRouter(APP_DIR, { initialUrl: '/delete-account' });
    await settle(() => screen.queryByTestId('delete-phone') !== null);
    expect(screen.getByTestId('delete-get-code')).toBeDisabled();
    await fireEvent.changeText(screen.getByTestId('delete-phone'), '+7 701 123 45 67');
    await fireEvent.press(screen.getByTestId('delete-get-code'));
    await settle(() => screen.queryByTestId('delete-code') !== null);
    expect(s.callsTo('POST /me/deletion/otp')[0]?.body).toEqual({ phone: '+7 701 123 45 67' });
    await fireEvent.press(screen.getByTestId('delete-confirm'));
    await settle(() => r.getPathname() === '/account-deleting');
    expect(s.callsTo('POST /me/deletion')[0]?.body).toEqual({ challenge_id: 'ch-1', code: '123456' });
  });

  it('offline: S32 says so and the «Да» does not work', async () => {
    resetApp();
    finishOnboarding();
    await renderRouter(APP_DIR, { initialUrl: '/delete-account' });
    await settle(() => screen.queryByTestId('delete-offline') !== null);
    expect(screen.getByTestId('delete-confirm')).toBeDisabled();
  });
});
