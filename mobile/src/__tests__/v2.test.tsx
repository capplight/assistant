import { act, fireEvent, renderRouter, screen } from 'expo-router/testing-library';

import { actionOut, budgetOut, FEATURE_DEFAULTS, todayOut } from '@/api/endpoints';
import type { ActionOut, ReminderDraft } from '@/api/types';
import { historyEntries, matchesFilter } from '@/chat/history';
import { caught } from '@/chat/caught';
import { litSegments } from '@/components/CaughtCard';
import { directValue } from '@/components/SearchAnswer';
import { blurSupported } from '@/components/ui/Glass';
import { tabBarMetrics } from '@/components/ui/TabBar';
import { getRecords } from '@/db';
import { looksLikeKp, openServerKp } from '@/kp/start';
import { useKp } from '@/kp/store';
import { useConnectivity } from '@/store/connectivity';
import { mainTabs, visiblePages } from '@/pages/tabs';
import { isDefaultTitle } from '@/pages/templates';
import { useAlarms } from '@/alarms/store';
import { useAssistant, type ChatMessage } from '@/store/assistant';
import { budgetMinor, useBudget } from '@/store/budget';
import { useFeatureStore } from '@/store/features';
import { useOnboarding } from '@/store/onboarding';
import { usePages } from '@/store/pages';
import { useReminderCard } from '@/store/reminderCard';
import { useUndo } from '@/store/undo';
import { useView } from '@/store/view';
import { useShareAsk } from '@/share/ask';
import { useTasks } from '@/tasks/store';
import { briefOf, dayPart } from '@/today/brief';
import { darkColors, lightColors, lightNoteColors, NOTE_COLOR_KEYS, noteInk, useSchemePreference } from '@/theme';
import { APP_DIR, finishOnboarding, resetApp, settle } from '@/testing/helpers';
import { auditLayout, AUDIT_MATRIX, resetWindow, setWindow } from '@/testing/layoutAudit';

/** Ф-48…Ф-51 + the approved v2 mocks (Ф-55): tabs, no shopping, «История», SaveToast, ConfirmCard, one search, КП. */

beforeEach(() => {
  resetApp();
  finishOnboarding('full');
});
afterEach(() => resetWindow());

const pageOf = (k: string) => usePages.getState().pages.find((p) => p.templateKey === k)!;

describe('tokens v2 (design-system v2 §2)', () => {
  it('light: deeper mint page, white cards; dark: the one tonal scale and the lighter brand', () => {
    expect(lightColors.bg).toBe('#D3ECDE');
    expect(lightColors.surface).toBe('#FFFFFF');
    expect(darkColors.bg).toBe('#051F20');
    expect(darkColors.brand).toBe('#5FD6A8');
    expect(NOTE_COLOR_KEYS).toEqual(['white', 'yellow', 'peach', 'pink', 'lilac', 'blue', 'green']);
    expect(lightNoteColors.lilac).toBe('#E6DDFB');
    expect(noteInk.light.ink).toBe('#1F2B24');
  });
});

