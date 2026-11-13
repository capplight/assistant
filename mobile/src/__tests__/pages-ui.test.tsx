import { lineRouting } from '@/chat/service';
import { router } from 'expo-router';
import { act, fireEvent, renderRouter, screen, within } from 'expo-router/testing-library';

import { useOnboarding } from '@/store/onboarding';
import { usePages } from '@/store/pages';
import { useUndo } from '@/store/undo';
import { happyServer, itemOut, pageOut, tokenPair } from '@/testing/fakeServer';
import { APP_DIR, finishOnboarding, resetApp, settle, testPages, testRecords } from '@/testing/helpers';

// The line here saves notes on the phone (week 2-5 routing). Week 6 sends every phrase to the server
// when it can (src/chat/service.ts `lineRouting`); that is covered in week6.test.tsx.
beforeAll(() => {
  lineRouting.serverDecides = false;
});
afterAll(() => {
  lineRouting.serverDecides = true;
});

const notes = () => usePages.getState().pages.find((p) => p.templateKey === 'notes')!;

describe('S37 page', () => {
  let outbox: ReturnType<typeof resetApp>;
  beforeEach(() => {
    outbox = resetApp();
    finishOnboarding();
  });

  it('offline: empty state, then what is typed shows on the page at once, «Ждёт связи»', async () => {
    await renderRouter(APP_DIR, { initialUrl: `/page/${notes().id}` });
    await settle(() => screen.queryByTestId('page-empty') !== null);
    // Week 11а: the sticker wall's own empty sheet (template-screens 2.1).
    expect(screen.getByText('Здесь будут ваши заметки. Скажите: «Запиши код домофона 4512»')).toBeTruthy();

    await fireEvent.changeText(screen.getByTestId('assistant-input'), 'Код домофона 4512');
    await fireEvent.press(screen.getByTestId('assistant-send'));
    await settle(() => screen.queryByText('Код домофона 4512') !== null);
    expect(screen.getByText('Ждёт связи')).toBeTruthy();
    expect(screen.queryByTestId('page-empty')).toBeNull();
    expect((await outbox.listPending()).map((e) => e.kind)).toEqual(['item.create']);
  });

  it('switching tabs shows each page its own records: a record saved on another page is not here', async () => {
    usePages.getState().addPage('custom', 'Дача');
    const custom = usePages.getState().pages.find((p) => p.templateKey === 'custom')!;
    await testRecords.insertLocal({ id: 'r1', kind: 'note', source: 'typed', text: 'Плитка', pageId: custom.id });
    await testRecords.insertLocal({ id: 'r2', kind: 'note', source: 'typed', text: 'Про другое', pageId: 'today' });
    await renderRouter(APP_DIR, { initialUrl: `/page/${custom.id}` });
    await settle(() => screen.queryByText('Плитка') !== null);
    expect(screen.queryByText('Про другое')).toBeNull();

    // A view, not a folder: «Заметки» shows everything.
    await fireEvent.press(screen.getByTestId(`tab-${notes().id}`));
    await settle(() => screen.queryByText('Про другое') !== null);
    expect(screen.getByText('Плитка')).toBeTruthy();
  });

  it('«Все записи» from «Ещё» shows a record that no page shows', async () => {
    usePages.setState({ pages: usePages.getState().pages.filter((p) => p.templateKey === 'tasks') });
    await testRecords.insertLocal({ id: 'r1', kind: 'note', source: 'typed', text: 'Нигде', pageId: 'today' });
    const r = await renderRouter(APP_DIR, { initialUrl: '/more' });
    await fireEvent.press(screen.getByTestId('more-settings'));
    await fireEvent.press(screen.getByTestId('settings-all_records'));
    await settle(() => screen.queryByText('Нигде') !== null);
    expect(r.getPathname()).toBe('/records');
    expect(screen.getByTestId('assistant-line')).toBeTruthy();
  });

  it('«Своя страница»: «Ещё» → name → the page opens; a new tab; goes to the outbox; rename works', async () => {
    usePages.setState({ pages: usePages.getState().pages.slice(0, 1) });
    const r = await renderRouter(APP_DIR, { initialUrl: '/more' });
    await fireEvent.press(screen.getByTestId('more-add_page'));
    await fireEvent.changeText(screen.getByTestId('page-name-input'), 'Ремонт');
    await fireEvent.press(screen.getByTestId('page-name-save'));
    await settle(() => usePages.getState().pages.length === 2 && r.getPathname().startsWith('/page/'));
    const page = usePages.getState().pages.find((p) => p.templateKey === 'custom')!;
    expect(r.getPathname()).toBe(`/page/${page.id}`);
    expect(within(screen.getByTestId('bottom-tabs')).getByText('Ремонт')).toBeTruthy();
    await settle(() => outbox.all().some((e) => e.kind === 'pages.create'));
    expect(await testPages.get(page.id)).toMatchObject({ title: 'Ремонт' });

    await fireEvent.press(screen.getByTestId('page-menu'));
    await fireEvent.press(screen.getByTestId('page-rename'));
    expect(screen.getByTestId('page-name-input').props.value).toBe('Ремонт');
    await fireEvent.changeText(screen.getByTestId('page-name-input'), 'Дача');
    await fireEvent.press(screen.getByTestId('page-name-save'));
    await settle(() => outbox.all().some((e) => e.kind === 'pages.update'));
    expect(usePages.getState().pages.find((p) => p.id === page.id)?.title).toBe('Дача');
    expect(screen.getAllByText('Дача').length).toBeGreaterThan(0);
  });

  it('«Пока без названия» gives «Моя страница»', async () => {
    usePages.setState({ pages: usePages.getState().pages.slice(0, 1) });
    await renderRouter(APP_DIR, { initialUrl: '/more' });
    await fireEvent.press(screen.getByTestId('more-add_page'));
    await fireEvent.press(screen.getByTestId('page-name-later'));
    await settle(() => screen.queryByText('Моя страница') !== null);
  });

  it('reads Kazakh labels', async () => {
    useOnboarding.getState().setLanguage('kk');
    await testRecords.insertLocal({ id: 'r1', kind: 'voice', source: 'mic' });
    await renderRouter(APP_DIR, { initialUrl: `/page/${notes().id}` });
    await settle(() => screen.queryByText('Дауыстық жазба') !== null);
    expect(screen.getByText('Байланысты күтуде')).toBeTruthy();
  });
});

