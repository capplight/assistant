import { useEffect, useState } from 'react';
import { Keyboard, Platform, type KeyboardEvent } from 'react-native';

/**
 * Week 17: the assistant line above the keyboard (2-design §4.3 «Пишу: поле над клавиатурой»).
 *
 * Expo apps are edge-to-edge on Android, so the window no longer resizes for the keyboard: a
 * `KeyboardAvoidingView` needs a `behavior` on both platforms, `padding` (docs.expo.dev
 * «Keyboard handling», SDK 58). No `softwareKeyboardLayoutMode: pan` in app.json (it would move
 * the line twice). No new dependency: react-native-keyboard-controller is not in Expo Go.
 */
export const KEYBOARD_BEHAVIOR = 'padding' as const;

/** The keyboard's height while it is open, 0 when closed. iOS: «will» events (moves with it); Android: «did». */
export function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const show = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hide = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const subs = [
      Keyboard.addListener(show, (e: KeyboardEvent) => setHeight(Math.max(0, e.endCoordinates?.height ?? 0))),
      Keyboard.addListener(hide, () => setHeight(0)),
    ];
    return () => subs.forEach((s) => s.remove());
  }, []);
  return height;
}

/**
 * How tall the line's field may grow before it scrolls: 4 lines (3 at ≥150%), but never more than
 * 30% of what the keyboard leaves, so the chip, the field, mic / send and «Отменить» above all stay
 * on screen at 200% on a 320 × 568 phone. Never under the 48 pt touch target.
 */
export function lineInputMaxHeight(o: { lineHeight: number; fontScale: number; largeFont: boolean; windowHeight: number; keyboardHeight: number; padding: number }): number {
  const lines = o.largeFont ? 3 : 4;
  const byLines = o.lineHeight * o.fontScale * lines + o.padding;
  const byRoom = (o.windowHeight - o.keyboardHeight) * 0.3;
  return Math.round(Math.max(48, Math.min(byLines, byRoom)));
}

/** What may sit above the line while typing (answer banner, reminder draft, «Отменить»): scrolls inside this. */
export function aboveLineMaxHeight(windowHeight: number, keyboardHeight: number): number {
  return Math.round(Math.max(96, (windowHeight - keyboardHeight) * 0.3));
}
