import { router } from 'expo-router';
import { fireEvent, renderRouter, screen } from 'expo-router/testing-library';
import { Dimensions } from 'react-native';

import type { InMemoryOutboxRepository } from '@/db';
import { saveNewPages } from '@/pages/service';
import { fold, looksLikeQuestion, searchRecords } from '@/records/search';
import { getApi, getCapture, getRecordActions, getSyncEngine, kickSync } from '@/services';
import { useConnectivity } from '@/store/connectivity';
import { useOnboarding } from '@/store/onboarding';
import { usePages } from '@/store/pages';
import { useSession } from '@/store/session';
import { undoStripMs, useUndo } from '@/store/undo';
import type { Call, FakeServer } from '@/testing/fakeServer';
import { happyServer, itemOut, pageOut, tokenPair } from '@/testing/fakeServer';
import { APP_DIR, finishOnboarding, offlineFetch, resetApp, settle, testPages, testRecords } from '@/testing/helpers';

const notes = () => usePages.getState().pages.find((p) => p.templateKey === 'notes')!;

const OLD_USER = 'u-anon';
const NEW_USER = 'u-phone';

function verifyBody(over: { switched?: boolean; app?: boolean; ai?: boolean; userId?: string; name?: string | null }) {
  const pair = tokenPair('phone');
  return {
    ...pair,
    user: { ...pair.user, id: over.userId ?? NEW_USER, is_anonymous: false, display_name: over.name ?? null },
    account_switched: over.switched ?? true,
    app_enabled: over.app ?? false,
    ai_enabled: over.ai ?? false,
  };
}

/** Everything the phone sent to the server after the first call matching `from`. */
const dataCalls = (s: FakeServer): Call[] =>
  s.calls.filter((c) => !c.path.startsWith('/auth/') && !c.path.startsWith('/consents/text'));

