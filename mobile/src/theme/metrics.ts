import { useContext, useMemo } from 'react';
import { useWindowDimensions } from 'react-native';
import { SafeAreaInsetsContext, type EdgeInsets } from 'react-native-safe-area-context';

import { askBar, sheet, tabBarV5 } from './layout';
import { HERO_MAX_SCALE, MAX_FONT_SCALE, SMALL_WIDTH, TAB_LABEL_MAX, TITLE_ONLY_SCALE } from './typography';

/**
 * v5 «Листы» adaptive metrics — the ONE place where window width, system font scale, theme and safe areas turn into
 * dp for the sheets, the tab bar and the assistant strip (design-system §11.4, §11.5, §11.12). Screens never compute
 * these themselves.
 *
 *   width     ≤ 340 «small» · 341–419 «regular» · ≥ 420 «large»
 *   gutter    16 / 20 / 24
 *   phrase    23 / 27 / 30, and 25 in the dark theme (on regular widths)
 *   title only (no phrase): width ≤ 340 OR fontScale ≥ 1.3; the day plan turns into rows from 1.3
 *   tab label 11.5 at ≤ 340, otherwise 12; never above 13 dp with the system font
 */
export type Scheme = 'light' | 'dark';

export type LayoutMetrics = {
  width: number;
  height: number;
  size: 'small' | 'regular' | 'large';
  fontScale: number;
  /** fontScale ≥ 1.3 (v5 «крупный шрифт»). */
  largeText: boolean;
  gutter: number;
  /** No big phrase: only the title stays on the sheet. */
  titleOnly: boolean;
  /** The day plan as «время — дело» rows instead of duration blocks. */
  planAsRows: boolean;
  /** Font size of the phrase in dp (before the capped system scale). */
  phraseSize: number;
  /** Bottom padding of the coloured sheet (dark sheets are 6 shorter). */
  sheetPadBottom: number;
  /** Height of the collapsed coloured sheet incl. its paddings (the paper overlap is inside). */
  collapsedSheet: number;
  /** Top safe area (status bar / notch); at least 20 so the tray always shows above the sheet. */
  top: number;
  /** Bottom safe area under the tab bar (gesture bar, 3-button bar: 0 → a small gap). */
  bottom: number;
  insets: EdgeInsets;
  tab: { capsule: number; capsuleActive: number; labelSize: number; labelMaxScale: number; barHeight: number };
  ask: {
    height: number;
    radius: number;
    inset: number;
    padLeft: number;
    gap: number;
    mic: number;
    fontSize: number;
    /** Lists end this far above the tab bar so the last row is not under the strip. */
    listBottomPadding: number;
  };
  /** A row's minimum height (54, 68 with large text). */
  row: number;
  checkbox: number;
  /** Max multiplier for hero text (phrase, big number). */
  heroMaxScale: number;
};

const ZERO: EdgeInsets = { top: 0, right: 0, bottom: 0, left: 0 };

export function sizeClassOf(width: number): LayoutMetrics['size'] {
  if (width <= SMALL_WIDTH) return 'small';
  if (width >= 420) return 'large';
  return 'regular';
}

/** Pure: everything a v5 screen needs for a window. `useLayoutMetrics()` is this plus the live window. */
export function layoutMetricsFor(o: { width: number; height: number; fontScale?: number; scheme?: Scheme; insets?: EdgeInsets }): LayoutMetrics {
  const fontScale = Math.min(o.fontScale || 1, MAX_FONT_SCALE);
  const scheme = o.scheme ?? 'light';
  const sz = sizeClassOf(o.width);
  const largeText = fontScale >= TITLE_ONLY_SCALE;
  const insets = o.insets ?? ZERO;
  const gutter = sz === 'small' ? 16 : sz === 'large' ? 24 : 20;
  const phraseSize = sz === 'small' ? 23 : sz === 'large' ? 30 : scheme === 'dark' ? 25 : 27;
  const sheetPadBottom = sheet.padBottom[scheme];
  const labelSize = sz === 'small' ? 11.5 : 12;
  const askHeight = largeText ? askBar.heightLarge : askBar.height;
  return {
    width: o.width,
    height: o.height,
    size: sz,
    fontScale,
    largeText,
    gutter,
    titleOnly: sz === 'small' || largeText,
    planAsRows: largeText,
    phraseSize,
    sheetPadBottom,
    collapsedSheet: sheet.stripPadTop + sheet.strip + (sheetPadBottom - 12),
    top: Math.max(insets.top, 20),
    bottom: insets.bottom > 0 ? insets.bottom : 8,
    insets,
    tab: {
      capsule: sz === 'small' ? tabBarV5.capsule.widthSmall : tabBarV5.capsule.width,
      capsuleActive: sz === 'small' ? tabBarV5.capsule.widthSmallActive : tabBarV5.capsule.widthActive,
      labelSize,
      labelMaxScale: TAB_LABEL_MAX / labelSize,
      barHeight: tabBarV5.height,
    },
    ask: {
      height: askHeight,
      radius: askHeight / 2,
      inset: sz === 'small' ? askBar.inset.small : sz === 'large' ? askBar.inset.large : askBar.inset.default,
      padLeft: sz === 'small' ? askBar.padLeftSmall : askBar.padLeft,
      gap: sz === 'small' ? askBar.gapSmall : askBar.gap,
      mic: largeText ? askBar.micLarge : askBar.mic,
      fontSize: largeText ? 19 : sz === 'small' ? 15 : 16,
      listBottomPadding: largeText ? askBar.listBottomPaddingLarge : askBar.listBottomPadding,
    },
    row: largeText ? 68 : 54,
    checkbox: largeText ? 32 : 26,
    heroMaxScale: HERO_MAX_SCALE,
  };
}

/** v5 metrics for the current window, theme scheme and safe areas. */
export function useLayoutMetrics(scheme: Scheme): LayoutMetrics {
  const { width, height, fontScale } = useWindowDimensions();
  const insets = useContext(SafeAreaInsetsContext) ?? ZERO;
  const { top, right, bottom, left } = insets;
  return useMemo(
    () => layoutMetricsFor({ width, height, fontScale, scheme, insets: { top, right, bottom, left } }),
    [width, height, fontScale, scheme, top, right, bottom, left],
  );
}
