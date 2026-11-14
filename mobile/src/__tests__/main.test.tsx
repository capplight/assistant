import { act, fireEvent, renderRouter, screen, within } from 'expo-router/testing-library';
import { router } from 'expo-router';
import { Dimensions } from 'react-native';

import { usePages } from '@/store/pages';

import { APP_DIR, finishOnboarding, resetApp, settle, testRecords } from '@/testing/helpers';

describe('main navigation', () => {
  let outbox: ReturnType<typeof resetApp>;
  beforeEach(() => {
    outbox = resetApp();
    finishOnboarding();
  });

  it('renders tabs (Ф-48): Сегодня · Заметки · Расходы · Дела · Ещё; other pages go to «Ещё»', async () => {
    usePages.getState().addPage('custom', 'Дача'); // not a tab → «Ещё»
    await renderRouter(APP_DIR, { initialUrl: '/' });
    const tabs = within(screen.getByTestId('bottom-tabs'));
    const labels = tabs.getAllByRole('tab').map((el) => el.props.accessibilityLabel as string);
    expect(labels).toEqual([
      'Сегодня, вкладка',
      'Заметки, вкладка',
      'Расходы, вкладка',
      'Дела, вкладка',
      'Ещё, вкладка',
    ]);
    expect(tabs.getByText('Сегодня')).toBeTruthy();
    expect(tabs.getByText('Ещё')).toBeTruthy();
    expect(screen.getByTestId('tab-today')).toBeSelected();
  });

  it('shows the assistant line above the tabs on every page, with no «Про: …» label (Ф-47)', async () => {
    const r = await renderRouter(APP_DIR, { initialUrl: '/' });
    const pages = usePages.getState().pages;

    const check = () => {
      expect(screen.getByTestId('assistant-line')).toBeTruthy();
      expect(screen.getByTestId('assistant-plus')).toBeTruthy();
      expect(screen.getByTestId('assistant-input')).toBeTruthy();
      expect(screen.getByTestId('assistant-mic')).toBeTruthy();
      expect(screen.queryByTestId('context-chip')).toBeNull();
      expect(screen.queryByText(/^Про:/)).toBeNull();
      expect(screen.getByTestId('assistant-input').props.accessibilityLabel).toBe('Помощник. Скажите или напишите');
    };

    check();
    // Pages past the two tabs live in «Ещё».
    for (const page of pages.slice(0, 2)) {
      await fireEvent.press(screen.getByTestId(`tab-${page.id}`));
      expect(r.getPathname()).toBe(`/page/${page.id}`);
      expect(screen.getByTestId(`tab-${page.id}`)).toBeSelected();
      check();
    }
    await fireEvent.press(screen.getByTestId('tab-more'));
    expect(r.getPathname()).toBe('/more');
    check();
  });

  it('offline, a note typed on «Расходы» is saved without a page and shows on «Заметки» until the server places it', async () => {
    usePages.getState().addPage('expenses');
    const pages = usePages.getState().pages;
    const exp = pages.find((p) => p.templateKey === 'expenses')!;
    const notes = pages.find((p) => p.templateKey === 'notes')!;
    await renderRouter(APP_DIR, { initialUrl: `/page/${exp.id}` });
    await fireEvent.changeText(screen.getByTestId('assistant-input'), 'Плитка для ванной 3 метра');
    await fireEvent.press(screen.getByTestId('assistant-send'));
    const pending = await outbox.listPending();
    expect(pending[0]?.payload).toMatchObject({ text: 'Плитка для ванной 3 метра', kind: 'note' });
    expect(pending[0]?.payload).not.toHaveProperty('pageId');
    expect((await testRecords.list())[0]?.pageId).toBeNull();
    await fireEvent.press(screen.getByTestId(`tab-${notes.id}`));
    await settle(() => screen.queryByText('Плитка для ванной 3 метра') !== null);
  });

  it('typing a note offline writes to the outbox and says where it went (SaveToast, Ф-50); «История» has the turn', async () => {
    const r = await renderRouter(APP_DIR, { initialUrl: '/' });
    await fireEvent.changeText(screen.getByTestId('assistant-input'), 'Купить хлеб');
    await fireEvent.press(screen.getByTestId('assistant-send'));

    const pending = await outbox.listPending();
    expect(pending.map((e) => e.kind)).toEqual(['item.create']);
    expect(pending[0]?.payload).toMatchObject({ text: 'Купить хлеб', kind: 'note', source: 'typed' });
    // Ф-47: no page from the line; the server places it by its rules.
    expect(pending[0]?.payload).not.toHaveProperty('pageId');
    expect((await testRecords.list())[0]).toMatchObject({ text: 'Купить хлеб', status: 'queued' });

    expect(screen.getByTestId('undo-strip-text')).toHaveTextContent(/^Сохранил в «Заметки»: Купить хлеб/);
    expect(screen.getByTestId('undo-strip-replace')).toBeTruthy();
    await act(async () => router.push('/chat'));
    expect(r.getPathname()).toBe('/history');
    expect(screen.getByText('История')).toBeTruthy();
    expect(screen.getByText('Вы: «Купить хлеб»')).toBeTruthy();
    // Same assistant line in «История», no scope label (Ф-47).
    expect(screen.getByTestId('assistant-input')).toBeTruthy();
    expect(screen.queryByTestId('context-chip')).toBeNull();
  });

  it('mic → «Слушаю…» with timer and level ring → «Готово» → voice record queued + «Сохранил в «Заметки»»', async () => {
    await renderRouter(APP_DIR, { initialUrl: '/' });
    await fireEvent.press(screen.getByTestId('assistant-mic'));
    await settle(() => screen.queryByTestId('assistant-listening') !== null);
    expect(screen.getByText('Слушаю…')).toBeTruthy();
    expect(screen.getByTestId('voice-timer')).toHaveTextContent('0:00');
    expect(screen.getByTestId('voice-level-ring')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('assistant-listening-done'));
    await settle(() => outbox.all().length === 1 && screen.queryByTestId('undo-strip-text') !== null);
    const [entry] = await outbox.listPending();
    expect(entry?.payload).toMatchObject({ kind: 'voice', source: 'mic', file: { mime: 'audio/mp4' } });
    expect(screen.getByTestId('undo-strip-text')).toHaveTextContent(/Сохранил в «Заметки»/);
    expect(screen.queryByTestId('assistant-listening')).toBeNull();
  });

  it('«Без ИИ» replaces the mic with «Написать»', async () => {
    resetApp();
    finishOnboarding('no_ai');
    await renderRouter(APP_DIR, { initialUrl: '/' });
    expect(screen.queryByTestId('assistant-mic')).toBeNull();
    expect(screen.getByTestId('assistant-write')).toBeTruthy();
  });

  it('large font (≥150%): «Сегодня · Расходы · Дела · Ещё», «Заметки» move to «Ещё» (Ф-48)', async () => {
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