describe('phone already on another account', () => {
  let outbox: InMemoryOutboxRepository;
  let s: FakeServer;

  /** An anonymous account that has already sent one record and one page, and has work on its way. */
  async function setup(verify: Parameters<typeof verifyBody>[0]) {
    s = happyServer();
    s.on('POST /auth/otp/request', () => ({
      status: 200,
      body: { challenge_id: 'ch-1', expires_at: new Date().toISOString(), dev_code: null },
    })).on('POST /auth/otp/verify', () => ({ status: 200, body: verifyBody(verify) }));
    // Until the number is confirmed the data routes are out of reach: the old account's rows stay queued.
    let confirmed = false;
    outbox = resetApp({
      fetch: async (url, init) => {
        if (url.includes('/auth/otp/verify')) confirmed = true;
        if (!confirmed && !url.includes('/auth/') && !url.includes('/consents/text')) {
          throw new TypeError('Network request failed');
        }
        return s.fetch(url, init);
      },
    });
    finishOnboarding();
    useOnboarding.setState((st) => ({
      consent: st.consent && {
        ...st.consent,
        texts: [{ kind: 'pd_processing', version: 'old-account-v', textHash: 'old-hash', locale: 'ru' }],
      },
    }));
    const pair = tokenPair('anon');
    await testPagesReady();
    await getApi().client.tokens.saveTokens({ ...pair, user: { ...pair.user, id: OLD_USER, is_anonymous: true } } as never);

    // Sent earlier: a typed note.
    await testRecords.insertLocal({ id: 'sent-1', kind: 'note', source: 'typed', text: 'Старая запись' });
    const row = await outbox.enqueue('item.create', {
      clientId: 'sent-1',
      kind: 'note',
      source: 'typed',
      text: 'Старая запись',
      occurredAt: '2026-11-01T10:00:00Z',
    });
    await outbox.markSent(row.id);
    await testRecords.markSynced('sent-1', itemOut('sent-1', 5, { text: 'Старая запись', status: 'ready' }));

    // Sent earlier and then deleted: stays out.
    await testRecords.insertLocal({ id: 'gone-1', kind: 'note', source: 'typed', text: 'Удалённая' });
    const gone = await outbox.enqueue('item.create', {
      clientId: 'gone-1',
      kind: 'note',
      source: 'typed',
      text: 'Удалённая',
      occurredAt: '2026-11-01T10:00:00Z',
    });
    await outbox.markSent(gone.id);
    await testRecords.markSynced('gone-1', itemOut('gone-1', 6, { deleted_at: '2026-11-02T10:00:00Z' }));

    // On its way: names an id of the old account.
    await outbox.enqueue('item.verify', { recordId: 'sent-1', serverId: 'srv-sent-1', baseSeq: 5, fields: {} });
    await outbox.enqueue('consent.accept', { request: { consents: [], screen: 'S05', age_confirmed_18: true } });

    // Saved offline, never sent.
    await testRecords.insertLocal({ id: 'new-1', kind: 'note', source: 'typed', text: 'Новая запись' });
    await outbox.enqueue('item.create', {
      clientId: 'new-1',
      kind: 'note',
      source: 'typed',
      text: 'Новая запись',
      occurredAt: '2026-11-07T10:00:00Z',
    });
    await testRecords.setCursor(99);
  }

  async function testPagesReady() {
    const page = notes();
    await testPages.insertLocal(page);
    await testPages.markSynced(page.id, pageOut(page.id, 3, { id: 'old-notes', template_key: 'notes', title: 'Заметки' }));
    await testPages.applyLink({
      id: 'l1',
      page_id: 'old-notes',
      item_id: 'srv-sent-1',
      position: 'V',
      group_key: null,
      manual_order: false,
      manual_at: null,
      pinned: false,
      added_by: 'rule',
      removed_at: null,
      seq: 4,
      updated_at: 'x',
      updated_by: 'agent',
    });
  }

  async function verifyNumber(url = '/phone?next=home') {
    const r = await renderRouter(APP_DIR, { initialUrl: url });
    await fireEvent.changeText(screen.getByTestId('phone-number'), '7010000000');
    await fireEvent.press(screen.getByTestId('phone-get-code'));
    await settle(() => screen.queryByTestId('phone-code') !== null);
    await fireEvent.changeText(screen.getByTestId('phone-code'), '123456');
    await fireEvent.press(screen.getByTestId('phone-verify'));
    return r;
  }

  it('shows S05 again; nothing is resent and nothing leaves until the person agrees; records stay', async () => {
    await setup({ switched: true, app: false });
    const r = await verifyNumber();
    await settle(() => r.getPathname() === '/account-consent');
    expect(screen.getByTestId('account-consent-intro')).toBeTruthy();
    expect(useOnboarding.getState().accountConsent).toMatchObject({ userId: NEW_USER, switched: true });

    // Time passes, the foreground timer and every trigger run: not one request.
    const before = dataCalls(s).length;
    kickSync();
    await settle(() => false, 30).catch(() => undefined);
    expect(dataCalls(s).length).toBe(before);
    expect(s.callsTo('POST /consents')).toHaveLength(0);
    expect(s.callsTo('POST /items')).toHaveLength(0);
    expect(s.callsTo('GET /sync')).toHaveLength(0);

    // Nothing lost on the phone either.
    expect((await testRecords.list()).map((x) => x.id).sort()).toEqual(['new-1', 'sent-1']);
    expect((await testRecords.get('sent-1'))?.serverId).toBe('srv-sent-1');
  });

  it('«Позже»: the app works on this phone alone, still nothing is sent; the block survives until S05', async () => {
    await setup({ switched: true, app: false });
    const r = await verifyNumber();
    await settle(() => r.getPathname() === '/account-consent');
    await fireEvent.press(screen.getByTestId('account-consent-later'));
    await settle(() => r.getPathname() === '/');
    await fireEvent.changeText(screen.getByTestId('assistant-input'), 'Пока без согласия');
    await fireEvent.press(screen.getByTestId('assistant-send'));
    await settle(() => outbox.all().some((e) => (e.payload as { text?: string }).text === 'Пока без согласия'));
    expect(s.callsTo('POST /items')).toHaveLength(0);
    expect(useOnboarding.getState().accountConsent).not.toBeNull();
  });

  it('after agreeing: new consent first, device next, then the phone\'s records go to the new account', async () => {
    await setup({ switched: true, app: false });
    const r = await verifyNumber();
    await settle(() => r.getPathname() === '/account-consent');
    await fireEvent.press(screen.getByTestId('consent-storage'));
    await fireEvent.press(screen.getByTestId('consent-no-ai'));
    await settle(() => s.callsTo('GET /sync').length > 0 && s.callsTo('POST /items').length >= 2);

    const order = s.calls.filter((c) => c.method !== 'GET' && !c.path.startsWith('/auth/')).map((c) => c.path);
    expect(order[0]).toBe('/consents');
    expect(order[1]).toBe('/devices');
    // What the old account accepted is never sent again; the rows that spoke for it were dropped.
    expect(JSON.stringify(s.callsTo('POST /consents'))).not.toContain('old-hash');
    expect(s.callsTo('POST /consents')).toHaveLength(1);
    expect(s.calls.some((c) => c.method === 'PATCH' && c.path.startsWith('/items/'))).toBe(false);
    expect(outbox.all().filter((e) => e.lastError === 'account_switched').map((e) => e.kind).sort()).toEqual([
      'consent.accept',
      'item.verify',
    ]);

    const sent = s.callsTo('POST /items').map((c) => (c.body as { client_id: string }).client_id).sort();
    expect(sent).toEqual(['new-1', 'sent-1']); // the deleted record stays out
    expect(s.callsTo('POST /pages').map((c) => (c.body as { template_key: string }).template_key)).toContain('notes');
    expect(s.callsTo('GET /sync')[0]?.query.since).toBe('0');
    expect(useOnboarding.getState().consent?.mode).toBe('no_ai');
    expect(useOnboarding.getState().accountConsent).toBeNull();

    // On the phone: all there, now under the new account's ids; the deleted one still in the trash.
    await settle(() => s.callsTo('POST /items').length >= 2);
    expect((await testRecords.list()).map((x) => x.id).sort()).toEqual(['new-1', 'sent-1']);
    expect((await testRecords.listTrash()).map((x) => x.id)).toEqual(['gone-1']);
    expect((await testRecords.get('gone-1'))?.serverId).toBeNull();
    expect(await testPages.linksFor('old-notes')).toEqual([]);
    // The name is asked here, not before.
    await settle(() => r.getPathname() === '/phone');
  });

  it('the account already has consent: no S05, its «Без ИИ» stands, the records move at once', async () => {
    await setup({ switched: true, app: true, ai: false, name: 'Али' });
    await verifyNumber();
    await settle(() => s.callsTo('POST /items').length >= 2);
    expect(s.callsTo('POST /consents')).toHaveLength(0);
    expect(useOnboarding.getState().consent?.mode).toBe('no_ai');
    expect(useOnboarding.getState().displayName).toBe('Али');
    expect(useOnboarding.getState().accountConsent).toBeNull();
    expect(s.callsTo('POST /devices').length).toBeGreaterThan(0);
  });

  it('the same account, phone newly linked: nothing changes, no S05', async () => {
    await setup({ switched: false, app: true, ai: true, userId: OLD_USER });
    await verifyNumber();
    await settle(() => screen.queryByTestId('phone-name') !== null);
    expect(useOnboarding.getState().accountConsent).toBeNull();
    expect((await testRecords.get('sent-1'))?.serverId).toBe('srv-sent-1');
    expect(s.callsTo('POST /consents').length).toBeLessThanOrEqual(1); // the row queued before, not a new one
  });
});