describe('S09 card', () => {
  beforeEach(() => {
    resetApp();
    finishOnboarding();
  });

  async function openCard(extra: Record<string, unknown>) {
    await testRecords.applyRemote(itemOut('c1', 5, { text: 'Чек из магазина', status: 'needs_review', ...extra }));
    const r = await renderRouter(APP_DIR, { initialUrl: `/page/${notes().id}` });
    await settle(() => screen.queryByTestId('record-c1') !== null);
    return r;
  }

  const twoFields = {
    review_fields: {
      amount_1: { kind: 'amount', value: '389 990 ₸', state: 'unverified' },
      phone_1: { kind: 'phone', value: '+7 701 000 00 00', state: 'unverified' },
    },
  };

  it('list shows «проверьте»; card shows how many; «Верно» removes the mark for that field only, offline', async () => {
    const r = await openCard(twoFields);
    expect(screen.getByTestId('record-check-c1')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('record-c1'));
    await settle(() => screen.queryByTestId('record-card') !== null);
    expect(r.getPathname()).toBe('/record/c1');
    expect(screen.getByText('Проверьте 2 места — я мог ошибиться при распознавании')).toBeTruthy();
    expect(screen.getByTestId('check-field-amount_1').props.accessibilityLabel).toBe(
      'Сумма: 389 990 ₸. Проверьте, возможна ошибка распознавания',
    );

    await fireEvent.press(screen.getByTestId('check-field-amount_1'));
    expect(screen.getByText('Здесь верно: 389 990 ₸?')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('check-ok'));
    await settle(() => screen.queryByText('Проверьте 1 место — я мог ошибиться при распознавании') !== null);
    expect(within(screen.getByTestId('check-field-amount_1')).getByText('верно')).toBeTruthy();
    expect(within(screen.getByTestId('check-field-phone_1')).getByText('проверьте')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('check-show'));
    expect(screen.getByText('Здесь верно: +7 701 000 00 00?')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('check-ok'));
    await settle(() => screen.queryByTestId('check-banner') === null);
  });

  it('«Закрыть» on the question changes nothing', async () => {
    await openCard(twoFields);
    await fireEvent.press(screen.getByTestId('record-c1'));
    await settle(() => screen.queryByTestId('record-card') !== null);
    await fireEvent.press(screen.getByTestId('check-show'));
    await fireEvent.press(screen.getByTestId('check-close'));
    expect(screen.queryByTestId('check-sheet')).toBeNull();
    expect(screen.getByText('Проверьте 2 места — я мог ошибиться при распознавании')).toBeTruthy();
  });

  it('the label appears only on generated content; ordinary records never say «ИИ»', async () => {
    await openCard({ ai_generated: true });
    expect(screen.getByText('Подготовил помощник (ИИ) — проверьте')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('record-c1'));
    await settle(() => screen.queryByTestId('record-ai-label') !== null);
    expect(screen.getByText('Подготовил помощник (ИИ) по вашим записям — проверьте')).toBeTruthy();
  });

  it('no label without ai_generated', async () => {
    await openCard({});
    expect(screen.queryByText(/ИИ/)).toBeNull();
    await fireEvent.press(screen.getByTestId('record-c1'));
    await settle(() => screen.queryByTestId('record-card') !== null);
    expect(screen.queryByTestId('record-ai-label')).toBeNull();
    expect(screen.queryByText(/ИИ/)).toBeNull();
  });

  it('stays «on» the page: same tab and chip, the line is there; «Назад» and the tab return to it', async () => {
    const r = await openCard({});
    await fireEvent.press(screen.getByTestId('record-c1'));
    await settle(() => screen.queryByTestId('record-card') !== null);
    expect(screen.getByTestId(`tab-${notes().id}`)).toBeSelected();
    expect(screen.getByTestId('assistant-input')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('record-back'));
    expect(r.getPathname()).toBe(`/page/${notes().id}`);

    await fireEvent.press(screen.getByTestId('record-c1'));
    await settle(() => r.getPathname() === '/record/c1');
    await fireEvent.press(screen.getByTestId(`tab-${notes().id}`));
    expect(r.getPathname()).toBe(`/page/${notes().id}`);
  });

  it('opening a card asks the server for the record (it stops waiting) and shows what is new', async () => {
    const s = happyServer();
    s.on('GET /items/*', () => ({ status: 200, body: itemOut('c1', 9, { text: 'Свежий текст', summary: 'Коротко о чеке' }) }));
    resetApp({ fetch: s.fetch });
    finishOnboarding();
    await testRecords.applyRemote(itemOut('c1', 5, { text: 'Старый текст' }));
    await renderRouter(APP_DIR, { initialUrl: '/record/c1' });
    await settle(() => screen.queryByText('Свежий текст') !== null);
    expect(s.callsTo('GET /items/srv-c1').length).toBeGreaterThan(0);
  });

  it('an unknown id says so', async () => {
    await renderRouter(APP_DIR, { initialUrl: '/record/nope' });
    await settle(() => screen.queryByTestId('record-missing') !== null);
    expect(screen.getByText('Такой записи нет')).toBeTruthy();
  });
});

