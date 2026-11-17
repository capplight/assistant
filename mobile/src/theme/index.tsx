import { useMemo } from 'react';
import { useColorScheme, useWindowDimensions } from 'react-native';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { persistStorage } from '@/store/storage';

import { darkColors, darkNoteColors, lightColors, lightNoteColors, type ColorTokens, type NoteColorKey } from './colors';
import { elevation, icon, motion, radius, size, space, type Elevation } from './layout';
import { useLayoutMetrics, type LayoutMetrics, type Scheme } from './metrics';
import { gutterFor } from './responsive';
import { LARGE_FONT_SCALE, MAX_FONT_SCALE, type } from './typography';

export * from './colors';
export * from './layout';
export * from './metrics';
export * from './responsive';
export * from './typography';

export type SchemePreference = 'system' | Scheme;

/** «Как в телефоне» by default; «Настройки → Тема» overrides it (kept on the phone). */
export const useSchemePreference = create<{ preference: SchemePreference; set: (p: SchemePreference) => void }>()(
  persist(
    (set) => ({
      preference: 'system',
      set: (preference) => set({ preference }),
    }),
    { name: 'theme.v1', storage: persistStorage, partialize: (s) => ({ preference: s.preference }) },
  ),
);

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
  /** Side padding for this window width: 16 (≤340) · 20 · 24 (≥420). */
  screenPadding: number;
  /** v5 adaptive metrics (sheets, tab bar, assistant strip): `useLayoutMetrics`. */
  m: LayoutMetrics;
};

/** v5 «Листы» light / dark, following the phone unless overridden («Настройки → Тема»). */
export function useTheme(): Theme {
  const system = useColorScheme() === 'dark' ? 'dark' : 'light';
  const preference = useSchemePreference((s) => s.preference);
  const scheme: Scheme = preference === 'system' ? system : preference;
  const { fontScale: rawScale, width } = useWindowDimensions();
  const m = useLayoutMetrics(scheme);
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
      m,
    };
  }, [scheme, rawScale, width, m]);
}