describe('rejected refresh on a linked account', () => {
  it('opens S04b instead of a new anonymous account; local data stays; signing in brings sync back', async () => {
    const s = happyServer();
    s.on('POST /auth/refresh', () => ({
      status: 401,
      body: { code: 'invalid_refresh', message_ru: '', message_kk: '', details: { account_linked: true } },
    }))
      .on('POST /auth/otp/request', () => ({
        status: 200,
        body: { challenge_id: 'ch-1', expires_at: new Date().toISOString(), dev_code: null },
      }))
      .on('POST /auth/otp/verify', () => ({
        status: 200,
        body: verifyBody({ switched: false, app: true, ai: true, userId: 'u-1', name: 'Али' }),
      }));
    const outbox = resetApp({ fetch: s.fetch });
    finishOnboarding();
    useOnboarding.getState().markPhoneLinked();
    const pair = tokenPair('old');
    await getApi().client.tokens.saveTokens({
      ...pair,
      access_expires_at: new Date(0).toISOString(),
      user: { ...pair.user, id: 'u-1', is_anonymous: false },
    } as never);
    await testRecords.insertLocal({ id: 'r1', kind: 'note', source: 'typed', text: 'Моя запись' });
    await outbox.enqueue('item.create', {
      clientId: 'r1',
      kind: 'note',
      source: 'typed',
      text: 'Моя запись',
      occurredAt: '2026-11-07T10:00:00Z',
    });

    const r = await renderRouter(APP_DIR, { initialUrl: '/' });
    kickSync();
    await settle(() => r.getPathname() === '/phone');
    expect(screen.getByTestId('phone-expired')).toBeTruthy();
    expect(s.callsTo('POST /auth/anonymous')).toHaveLength(0);
    expect((await testRecords.list()).map((x) => x.id)).toEqual(['r1']);
    expect((await outbox.listPending()).map((e) => e.kind)).toEqual(['item.create']);
    expect((await outbox.listPending())[0]?.attempts).toBe(0);

    await fireEvent.changeText(screen.getByTestId('phone-number'), '7010000000');
    await fireEvent.press(screen.getByTestId('phone-get-code'));
    await settle(() => screen.queryByTestId('phone-code') !== null);
    expect(s.callsTo('POST /auth/otp/request')[0]?.headers.Authorization).toBeUndefined();
    expect(s.callsTo('POST /auth/otp/request')[0]?.body).toMatchObject({ purpose: 'login' });
    await fireEvent.changeText(screen.getByTestId('phone-code'), '123456');
    await fireEvent.press(screen.getByTestId('phone-verify'));
    await settle(() => s.callsTo('POST /items').length === 1);
    expect(useSession.getState().needsSignIn).toBe(false);
    expect(useOnboarding.getState().accountConsent).toBeNull();
    expect(s.callsTo('POST /consents')).toHaveLength(0);
    await settle(() => r.getPathname() === '/');
  });

  it('«Позже»: back to the app, local work goes on, nothing is sent', async () => {
    const s = happyServer();
    const outbox = resetApp({ fetch: s.fetch });
    finishOnboarding();
    useSession.getState().setNeedsSignIn(true);
    const r = await renderRouter(APP_DIR, { initialUrl: '/' });
    await settle(() => r.getPathname() === '/phone');
    await fireEvent.press(screen.getByTestId('phone-later'));
    await settle(() => r.getPathname() === '/');
    await fireEvent.changeText(screen.getByTestId('assistant-input'), 'Запись');
    await fireEvent.press(screen.getByTestId('assistant-send'));
    await settle(() => outbox.all().length === 1);
    expect(s.callsTo('POST /items')).toHaveLength(0);
    expect(screen.getByTestId('assistant-line')).toBeTruthy();
  });
});

