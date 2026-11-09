import { useMemo } from 'react';
import { useColorScheme, useWindowDimensions } from 'react-native';

import { darkColors, darkNoteColors, lightColors, lightNoteColors, type ColorTokens, type NoteColorKey } from './colors';
import { elevation, motion, radius, size, space } from './layout';
import { LARGE_FONT_SCALE, MAX_FONT_SCALE, type } from './typography';

export * from './colors';
export * from './layout';
export * from './typography';

export type Theme = {
  scheme: 'light' | 'dark';
  colors: ColorTokens;
  /** Week 11а: sticker colours (`color.note.*`) of this scheme. */
  notes: Record<NoteColorKey, string>;
  type: typeof type;
  space: typeof space;
  size: typeof size;
  radius: typeof radius;
  motion: typeof motion;
  /** Shadows only in light theme (2-design §2.4). */
  elevation: typeof elevation | null;
  /** System font scale clamped to MAX_FONT_SCALE. */
  fontScale: number;
  /** ≥150%: two tabs + «Ещё», two-row assistant line, one-column grids. */
  largeFont: boolean;
  screenPadding: number;
};

/** Theme follows the phone («Как в телефоне», default); manual switch comes with S23 Settings. */
export function useTheme(): Theme {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const { fontScale: rawScale } = useWindowDimensions();
  return useMemo(() => {
    const fontScale = Math.min(rawScale || 1, MAX_FONT_SCALE);
    const largeFont = fontScale >= LARGE_FONT_SCALE;
    return {
      scheme,
      colors: scheme === 'dark' ? darkColors : lightColors,
      notes: scheme === 'dark' ? darkNoteColors : lightNoteColors,
      type,
      space,
      size,
      radius,
      motion,
      elevation: scheme === 'dark' ? null : elevation,
      fontScale,
      largeFont,
      screenPadding: largeFont ? size.screenPaddingLarge : size.screenPadding,
    };
  }, [scheme, rawScale]);
}
