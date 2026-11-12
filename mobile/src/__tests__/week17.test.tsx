import { act, fireEvent, renderRouter, screen, within } from 'expo-router/testing-library';
import { Keyboard, StyleSheet, type KeyboardEvent } from 'react-native';
import type { JsonElement } from 'test-renderer';

import { amountEm, fitAmount } from '@/components/AmountText';
import { aboveLineMaxHeight, KEYBOARD_BEHAVIOR, lineInputMaxHeight } from '@/components/useKeyboard';
import { usePages } from '@/store/pages';
import { useUndo } from '@/store/undo';
import { type as typeScale } from '@/theme';
import { APP_DIR, finishOnboarding, resetApp } from '@/testing/helpers';
import { auditLayout, NARROW, resetWindow, setWindow } from '@/testing/layoutAudit';

/**
 * Week 17 (3-engineering §11.2): «the line above the keyboard at 200%». Jest has no keyboard and no
 * layout: the keyboard events are fired by hand through the real `Keyboard.addListener` path and the
 * props that decide the layout on a phone are checked. A real device still has the last word.
 */

const flat = (id: string) => StyleSheet.flatten(screen.getByTestId(id).props.style) ?? {};

/** Captures the app's keyboard listeners so a test can «open» the keyboard. */
function keyboardSpy() {
  const listeners = new Map<string, ((e: KeyboardEvent) => void)[]>();
  const real = Keyboard.addListener.bind(Keyboard);
  jest.spyOn(Keyboard, 'addListener').mockImplementation(((event: string, fn: (e: KeyboardEvent) => void) => {
    listeners.set(event, [...(listeners.get(event) ?? []), fn]);
    const sub = real(event as never, fn as never);
    return { remove: () => { listeners.set(event, (listeners.get(event) ?? []).filter((f) => f !== fn)); sub.remove(); } };
  }) as typeof Keyboard.addListener);
  const fire = async (event: string, height = 0) => {
    const e = { endCoordinates: { height, screenX: 0, screenY: NARROW.height - height, width: NARROW.width }, duration: 0, easing: 'keyboard', isEventFromThisApp: true, startCoordinates: undefined } as unknown as KeyboardEvent;
    await act(async () => (listeners.get(event) ?? []).forEach((fn) => fn(e)));
  };
  return { open: (h: number) => fire('keyboardWillShow', h), close: () => fire('keyboardWillHide') };
}

/** True when `inner` is inside `outer` in the rendered tree. */
function inside(outerId: string, innerId: string): boolean {
  return within(screen.getByTestId(outerId)).queryByTestId(innerId) !== null;
}

afterEach(() => resetWindow());