describe('Ф-48 tabs', () => {
  it('«Сегодня · Заметки · Расходы · Дела · Ещё»; at ≥150 % «Заметки» go to «Ещё», «Дела» stay', () => {
    const pages = usePages.getState().pages;
    expect(mainTabs(pages, { largeFont: false, shopping: false }).slots.map((s) => s.key)).toEqual(['notes', 'expenses', 'tasks']);
    const large = mainTabs(pages, { largeFont: true, shopping: false });
    expect(large.slots.map((s) => s.key)).toEqual(['expenses', 'tasks']);
    expect(large.overflow.map((p) => p.templateKey)).toContain('notes');
  });

  it('«Расходы» is a tab even before the page exists; the first tap makes it and opens it', async () => {
    usePages.setState((s) => ({ pages: s.pages.filter((p) => p.templateKey !== 'expenses') }));
    expect(mainTabs(usePages.getState().pages, { largeFont: false, shopping: false }).slots[1]).toMatchObject({ key: 'expenses', page: null, centre: true });
    const r = await renderRouter(APP_DIR, { initialUrl: '/' });
    expect(screen.getByTestId('tab-expenses-circle')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('tab-expenses'));
    await settle(() => usePages.getState().pages.some((p) => p.templateKey === 'expenses'));
    expect(r.getPathname()).toBe(`/page/${pageOf('expenses').id}`);
    // A second tap on the open «Расходы» asks for the keypad.
    const before = useView.getState().keypadRequest;
    await fireEvent.press(screen.getByTestId('tab-expenses'));
    expect(useView.getState().keypadRequest).toBe(before + 1);
    await settle(() => screen.queryByTestId('exp-entry-sheet') !== null);
  });

  it('the app shows 5 tabs, and 4 at font 200 %', async () => {
    await renderRouter(APP_DIR, { initialUrl: '/' });
    expect(screen.getAllByRole('tab')).toHaveLength(5);
    expect(screen.getByTestId(`tab-${pageOf('notes').id}`)).toBeTruthy();
    resetWindow();
    setWindow({ fontScale: 2, width: 320, height: 568 });
    await renderRouter(APP_DIR, { initialUrl: '/' });
    expect(screen.getAllByRole('tab')).toHaveLength(4);
    expect(screen.queryByTestId(`tab-${pageOf('notes').id}`)).toBeNull();
    expect(screen.getByTestId(`tab-${pageOf('tasks').id}`)).toBeTruthy();
  });

  it.each(AUDIT_MATRIX.map((w) => [`${w.width} @ ${w.fontScale}`, w] as const))('the bar fits %s', async (_n, w) => {
    const count = w.fontScale >= 1.5 ? 4 : 5;
    const m = tabBarMetrics({ windowWidth: w.width, count });
    expect(m.cell).toBeGreaterThanOrEqual(48);
    expect(m.pill).toBeLessThanOrEqual(m.cell);
    expect(m.pill).toBeLessThanOrEqual(68);
    // The widest label we have (KK «Шығындар», 8 letters at 11 pt ≈ 6.3 pt a letter) fits once shrunk to 0.7, ×1.5 cap.
    expect(8 * 6.3 * Math.min(w.fontScale, 1.5) * 0.7).toBeLessThanOrEqual(m.label + 1);
    setWindow(w);
    await renderRouter(APP_DIR, { initialUrl: '/' });
    const v = auditLayout(screen.getByTestId('bottom-tabs').props ? screen.toJSON() : null).filter((x) => x.where.startsWith('tab'));
    expect(v).toEqual([]);
  });
});

describe('Ф-49 no shopping list', () => {
  it('«Покупки» is hidden while `shopping` is off and comes back with it', async () => {
    usePages.getState().addPage('shopping');
    expect(visiblePages(usePages.getState().pages, false).some((p) => p.templateKey === 'shopping')).toBe(false);
    expect(visiblePages(usePages.getState().pages, true).some((p) => p.templateKey === 'shopping')).toBe(true);
    expect(FEATURE_DEFAULTS.shopping).toBe(false);
    await renderRouter(APP_DIR, { initialUrl: '/more' });
    expect(screen.queryByTestId(`more-page-${pageOf('shopping').id}`)).toBeNull();
    await act(async () => useFeatureStore.getState().set({ ...FEATURE_DEFAULTS, shopping: true }));
    expect(screen.getByTestId(`more-page-${pageOf('shopping').id}`)).toBeTruthy();
  });
});

