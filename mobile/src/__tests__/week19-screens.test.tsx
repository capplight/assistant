import { router } from 'expo-router';
import { act, fireEvent, renderRouter, screen } from 'expo-router/testing-library';

import { FEATURE_DEFAULTS } from '@/api/endpoints';
import type { TodayOut } from '@/api/types';
import { useFeatureStore } from '@/store/features';
import { useOnboarding } from '@/store/onboarding';
import { useTasks } from '@/tasks/store';
import { usePages } from '@/store/pages';
import { useToday } from '@/today/service';
import { useSchemePreference } from '@/theme';
import { APP_DIR, finishOnboarding, resetApp, settle } from '@/testing/helpers';

/** Week 19 (Ф-33, Ф-41, Ф-42, Ф-43): «Ещё» in six rows, one «Настройки», what the beta switches hide. */

const DAY = 86_400_000;

beforeEach(() => {
  resetApp();
  finishOnboarding('full');
});

describe('«Ещё» (Ф-41)', () => {
  it('v4: the profile, the «Дела» / «Документы» tiles, the rows (История among them), «Ваши страницы»; no stubs', async () => {
    await renderRouter(APP_DIR, { initialUrl: '/more' });
    // screens-v5 «Ещё»: plain rows, «Корзина» among them, 🔍 on the stone sheet.
    // QA v5-device-1 B «Ещё» 1: the list ends at «Настройки» (import is in «Переписки», own pages show only when there are any).
    const rows = ['more-search', 'more-profile', 'more-tasks', 'more-documents', 'more-history', 'more-records', 'more-trash', 'more-ai-chats', 'more-settings'];
    for (const id of rows) expect(screen.getByTestId(id)).toBeTruthy();
    const ids = new Set<string>();
    const walk = (n: unknown): void => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) return n.forEach(walk);
      const node = n as { props?: { testID?: unknown }; children?: unknown };
      const id = node.props?.testID;
      if (typeof id === 'string' && /^more-(?!page-)/.test(id)) ids.add(id);
      walk(node.children);
    };
    walk(screen.toJSON());
    expect([...ids].sort()).toEqual([...rows].sort());
    expect(screen.queryByText('Появится позже')).toBeNull();
    for (const gone of ['more-did', 'more-lang', 'more-delete_account', 'more-my_data', 'more-alarms', 'more-chat']) {
      expect(screen.queryByTestId(gone)).toBeNull();
    }
  });

  it('the profile and «Настройки» open the one settings screen; «История» opens the merged history', async () => {
    const r = await renderRouter(APP_DIR, { initialUrl: '/more' });
    // Not signed in yet: the one profile card leads to the number (QA v2 §5.1); «Настройки» is its own row.
    await fireEvent.press(screen.getByTestId('more-profile'));
    expect(r.getPathname()).toBe('/phone');
    await act(async () => router.back());
    await fireEvent.press(screen.getByTestId('more-settings'));
    expect(r.getPathname()).toBe('/settings');
    await fireEvent.press(screen.getByTestId('header-back'));
    expect(r.getPathname()).toBe('/more');
    await fireEvent.press(screen.getByTestId('more-history'));
    expect(r.getPathname()).toBe('/history');
  });

  it('pages that do not fit in the tabs are «Ваши страницы»', async () => {
    usePages.getState().addPage('custom', 'Дача');
    await renderRouter(APP_DIR, { initialUrl: '/more' });
    expect(screen.getByText('Ваши страницы')).toBeTruthy();
    const extra = usePages.getState().pages.filter((p) => p.templateKey === 'custom')[0]!;
    expect(screen.getByTestId(`more-page-${extra.id}`)).toBeTruthy();
  });
});

