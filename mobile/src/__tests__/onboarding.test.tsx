import { fireEvent, renderRouter, screen } from 'expo-router/testing-library';

import { useOnboarding } from '@/store/onboarding';
import { usePages } from '@/store/pages';

import { APP_DIR, resetApp } from '@/testing/helpers';

describe('first launch flow', () => {
  let outbox: ReturnType<typeof resetApp>;
  beforeEach(() => {
    outbox = resetApp();
  });

  it('starts on the welcome screen when onboarding is not done', async () => {
    const r = await renderRouter(APP_DIR, { initialUrl: '/' });
    expect(r.getPathname()).toBe('/welcome');
    expect(screen.getByText('Добро пожаловать!')).toBeTruthy();
    expect(screen.getByText('Пропустить')).toBeTruthy();
  });

  it('welcome → 3 frames → consent → «Без ИИ» → S41 → blank page', async () => {
    const r = await renderRouter(APP_DIR, { initialUrl: '/welcome' });

    // Frame 2: soft pick «Посчитать расходы»
    await fireEvent.press(screen.getByTestId('welcome-next'));
    expect(screen.getByText('Что вас интересует? Вы можете:')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('interest-money'));
    expect(useOnboarding.getState().interests).toEqual(['money']);
    await fireEvent.press(screen.getByTestId('welcome-next'));
    expect(screen.getByText('Начать')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('welcome-next'));
    expect(r.getPathname()).toBe('/consent');

    // Consent: all named providers, 18+ line, both buttons present
    expect(screen.getByText('Anthropic, OpenAI, Google, Groq')).toBeTruthy();
    expect(screen.getByText('Мне есть 18 лет, принимаю Условия.')).toBeTruthy();
    const agree = screen.getByTestId('consent-agree');
    const noAi = screen.getByTestId('consent-no-ai');
    expect(agree).toBeDisabled();
    expect(noAi).toBeDisabled();
    await fireEvent.press(screen.getByTestId('consent-storage'));
    expect(noAi).toBeEnabled();
    expect(agree).toBeDisabled(); // needs item 2 too
    await fireEvent.press(noAi);

    expect(useOnboarding.getState().consent?.mode).toBe('no_ai');
    expect(useOnboarding.getState().consent?.kinds).not.toContain('ai_cross_border');
    expect(r.getPathname()).toBe('/start');
    expect(screen.getByText('С чего начнём?')).toBeTruthy();
    // «Без ИИ»: the phrase path is typed
    expect(screen.getByText('Напишите одну фразу — я сразу сделаю')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('start-blank'));
    const pages = usePages.getState().pages;
    expect(pages).toHaveLength(1);
    expect(pages[0]?.templateKey).toBe('custom');
    expect(useOnboarding.getState().path).toBe('blank');
    expect(useOnboarding.getState().doneAt).not.toBeNull();
    expect(r.getPathname()).toBe(`/page/${pages[0]?.id}`);
    expect(screen.getByText('Моя страница')).toBeTruthy();

    const kinds = (await outbox.listPending()).map((e) => e.kind);
    expect(kinds).toEqual(['consent.accept', 'pages.create']);
  });

  it('skip → consent «Согласен» → gallery path creates the chosen pages', async () => {
    const r = await renderRouter(APP_DIR, { initialUrl: '/welcome' });
    await fireEvent.press(screen.getByTestId('welcome-skip'));
    expect(r.getPathname()).toBe('/consent');
    expect(useOnboarding.getState().path).toBe('skipped');

    await fireEvent.press(screen.getByTestId('consent-storage'));
    await fireEvent.press(screen.getByTestId('consent-cross'));
    await fireEvent.press(screen.getByTestId('consent-agree'));
    expect(useOnboarding.getState().consent?.kinds).toEqual(
      expect.arrayContaining(['pd_processing', 'ai_cross_border', 'terms', 'age_confirmed_18', 'push_content']),
    );

    // Path 1 via «Все шаблоны (6)»: gallery shows all 6 templates
    await fireEvent.press(screen.getByTestId('start-all'));
    expect(r.getPathname()).toBe('/gallery');
    for (const title of ['Заметки', 'Дела и напоминания', 'Покупки', 'Документы и КП', 'Расходы', 'Своя страница']) {
      expect(screen.getByText(title)).toBeTruthy();
    }
    await fireEvent.press(screen.getByTestId('gallery-shopping'));
    await fireEvent.press(screen.getByTestId('gallery-expenses'));
    expect(screen.getByTestId('gallery-shopping')).toBeChecked();
    await fireEvent.press(screen.getByTestId('gallery-ok'));

    const keys = usePages.getState().pages.map((p) => p.templateKey);
    expect(keys).toEqual(['shopping', 'expenses']);
    expect(r.getPathname()).toBe(`/page/${usePages.getState().pages[0]?.id}`);
  });

  it('path 3 (default): phrase → gallery with Notes + Tasks (+ Expenses by words) premarked', async () => {
    const s = useOnboarding.getState();
    s.markWelcomeSeen(false);
    s.acceptConsent('full');
    const r = await renderRouter(APP_DIR, { initialUrl: '/start' });
    await fireEvent.press(screen.getByTestId('start-phrase'));
    expect(r.getPathname()).toBe('/phrase');
    await fireEvent.changeText(screen.getByTestId('phrase-input'), 'Потратил 5000 на бензин');
    await fireEvent.press(screen.getByTestId('phrase-send'));
    expect(r.getPathname()).toBe('/gallery');
    expect(screen.getByTestId('gallery-notes')).toBeChecked();
    expect(screen.getByTestId('gallery-tasks')).toBeChecked();
    expect(screen.getByTestId('gallery-expenses')).toBeChecked();
    expect(screen.getByTestId('gallery-shopping')).not.toBeChecked();
    await fireEvent.press(screen.getByTestId('gallery-ok'));
    expect(usePages.getState().pages.map((p) => p.templateKey)).toEqual(['notes', 'tasks', 'expenses']);
    expect(r.getPathname()).toBe('/');
    expect(useOnboarding.getState().path).toBe('phrase_first');
  });

  it('resumes at consent if welcome was seen but consent not given', async () => {
    useOnboarding.getState().markWelcomeSeen(false);
    const r = await renderRouter(APP_DIR, { initialUrl: '/' });
    expect(r.getPathname()).toBe('/consent');
  });
});