describe('«Заметки» shows all records', () => {
  it('saved anywhere, any kind, synced or not, whatever the rule of other pages', async () => {
    resetApp();
    finishOnboarding();
    await testRecords.insertLocal({ id: 'a', kind: 'note', source: 'typed', text: 'С другой страницы', pageId: 'other' });
    await testRecords.insertLocal({ id: 'b', kind: 'voice', source: 'mic', pageId: 'today' });
    await testRecords.applyRemote(itemOut('c', 3, { text: 'С сервера', kind: 'pdf', source: 'files' }));
    await renderRouter(APP_DIR, { initialUrl: `/page/${notes().id}` });
    await settle(() => screen.queryByText('С другой страницы') !== null);
    expect(screen.getByText('Голосовая запись')).toBeTruthy();
    expect(screen.getByText('С сервера')).toBeTruthy();
  });
});

describe('«Исправить» on the card', () => {
  async function card(s = happyServer()) {
    const outbox = resetApp({ fetch: s.fetch });
    finishOnboarding();
    await testRecords.applyRemote(
      itemOut('r1', 5, {
        text: 'Счёт на 5000',
        review_fields: {
          amount: { kind: 'amount', value: '5000', state: 'unverified' },
          transcript: { kind: 'transcript', value: 'весь текст', state: 'unverified' },
        },
      }),
    );
    await renderRouter(APP_DIR, { initialUrl: '/record/r1' });
    await settle(() => screen.queryByTestId('check-field-amount') !== null);
    return outbox;
  }

  it('offline: the new value shows at once, the mark goes, the outbox keeps it; online it goes with base_seq', async () => {
    const s = happyServer();
    s.offline = true;
    s.on('PATCH /items/*', () => ({
      status: 200,
      body: itemOut('r1', 7, {
        text: 'Счёт на 7000',
        review_fields: {
          amount: { kind: 'amount', value: '7000', state: 'verified' },
          transcript: { kind: 'transcript', value: 'весь текст', state: 'unverified' },
        },
      }),
    }));
    const outbox = await card(s);
    await fireEvent.press(screen.getByTestId('check-field-amount'));
    await fireEvent.press(screen.getByTestId('check-fix'));
    await fireEvent.changeText(screen.getByTestId('check-fix-input'), ' 7000 ');
    await fireEvent.press(screen.getByTestId('check-fix-save'));
    await settle(() => screen.queryByText('7000') !== null);
    expect((await outbox.listPending()).map((e) => e.kind)).toEqual(['item.correct']);
    expect((await testRecords.get('r1'))?.pending.corrected).toEqual({ amount: '7000' });

    s.offline = false;
    const engine = await getSyncEngine();
    await settle(() => {
      void engine.run(); // past the backoff of the offline try
      return s.calls.some((c) => c.method === 'PATCH');
    });
    await engine.whenIdle();
    const patch = s.calls.find((c) => c.method === 'PATCH');
    expect(patch?.path).toBe('/items/srv-r1');
    expect(patch?.body).toEqual({ corrections: { amount: '7000' }, base_seq: 5 });
    expect((await testRecords.get('r1'))?.pending.corrected).toEqual({});
    expect((await testRecords.get('r1'))?.reviewFields.amount?.value).toBe('7000');
  });

  it('a conflict, the field changed: the card shows the current value and asks again', async () => {
    const s = happyServer();
    let changed = false;
    s.on('GET /items/*', () => ({
      status: 200,
      body: changed
        ? itemOut('r1', 9, { review_fields: { amount: { kind: 'amount', value: '6000', state: 'unverified' } } })
        : itemOut('r1', 5, { review_fields: { amount: { kind: 'amount', value: '5000', state: 'unverified' } } }),
    }));
    s.on('PATCH /items/*', () => {
      changed = true;
      return { status: 409, body: { code: 'conflict', message_ru: '', message_kk: '', details: { seq: 9 } } };
    });
    await card(s);
    await (await getRecordActions()).correct('r1', 'amount', '7000');
    const engine = await getSyncEngine();
    await engine.whenIdle();
    await engine.run();
    await settle(() => s.calls.filter((c) => c.method === 'PATCH').length >= 1);
    await engine.whenIdle();
    expect(s.calls.filter((c) => c.method === 'PATCH')).toHaveLength(1);
    const rec = await testRecords.get('r1');
    expect(rec?.pending.corrected).toEqual({});
    expect(rec?.reviewFields.amount).toMatchObject({ value: '6000', state: 'unverified' });
  });

  it('a conflict, something else changed: the correction goes again on the newer version', async () => {
    const s = happyServer();
    let tries = 0;
    s.on('GET /items/*', () => ({
      status: 200,
      body: itemOut('r1', 9, { review_fields: { amount: { kind: 'amount', value: '5000', state: 'unverified' } } }),
    }));
    s.on('PATCH /items/*', () => {
      tries++;
      if (tries === 1) return { status: 409, body: { code: 'conflict', message_ru: '', message_kk: '', details: { seq: 9 } } };
      return { status: 200, body: itemOut('r1', 10) };
    });
    await card(s);
    await (await getRecordActions()).correct('r1', 'amount', '7000');
    await (await getSyncEngine()).run();
    await settle(() => tries >= 2);
    const patches = s.calls.filter((c) => c.method === 'PATCH').map((c) => c.body);
    expect(patches.at(-1)).toEqual({ corrections: { amount: '7000' }, base_seq: 9 });
  });

  it('a refusal brings the server\'s value back', async () => {
    const s = happyServer();
    s.on('PATCH /items/*', () => ({
      status: 422,
      body: { code: 'review_field_not_editable', message_ru: '', message_kk: '' },
    }));
    const outbox = await card(s);
    await (await getRecordActions()).correct('r1', 'amount', '7000');
    await (await getSyncEngine()).run();
    await settle(() => outbox.all().some((e) => e.status === 'failed'));
    expect((await testRecords.get('r1'))?.pending.corrected).toEqual({});
  });

  it('a whole transcript has no «Исправить», as the server refuses it', async () => {
    await card();
    await fireEvent.press(screen.getByTestId('check-field-transcript'));
    expect(screen.queryByTestId('check-fix')).toBeNull();
    expect(screen.getByTestId('check-ok')).toBeTruthy();
  });
});