describe('merged repeat strip', () => {
  it('«Отменить» brings the record back, the strip goes away by itself otherwise', async () => {
    resetApp();
    finishOnboarding();
    await testRecords.applyRemote(itemOut('dup', 3, { text: 'Повтор', hidden_reason: 'duplicate_merged' }));
    await renderRouter(APP_DIR, { initialUrl: `/page/${notes().id}` });
    await settle(() => screen.queryByTestId('page-empty') !== null);

    useUndo.getState().showMerged('dup', '2026-03-12T10:00:00Z');
    await settle(() => screen.queryByTestId('undo-strip') !== null);
    expect(screen.getByText(/^Уже было — добавил к записи от 12 мар/)).toBeTruthy();

    await fireEvent.press(screen.getByTestId('undo-strip-undo'));
    await settle(() => screen.queryByText('Повтор') !== null);
    expect(screen.queryByTestId('undo-strip')).toBeNull();
    expect(screen.getByText('Отменено')).toBeTruthy();

    useUndo.getState().showMerged('dup', '2026-03-12T10:00:00Z');
    await settle(() => screen.queryByTestId('undo-strip') !== null);
    await settle(() => screen.queryByTestId('undo-strip') === null, 600);
  });
});

describe('sync reaches the screen', () => {
  it('a page and a record from /sync appear without a restart', async () => {
    const s = happyServer();
    s.on('GET /sync', () => ({
      status: 200,
      body: {
        items: [itemOut('remote', 3, { text: 'С другого телефона' })],
        screens: [pageOut(null, 1, { id: 'srv-a', title: 'Дача' })],
        screen_items: [],
        tombstones: [],
        next_since: 3,
        has_more: false,
      },
    }));
    resetApp({ fetch: s.fetch });
    finishOnboarding();
    await renderRouter(APP_DIR, { initialUrl: `/page/${notes().id}` });
    await settle(() => screen.queryByText('С другого телефона') !== null);
    await settle(() => usePages.getState().pages.some((p) => p.serverId === 'srv-a'));
    expect(usePages.getState().pages.find((p) => p.serverId === 'srv-a')?.title).toBe('Дача');
  });
});

