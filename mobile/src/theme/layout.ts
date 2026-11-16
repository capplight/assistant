import type { ViewStyle } from 'react-native';

/** Spacing, sizes, radii, elevation and motion «Мята / Глубина» (`docs/design/system/design-system.md` §2). */

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
  buttonHeight: 50,
  /** Chip-like buttons, «Готово» on cards. */
  buttonHeightSmall: 36,
  rowHeight: 52,
  rowHeightMeta: 64,
  assistantCapsule: 56,
  /** Visible mic circle; the hit area stays 48. */
  assistantMic: 44,
  assistantPlus: 40,
  /** Floating capsule (v2: 72). */
  tabBar: 72,
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
  chipHeight: 36,
  toastHeight: 48,
  /** v4 TopNotice (design-system §10.2): the capsule at the top. */
  noticeHeight: 52,
  emptyIconCircle: 88,
  emptyIcon: 48,
  sheetHandle: { width: 36, height: 4 },
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
  notice: 22,
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
export const elevation: Record<'light' | 'dark', Elevation> = {
  light: {
    card: { shadowColor: '#0A462D', shadowOffset: { width: 0, height: 6 }, shadowRadius: 16, shadowOpacity: 0.14, elevation: 3 },
    floating: { shadowColor: '#0A462D', shadowOffset: { width: 0, height: 10 }, shadowRadius: 28, shadowOpacity: 0.22, elevation: 10 },
    ring: { borderWidth: 1, borderColor: 'rgba(10,90,60,0.07)' },
  },
  dark: {
    card: null,
    floating: { shadowColor: '#000000', shadowOffset: { width: 0, height: 10 }, shadowRadius: 30, shadowOpacity: 0.45, elevation: 10 },
    ring: null,
  },
};

/** Lucide: stroke 1.75, round caps; sizes 20 / 24 / 28 only. */
export const icon = { strokeWidth: 1.75, sizes: [20, 24, 28] } as const;

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