describe('the name from S04b', () => {
  it('goes to PATCH /me through the outbox only when it was typed', async () => {
    const s = happyServer();
    const outbox = resetApp({ fetch: s.fetch });
    finishOnboarding();
    const r = await renderRouter(APP_DIR, { initialUrl: '/phone?step=name&next=home' });
    await fireEvent.changeText(screen.getByTestId('phone-name'), ' Али ');
    await fireEvent.press(screen.getByTestId('phone-name-done'));
    await settle(() => s.callsTo('PATCH /me').length === 1);
    expect(s.callsTo('PATCH /me')[0]?.body).toEqual({ display_name: 'Али' });
    expect(useOnboarding.getState().displayName).toBe('Али');
    expect(outbox.all().map((e) => e.kind)).toContain('profile.update');
    expect(r.getPathname()).toBe('/');
  });

  it('«Пропустить» sends nothing', async () => {
    const s = happyServer();
    resetApp({ fetch: s.fetch });
    finishOnboarding();
    await renderRouter(APP_DIR, { initialUrl: '/phone?step=name&next=home' });
    await fireEvent.press(screen.getByTestId('phone-name-skip'));
    await settle(() => s.calls.length >= 0);
    expect(s.callsTo('PATCH /me')).toHaveLength(0);
  });
});

describe('copy', () => {
  async function saveOnPage(fetch: Parameters<typeof resetApp>[0]) {
    resetApp(fetch);
    finishOnboarding();
    await renderRouter(APP_DIR, { initialUrl: `/page/${notes().id}` });
    await fireEvent.changeText(screen.getByTestId('assistant-input'), 'Запись');
    await fireEvent.press(screen.getByTestId('assistant-send'));
    await settle(() => screen.queryByTestId('answer-banner') !== null);
  }

  it('online: «Сохранил.», never «Сделаю, когда появится связь»', async () => {
    const s = happyServer();
    await saveOnPage({ fetch: s.fetch });
    await settle(() => s.callsTo('POST /items').length === 1);
    expect(screen.getByText('Сохранил.')).toBeTruthy();
    expect(screen.queryByText(/появится связь/)).toBeNull();
  });

  it('offline: the honest line shows once the attempt fails', async () => {
    await saveOnPage({ fetch: offlineFetch });
    await settle(() => !useConnectivity.getState().online);
    await settle(() => screen.queryByText('Сохранил. Сделаю, когда появится связь.') !== null);
  });

  it('the connection comes back: the line follows', async () => {
    const s = happyServer();
    s.offline = true;
    await saveOnPage({ fetch: s.fetch });
    await settle(() => screen.queryByText(/появится связь/) !== null);
    s.offline = false;
    await (await getSyncEngine()).run();
    await settle(() => screen.queryByText('Сохранил.') !== null);
  });

  it('hints promise only what v0 does', async () => {
    resetApp();
    finishOnboarding();
    usePages.getState().addPage('documents');
    const doc = usePages.getState().pages.find((p) => p.templateKey === 'documents')!;
    await renderRouter(APP_DIR, { initialUrl: `/page/${doc.id}` });
    await settle(() => screen.queryByTestId('page-empty') !== null);
    expect(screen.queryByText('Например: сделай КП по этому ТЗ')).toBeNull();
    const input = screen.getByTestId('assistant-input');
    expect(input.props.accessibilityHint).toBe('Например: договор с мастером № 15');
  });

  it('the undo strip follows 2-design 4.3: 10 s, 15 s with a large font, 30 s with a screen reader', () => {
    expect(undoStripMs({ largeFont: false, screenReader: false })).toBe(10_000);
    expect(undoStripMs({ largeFont: true, screenReader: false })).toBe(15_000);
    expect(undoStripMs({ largeFont: true, screenReader: true })).toBe(30_000);
  });

  it('a large font keeps the strip on screen past 10 s', async () => {
    const dims = { width: 390, height: 844, scale: 3, fontScale: 1.5 };
    Dimensions.set({ window: dims, screen: dims });
    try {
      resetApp();
      finishOnboarding();
      await renderRouter(APP_DIR, { initialUrl: '/' });
      useUndo.getState().showMerged('r1', '2026-03-12T10:00:00Z');
      await settle(() => screen.queryByTestId('undo-strip') !== null);
      await settle(() => false, 600).catch(() => undefined); // 12 s
      expect(screen.queryByTestId('undo-strip')).not.toBeNull();
    } finally {
      const back = { width: 390, height: 844, scale: 3, fontScale: 1 };
      Dimensions.set({ window: back, screen: back });
    }
  });
});