describe('S04b', () => {
  const setup = () => {
    const s = happyServer();
    s.on('POST /auth/otp/request', () => ({
      status: 200,
      body: { challenge_id: 'ch-1', expires_at: new Date().toISOString(), dev_code: null },
    })).on('POST /auth/otp/verify', () => ({
      status: 200,
      body: { ...tokenPair('linked'), account_switched: false },
    }));
    resetApp({ fetch: s.fetch });
    const o = useOnboarding.getState();
    o.markWelcomeSeen(false);
    o.acceptConsent('full');
    o.setPath('gallery');
    o.complete();
    return s;
  };

  it('Ф-34: never opens by itself after a saved record; the honest line when opened from «Настройки»', async () => {
    setup();
    const r = await renderRouter(APP_DIR, { initialUrl: `/page/${notes().id}` });
    await fireEvent.changeText(screen.getByTestId('assistant-input'), 'Первая запись');
    await fireEvent.press(screen.getByTestId('assistant-send'));
    await settle(() => screen.queryByText('Первая запись') !== null);
    expect(r.getPathname()).toBe(`/page/${notes().id}`);
    await fireEvent.changeText(screen.getByTestId('assistant-input'), 'Вторая запись');
    await fireEvent.press(screen.getByTestId('assistant-send'));
    await settle(() => screen.queryByText('Вторая запись') !== null);
    expect(r.getPathname()).toBe(`/page/${notes().id}`);
    await act(async () => router.push('/settings'));
    await fireEvent.press(screen.getByTestId('settings-phone'));
    expect(r.getPathname()).toBe('/phone');
    expect(screen.getByText('Сохранить записи, чтобы не потерять при смене телефона')).toBeTruthy();
    expect(screen.getByText('Без номера записи пропадут при удалении приложения')).toBeTruthy();
  });

  it('number → SMS code → name; the session becomes the linked one; greeting by name', async () => {
    const s = setup();
    const r = await renderRouter(APP_DIR, { initialUrl: '/phone?next=home' });
    await fireEvent.changeText(screen.getByTestId('phone-number'), '701 000-00-0');
    await fireEvent.press(screen.getByTestId('phone-get-code'));
    expect(screen.getByText('Проверьте номер: нужно 10 цифр')).toBeTruthy();
    expect(s.callsTo('POST /auth/otp/request')).toHaveLength(0);

    await fireEvent.changeText(screen.getByTestId('phone-number'), '7010000000');
    await fireEvent.press(screen.getByTestId('phone-get-code'));
    await settle(() => screen.queryByTestId('phone-code') !== null);
    expect(s.callsTo('POST /auth/otp/request')[0]?.body).toEqual({ phone: '+77010000000', purpose: 'link' });
    expect(screen.getByTestId('phone-verify')).toBeDisabled();

    await fireEvent.changeText(screen.getByTestId('phone-code'), '123456');
    await fireEvent.press(screen.getByTestId('phone-verify'));
    await settle(() => screen.queryByTestId('phone-name') !== null);
    expect(s.callsTo('POST /auth/otp/verify')[0]?.body).toEqual({
      challenge_id: 'ch-1',
      phone: '+77010000000',
      code: '123456',
    });
    expect(useOnboarding.getState().phoneLinkedAt).not.toBeNull();

    await fireEvent.changeText(screen.getByTestId('phone-name'), 'Али');
    await fireEvent.press(screen.getByTestId('phone-name-done'));
    expect(r.getPathname()).toBe('/alarm-setup'); // Android 14+: S15 (week 8)
    await fireEvent.press(screen.getByTestId('setup-later'));
    expect(r.getPathname()).toBe('/');
    expect(useOnboarding.getState().displayName).toBe('Али');
  });

  it('+996 has 9 digits; a wrong code shows the server text and lets you try again', async () => {
    const s = setup();
    s.on('POST /auth/otp/verify', () => ({
      status: 400,
      body: { code: 'otp_invalid', message_ru: 'Код не подошёл.', message_kk: 'Код сәйкес келмеді.' },
    }));
    await renderRouter(APP_DIR, { initialUrl: '/phone?next=home' });
    await fireEvent.press(screen.getByTestId('phone-country'));
    await fireEvent.changeText(screen.getByTestId('phone-number'), '700123456');
    await fireEvent.press(screen.getByTestId('phone-get-code'));
    await settle(() => screen.queryByTestId('phone-code') !== null);
    expect(s.callsTo('POST /auth/otp/request')[0]?.body).toMatchObject({ phone: '+996700123456' });
    await fireEvent.changeText(screen.getByTestId('phone-code'), '000000');
    await fireEvent.press(screen.getByTestId('phone-verify'));
    await settle(() => screen.queryByTestId('phone-error') !== null);
    expect(screen.getByText('Код не подошёл.')).toBeTruthy();
    expect(useOnboarding.getState().phoneLinkedAt).toBeNull();
  });

  it('offline: says the code needs a connection; «Позже» still works', async () => {
    resetApp();
    finishOnboarding();
    const r = await renderRouter(APP_DIR, { initialUrl: '/phone?next=home' });
    await fireEvent.changeText(screen.getByTestId('phone-number'), '7010000000');
    await fireEvent.press(screen.getByTestId('phone-get-code'));
    await settle(() => screen.queryByTestId('phone-error') !== null);
    expect(screen.getByText('Нет интернета. Для кода нужна связь. Можно указать номер позже.')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('phone-later'));
    expect(r.getPathname()).toBe('/');
  });

  it('«Ещё → Настройки» offers the number until it is linked', async () => {
    resetApp();
    finishOnboarding();
    const r = await renderRouter(APP_DIR, { initialUrl: '/more' });
    await fireEvent.press(screen.getByTestId('more-settings'));
    await fireEvent.press(screen.getByTestId('settings-phone'));
    expect(r.getPathname()).toBe('/phone');
  });
});
