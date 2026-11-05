import { fireEvent, renderRouter, screen, within } from 'expo-router/testing-library';
import { Dimensions } from 'react-native';

import { usePages } from '@/store/pages';

import { APP_DIR, finishOnboarding, resetApp } from '@/testing/helpers';

describe('main navigation', () => {
  let outbox: ReturnType<typeof resetApp>;
  beforeEach(() => {
    outbox = resetApp();
    finishOnboarding();
  });

  it('renders tabs: Сегодня + up to 3 pages + Ещё with labels', async () => {
    usePages.getState().addPage('shopping'); // 4th page → goes to «Ещё»
    await renderRouter(APP_DIR, { initialUrl: '/' });
    const tabs = within(screen.getByTestId('bottom-tabs'));
    const labels = tabs.getAllByRole('tab').map((el) => el.props.accessibilityLabel as string);
    expect(labels).toEqual([
      'Сегодня, вкладка',
      'Заметки, вкладка',
      'Дела, вкладка',
      'Расходы, вкладка',
      'Ещё, вкладка',
    ]);
    expect(tabs.getByText('Сегодня')).toBeTruthy();
    expect(tabs.getByText('Ещё')).toBeTruthy();
    expect(screen.getByTestId('tab-today')).toBeSelected();
  });

  it('shows the assistant line above the tabs on every page with the «Про: <страница>» chip', async () => {
    const r = await renderRouter(APP_DIR, { initialUrl: '/' });
    const pages = usePages.getState().pages;

    const check = (chip: string) => {
      expect(screen.getByTestId('assistant-line')).toBeTruthy();
      expect(screen.getByTestId('assistant-plus')).toBeTruthy();
      expect(screen.getByTestId('assistant-input')).toBeTruthy();
      expect(screen.getByTestId('assistant-mic')).toBeTruthy();
      expect(within(screen.getByTestId('context-chip')).getByText(chip)).toBeTruthy();
    };

    check('Про: Сегодня');
    const expected = ['Про: Заметки', 'Про: Дела и напоминания', 'Про: Расходы'];
    for (const [i, page] of pages.entries()) {
      await fireEvent.press(screen.getByTestId(`tab-${page.id}`));
      expect(r.getPathname()).toBe(`/page/${page.id}`);
      expect(screen.getByTestId(`tab-${page.id}`)).toBeSelected();
      check(expected[i] ?? '');
    }
    await fireEvent.press(screen.getByTestId('tab-more'));
    expect(r.getPathname()).toBe('/more');
    check('Про: Ещё');
  });

  it('typing a message writes to the outbox and shows the answer banner → «Открыть ответ» → Переписка', async () => {
    const r = await renderRouter(APP_DIR, { initialUrl: '/' });
    await fireEvent.changeText(screen.getByTestId('assistant-input'), 'Купить хлеб');
    await fireEvent.press(screen.getByTestId('assistant-send'));

    const pending = await outbox.listPending();
    expect(pending.map((e) => e.kind)).toEqual(['chat.message']);
    expect(pending[0]?.payload).toMatchObject({ text: 'Купить хлеб', pageId: 'today', scope: 'page' });

    expect(screen.getByTestId('answer-banner')).toBeTruthy();
    expect(screen.getByText('Открыть ответ')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('answer-open'));
    expect(r.getPathname()).toBe('/chat');
    expect(screen.getByText('Переписка')).toBeTruthy();
    expect(screen.getByText('Вы: Купить хлеб')).toBeTruthy();
    // Same assistant line in Переписка, over all pages
    expect(within(screen.getByTestId('context-chip')).getByText('Про: все страницы')).toBeTruthy();
  });

  it('«Без ИИ» replaces the mic with «Написать»', async () => {
    resetApp();
    finishOnboarding('no_ai');
    await renderRouter(APP_DIR, { initialUrl: '/' });
    expect(screen.queryByTestId('assistant-mic')).toBeNull();
    expect(screen.getByTestId('assistant-write')).toBeTruthy();
  });

  it('large font (≥150%): two pages in tabs, the third moves to «Ещё»', async () => {
    const spy = jest
      .spyOn(Dimensions, 'get')
      .mockImplementation(() => ({ width: 360, height: 640, scale: 2, fontScale: 1.6 }));
    try {
      await renderRouter(APP_DIR, { initialUrl: '/' });
      const tabs = within(screen.getByTestId('bottom-tabs')).getAllByRole('tab');
      expect(tabs).toHaveLength(4);
    } finally {
      spy.mockRestore();
    }
  });
});
