/** Spacing, sizes, radii, elevation and motion tokens (2-design §2.3, §2.4, §2.6). */

export const space = {
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  14: 56,
} as const;

export const size = {
  /** Screen side padding; 16 when font ≥150%. */
  screenPadding: 20,
  screenPaddingLarge: 16,
  /** Minimum touch target (2-design §2.3). */
  minTouch: 48,
  /** Main buttons and microphone in the assistant line — the task brief requires 56 for all primary targets. */
  primaryTouch: 56,
  mic: 56,
  micLarge: 96,
  plus: 48,
  assistantLine: 64,
  tabBar: 64,
  tabBarLarge: 72,
  tabIcon: 28,
  cardIcon: 24,
  contextChip: 40,
  /** Active tab indicator bar. */
  activeTabBar: 3,
  focusRing: 3,
  /** Tablet: content ≤600 centred. */
  maxContentWidth: 600,
} as const;

export const radius = {
  card: 14,
  button: 14,
  input: 12,
  chip: 12,
  sheet: 20,
  /** Week 11а: a sticker (template-screens 2.1). */
  note: 4,
  round: 9999,
} as const;

/** Light theme only — in dark theme depth = lighter surface + border, no shadows. */
export const elevation = {
  sheet: {
    shadowColor: '#1F1D1A',
    shadowOffset: { width: 0, height: 8 },
    shadowRadius: 24,
    shadowOpacity: 0.12,
    elevation: 8,
  },
  mic: {
    shadowColor: '#2F4BD8',
    shadowOffset: { width: 0, height: 6 },
    shadowRadius: 16,
    shadowOpacity: 0.3,
    elevation: 6,
  },
} as const;

export type Easing = readonly [number, number, number, number] | 'linear' | 'ease-out' | 'ease-in-out' | 'spring';

export type MotionToken = { duration: number; easing: Easing };

export const motion = {
  instant: { duration: 100, easing: 'linear' },
  fast: { duration: 150, easing: [0.2, 0, 0, 1] },
  base: { duration: 250, easing: [0.2, 0, 0, 1] },
  exit: { duration: 200, easing: [0.3, 0, 1, 1] },
  /** spring: damping 20, stiffness 180 */
  stack: { duration: 400, easing: 'spring' },
  count: { duration: 600, easing: 'ease-out' },
  move: { duration: 250, easing: [0.2, 0, 0, 1] },
  lift: { duration: 150, easing: [0.2, 0, 0, 1] },
  highlight: { duration: 600, easing: 'ease-out' },
  listen: { duration: 1200, easing: 'linear' },
  alarm: { duration: 1000, easing: 'ease-in-out' },
} as const satisfies Record<string, MotionToken>;

export const springStack = { damping: 20, stiffness: 180 } as const;
/** With Reduce Motion: moves and scale become a 150 ms fade. */
export const reducedMotionFade = 150;
