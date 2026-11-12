import { useMemo } from 'react';
import { useColorScheme, useWindowDimensions } from 'react-native';
import { create } from 'zustand';

import { darkColors, darkNoteColors, lightColors, lightNoteColors, type ColorTokens, type NoteColorKey } from './colors';
import { elevation, icon, motion, radius, size, space, type Elevation } from './layout';
import { gutterFor } from './responsive';
import { LARGE_FONT_SCALE, MAX_FONT_SCALE, type } from './typography';

export * from './colors';
export * from './layout';
export * from './responsive';
export * from './typography';

export type Scheme = 'light' | 'dark';
export type SchemePreference = 'system' | Scheme;

/**
 * «Как в телефоне» by default. The override is for the future Settings switch (S23) and for tests;
 * not persisted yet (no setting screen offers it).
 */
export const useSchemePreference = create<{ preference: SchemePreference; set: (p: SchemePreference) => void }>((set) => ({
  preference: 'system',
  set: (preference) => set({ preference }),
}));

export type Theme = {
  scheme: Scheme;
  colors: ColorTokens;
  /** Sticker colours of this scheme. */
  notes: Record<NoteColorKey, string>;
  type: typeof type;
  space: typeof space;
  size: typeof size;
  radius: typeof radius;
  motion: typeof motion;
  icon: typeof icon;
  /** `card` is null in the dark theme (depth = surface steps); `floating` always present. */
  elevation: Elevation;
  /** System font scale clamped to MAX_FONT_SCALE. */
  fontScale: number;
  /** ≥150%: fewer tabs, two-row capsule, one-column grids. */
  largeFont: boolean;
  /** Side padding for this window width: 12 (<360) · 16 · 20 (≥600). */
  screenPadding: number;
};

/** «Мята» (light) / «Глубина» (dark), following the phone unless overridden. */
export function useTheme(): Theme {
  const system = useColorScheme() === 'dark' ? 'dark' : 'light';
  const preference = useSchemePreference((s) => s.preference);
  const scheme: Scheme = preference === 'system' ? system : preference;
  const { fontScale: rawScale, width } = useWindowDimensions();
  return useMemo(() => {
    const fontScale = Math.min(rawScale || 1, MAX_FONT_SCALE);
    return {
      scheme,
      colors: scheme === 'dark' ? darkColors : lightColors,
      notes: scheme === 'dark' ? darkNoteColors : lightNoteColors,
      type,
      space,
      size,
      radius,
      motion,
      icon,
      elevation: elevation[scheme],
      fontScale,
      largeFont: fontScale >= LARGE_FONT_SCALE,
      screenPadding: gutterFor(width),
    };
  }, [scheme, rawScale, width]);
}
