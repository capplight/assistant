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
  assistantCapsule: 52,
  /** Visible mic circle; the hit area stays 48. */
  assistantMic: 40,
  assistantPlus: 36,
  /** Floating capsule. */
  tabBar: 60,
  /** Left / right / bottom gap of the floating tab bar (+ safe area). */
  tabBarInset: 12,
  /** Gap between the capsule and the tab bar. */
  capsuleGap: 8,
  tabPill: { width: 56, height: 30 },
  /** The fade under the floating bottom (content dissolves). */
  bottomFade: 150,
  checkbox: 24,
  iconSm: 20,
  icon: 24,
  iconLg: 28,
  headerButton: 36,
  segmentedHeight: 36,
  chipHeight: 32,
  toastHeight: 48,
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
  /** Cards, list groups. */
  lg: 16,
  /** «Дальше», toast. */
  xl: 20,
  sheet: 24,
  /** Capsules, pills, mic. */
  round: 9999,
} as const;

type Shadow = Pick<ViewStyle, 'shadowColor' | 'shadowOffset' | 'shadowRadius' | 'shadowOpacity' | 'elevation'>;
export type Elevation = { card: Shadow | null; floating: Shadow };

/** Light: soft green-tinted shadows. Dark: no card shadows — depth = surface → surfaceRaised. */
export const elevation: Record<'light' | 'dark', Elevation> = {
  light: {
    card: { shadowColor: '#0A462D', shadowOffset: { width: 0, height: 2 }, shadowRadius: 8, shadowOpacity: 0.06, elevation: 1 },
    floating: { shadowColor: '#0A462D', shadowOffset: { width: 0, height: 8 }, shadowRadius: 24, shadowOpacity: 0.16, elevation: 8 },
  },
  dark: {
    card: null,
    floating: { shadowColor: '#000000', shadowOffset: { width: 0, height: 8 }, shadowRadius: 24, shadowOpacity: 0.35, elevation: 8 },
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
  /** Stays 5 s, «Отменить» always. */
  toast: { duration: 250, easing: 'spring' },
  listen: { duration: 1200, easing: 'linear' },
  /** A new sticker / row is lit (board, week 16а). */
  highlight: { duration: 600, easing: 'ease-out' },
  /** A sticker lifts on long press. */
  lift: { duration: 150, easing: [0.2, 0, 0, 1] },
} as const satisfies Record<string, MotionToken>;

export const pressScale = 0.97;
export const toastMs = 5000;
export const springSheet = { damping: 22, stiffness: 220 } as const;
/** With Reduce Motion: moves and scale become a 150 ms fade. */
export const reducedMotionFade = 150;
