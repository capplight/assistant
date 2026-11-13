import { fireEvent, renderRouter, screen } from 'expo-router/testing-library';

import { FEATURE_DEFAULTS } from '@/api/endpoints';
import type { ConsentsIn } from '@/api/types';
import { useFeatureStore } from '@/store/features';
import { useOnboarding } from '@/store/onboarding';
import { usePages } from '@/store/pages';
import { happyServer } from '@/testing/fakeServer';

import { APP_DIR, resetApp, settle } from '@/testing/helpers';

/** Ф-34: welcome → «Начать» (with the policy line) → «Сегодня». No S05, S41, gallery, SMS, alarm or notification prompt. */
describe('first launch flow (Ф-34)', () => {
  let outbox: ReturnType<typeof resetApp>;
  beforeEach(() => {
    outbox = resetApp();
  });

  it('starts on the one welcome screen: picture, title, language, «Начать», the policy line with links', async () => {
    const r = await renderRouter(APP_DIR, { initialUrl: '/' });
    expect(r.getPathname()).toBe('/welcome');
    expect(screen.getByText('Скажите — я запомню, напомню и найду')).toBeTruthy();
    expect(screen.getByTestId('welcome-policy')).toHaveTextContent(
      'Нажимая «Начать», вы принимаете Политику конфиденциальности и Условия.',
    );
    expect(screen.getByTestId('welcome-policy').props.children).toBeTruthy();
    expect(screen.getByTestId('welcome-start')).toHaveTextContent('Начать');
    // Gone from the first launch: «Пропустить», frames, «Настраиваю для другого человека» (flag off).
    expect(screen.queryByText('Пропустить')).toBeNull();
    expect(screen.queryByTestId('welcome-next')).toBeNull();
    expect(screen.queryByTestId('welcome-for-other')).toBeNull();
    await fireEvent.press(screen.getByTestId('lang-kk'));
    expect(useOnboarding.getState().language).toBe('kk');
  });

  it('«Начать» records the consents (screen «welcome», versions, hashes), makes Заметки + Дела, opens «Сегодня»', async () => {
    const r = await renderRouter(APP_DIR, { initialUrl: '/welcome' });
    await fireEvent.press(screen.getByTestId('welcome-start'));
    await settle(() => r.getPathname() === '/');

    const st = useOnboarding.getState();
    expect(st.consent?.mode).toBe('full');
    expect(st.consent?.kinds).toEqual(expect.arrayContaining(['pd_processing', 'ai_cross_border', 'terms', 'age_confirmed_18', 'push_content']));
    expect(st.consent?.texts.map((x) => x.version)).toEqual(['pd-2026-11-v1', 'ai-2026-11-v1', 'terms-2026-11-v1', 'push-2026-11-v1']);
    expect(st.doneAt).not.toBeNull();
    expect(st.path).toBe('skipped');
    expect(usePages.getState().pages.map((p) => p.templateKey)).toEqual(['notes', 'tasks']);

    const rows = await outbox.listPending();
    expect(rows.map((e) => e.kind)).toEqual(['consent.accept', 'device.register', 'onboarding.welcome_seen', 'pages.batch']);
    const request = (rows[0]?.payload as { request: ConsentsIn }).request;
    expect(request.screen).toBe('welcome');
    expect(request.age_confirmed_18).toBe(true);
    expect(request.consents.map((c) => c.kind)).toEqual(['pd_processing', 'ai_cross_border', 'terms', 'push_content']);
    expect(request.consents.every((c) => /^[0-9a-f]{64}$/.test(c.text_hash))).toBe(true);
    expect((rows[3]?.payload as { path: string }).path).toBe('skipped');
    // «Сегодня», not the phone / alarm / notification screens.
    expect(screen.getByTestId('page-today')).toBeTruthy();
  });

  it('online: POST /consents with screen = the server’s `consent_screen`, then POST /pages/batch {"path":"skipped"}', async () => {
    const s = happyServer();
    outbox = resetApp({ fetch: s.fetch });
    const r = await renderRouter(APP_DIR, { initialUrl: '/welcome' });
    await fireEvent.press(screen.getByTestId('welcome-start'));
    await settle(() => r.getPathname() === '/');
    await settle(() => s.callsTo('POST /consents').length === 1 && s.callsTo('POST /pages/batch').length === 1);
    expect(s.callsTo('POST /consents')[0]?.body).toMatchObject({ screen: 'welcome', age_confirmed_18: true });
    expect(s.callsTo('POST /pages/batch')[0]?.body).toMatchObject({ path: 'skipped' });
    expect(r.getPathname()).toBe('/');
  });

  it('the policy and terms links open the texts being accepted (the «ИИ» disclosure and the named services)', async () => {
    const r = await renderRouter(APP_DIR, { initialUrl: '/welcome' });
    await fireEvent.press(screen.getByTestId('welcome-policy-link-policy'));
    expect(r.getPathname()).toBe('/legal');
    expect(screen.getByText('2. Передача сервисам ИИ за рубеж')).toBeTruthy();
    expect(screen.getByText('Anthropic, OpenAI, Google, Groq')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('header-back'));
    expect(r.getPathname()).toBe('/welcome');
    await fireEvent.press(screen.getByTestId('welcome-policy-link-terms'));
    expect(screen.getByText('Я принимаю условия использования. Мне есть 18 лет.')).toBeTruthy();
    expect(useOnboarding.getState().consent).toBeNull();
  });

  it('closed right after «Начать» (consents kept, launch not finished) → «Сегодня» with the default pages', async () => {
    useOnboarding.getState().acceptConsent('full');
    const r = await renderRouter(APP_DIR, { initialUrl: '/' });
    expect(r.getPathname()).toBe('/');
    await settle(() => usePages.getState().pages.length === 2);
    expect(useOnboarding.getState().doneAt).not.toBeNull();
  });

  it('no consent yet → the welcome screen again (S05 is not on the path any more)', async () => {
    useOnboarding.getState().markWelcomeSeen(false);
    const r = await renderRouter(APP_DIR, { initialUrl: '/' });
    expect(r.getPathname()).toBe('/welcome');
  });

  it('«Настраиваю для другого человека» shows only with `setup_for_other`', async () => {
    useFeatureStore.getState().set({ ...FEATURE_DEFAULTS, setup_for_other: true });
    await renderRouter(APP_DIR, { initialUrl: '/welcome' });
    expect(screen.getByTestId('welcome-for-other')).toBeTruthy();
  });

  it('hidden, not deleted (Ф-33): S05 and S41 still open by their address', async () => {
    useOnboarding.getState().markWelcomeSeen(false);
    const r = await renderRouter(APP_DIR, { initialUrl: '/consent' });
    await fireEvent.press(screen.getByTestId('consent-storage'));
    await fireEvent.press(screen.getByTestId('consent-no-ai'));
    expect(useOnboarding.getState().consent?.mode).toBe('no_ai');
    expect(r.getPathname()).toBe('/start');
    expect(screen.getByText('С чего начнём?')).toBeTruthy();
  });

  it('S41 path 3 still works: phrase → gallery with Notes + Tasks (+ Expenses by words) premarked', async () => {
    const s = useOnboarding.getState();
    s.markWelcomeSeen(false);
    s.acceptConsent('full');
    const r = await renderRouter(APP_DIR, { initialUrl: '/start' });
    await fireEvent.press(screen.getByTestId('start-phrase'));
    expect(r.getPathname()).toBe('/phrase');
    await fireEvent.changeText(screen.getByTestId('phrase-input'), 'Потратил 5000 на бензин');
    await fireEvent.press(screen.getByTestId('phrase-send'));
    expect(r.getPathname()).toBe('/notify');
    await fireEvent.press(screen.getByTestId('notify-next'));
    expect(r.getPathname()).toBe('/gallery');
    expect(screen.getByTestId('gallery-expenses')).toBeChecked();
    await fireEvent.press(screen.getByTestId('gallery-ok'));
    expect(usePages.getState().pages.map((p) => p.templateKey)).toEqual(['notes', 'tasks', 'expenses']);
    expect(useOnboarding.getState().path).toBe('phrase_first');
  });
});
