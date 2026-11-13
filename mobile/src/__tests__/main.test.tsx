import { fireEvent, renderRouter, screen, within } from 'expo-router/testing-library';
import { Dimensions } from 'react-native';

import { usePages } from '@/store/pages';

import { APP_DIR, finishOnboarding, resetApp, settle, testRecords } from '@/testing/helpers';

describe('main navigation', () => {
  let outbox: ReturnType<typeof resetApp>;
  beforeEach(() => {
    outbox = resetApp();
    finishOnboarding();
  });

  it('renders tabs: Сегодня + up to 2 pages + Ещё with labels — never more than 4 (design-system TabBar)', async () => {
    usePages.getState().addPage('shopping'); // 3rd and 4th pages → go to «Ещё»
    await renderRouter(APP_DIR, { initialUrl: '/' });
    const tabs = within(screen.getByTestId('bottom-tabs'));
    const labels = tabs.getAllByRole('tab').map((el) => el.props.accessibilityLabel as string);
    expect(labels).toEqual([
      'Сегодня, вкладка',
      'Заметки, вкладка',
      'Дела, вкладка',
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
    // Pages past the two tabs live in «Ещё»; the line names whichever page is open.
    for (const [i, page] of pages.slice(0, 2).entries()) {
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
    expect(pending.map((e) => e.kind)).toEqual(['item.create']);
    expect(pending[0]?.payload).toMatchObject({ text: 'Купить хлеб', pageId: 'today', kind: 'note', source: 'typed' });
    expect((await testRecords.list())[0]).toMatchObject({ text: 'Купить хлеб', status: 'queued' });

    expect(screen.getByTestId('answer-banner')).toBeTruthy();
    expect(screen.getByText('Открыть ответ')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('answer-open'));
    expect(r.getPathname()).toBe('/chat');
    expect(screen.getByText('Переписка')).toBeTruthy();
    expect(screen.getByLabelText('Вы: Купить хлеб')).toBeTruthy();
    // Same assistant line in Переписка, over all pages
    expect(within(screen.getByTestId('context-chip')).getByText('Про: все страницы')).toBeTruthy();
  });

  it('mic → «Слушаю…» with timer and level ring → «Готово» → voice record queued + «Сохранено»', async () => {
    await renderRouter(APP_DIR, { initialUrl: '/' });
    await fireEvent.press(screen.getByTestId('assistant-mic'));
    await settle(() => screen.queryByTestId('assistant-listening') !== null);
    expect(screen.getByText('Слушаю…')).toBeTruthy();
    expect(screen.getByTestId('voice-timer')).toHaveTextContent('0:00');
    expect(screen.getByTestId('voice-level-ring')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('assistant-listening-done'));
    await settle(() => outbox.all().length === 1 && screen.queryByText('Сохранено') !== null);
    const [entry] = await outbox.listPending();
    expect(entry?.payload).toMatchObject({ kind: 'voice', source: 'mic', file: { mime: 'audio/mp4' } });
    expect(screen.getByText('Сохранено')).toBeTruthy();
    expect(screen.queryByTestId('assistant-listening')).toBeNull();
  });

  it('«Без ИИ» replaces the mic with «Написать»', async () => {
    resetApp();
    finishOnboarding('no_ai');
    await renderRouter(APP_DIR, { initialUrl: '/' });
    expect(screen.queryByTestId('assistant-mic')).toBeNull();
    expect(screen.getByTestId('assistant-write')).toBeTruthy();
  });

  it('large font (≥150%): one page in tabs, the rest move to «Ещё»', async () => {
    const spy = jest
      .spyOn(Dimensions, 'get')
      .mockImplementation(() => ({ width: 360, height: 640, scale: 2, fontScale: 1.6 }));
    try {
      await renderRouter(APP_DIR, { initialUrl: '/' });
      const tabs = within(screen.getByTestId('bottom-tabs')).getAllByRole('tab');
      expect(tabs).toHaveLength(3);
    } finally {
      spy.mockRestore();
    }
  });
});
