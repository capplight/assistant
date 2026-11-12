import { useContext, useMemo } from 'react';
import { useWindowDimensions } from 'react-native';
import { SafeAreaInsetsContext, type EdgeInsets } from 'react-native-safe-area-context';

import { size } from './layout';
import { LARGE_FONT_SCALE, MAX_FONT_SCALE } from './typography';

/**
 * Adaptive layout toolkit (founder requirement; design-system §4 «Ширины экрана»).
 *
 * Width classes (dp):  compact < 360 · regular 360–599 · expanded ≥ 600 (tablets, foldables open, landscape
 * phones from 600). `twoPane` from 840: a list + detail side by side where the design asks for it.
 * Content, the tab bar and the assistant capsule are never wider than `contentMaxWidth` (600), centred.
 * Font scale 1.0–2.0 is honoured; ≥1.5 is «large font».
 */
export type WidthClass = 'compact' | 'regular' | 'expanded';

export const BREAKPOINTS = { regular: 360, expanded: 600, twoPane: 840 } as const;

export type Layout = {
  width: number;
  height: number;
  widthClass: WidthClass;
  /** ≥840 dp: room for two panes (list + detail). */
  twoPane: boolean;
  landscape: boolean;
  /** Shortest side ≥600: a tablet (in either orientation). */
  tablet: boolean;
  /** Clamped to MAX_FONT_SCALE. */
  fontScale: number;
  largeFont: boolean;
  /** Screen side padding: 12 / 16 / 20. */
  gutter: number;
  /** Max width of a readable column (text, lists, the bottom bar). */
  contentMaxWidth: number;
  /** Width the content column actually gets (window − gutters, ≤ contentMaxWidth). */
  contentWidth: number;
  /** Sticky-note columns (1–3). */
  noteColumns: number;
  /** Tile columns (gallery cards, «Ещё» squares): 1–4. */
  tileColumns: number;
  insets: EdgeInsets;
};

const ZERO: EdgeInsets = { top: 0, right: 0, bottom: 0, left: 0 };

export function widthClassOf(width: number): WidthClass {
  if (width >= BREAKPOINTS.expanded) return 'expanded';
  if (width >= BREAKPOINTS.regular) return 'regular';
  return 'compact';
}

export function gutterFor(width: number): number {
  const c = widthClassOf(width);
  return c === 'compact' ? size.screenPaddingNarrow : c === 'expanded' ? size.screenPaddingWide : size.screenPadding;
}

/**
 * Sticky notes (design-system §3 StickyNote, §4): 2 columns, 3 from 600, 1 at ≥150% font, and 1 under 360
 * from 130% font.
 */
export function noteColumnsFor(width: number, fontScale: number): number {
  if (fontScale >= LARGE_FONT_SCALE) return 1;
  const c = widthClassOf(width);
  if (c === 'compact' && fontScale >= 1.3) return 1;
  return c === 'expanded' ? 3 : 2;
}

/** Tiles: as many ≥ `minTile` (× font scale, capped) columns as fit, 1–4. */
export function tileColumnsFor(contentWidth: number, fontScale: number, gap = 8, minTile = 150): number {
  const min = minTile * Math.min(Math.max(fontScale, 1), 1.6);
  const n = Math.floor((contentWidth + gap) / (min + gap));
  return Math.max(1, Math.min(4, n));
}

/** Width of one cell in a grid of `columns` with `gap` between, inside `width`. Floors to whole dp. */
export function gridItemWidth(width: number, columns: number, gap = 8): number {
  const n = Math.max(1, columns);
  return Math.floor((width - gap * (n - 1)) / n);
}

/** Pure: the layout for a window. `useLayout()` is this plus the live window and safe areas. */
export function layoutFor(o: { width: number; height: number; fontScale?: number; insets?: EdgeInsets }): Layout {
  const fontScale = Math.min(o.fontScale || 1, MAX_FONT_SCALE);
  const gutter = gutterFor(o.width);
  const insets = o.insets ?? ZERO;
  const usable = o.width - insets.left - insets.right;
  const contentWidth = Math.max(0, Math.min(size.maxContentWidth, usable - gutter * 2));
  return {
    width: o.width,
    height: o.height,
    widthClass: widthClassOf(o.width),
    twoPane: o.width >= BREAKPOINTS.twoPane,
    landscape: o.width > o.height,
    tablet: Math.min(o.width, o.height) >= BREAKPOINTS.expanded,
    fontScale,
    largeFont: fontScale >= LARGE_FONT_SCALE,
    gutter,
    contentMaxWidth: size.maxContentWidth,
    contentWidth,
    noteColumns: noteColumnsFor(o.width, fontScale),
    tileColumns: tileColumnsFor(contentWidth, fontScale),
    insets,
  };
}

/** Breakpoints, columns, gutters, readable width and safe areas for the current window. */
export function useLayout(): Layout {
  const { width, height, fontScale } = useWindowDimensions();
  // No provider (a bare component test): no insets rather than a crash.
  const insets = useContext(SafeAreaInsetsContext) ?? ZERO;
  const { top, right, bottom, left } = insets;
  return useMemo(
    () => layoutFor({ width, height, fontScale, insets: { top, right, bottom, left } }),
    [width, height, fontScale, top, right, bottom, left],
  );
}

/** Style of a centred column no wider than the readable width (tablets). */
export function readableColumn(maxWidth: number = size.maxContentWidth) {
  return { width: '100%', maxWidth, alignSelf: 'center' } as const;
}