describe('«Настройки»', () => {
  it('theme, language, alarms, budget, data, the assistant, account, about and «Удалить аккаунт» in one screen', async () => {
    const r = await renderRouter(APP_DIR, { initialUrl: '/settings' });
    // «Корзина» is in «Ещё» only (QA B «Настройки» 4).
    for (const id of ['phone', 'my_data', 'duplicates', 'habits', 'alarms', 'lang', 'budget', 'policy', 'consents', 'version', 'delete_account']) {
      expect(screen.getByTestId(`settings-${id}`)).toBeTruthy();
    }
    await fireEvent.press(screen.getByTestId('settings-consents'));
    expect(r.getPathname()).toBe('/legal');
    expect(screen.getByTestId('legal-consent-mode')).toHaveTextContent(/Хранение в Казахстане и передача сервисам ИИ/);
  });

  it('features off (the beta): no Telegram sign-in, no personal mail; on: the rows appear', async () => {
    await renderRouter(APP_DIR, { initialUrl: '/settings' });
    expect(screen.queryByTestId('settings-telegram')).toBeNull();
    expect(screen.queryByTestId('settings-mail')).toBeNull();
    await act(async () => useFeatureStore.getState().set({ ...FEATURE_DEFAULTS, telegram_login: true, personal_mail: true }));
    expect(screen.getByTestId('settings-telegram')).toBeTruthy();
    expect(screen.getByTestId('settings-mail')).toBeTruthy();
  });

  it('language switches after the confirmation; the theme card «Глубина» sets dark and keeps it', async () => {
    await renderRouter(APP_DIR, { initialUrl: '/settings' });
    await fireEvent.press(screen.getByTestId('settings-lang'));
    await fireEvent.press(screen.getByTestId('lang-kk'));
    await fireEvent.press(screen.getByTestId('lang-confirm-yes'));
    expect(useOnboarding.getState().language).toBe('kk');
    await fireEvent.press(screen.getByTestId('theme-row'));
    await fireEvent.press(screen.getByTestId('theme-dark'));
    expect(useSchemePreference.getState().preference).toBe('dark');
    expect(screen.getByTestId('theme-dark').props.accessibilityState.checked).toBe(true);
  });
});

describe('«Сегодня» and the beta switches (Ф-42)', () => {
  const withTile = (): void => {
    const notes = usePages.getState().pages.find((p) => p.templateKey === 'notes')!;
    usePages.setState((s) => ({ pages: s.pages.map((p) => (p.id === notes.id ? { ...p, serverId: 'srv-notes' } : p)) }));
    useOnboarding.setState({ openedAt: new Date(Date.now() - 30 * DAY).toISOString() });
    useToday.setState({
      last: {
        date: null, tz: null, greeting: null, sections: [], today: { reminders: [], tasks: [], shopping: null }, missed: [],
        done_for_you: { actions: [], count_today: 0 }, banner: null, proposals: [], tip: null, empty: true, example: null,
        page_tiles: [{ page_id: 'srv-notes', template_key: 'notes', title: 'Заметки', icon: null, text_ru: '12 заметок', pinned: true }],
      } as unknown as TodayOut,
    });
  };

  it('`today.tiles` off: no tiles, no «Я сделал за вас», no «Новое напоминание»; on: the tile shows', async () => {
    withTile();
    await renderRouter(APP_DIR, { initialUrl: '/' });
    expect(screen.getByTestId('today-empty')).toBeTruthy();
    expect(screen.queryByTestId('today-tiles')).toBeNull();
    expect(screen.queryByTestId('today-did-all')).toBeNull();
    expect(screen.queryByTestId('today-new-reminder')).toBeNull();
    await act(async () => useFeatureStore.getState().set({ ...FEATURE_DEFAULTS, today: { ...FEATURE_DEFAULTS.today, tiles: true } }));
    await settle(() => screen.queryByTestId('today-tiles') !== null);
    await fireEvent.press(screen.getAllByTestId(/^today-tile-menu-/)[0]!);
    expect(screen.getByTestId('tile-pin')).toBeTruthy();
  });

  it('v4: today’s to-dos are «Дела» rows with circles; «Все дела · N» counts the open ones', async () => {
    const d = new Date();
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const iso = new Date().toISOString();
    const task = (id: string, title: string) => ({ id, client_id: id, item_id: `i-${id}`, list_key: 'todo', title, qty: null, where: null, due_date: day, done: false, done_at: null, version: 1, seq: 1, created_at: iso, updated_at: iso, deleted_at: null });
    useTasks.setState({ tasks: { a: task('a', 'Позвонить в банк'), b: task('b', 'Оплатить интернет') } as never });
    await renderRouter(APP_DIR, { initialUrl: '/' });
    expect(screen.getByTestId('task-a')).toHaveTextContent(/Позвонить в банк/);
    expect(screen.getByTestId('task-b')).toHaveTextContent(/Оплатить интернет/);
    // Ф-84 «Сводка»: no plan today → the phrase names what is there, the week is on the sheet (a day opens «Дела»);
    // «Все дела ›» belongs to the nearest day with things, so an empty week has none.
    expect(screen.getByTestId('sheet-phrase')).toHaveTextContent('Свободный день. Не забыть 2 дела.');
    expect(screen.getByTestId(`week-${day}`).props.accessibilityState.selected).toBe(true);
    expect(screen.queryByTestId('today-all-tasks')).toBeNull();
    await fireEvent.press(screen.getByTestId('task-check-b'));
    await settle(() => screen.getByTestId('task-check-b').props.accessibilityState.checked === true);
  });
});
