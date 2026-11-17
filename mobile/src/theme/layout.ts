import type { ViewStyle } from 'react-native';

/** Spacing, sizes, radii, elevation and motion v5 «Листы» (`docs/design/system/tokens-v5.ts`, design-system.md §11). */

/** 4-pt steps. */
export const space = { 0: 0, 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40 } as const;

export const size = {
  /** Screen side padding: 12 under 360 dp, 16 up to 599, 20 from 600 (see `useLayout`). */
  screenPaddingNarrow: 12,
  screenPadding: 16,
  screenPaddingWide: 20,
  /** Content, the tab bar and the capsule are never wider than this; centred on tablets. */
  maxContentWidth: 600,
  /** Hit area (hitSlop / the Pressable box). Android 48 / iOS 44 → 48 everywhere. */
  minTouch: 48,
  /** Primary / secondary button. */
  buttonHeight: 52,
  /** Chip-like buttons, «Готово» on cards. */
  buttonHeightSmall: 42,
  rowHeight: 54,
  rowHeightMeta: 64,
  assistantCapsule: 48,
  /** Visible mic circle; the hit area stays 48. */
  assistantMic: 36,
  assistantPlus: 36,
  /** Floating capsule (v2: 72). */
  tabBar: 68,
  /** Left / right / bottom gap of the floating tab bar (+ safe area). */
  tabBarInset: 12,
  /** Gap between the capsule and the tab bar. */
  capsuleGap: 8,
  /** v2: icon and label inside the pill (p14). */
  tabPill: { width: 68, height: 56 },
  /** «Расходы»: the emerald circle in the centre, raised above the bar top. */
  centreTab: 60,
  centreTabLift: 20,
  /** Suggestion chips above the capsule. */
  chipRow: 36,
  toastMinHeight: 72,
  metricTile: { minHeight: 132, radius: 22 },
  briefCardRadius: 26,
  keypadKey: 56,
  viewToggle: { width: 76, height: 36 },
  /** The fade under the floating bottom (content dissolves). */
  bottomFade: 150,
  /** QA v2 §0.2: the end of a scrolling list stays clear of the floating bottom's fade and shadow. */
  contentEndGap: 72,
  checkbox: 26,
  iconSm: 20,
  icon: 24,
  iconLg: 28,
  headerButton: 40,
  segmentedHeight: 40,
  chipHeight: 38,
  toastHeight: 48,
  /** v4 TopNotice (design-system §10.2): the capsule at the top. */
  noticeHeight: 54,
  emptyIconCircle: 88,
  emptyIcon: 48,
  sheetHandle: { width: 40, height: 5 },
} as const;

export const radius = {
  /** Tiny badges. */
  xs: 6,
  /** Inputs, segmented track. */
  sm: 10,
  /** Sticky note, small cards, rectangular buttons. */
  md: 14,
  /** Cards, list groups, sticky notes (v2). */
  lg: 18,
  /** Tiles, toast. */
  xl: 22,
  /** The brief card. */
  xxl: 26,
  /** v4 TopNotice capsule. */
  notice: 18,
  sheet: 28,
  /** Capsules, pills, mic. */
  round: 9999,
} as const;

type Shadow = Pick<ViewStyle, 'shadowColor' | 'shadowOffset' | 'shadowRadius' | 'shadowOpacity' | 'elevation'>;
export type Elevation = {
  card: Shadow | null;
  floating: Shadow;
  /** v2.1 light: the 1 px green ring of a card (null in dark: glass uses `glassBorder`). */
  ring: Pick<ViewStyle, 'borderWidth' | 'borderColor'> | null;
};

/** Light v2.1: a green ring + soft green shadows. Dark: glass cards without shadows, a deep floating shadow. */
/** v5: flat sheets — no card shadows, no rings. Only floating layers (notice, sheets, confirm) get a shadow. */
export const elevation: Record<'light' | 'dark', Elevation> = {
  light: {
    card: null,
    floating: { shadowColor: '#000000', shadowOffset: { width: 0, height: 14 }, shadowRadius: 30, shadowOpacity: 0.25, elevation: 12 },
    ring: null,
  },
  dark: {
    card: null,
    floating: { shadowColor: '#000000', shadowOffset: { width: 0, height: 14 }, shadowRadius: 30, shadowOpacity: 0.45, elevation: 12 },
    ring: null,
  },
};

/** Lucide: stroke 1.8, round caps (v5 sizes 15 / 18 / 22 / 26 / 30). */
export const icon = { strokeWidth: 1.8, sizes: [15, 18, 22, 26, 30] } as const;

export type Easing = readonly [number, number, number, number] | 'linear' | 'ease-out' | 'spring';
export type MotionToken = { duration: number; easing: Easing };