describe('the assistant line above the keyboard at 200%, 320 × 568', () => {
  const KB = 260;

  it('KeyboardAvoidingView lifts on both platforms (Android is edge-to-edge)', () => {
    expect(KEYBOARD_BEHAVIOR).toBe('padding');
  });

  it('typing: tabs step aside, no safe-area gap, the field grows to a cap and scrolls, mic / send ≥48 at the bottom edge', async () => {
    setWindow({ fontScale: 2, ...NARROW });
    const kb = keyboardSpy();
    resetApp();
    finishOnboarding('full');
    await renderRouter(APP_DIR, { initialUrl: `/page/${usePages.getState().pages[0]!.id}` });
    expect(screen.getByTestId('bottom-tabs')).toBeTruthy();

    await kb.open(KB);
    expect(screen.queryByTestId('bottom-tabs')).toBeNull();
    expect(flat('main-footer').paddingBottom).toBe(0);
    // ≥150%: two rows — the chip stays (2-design §4.3 «Пишу: чип остаётся»).
    expect(screen.getByTestId('context-chip')).toBeTruthy();

    const input = screen.getByTestId('assistant-input');
    expect(input.props.multiline).toBe(true);
    expect(input.props.scrollEnabled).toBe(true);
    expect(input.props.submitBehavior).toBe('submit');
    const style = StyleSheet.flatten(input.props.style);
    const cap = lineInputMaxHeight({ lineHeight: typeScale.body.lineHeight!, fontScale: 2, largeFont: true, windowHeight: NARROW.height, keyboardHeight: KB, padding: 16 });
    expect(style.maxHeight).toBe(cap);
    expect(cap).toBeGreaterThanOrEqual(48);
    expect(cap).toBeLessThanOrEqual((NARROW.height - KB) * 0.3 + 1);
    expect(style.height).toBeUndefined();

    // Mic, then send once there is text: 56 pt, at the bottom edge of a grown field.
    for (const id of ['assistant-mic', 'assistant-plus']) {
      const b = flat(id);
      expect(b.width).toBeGreaterThanOrEqual(48);
      expect(b.height).toBeGreaterThanOrEqual(48);
    }
    await fireEvent.changeText(input, 'Купить молоко, хлеб, яйца, сыр, масло, помидоры и огурцы, и ещё не забыть лекарства маме в аптеке');
    const send = flat('assistant-send');
    expect(send.width).toBeGreaterThanOrEqual(48);
    expect(send.height).toBeGreaterThanOrEqual(48);
    expect(flat('assistant-line-row').alignItems).toBe('flex-end');

    // The return key still sends a multi-line field.
    await fireEvent(screen.getByTestId('assistant-input'), 'submitEditing');
    expect(screen.getByTestId('assistant-input').props.value).toBe('');

    await kb.close();
    expect(screen.getByTestId('bottom-tabs')).toBeTruthy();
    // Keyboard closed: the cap is 30% of the window (3 lines at 200% would be 172).
    expect(StyleSheet.flatten(screen.getByTestId('assistant-input').props.style).maxHeight).toBe(
      lineInputMaxHeight({ lineHeight: typeScale.body.lineHeight!, fontScale: 2, largeFont: true, windowHeight: NARROW.height, keyboardHeight: 0, padding: 16 }),
    );
  });

  it('«Отменить» never covers the line: same column, above it, bounded and scrolling while typing', async () => {
    setWindow({ fontScale: 2, ...NARROW });
    const kb = keyboardSpy();
    resetApp();
    finishOnboarding('full');
    await renderRouter(APP_DIR, { initialUrl: '/' });
    await act(async () => useUndo.getState().showCustom('Добавил в Покупки: молоко, хлеб, яйца, сыр, масло и ещё четыре строки', () => undefined));
    await kb.open(KB);
    expect(inside('footer-above-line', 'undo-strip')).toBe(true);
    expect(inside('footer-above-line', 'assistant-line')).toBe(false);
    const above = flat('footer-above-line');
    expect(above.maxHeight).toBe(aboveLineMaxHeight(NARROW.height, KB));
    expect(screen.getByTestId('footer-above-line').props.scrollEnabled).toBe(true);
    for (const id of ['undo-strip', 'assistant-line', 'footer-above-line']) expect(flat(id).position).not.toBe('absolute');
    // Order in the footer: what is above, then the line.
    const footer = screen.getByTestId('main-footer');
    const order = footer.children.filter((c): c is typeof footer => typeof c !== 'string').map((c) => c.props.testID);
    expect(order.indexOf('footer-above-line')).toBeLessThan(order.indexOf('assistant-line'));
    // What the keyboard leaves: line + bounded strip still fit (chip 48 + field cap + paddings).
    const cap = StyleSheet.flatten(screen.getByTestId('assistant-input').props.style).maxHeight as number;
    expect(above.maxHeight + 48 + cap + 4 * 8).toBeLessThanOrEqual(NARROW.height - KB);
    expect(auditLayout(screen.toJSON(), { windowWidth: NARROW.width })).toEqual([]);
  });

  it('«Переписка»: the same line, the same cap while typing', async () => {
    setWindow({ fontScale: 2, ...NARROW });
    const kb = keyboardSpy();
    resetApp();
    finishOnboarding('full');
    await renderRouter(APP_DIR, { initialUrl: '/chat' });
    await kb.open(KB);
    const style = StyleSheet.flatten(screen.getByTestId('assistant-input').props.style);
    expect(style.maxHeight).toBe(lineInputMaxHeight({ lineHeight: typeScale.body.lineHeight!, fontScale: 2, largeFont: true, windowHeight: NARROW.height, keyboardHeight: KB, padding: 16 }));
  });

  it('caps: 4 lines at 100%, 3 at ≥150%, never past 30% of the room, never under 48', () => {
    const base = { lineHeight: 26, padding: 16, windowHeight: 844, keyboardHeight: 0 };
    expect(lineInputMaxHeight({ ...base, fontScale: 1, largeFont: false })).toBe(26 * 4 + 16);
    expect(lineInputMaxHeight({ ...base, fontScale: 1.5, largeFont: true })).toBe(26 * 1.5 * 3 + 16);
    expect(lineInputMaxHeight({ ...base, fontScale: 2, largeFont: true, windowHeight: 568, keyboardHeight: 260 })).toBe(92);
    expect(lineInputMaxHeight({ ...base, fontScale: 2, largeFont: true, windowHeight: 400, keyboardHeight: 330 })).toBe(48);
  });
});

