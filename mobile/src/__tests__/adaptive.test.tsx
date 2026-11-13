import { act, renderRouter, screen } from 'expo-router/testing-library';
import { StyleSheet } from 'react-native';

import { usePages } from '@/store/pages';
import { APP_DIR, finishOnboarding, resetApp } from '@/testing/helpers';
import { auditLayout, AUDIT_MATRIX, resetWindow, setWindow } from '@/testing/layoutAudit';

/**
 * The adaptive foundation in the real app (founder requirement): «Сегодня» and «Заметки» with the floating
 * bottom (capsule + tab bar) at 320 / 360 / 412 / 600 / 840 × font 1.0 / 1.3 / 2.0 — structural audit, the
 * bottom column ≤600, tabs ≤4 (≤3 at ≥150 %), every target of the capsule ≥48.
 */

afterEach(() => resetWindow());

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
    expect(flat('main-footer').maxWidth).toBe(600);
    expect(flat('bottom-tabs').maxWidth).toBe(600);
    const tabs = screen.getAllByRole('tab').filter((t) => typeof t.props.testID === 'string' && t.props.testID.startsWith('tab-'));
    expect(tabs.length).toBeLessThanOrEqual(w.fontScale >= 1.5 ? 3 : 4);
    for (const id of ['assistant-plus', 'assistant-mic']) {
      expect(flat(id).width).toBeGreaterThanOrEqual(48);
      expect(flat(id).height).toBeGreaterThanOrEqual(48);
    }
    // The «Про: …» toggle lives inside the capsule, not on a row of its own above the field (≥150 %: own line inside).
    expect(screen.getByTestId('context-chip')).toBeTruthy();
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