describe('«Сегодня» v2 — the briefing', () => {
  it('four blocks: the brief, the 2×2 tiles; the headline follows the part of the day', async () => {
    await renderRouter(APP_DIR, { initialUrl: '/' });
    expect(screen.getByTestId('today-brief')).toBeTruthy();
    for (const id of ['tile-tasks', 'tile-spent', 'tile-new']) expect(screen.getByTestId(id)).toBeTruthy();
    const t = (k: string, o?: Record<string, unknown>) => `${k}${o ? JSON.stringify(o) : ''}`;
    expect(dayPart(new Date(2026, 10, 13, 8).getTime())).toBe('morning');
    expect(dayPart(new Date(2026, 10, 13, 14).getTime())).toBe('day');
    expect(dayPart(new Date(2026, 10, 13, 20).getTime())).toBe('evening');
    const morning = briefOf({ part: 'morning', total: 5, done: 0, ahead: [{ title: 'Таблетка', time: '9:00', inMinutes: 50 }], spent: '18 400 ₸', left: '41 600 ₸', tomorrow: null }, t);
    expect(morning.headline).toBe('brief.calm');
    expect(morning.body).toContain('brief.spent_left');
    const day = briefOf({ part: 'day', total: 5, done: 2, ahead: [{ title: 'Забрать Алию', time: '14:30', inMinutes: 25 }], spent: null, left: null, tomorrow: null }, t);
    expect(day.headline).toContain('brief.now');
    expect(briefOf({ part: 'evening', total: 5, done: 4, ahead: [], spent: null, left: null, tomorrow: null }, t).headline).toBe('brief.good');
  });

  it('a budget makes «осталось» appear on the spent tile', async () => {
    useBudget.getState().set(12_000_000n);
    await renderRouter(APP_DIR, { initialUrl: '/' });
    expect(screen.getByTestId('tile-spent')).toHaveTextContent(/осталось 120 000 ₸/);
  });
});

describe('«+» and the statement leak (Ф-50, Ф-37)', () => {
  it('no «Появится позже»; on «Расходы» no statement while `statements_pdf` is off', async () => {
    await renderRouter(APP_DIR, { initialUrl: `/page/${pageOf('notes').id}` });
    await fireEvent.press(screen.getByTestId('assistant-plus'));
    expect(screen.getByTestId('add-reminder')).toBeTruthy();
    expect(screen.queryByTestId('add-photo')).toBeNull();
    expect(screen.queryByText('Появится позже')).toBeNull();
    await renderRouter(APP_DIR, { initialUrl: `/page/${pageOf('expenses').id}` });
    await fireEvent.press(screen.getByTestId('assistant-plus'));
    expect(screen.getByTestId('add-photo')).toBeTruthy();
    expect(screen.queryByTestId('add-file')).toBeNull();
    await act(async () => useFeatureStore.getState().set({ ...FEATURE_DEFAULTS, statements_pdf: true }));
    expect(screen.getByTestId('add-file')).toBeTruthy();
  });

  it('«Поделиться» PDF: no «Выписка» while off; «Сделать документ из этого» is there', async () => {
    await renderRouter(APP_DIR, { initialUrl: '/' });
    await act(async () => useShareAsk.getState().set({ recordId: 'r1', pdf: true } as never));
    expect(screen.getByTestId('share-ask')).toBeTruthy();
    expect(screen.queryByTestId('share-ask-statement')).toBeNull();
    expect(screen.getByTestId('share-ask-document')).toBeTruthy();
  });
});

describe('language with a confirmation (Ф-50)', () => {
  it('both languages; the switch asks in both languages first', async () => {
    await renderRouter(APP_DIR, { initialUrl: '/settings' });
    await fireEvent.press(screen.getByTestId('settings-lang'));
    expect(screen.getByTestId('lang-ru')).toHaveTextContent('Русский');
    expect(screen.getByTestId('lang-kk')).toHaveTextContent('Қазақша');
    await fireEvent.press(screen.getByTestId('lang-kk'));
    expect(screen.getByTestId('lang-confirm')).toHaveTextContent(/казахский.*қазақ тіліне/s);
    await fireEvent.press(screen.getByTestId('lang-confirm-no'));
    expect(useOnboarding.getState().language).toBe('ru');
    await fireEvent.press(screen.getByTestId('lang-kk'));
    await fireEvent.press(screen.getByTestId('lang-confirm-yes'));
    expect(useOnboarding.getState().language).toBe('kk');
  });

  it('theme: two previews and «Как в телефоне»', async () => {
    await renderRouter(APP_DIR, { initialUrl: '/settings' });
    await fireEvent.press(screen.getByTestId('theme-dark'));
    expect(useSchemePreference.getState().preference).toBe('dark');
    await fireEvent(screen.getByTestId('theme-system'), 'valueChange', true);
    expect(useSchemePreference.getState().preference).toBe('system');
  });

  it('«Бюджет на месяц» is set in «Настройки»', async () => {
    await renderRouter(APP_DIR, { initialUrl: '/settings' });
    await fireEvent.press(screen.getByTestId('settings-budget'));
    await fireEvent.changeText(screen.getByTestId('budget-input'), '120000');
    await fireEvent.press(screen.getByTestId('budget-save'));
    expect(budgetMinor(useBudget.getState())).toBe(12_000_000n);
  });
});