describe('sums never cut at 200%', () => {
  it('a long total gets a smaller size instead of a cut; a short one grows to its cap', () => {
    expect(fitAmount('7 ₸', { fontSize: 48, lineHeight: 56, available: 248, maxScale: 1.6 })).toEqual({ maxFontSizeMultiplier: 1.6 });
    const big = '999 999 999,99 ₸';
    const fit = fitAmount(big, { fontSize: 48, lineHeight: 56, available: 248, maxScale: 1.6 });
    expect(fit.maxFontSizeMultiplier).toBe(1);
    expect(amountEm(big) * fit.style!.fontSize!).toBeLessThanOrEqual(248);
    const mid = fitAmount('389 990 ₸', { fontSize: 48, lineHeight: 56, available: 248, maxScale: 1.6 });
    expect(amountEm('389 990 ₸') * 48 * Math.max(1, mid.maxFontSizeMultiplier)).toBeLessThanOrEqual(248 + 1);
  });

  it('«Расходы» at 200% on 320 pt: the board total fits its line, no numberOfLines', async () => {
    setWindow({ fontScale: 2, ...NARROW });
    resetApp();
    finishOnboarding('full');
    const page = usePages.getState().pages.find((p) => p.templateKey === 'expenses')!;
    await renderRouter(APP_DIR, { initialUrl: `/page/${page.id}` });
    const total = screen.getByTestId('exp-total');
    expect(total.props.numberOfLines).toBeUndefined();
    expect(total.props.adjustsFontSizeToFit).toBeUndefined();
    expect(total.props.maxFontSizeMultiplier).toBeLessThanOrEqual(1.6);
  });
});

describe('the 200% audit itself', () => {
  const el = (type: string, props: Record<string, unknown>, children: (JsonElement | string)[] = []) =>
    ({ type, props, children, $$typeof: Symbol.for('react.test.json') }) as JsonElement;
  const btn = (label: string) => el('View', { accessibilityRole: 'button', accessible: true }, [el('Text', {}, [label])]);

  it('finds a cut sum, a fixed box around text, a fixed input, a capped label, a row of word buttons, a small target', () => {
    const tree = el('View', {}, [
      el('Text', { testID: 'sum', numberOfLines: 1 }, ['1 240 000 ₸']),
      el('Text', { testID: 'note', numberOfLines: 3 }, ['Длинная заметка человека про чек на 389 990 ₸ и всё остальное, что он написал']),
      el('View', { testID: 'box', style: { height: 40 } }, [el('Text', {}, ['Сохранить'])]),
      el('TextInput', { testID: 'in', style: { height: 40 } }),
      el('Text', { testID: 'cap', maxFontSizeMultiplier: 1.2 }, ['Итого']),
      el('View', { testID: 'chips', style: { flexDirection: 'row' } }, [btn('Неделя'), btn('Месяц'), btn('Год…')]),
      el('View', { testID: 'wrap', style: { flexDirection: 'row', flexWrap: 'wrap' } }, [btn('Неделя'), btn('Месяц'), btn('Годы')]),
      el('RCTScrollView', { horizontal: true }, [el('View', { style: { flexDirection: 'row' } }, [btn('Неделя'), btn('Месяц'), btn('Годы')])]),
      el('View', { testID: 'tiny', accessibilityRole: 'button', style: { height: 32 } }, []),
      el('View', { importantForAccessibility: 'no-hide-descendants', style: { height: 64 } }, [el('Text', { maxFontSizeMultiplier: 1 }, ['КП'])]),
    ]);
    const found = auditLayout(tree, { windowWidth: 320 }).map((v) => `${v.rule}:${v.where}`);
    expect(found).toEqual(['clipped-value:sum', 'fixed-height:box', 'fixed-input:in', 'no-scale:cap', 'row-of-buttons:chips', 'small-target:tiny']);
  });
});
