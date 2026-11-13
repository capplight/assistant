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
  it('the profile + five rows in one card, no «Появится позже» stubs, nothing service-like', async () => {
    await renderRouter(APP_DIR, { initialUrl: '/more' });
    const rows = ['more-profile', 'more-add_page', 'more-my_pages', 'more-did', 'more-import', 'more-settings'];
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
    for (const gone of ['more-trash', 'more-help', 'more-lang', 'more-delete_account', 'more-my_data', 'more-alarms', 'more-chat']) {
      expect(screen.queryByTestId(gone)).toBeNull();
    }
  });

  it('the profile and «Настройки» open the one settings screen; «Что я сделал» opens S20', async () => {
    const r = await renderRouter(APP_DIR, { initialUrl: '/more' });
    await fireEvent.press(screen.getByTestId('more-profile'));
    expect(r.getPathname()).toBe('/settings');
    await fireEvent.press(screen.getByTestId('header-back'));
    expect(r.getPathname()).toBe('/more');
    await fireEvent.press(screen.getByTestId('more-did'));
    expect(r.getPathname()).toBe('/did');
  });

  it('pages that do not fit in the tabs are «Ваши страницы»', async () => {
    usePages.getState().addPage('shopping');
    usePages.getState().addPage('expenses');
    await renderRouter(APP_DIR, { initialUrl: '/more' });
    expect(screen.getByText('Ваши страницы')).toBeTruthy();
    const extra = usePages.getState().pages.filter((p) => p.templateKey === 'expenses')[0]!;
    expect(screen.getByTestId(`more-page-${extra.id}`)).toBeTruthy();
  });
});

describe('«Настройки»', () => {
  it('account, data, assistant, look, about and «Удалить аккаунт» in one screen', async () => {
    const r = await renderRouter(APP_DIR, { initialUrl: '/settings' });
    for (const id of ['phone', 'my_data', 'all_records', 'duplicates', 'trash', 'chat', 'habits', 'alarms', 'lang', 'theme', 'policy', 'terms', 'consents', 'version', 'delete_account']) {
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

  it('language switches; the theme sheet sets «Тёмная» and keeps it', async () => {
    await renderRouter(APP_DIR, { initialUrl: '/settings' });
    await fireEvent.press(screen.getByTestId('settings-lang'));
    expect(useOnboarding.getState().language).toBe('kk');
    await fireEvent.press(screen.getByTestId('settings-lang'));
    await fireEvent.press(screen.getByTestId('settings-theme'));
    await fireEvent.press(screen.getByTestId('theme-dark'));
    expect(useSchemePreference.getState().preference).toBe('dark');
    expect(screen.getByTestId('settings-theme')).toHaveTextContent(/Тёмная/);
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

  it('«Дальше» is the first to-do; the others are one flat list with circles', async () => {
    const d = new Date();
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const iso = new Date().toISOString();
    const task = (id: string, title: string) => ({ id, client_id: id, item_id: `i-${id}`, list_key: 'todo', title, qty: null, where: null, due_date: day, done: false, done_at: null, version: 1, seq: 1, created_at: iso, updated_at: iso, deleted_at: null });
    useTasks.setState({ tasks: { a: task('a', 'Позвонить в банк'), b: task('b', 'Оплатить интернет') } as never });
    await renderRouter(APP_DIR, { initialUrl: '/' });
    expect(screen.getByTestId('today-next')).toHaveTextContent(/Позвонить в банк/);
    expect(screen.getByTestId('task-b')).toHaveTextContent(/Оплатить интернет/);
    await fireEvent.press(screen.getByTestId('task-check-b'));
    await settle(() => screen.getByTestId('task-check-b').props.accessibilityState.checked === true);
  });
});