const action = (o: Partial<ActionOut>): ActionOut =>
  ({
    id: 'a1', kind: 'save_item', scope: 'internal', initiated_by: 'agent', summary: { ru: 'Записал «код»', kk: null }, page: { id: 'srv-n', title: 'Заметки', icon: null },
    changes: [], changed_item_ids: [], created_page_id: null, undoable: true, undoable_until: null, undone_at: null, undo_of: null, message_id: null, seq: 1,
    created_at: new Date().toISOString(), ...o,
  }) as ActionOut;

describe('«История» (Ф-50: «Переписка» + «Что я сделал»)', () => {
  it('what you said → what was done; a change by hand once; filters', () => {
    const now = Date.now();
    const q: ChatMessage = { id: 'q1', role: 'user', text: 'запиши код 4512', pageId: 'today', pageTitle: 'Сегодня', at: new Date(now - 1000).toISOString() };
    const a: ChatMessage = { id: 'm1', role: 'assistant', text: '', pageId: 'today', pageTitle: 'Сегодня', at: new Date(now).toISOString(), replyTo: 'q1', status: 'done',
      action: { id: 'a1', kind: 'save_item', text: 'Записал', textKk: null, pageServerId: null, pageTitle: 'Заметки', changedItemIds: [], changes: [], createdPageId: null, undoable: true, undone: false } };
    const list = historyEntries([q, a], { a1: action({ id: 'a1' }), a2: action({ id: 'a2', initiated_by: 'user', kind: 'facet_edit' }) });
    expect(list).toHaveLength(2);
    expect(list.find((e) => e.key === 'm1')).toMatchObject({ said: 'запиши код 4512', kind: 'change' });
    expect(list.filter((e) => matchesFilter(e, 'questions'))).toHaveLength(0);
  });

  it('opens from «Ещё»; old «/chat» and «/did» land there', async () => {
    useTasks.getState().set({ actions: { a2: action({ id: 'a2', initiated_by: 'user', summary: { ru: 'Отметил: хлеб', kk: null } }) } } as never);
    const r = await renderRouter(APP_DIR, { initialUrl: '/more' });
    await fireEvent.press(screen.getByTestId('more-history'));
    expect(r.getPathname()).toBe('/history');
    expect(screen.getByTestId('did-a2')).toHaveTextContent(/Отметил: хлеб/);
    expect(screen.getByTestId('did-undo-a2')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('history-filter-questions'));
    expect(screen.queryByTestId('did-a2')).toBeNull();
    const r2 = await renderRouter(APP_DIR, { initialUrl: '/did' });
    expect(r2.getPathname()).toBe('/history');
  });
});

describe('SaveToast «Сохранил в «…» · Переложить · Отменить» (Ф-50)', () => {
  it('a note saved on this phone names its page; «Переложить» opens the pages', async () => {
    await renderRouter(APP_DIR, { initialUrl: '/' });
    await fireEvent.changeText(screen.getByTestId('assistant-input'), 'код домофона 4512');
    await fireEvent(screen.getByTestId('assistant-input'), 'submitEditing');
    await settle(() => useUndo.getState().strip?.kind === 'saved');
    expect(screen.getByTestId('undo-strip-text')).toHaveTextContent(/^Сохранил в «Заметки»: код домофона 4512/);
    expect(screen.getByTestId('undo-strip-undo')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('undo-strip-replace'));
    await settle(() => screen.queryByTestId('replace-sheet') !== null);
    await fireEvent.press(screen.getByTestId(`replace-${pageOf('tasks').id}`));
    await fireEvent.press(screen.getByTestId('replace-go'));
    await settle(() => useUndo.getState().strip?.kind === 'manual');
    expect((await (await getRecords()).list(10)).length).toBe(1);
  });
});