describe('/sync', () => {
  it('the cursor is the server\'s next_since, also past every row it applied; summaries change nothing', async () => {
    const s = happyServer();
    s.on('GET /sync', () => ({
      status: 200,
      body: {
        items: [itemOut('a', 3)],
        screens: [],
        screen_items: [],
        screen_summaries: [
          { page_id: 'p', item_count: 1, last_titles: ['a'], aggregates: {}, seq: 7, updated_at: '2026-11-07T10:00:00Z' },
        ],
        tombstones: [],
        next_since: 7,
        has_more: false,
      },
    }));
    resetApp({ fetch: s.fetch });
    finishOnboarding();
    await (await getSyncEngine()).pull();
    expect(await testRecords.getCursor()).toBe(7);
    expect((await testRecords.list()).map((r) => r.id)).toEqual(['a']);
  });
});

describe('re-adding a removed page', () => {
  it('comes back with its old place, name and links; the removed row is replaced', async () => {
    const s = happyServer();
    s.on('POST /pages', () => ({
      status: 200,
      body: {
        page: pageOut('new-local', 20, { id: 'srv-old', template_key: 'shopping', title: 'Покупки', position: 'A', client_id: 'new-local' }),
        created: false,
        revived: true,
      },
    }));
    const outbox = resetApp({ fetch: s.fetch });
    finishOnboarding();
    await testPages.applyRemote(
      pageOut('old-local', 9, { id: 'srv-old', template_key: 'shopping', title: 'Покупки', position: 'A', deleted_at: '2026-11-01T10:00:00Z' }),
    );
    await testPages.applyLink({
      id: 'l1', page_id: 'srv-old', item_id: 'srv-a', position: 'V', group_key: null, manual_order: false,
      manual_at: null, pinned: false, added_by: 'rule', removed_at: null, seq: 3, updated_at: 'x', updated_by: 'agent',
    });
    const added = usePages.getState().addPage('shopping')!;
    expect(added.position).not.toBe('A');
    await saveNewPages([added]);
    // Before the server answered: the old place already.
    expect(usePages.getState().pages.find((p) => p.id === added.id)?.position).toBe('A');
    expect(outbox.all().map((e) => e.kind)).toContain('pages.create');
    await (await getSyncEngine()).run();
    await settle(() => s.callsTo('POST /pages').length > 0);
    const rows = (await testPages.listAll()).filter((p) => p.templateKey === 'shopping');
    expect(rows.map((p) => [p.id, p.serverId, p.position, p.deletedAt])).toEqual([[added.id, 'srv-old', 'A', null]]);
    expect((await testPages.linksFor('srv-old')).length).toBe(1);
  });
});

describe('«Найти на странице»', () => {
  beforeEach(() => {
    resetApp();
    finishOnboarding();
  });

  const fill = async () => {
    await testRecords.insertLocal({ id: 'a', kind: 'note', source: 'typed', text: 'Купить ёлку' });
    await testRecords.insertLocal({ id: 'b', kind: 'note', source: 'typed', text: 'Қала туралы жазба' });
    await testRecords.insertLocal({ id: 'c', kind: 'note', source: 'typed', text: 'Телефон +7 701 123 45 67' });
  };

  it('offline, at once by letters; ё = е, Kazakh letters as Russian ones, digits without spaces', async () => {
    await fill();
    await renderRouter(APP_DIR, { initialUrl: `/page/${notes().id}` });
    await settle(() => screen.queryByText('Купить ёлку') !== null);
    await fireEvent.changeText(screen.getByTestId('page-find'), 'елк');
    await settle(() => screen.queryByText('Қала туралы жазба') === null);
    expect(screen.getByText('Купить ёлку')).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('page-find'), 'кала');
    await settle(() => screen.queryByText('Қала туралы жазба') !== null);
    await fireEvent.changeText(screen.getByTestId('page-find'), '7011234567');
    await settle(() => screen.queryByText('Телефон +7 701 123 45 67') !== null);
  });

  it('only this page; nothing is made up; «Искать по всем страницам» carries the words over', async () => {
    usePages.getState().addPage('custom', 'Дача');
    const custom = usePages.getState().pages.find((p) => p.templateKey === 'custom')!;
    await testRecords.insertLocal({ id: 'a', kind: 'note', source: 'typed', text: 'Плитка в ванную', pageId: 'today' });
    const r = await renderRouter(APP_DIR, { initialUrl: `/page/${custom.id}` });
    await fireEvent.changeText(screen.getByTestId('page-find'), 'плитка');
    await settle(() => screen.queryByTestId('page-find-none') !== null);
    expect(screen.getByText('На этой странице такого нет')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('page-find-all'));
    await settle(() => r.getPathname() === '/search');
    await settle(() => screen.queryByText('Плитка в ванную') !== null);
    expect(screen.getByText('Нашёл сразу: 1')).toBeTruthy();
  });

  it('what was typed stays with its page when switching tabs', async () => {
    await renderRouter(APP_DIR, { initialUrl: `/page/${notes().id}` });
    await fireEvent.changeText(screen.getByTestId('page-find'), 'что-то');
    const tasks = usePages.getState().pages.find((p) => p.templateKey === 'tasks')!;
    await fireEvent.press(screen.getByTestId(`tab-${tasks.id}`));
    await settle(() => screen.getByTestId('page-find').props.value === '');
  });

  it('online: asks the server for this page only', async () => {
    const s = happyServer();
    resetApp({ fetch: s.fetch });
    finishOnboarding();
    await testPages.insertLocal(notes());
    await testPages.markSynced(notes().id, pageOut(notes().id, 3, { id: 'srv-notes', template_key: 'notes', title: 'Заметки' }));
    usePages.setState({ pages: usePages.getState().pages.map((p) => (p.id === notes().id ? { ...p, serverId: 'srv-notes' } : p)) });
    await renderRouter(APP_DIR, { initialUrl: `/page/${notes().id}` });
    await fireEvent.changeText(screen.getByTestId('page-find'), 'молоком');
    await settle(() => s.callsTo('GET /search').length > 0);
    expect(s.callsTo('GET /search')[0]?.query).toEqual({ q: 'молоком', page_id: 'srv-notes' });
  });
});