export const motion = {
  /** Press: scale 0.97 + tint. */
  press: { duration: 100, easing: [0.2, 0, 0, 1] },
  fast: { duration: 150, easing: [0.2, 0, 0, 1] },
  base: { duration: 250, easing: [0.2, 0, 0, 1] },
  exit: { duration: 200, easing: [0.3, 0, 1, 1] },
  /** Spring `springSheet`. */
  sheet: { duration: 350, easing: 'spring' },
  /** Fill + haptic, then the row leaves to «Сделано». */
  check: { duration: 600, easing: [0.2, 0, 0, 1] },
  /** Stays 6 s (two actions), «Отменить» always. */
  toast: { duration: 250, easing: 'spring' },
  listen: { duration: 1200, easing: 'linear' },
  /** The reminder card closes by itself; a thin bar shows the time left. */
  confirmCard: { duration: 5000, easing: 'linear' },
  /** Tile numbers count up on the first show of the day. */
  metricCount: { duration: 600, easing: 'ease-out' },
  /** A new sticker / row is lit (board, week 16а). */
  highlight: { duration: 600, easing: 'ease-out' },
  /** A sticker lifts on long press. */
  lift: { duration: 150, easing: [0.2, 0, 0, 1] },
} as const satisfies Record<string, MotionToken>;

export const pressScale = 0.97;
export const toastMs = 6000;
export const springSheet = { damping: 22, stiffness: 220 } as const;
/** With Reduce Motion: moves and scale become a 150 ms fade. */
export const reducedMotionFade = 150;

/* ---------------- v5 «Листы» geometry (tokens-v5 `size`, `radius`, `motion`, `assistantEntry`) ---------------- */

export const sheet = {
  /** Two strips of the neighbour places peeking above the sheet (roots of the tabs only). */
  peek: 14,
  /** The top row of the sheet (date / back · icons). */
  topRow: 40,
  padTop: 10,
  /** The paper sheet overlaps the coloured one by this much. */
  overlap: 28,
  /** Padding under the sheet content: dark sheets are 6 shorter. */
  padBottom: { light: 44, dark: 38 },
  /** The collapsed strip (content) and the padding above it. */
  strip: 44,
  stripPadTop: 6,
  radius: 28,
  iconButton: 40,
  /** The small tab in place colour at the start of list rows. */
  placeTab: { width: 16, height: 22 },
  bottomSheetStrip: 6,
  categorySquare: 12,
  /** Paper top padding (from its top edge). */
  paperPadTop: 18,
} as const;

/** The tab bar v5: 5 capsules in place colours + a word under each. */
export const tabBarV5 = {
  height: 68,
  padTop: 9,
  capsule: { width: 46, widthActive: 58, widthSmall: 42, widthSmallActive: 52, height: 30, radius: 15 },
  ring: { gap: 2, width: 1.5 },
  labelGap: 5,
  /** Home indicator room when the system gives no inset. */
  homeIndicator: 24,
} as const;

/** The day plan («Ритм»): block height = duration, 1 dp per minute, at least 40. */
export const plan = { timeColumn: 56, dpPerMinute: 1, minBlock: 40, blockGap: 4, radius: 14, maxFree: 160 } as const;

export const radiusV5 = { tag: 4, placeTab: 5, a4: 4, inset: 16, card: 18, sticker: 20, button: 26, buttonSmall: 21, confirm: 26, sheet: 28, notice: 18 } as const;

export const motionV5 = {
  press: 100,
  /** The sheet follows the finger; this is the snap after release. */
  sheetCollapse: 200,
  noticeIn: 220,
  /** Ф-67, Ф-75: every notice incl. «Удалено · Восстановить». */
  noticeHold: 3000,
  noticeOut: 180,
  confirm: 220,
  check: 300,
  /** Ф-82: the assistant strip → circle, circle → strip. */
  askCollapse: 200,
  askExpand: 240,
} as const;

/** Top notice (Ф-65…Ф-67): an inverse capsule 10 from the edges, ≥ 54 high, radius 18, three dots, ≤ 2 lines. */
export const noticeV5 = { inset: 10, minHeight: 54, radius: 18, dots: 3, maxLines: 2 } as const;

/** The assistant strip on the tab screens (Ф-81, Ф-82 variant C; design-system §11.12). */
export const askBar = {
  height: 48,
  heightLarge: 56,
  aboveTabBar: 10,
  inset: { default: 12, small: 8, large: 16 },
  padLeft: 16,
  padLeftSmall: 14,
  padRight: 6,
  gap: 10,
  gapSmall: 8,
  dot: 9,
  mic: 36,
  micLarge: 44,
  border: 1.5,
  bottomFade: 34,
  listBottomPadding: 70,
  listBottomPaddingLarge: 78,
  aboveKeyboard: 8,
  noticeGap: 8,
  collapseAfterDown: 24,
  expandAfterIdleMs: 600,
  expandOnUp: 24,
  expandNearEnd: 24,
  destination: { height: 28, gap: 6, radius: 14 },
  elevation: { shadowColor: '#000000', shadowOffset: { width: 0, height: 10 }, shadowRadius: 22, shadowOpacity: 0.2, elevation: 6 },
} as const;