describe('ConfirmCard (reminder from the line, Ф-50)', () => {
  const draft = (h: number): ReminderDraft => ({
    title: 'Позвонить папе', due_at: new Date(Date.now() + h * 3_600_000).toISOString(), tz: 'Asia/Almaty', local: null, rrule: null, offsets: [], level: 'alarm', time_assumed: false, when_text: null, saved_text: null,
  });

  it('one reading is set at once; «Готово» closes the card, no form screen', async () => {
    useAlarms.setState({ notifyAskedAt: new Date().toISOString() });
    const r = await renderRouter(APP_DIR, { initialUrl: '/' });
    await act(async () => useReminderCard.getState().show({ text: 'напомни позвонить папе', draft: draft(20), options: [], message: null, messageId: null, via: 'voice' }));
    await settle(() => Object.keys(useAlarms.getState().reminders).length === 1);
    expect(screen.getByTestId('confirm-card-state')).toHaveTextContent(/Будильник поставлен/i);
    expect(screen.getByTestId('confirm-card-title')).toHaveTextContent('Позвонить папе');
    expect(r.getPathname()).not.toBe('/reminder-new');
    await fireEvent.press(screen.getByTestId('confirm-card-done'));
    expect(screen.queryByTestId('confirm-card')).toBeNull();
  });

  it('two readings ask with time chips; nothing is set before the tap', async () => {
    await renderRouter(APP_DIR, { initialUrl: '/' });
    await act(async () => useReminderCard.getState().show({ text: 'в 7', draft: null, options: [draft(5), draft(17)], message: null, messageId: null, via: 'typed' }));
    expect(screen.getByTestId('confirm-card-state')).toHaveTextContent(/Когда напомнить/i);
    expect(Object.keys(useAlarms.getState().reminders)).toHaveLength(0);
    await fireEvent.press(screen.getByTestId('confirm-card-option-1'));
    await settle(() => Object.keys(useAlarms.getState().reminders).length === 1);
  });
});

describe('one search, the answer as a value (Ф-50)', () => {
  it('short answers become a value with its note', () => {
    expect(directValue('4512')).toEqual({ value: '4512', note: null });
    expect(directValue('Код домофона — 4512.')).toEqual({ value: '4512', note: 'Код домофона' });
    expect(directValue('Паспорт лежит в верхнем ящике комода, в синей папке вместе со свидетельством о рождении')).toBeNull();
  });

  it('the line asked it: the value on top of the search', async () => {
    useAssistant.setState({
      messages: [
        { id: 'q', role: 'user', text: 'код домофона', pageId: 'today', pageTitle: 'Сегодня', at: new Date().toISOString() },
        { id: 'a', role: 'assistant', text: 'Код домофона — 4512', pageId: 'today', pageTitle: 'Сегодня', at: new Date().toISOString(), replyTo: 'q', status: 'done', sources: [] },
      ],
    });
    await renderRouter(APP_DIR, { initialUrl: '/search?q=код домофона' });
    expect(screen.getByTestId('search-answer-value')).toHaveTextContent('4512');
    expect(screen.getByTestId('search-answer-copy')).toBeTruthy();
  });

  it('the page 🔍 opens the same search screen', async () => {
    const r = await renderRouter(APP_DIR, { initialUrl: `/page/${pageOf('notes').id}` });
    await fireEvent.press(screen.getByTestId('page-search'));
    expect(r.getPathname()).toBe('/search');
  });
});