describe('search in the assistant line', () => {
  it('tells a question from a note', () => {
    for (const q of ['где мой чек за холодильник', 'Сколько я потратил', 'телефон сантехника?', 'қайда чегім']) {
      expect(looksLikeQuestion(q)).toBe(true);
    }
    for (const q of ['код домофона 4512', 'купить хлеб', 'гдекупить', 'сегодня к врачу']) {
      expect(looksLikeQuestion(q)).toBe(false);
    }
  });

  function hit(id: string, title: string, matched: string[]) {
    return {
      item_id: id, kind: 'note', status: 'ready', title, snippet: `…${title}…`, highlights: [], ai_label: null, pages: [],
      occurred_at: null, created_at: '2026-11-01T10:00:00Z', matched_by: matched,
    };
  }

  it('a question is not saved; first what is on the phone, then «Нашёл ещё»; a hit opens', async () => {
    const s = happyServer();
    s.on('GET /search', () => ({
      status: 200,
      body: {
        results: [
          hit('srv-a', 'Чек за холодильник', ['words']),
          hit('srv-b', 'Гарантия на технику', ['meaning']),
        ],
        semantic: true,
      },
    }));
    s.on('GET /items/*', () => ({ status: 200, body: itemOut('b', 3, { text: 'Гарантия на технику' }) }));
    const outbox = resetApp({ fetch: s.fetch });
    finishOnboarding();
    await testRecords.applyRemote(itemOut('a', 2, { text: 'Чек за холодильник' }));
    const r = await renderRouter(APP_DIR, { initialUrl: `/page/${notes().id}` });
    await fireEvent.changeText(screen.getByTestId('assistant-input'), 'где чек за холодильник');
    await fireEvent.press(screen.getByTestId('assistant-send'));
    await settle(() => r.getPathname() === '/search');
    await settle(() => screen.queryByText('Нашёл сразу: 1') !== null);
    await settle(() => screen.queryByText('Нашёл ещё по смыслу (1)') !== null);
    expect(s.callsTo('GET /search')[0]?.query).toEqual({ q: 'где чек за холодильник' });
    expect(outbox.all().filter((e) => e.kind === 'item.create')).toHaveLength(0);
    // The same record is not shown twice.
    expect(screen.getAllByText('Чек за холодильник')).toHaveLength(1);

    await fireEvent.press(screen.getByTestId('search-hit-srv-b'));
    await settle(() => r.getPathname() === '/record/b');
    expect((await testRecords.findByServerId('srv-b'))?.text).toBe('Гарантия на технику');
  });

  it('offline: what is on the phone, an honest line about the rest, no answer made up', async () => {
    resetApp();
    finishOnboarding();
    await testRecords.insertLocal({ id: 'a', kind: 'note', source: 'typed', text: 'Чек Magnum' });
    const r = await renderRouter(APP_DIR, { initialUrl: '/' });
    await fireEvent.changeText(screen.getByTestId('assistant-input'), 'где чек');
    await fireEvent.press(screen.getByTestId('assistant-send'));
    await settle(() => r.getPathname() === '/search');
    await settle(() => screen.queryByTestId('search-offline') !== null);
    expect(screen.getByText('Чек Magnum')).toBeTruthy();
  });

  it('nothing found: «Не нашёл», and it can still be saved as a record', async () => {
    const s = happyServer();
    const outbox = resetApp({ fetch: s.fetch });
    finishOnboarding();
    const r = await renderRouter(APP_DIR, { initialUrl: '/' });
    await fireEvent.changeText(screen.getByTestId('assistant-input'), 'где ключи от гаража?');
    await fireEvent.press(screen.getByTestId('assistant-send'));
    await settle(() => r.getPathname() === '/search');
    await settle(() => screen.queryByTestId('search-none') !== null);
    await fireEvent.press(screen.getByTestId('search-save'));
    await settle(() => outbox.all().some((e) => e.kind === 'item.create'));
    expect(screen.queryByTestId('search-save')).toBeNull();
  });

  it('while the account has no consent the server is not asked', async () => {
    const s = happyServer();
    resetApp({ fetch: s.fetch });
    finishOnboarding();
    useOnboarding.getState().requireAccountConsent({ userId: 'u', switched: true });
    useSession.getState().postponeConsent();
    const r = await renderRouter(APP_DIR, { initialUrl: '/' });
    await fireEvent.changeText(screen.getByTestId('assistant-input'), 'где чек');
    await fireEvent.press(screen.getByTestId('assistant-send'));
    await settle(() => r.getPathname() === '/search');
    await settle(() => false, 40).catch(() => undefined);
    expect(s.callsTo('GET /search')).toHaveLength(0);
  });

  it('1000 records: the phone answers well under a second', () => {
    const base = { kind: 'note', source: 'typed', files: [], reviewFields: {}, pending: {} };
    const many = Array.from({ length: 1000 }, (_, i) => ({ ...base, id: `r${i}`, text: `Запись номер ${i} про разное и всякое `.repeat(20) }));
    const t0 = Date.now();
    const out = searchRecords(many as never, 'номер 999');
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(out.map((r) => r.id)).toEqual(['r999']);
    expect(fold('ЁЛКА Қала')).toBe('елка кала');
  });
});

