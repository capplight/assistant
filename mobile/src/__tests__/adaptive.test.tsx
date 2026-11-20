import { act, renderRouter, screen } from 'expo-router/testing-library';
import { StyleSheet } from 'react-native';

import { usePages } from '@/store/pages';
import { useTasks } from '@/tasks/store';
import { APP_DIR, atLocalTime, finishOnboarding, resetApp } from '@/testing/helpers';
import { auditLayout, AUDIT_MATRIX, resetWindow, setWindow } from '@/testing/layoutAudit';

/**
 * The adaptive foundation in the real app (founder requirement): «Сегодня» and «Заметки» with the floating
 * bottom (capsule + tab bar) at 320 / 360 / 412 / 600 / 840 × font 1.0 / 1.3 / 2.0 — structural audit, the
 * bottom column ≤600, 5 tabs (3 at ≥150 %, VISION-2026-11), every target of the capsule ≥48.
 */

afterEach(() => {
  resetWindow();
  jest.useRealTimers();
});

const flat = (id: string) => StyleSheet.flatten(screen.getByTestId(id).props.style);

describe.each(['/', 'notes'] as const)('%s', (route) => {
  it.each(AUDIT_MATRIX.map((w) => [`${w.width} @ ${w.fontScale}`, w] as const))('%s', async (_n, w) => {
    setWindow(w);
    resetApp();
    finishOnboarding('full');
    const notes = usePages.getState().pages.find((p) => p.templateKey === 'notes')!;
    await renderRouter(APP_DIR, { initialUrl: route === '/' ? '/' : `/page/${notes.id}` });
    for (let i = 0; i < 5; i++) await act(async () => void (await jest.advanceTimersByTimeAsync(40)));

    expect(auditLayout(screen.toJSON(), { windowWidth: w.width })).toEqual([]);
    // v5: the tray spans the window; the strip and the tab cells stay in a ≤ 600 column.
    expect(flat('assistant-strip-column').maxWidth).toBe(600);
    expect(flat('bottom-tabs').maxWidth).toBe(600);
    const tabs = screen.getAllByRole('tab').filter((t) => typeof t.props.testID === 'string' && t.props.testID.startsWith('tab-'));
    // v5 (§11.5): the same five tabs at every font size.
    expect(tabs.length).toBe(5);
    // v5 strip: the dot and the mic (≥ 48 target); «+» is on the page sheet (Ф-82).
    for (const id of ['assistant-mic']) {
      expect(flat(id).width).toBeGreaterThanOrEqual(48);
      expect(flat(id).height).toBeGreaterThanOrEqual(48);
    }
    // Ф-47: no «Про: …» label in the capsule.
    expect(screen.queryByTestId('context-chip')).toBeNull();
  });
});

/**
 * The restyled screens of week 19 (Ф-34, Ф-41): «Ещё», «Настройки», the policy texts, «Переписка» and the welcome
 * screen at the same matrix — structural audit, content ≤600 where the screen has its own column.
 */
describe.each([
  ['/more', false],
  ['/settings', false],
  ['/legal?doc=policy', false],
  ['/chat', false],
  ['/welcome', true],
] as const)('%s', (url, first) => {
  it.each(AUDIT_MATRIX.map((w) => [`${w.width} @ ${w.fontScale}`, w] as const))('%s', async (_n, w) => {
    setWindow(w);
    resetApp();
    if (!first) finishOnboarding('full');
    await renderRouter(APP_DIR, { initialUrl: url });
    for (let i = 0; i < 5; i++) await act(async () => void (await jest.advanceTimersByTimeAsync(40)));
    expect(auditLayout(screen.toJSON(), { windowWidth: w.width })).toEqual([]);
  });
});

/**
 * Ф-84 «Пустое „Сегодня“» in v6 (today-v6-acceptance §3.4): no timed things today — «План» of the to-dos without a
 * time, the nearest day, the two tiles; at 320 / 390 / 430 and large text nothing is cut; at 320 only the title stays.
 */
describe('empty «Сегодня» (Ф-84)', () => {
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const task = (id: string, title: string, due: string | null) => {
    const at = new Date().toISOString();
    return { id, client_id: id, item_id: `i-${id}`, list_key: 'todo', title, qty: null, where: null, due_date: due, done: false, done_at: null, version: 1, seq: 1, created_at: at, updated_at: at, deleted_at: null };
  };
  it.each([
    [320, 640, 1],
    [390, 844, 1],
    [430, 932, 1],
    [390, 844, 1.3],
  ] as const)('%s × %s @ %s', async (width, height, fontScale) => {
    setWindow({ width, height, fontScale });
    resetApp();
    finishOnboarding('full');
    const now = atLocalTime(14);
    const yesterday = iso(new Date(now.getTime() - 86_400_000));
    const later = iso(new Date(now.getTime() + 3 * 86_400_000));
    useTasks.setState({ tasks: { a: task('a', 'Оплатить интернет', yesterday), b: task('b', 'Купить корм коту', null), c: task('c', 'Стоматолог', later) } as never });
    await renderRouter(APP_DIR, { initialUrl: '/' });
    for (let i = 0; i < 5; i++) await act(async () => void (await jest.advanceTimersByTimeAsync(40)));
    expect(auditLayout(screen.toJSON(), { windowWidth: width })).toEqual([]);
    expect(screen.queryByTestId('today-week')).toBeNull();
    // v6: no timed things today — «План» of the to-dos without a time, then the nearest day (read only).
    expect(screen.getByTestId('today-plan')).toHaveTextContent(/План.*Оплатить интернет.*без времени.*Купить корм коту.*без времени/);
    expect(screen.getByTestId('today-nearest')).toHaveTextContent(/Стоматолог/);
    expect(screen.queryByTestId('today-calendar')).toBeNull();
    expect(screen.getByTestId('today-tile-spent')).toBeTruthy();
    expect(screen.getByTestId('today-tile-spent-sum')).toHaveTextContent('0 ₸');
    if (width === 320 || fontScale >= 1.3) expect(screen.queryByTestId('sheet-phrase')).toBeNull();
    else expect(screen.getByTestId('sheet-phrase')).toHaveTextContent('Добрый день. Ещё 2 дела сегодня.');
  });
});