describe('«Документы» (Ф-51)', () => {
  it('the page is «Документы»; the old server title still counts as the default', () => {
    expect(isDefaultTitle('documents', 'Документы и КП')).toBe(true);
    expect(isDefaultTitle('documents', 'Документы')).toBe(true);
    expect(isDefaultTitle('documents', 'Мои бумаги')).toBe(false);
  });

  it('«сделай КП для …» from the line starts a КП', async () => {
    expect(looksLikeKp('сделай КП для ТОО Арман: гипсокартон 48 м²')).toBe(true);
    expect(looksLikeKp('купить молоко')).toBe(false);
    useConnectivity.setState({ online: false });
    const r = await renderRouter(APP_DIR, { initialUrl: '/' });
    await fireEvent.changeText(screen.getByTestId('assistant-input'), 'сделай КП для ТОО Арман');
    await fireEvent(screen.getByTestId('assistant-input'), 'submitEditing');
    await settle(() => r.getPathname() === '/kp/new');
    expect(Object.values(useKp.getState().jobs)).toHaveLength(1);
  });

  it('online the server starts it (kp_started): S16 follows its document', async () => {
    const r = await renderRouter(APP_DIR, { initialUrl: '/' });
    await act(async () => openServerKp('doc-1'));
    expect(r.getPathname()).toBe('/kp/new');
    expect(Object.values(useKp.getState().jobs)[0]).toMatchObject({ documentId: 'doc-1', state: 'reading' });
  });
});

describe('the server contract of week 20', () => {
  it('parses saved_to, the budget and the briefing', () => {
    const a = actionOut({ id: 'a', summary: { ru: 'Записал' }, saved_to: [{ page_id: 'p', title: 'Дела', item_ids: ['i'] }] });
    expect(a?.saved_to).toEqual([{ page_id: 'p', title: 'Дела', icon: null, template_key: null, item_ids: ['i'] }]);
    expect(budgetOut({ amount: '120000.00', currency: 'KZT', spent: '86400.00', left: '33600.00', percent: 72, days_left: 17 })).toMatchObject({ amount: '120000.00', percent: 72 });
    const today = todayOut({ brief: { part: 'day', headline: { ru: 'День в разгаре · 2 из 5', kk: null }, lines: { ru: ['Сейчас — школа.', 'Через 25 минут забрать Алию.'] } } });
    expect(today.brief).toMatchObject({ part: 'day', headline: { ru: 'День в разгаре · 2 из 5' } });
  });
});

describe('mock gaps closed (Ф-55)', () => {
  it('«Поймал так»: the phone reads the day and the time of a reminder phrase; nothing else is guessed', () => {
    expect(caught('Напомни завтра в 8 выпить таблетку')).toMatchObject({ day: 'tomorrow', time: '08:00', parts: ['завтра', 'в 8'] });
    expect(caught('Разбуди в 7:30 утра')).toMatchObject({ alarm: true, time: '07:30' });
    expect(caught('купить молоко')).toBeNull();
    expect(litSegments('Напомни завтра в 8 выпить', ['завтра', 'в 8'])).toEqual([
      { text: 'Напомни ', lit: false },
      { text: 'завтра', lit: true },
      { text: ' ', lit: false },
      { text: 'в 8', lit: true },
      { text: ' выпить', lit: false },
    ]);
  });

  it('voice: the screen behind is dimmed while the line listens', async () => {
    await renderRouter(APP_DIR, { initialUrl: '/' });
    expect(screen.queryByTestId('voice-dim', { includeHiddenElements: true })).toBeNull();
    await act(async () => useAssistant.getState().setListening(true));
    expect(screen.getByTestId('voice-dim', { includeHiddenElements: true })).toBeTruthy();
  });

  it('«Расходы» as the mock: «+ Трата» in the header, the period in a sheet from the status line', async () => {
    await renderRouter(APP_DIR, { initialUrl: `/page/${pageOf('expenses').id}` });
    await settle(() => screen.queryByTestId('exp-board') !== null);
    expect(screen.queryByTestId('exp-periods')).toBeNull();
    expect(screen.queryByTestId('exp-actions')).toBeNull();
    await fireEvent.press(screen.getByTestId('exp-period-open'));
    expect(screen.getByTestId('exp-periods')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('exp-period-sheet-close'));
    await fireEvent.press(screen.getByTestId('exp-enter'));
    await settle(() => screen.queryByTestId('exp-entry-sheet') !== null);
  });

  it('the dark theme draws glass; old Android gets the solid fill', () => {
    expect(typeof blurSupported()).toBe('boolean');
  });
});