describe('«Удалённые записи»', () => {
  it('offline: delete on the card, undo strip, list, «Вернуть»; the outbox keeps it for later', async () => {
    const outbox = resetApp();
    finishOnboarding();
    await testRecords.applyRemote(itemOut('a', 2, { text: 'Лишняя запись', status: 'ready' }));
    const r = await renderRouter(APP_DIR, { initialUrl: `/record/a?from=${notes().id}` });
    await settle(() => screen.queryByTestId('record-delete') !== null);
    await fireEvent.press(screen.getByTestId('record-delete'));
    await settle(() => r.getPathname() === `/page/${notes().id}`);
    await settle(() => screen.queryByText('Удалил запись') !== null);
    await settle(() => outbox.all().some((e) => e.kind === 'item.delete'));
    await settle(() => screen.queryByText('Лишняя запись') === null);
    router.navigate('/trash');
    await settle(() => screen.queryByText('Лишняя запись') !== null);
    expect(screen.getByText('Удалю насовсем через 30 дн.')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('trash-restore-a'));
    await settle(() => screen.queryByTestId('trash-empty') !== null);
    expect(outbox.all().map((e) => e.kind)).toEqual(expect.arrayContaining(['item.delete', 'item.restore']));
    expect((await testRecords.list()).map((x) => x.id)).toEqual(['a']);
  });

  it('online: DELETE, then POST restore with the server id; the overlay clears; 30 days from the server', async () => {
    const s = happyServer();
    const outbox = resetApp({ fetch: s.fetch });
    finishOnboarding();
    await testRecords.applyRemote(itemOut('a', 2, { text: 'Запись' }));
    const actions = await getRecordActions();
    await actions.remove('a');
    await (await getSyncEngine()).run();
    await settle(() => s.calls.some((c) => c.method === 'DELETE' && c.path === '/items/srv-a'));
    await (await getSyncEngine()).whenIdle();
    const trashed = await testRecords.get('a');
    expect(trashed?.pending).toEqual({});
    expect(trashed?.deletedAt).not.toBeNull();
    expect(trashed?.purgeAfter).not.toBeNull();
    expect((await testRecords.listTrash()).map((x) => x.id)).toEqual(['a']);

    await actions.restore('a');
    await (await getSyncEngine()).run();
    await settle(() => s.callsTo('POST /items/srv-a/restore').length === 1);
    await (await getSyncEngine()).whenIdle();
    expect((await testRecords.listTrash())).toEqual([]);
    expect((await testRecords.list()).map((x) => x.id)).toEqual(['a']);
    expect(outbox.all().filter((e) => e.status === 'failed')).toEqual([]);
  });

  it('a record not sent yet waits for its capture, then is deleted on the server', async () => {
    const s = happyServer();
    resetApp({ fetch: s.fetch });
    finishOnboarding();
    s.offline = true;
    const rec = await (await getCapture()).saveText({ text: 'Новая', source: 'typed' });
    await (await getRecordActions()).remove(rec.id);
    expect((await testRecords.list())).toEqual([]);
    expect((await testRecords.listTrash()).map((x) => x.id)).toEqual([rec.id]);
    s.offline = false;
    const engine = await getSyncEngine();
    await engine.whenIdle();
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 3_600_000); // past the backoff
    await engine.run();
    jest.restoreAllMocks();
    await settle(() => s.calls.some((c) => c.method === 'DELETE'));
  });

  it('a tombstone: gone for good, also from the trash', async () => {
    resetApp();
    await testRecords.applyRemote(itemOut('a', 2, { deleted_at: new Date().toISOString() }));
    expect((await testRecords.listTrash()).map((x) => x.id)).toEqual(['a']);
    await testRecords.applyTombstone('srv-a');
    expect(await testRecords.listTrash()).toEqual([]);
    expect(await testRecords.get('a')).toBeNull();
  });

  it('past the 30 days it is not offered any more, even offline', async () => {
    resetApp();
    await testRecords.applyRemote(
      itemOut('a', 2, { deleted_at: '2026-01-01T00:00:00Z', purge_after: '2026-01-31T00:00:00Z' }),
    );
    expect(await testRecords.listTrash()).toEqual([]);
  });
});
