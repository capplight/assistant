/**
 * DRAFT design tokens v2 — «Мята» (light) + «Глубина» (dark). Ф-46, Ф-48…Ф-54 (Pinterest ideas, p14 briefing).
 * Not wired into the app. Target: mobile/src/theme/{colors,layout,typography}.ts.
 * Mocks: docs/design/system/screens-v2.html. Changes vs v1: design-system.md §8 «Что меняется».
 *
 * Brand rule (both themes):
 *   brand     = emerald/mint: everything you press (primary button, mic, centre tab «Расходы», checkbox, links, focus).
 *   highlight = sun/amber:    what matters NOW (current item of the day, «Ждёт» badge). One sun fill per screen.
 *   Text on brand → onBrand, text on highlight → onHighlight (always dark).
 * Contrast (WCAG 2.1): ink/ink2 ≥ 4.5:1 on bg and surface; ink3 ≥ 4.5:1 on surface only; metric numbers ≥ 4.5:1 on surface.
 */

/** «Глубина» is built on ONE tonal scale (moodboard p55): every dark colour below is one of these steps or brand/highlight. */
export const deepScale = {
  0: '#051F20', // bg bottom, sunken
  1: '#0B2B26', // bg top, keypad-free areas
  2: '#163832', // surface (glass base)
  3: '#235347', // brandTint, separators (opaque)
  4: '#3E6B5A', // pressed surface
  5: '#8EB69B', // ink3
  6: '#DAF1DE', // ink, «light» accent card
} as const;

export type ColorTokens = {
  bg: string;
  /** Screen background: radial glow at the top + vertical gradient. Render with expo-linear-gradient + a radial PNG/SVG, or a Skia shader. */
  bgGradient: readonly [string, string];
  bgGlow: string; // colour of the radial glow at the top (alpha included)
  surface: string; // cards, tiles, list groups (dark: glass = semi-transparent + hairline)
  surfaceSolid: string; // when no blur/translucency is possible (Android low-end, sheets)
  surfaceRaised: string; // sheets, toasts, confirmation cards
  surfaceSunken: string; // inputs, segmented track, keypad bg, «+» circle
  glassBorder: string | null; // 1 px hairline on dark glass cards; null in light (no borders)
  ink: string;
  ink2: string;
  ink3: string; // ONLY on surface
  separator: string;
  iconSecondary: string;
  brand: string;
  brandPressed: string;
  brandTint: string;
  onBrand: string;
  brandGlow: string; // centre tab, mic, voice mode edge
  highlight: string;
  highlightTint: string;
  onHighlight: string;
  onHighlight2: string;
  success: string;
  successTint: string;
  warning: string;
  warningTint: string;
  danger: string;
  dangerTint: string;
  onDanger: string;
  focus: string;
  scrim: string;
  fade: string; // bottom dissolve behind the floating bar
  tabBar: string; // floating tab capsule
  tabPill: string; // active tab pill (p14: lighter pill)
  track: string; // progress-bar track
  paper: string; // A4 document preview (always light)
  linkOnBg: string; // «‹ Назад» and text links placed directly on the page background
};

export const lightColors: ColorTokens = {
  // v2.1 (A23 separation fix): deeper mint page + pure white cards + layered shadow with a 1 px tinted ring.
  bg: '#D3ECDE', // was #E2F2E9 · white card vs bg 1.25:1 (was 1.13:1)
  bgGradient: ['#D3ECDE', '#DEEFE5'], // was #DDF1E6 → #EAF5EF
  bgGlow: 'rgba(196,232,211,1)', // #C4E8D3, was #C3E8D3 on a lighter page
  surface: '#FFFFFF', // was #F9FDFA
  surfaceSolid: '#FFFFFF',
  surfaceRaised: '#FFFFFF',
  surfaceSunken: '#C5E1D1', // was #D3E8DC · brand text is NOT placed on sunken (4.1:1)
  glassBorder: null, // light edge = 1 px ring inside elevation.light.card (rgba(10,90,60,.07))
  ink: '#0E2A1F',
  ink2: '#47665A', // 5.1 on bg · 6.4 on surface
  ink3: '#587669',
  separator: '#DAEAE1',
  iconSecondary: '#728E81',
  brand: '#0A7553',
  brandPressed: '#06573D',
  brandTint: '#D2EEDF',
  onBrand: '#FFFFFF',
  brandGlow: 'rgba(10,117,83,0.38)',
  highlight: '#FFC845',
  highlightTint: '#FFF2CC',
  onHighlight: '#0E2A1F',
  onHighlight2: '#3D4A2A',
  success: '#0A7553',
  successTint: '#D2EEDF',
  warning: '#9A6400',
  warningTint: '#FFF2CC',
  danger: '#C4343D',
  dangerTint: '#FBE3E4',
  onDanger: '#FFFFFF',
  focus: '#0A7553',
  scrim: 'rgba(10,50,35,0.32)',
  fade: '#DEEFE5', // = bgGradient[1]
  tabBar: 'rgba(255,255,255,0.97)',
  tabPill: '#D2EEDF',
  track: '#E1EEE6',
  paper: '#FFFFFF',
  linkOnBg: '#06573D', // brand #0A7553 is 4.3:1 under the top glow → deeper emerald 6.4:1
};

export const darkColors: ColorTokens = {
  bg: deepScale[0],
  bgGradient: [deepScale[1], deepScale[0]],
  bgGlow: 'rgba(52,180,120,0.34)',
  surface: 'rgba(22,56,50,0.80)', // deepScale[2] @ 80 %
  surfaceSolid: deepScale[2],
  surfaceRaised: '#1D4239',
  surfaceSunken: deepScale[1],
  glassBorder: 'rgba(218,241,222,0.09)',
  ink: deepScale[6], // 14.4 on bg · 10.7 on surface
  ink2: '#A9CDB4', // 7.3 on surface
  ink3: deepScale[5], // 5.7 on surface
  separator: 'rgba(218,241,222,0.10)',
  iconSecondary: '#6F9A80',
  brand: '#5FD6A8', // 7.1 on surface
  brandPressed: '#8BE3C1',
  brandTint: deepScale[3],
  onBrand: '#04241C',
  brandGlow: 'rgba(95,214,168,0.50)',
  highlight: '#FFB547',
  highlightTint: '#4A3C22',
  onHighlight: '#12262B',
  onHighlight2: '#3A3420',
  success: '#5FD6A8',
  successTint: deepScale[3],
  warning: '#FFB547',
  warningTint: '#4A3C22',
  danger: '#FF8C86',
  dangerTint: '#4A2A2E',
  onDanger: '#2A0D0F',
  focus: '#8BE3C1',
  scrim: 'rgba(0,0,0,0.55)',
  fade: deepScale[0],
  tabBar: 'rgba(17,48,42,0.94)',
  tabPill: 'rgba(218,241,222,0.13)',
  track: 'rgba(218,241,222,0.10)',
  paper: '#F7FAF8',
  linkOnBg: '#5FD6A8',
};

/** Metric tiles (p14): big coloured number per tile. Fixed meaning in both themes. */
export type MetricKey = 'tasks' | 'spent' | 'reminders' | 'new';
export const metricColors: Record<'light' | 'dark', Record<MetricKey, string>> = {
  light: { tasks: '#0A7553', spent: '#A65A08', reminders: '#2F6FD6', new: '#8A6200' }, // all ≥ 4.5 on surface
  dark: { tasks: '#5FD6A8', spent: '#FFB547', reminders: '#8DB4FF', new: '#FFD36B' },
};

/**
 * Sticky notes: FIXED palette of 7 (moodboard idea 3). Existing keys unchanged (stored with notes); `lilac` is NEW.
 * Picker order = this array. Text on every fill: noteInk / noteInk2 (≥ 4.5:1).
 */
export type NoteColorKey = 'white' | 'yellow' | 'peach' | 'pink' | 'lilac' | 'blue' | 'green';
export const NOTE_COLOR_KEYS: readonly NoteColorKey[] = ['white', 'yellow', 'peach', 'pink', 'lilac', 'blue', 'green'];
export const lightNoteColors: Record<NoteColorKey, string> = {
  white: '#FFFFFF', yellow: '#FFEDB0', peach: '#FFDCC7', pink: '#FBD5DC', lilac: '#E6DDFB', blue: '#D4E6FB', green: '#DDEFC4',
};
export const darkNoteColors: Record<NoteColorKey, string> = {
  white: '#1D4239', yellow: '#4D4020', peach: '#4D3424', pink: '#4D2C36', lilac: '#3A3352', blue: '#22405A', green: '#354A26',
};
export const noteInk = { light: { ink: '#1F2B24', ink2: '#4A5A50' }, dark: { ink: '#DAF1DE', ink2: '#B9D5C1' } } as const;

/** «Расходы» categories: solid = icon/bar; tint = solid @ 15 % (light) / 22 % (dark). Text amounts use `categoryText`. */
export type CategoryKey = 'food' | 'transport' | 'home' | 'cafe' | 'health' | 'kids' | 'bills' | 'other';
export const categoryColors: Record<'light' | 'dark', Record<CategoryKey, string>> = {
  light: { food: '#2E9F6A', transport: '#3E7BEA', home: '#D98A0B', cafe: '#E36A5A', health: '#D9467A', kids: '#00A3B4', bills: '#56708F', other: '#8A9A93' },
  dark: { food: '#5CC98F', transport: '#78A6FF', home: '#FFC061', cafe: '#FF9585', health: '#FF85AE', kids: '#4FD3E0', bills: '#93A9C6', other: '#A9BAB3' },
};
/** Darker text variants for amounts on light surface (≥ 4.5:1); dark theme uses categoryColors.dark as is. */
export const categoryText: Record<CategoryKey, string> = {
  food: '#1E7F52', transport: '#2F6FD6', home: '#A65A08', cafe: '#B9483A', health: '#B23462', kids: '#00788A', bills: '#4A6280', other: '#5E6E67',
};

/* ---------------- typography (Onest; Kazakh ӘҒҚҢӨҰҮҺІ checked in the font cmap) ---------------- */
export const fontFamily = { regular: 'Onest_400Regular', medium: 'Onest_500Medium', semibold: 'Onest_600SemiBold', bold: 'Onest_700Bold' } as const;

type T = { fontFamily: string; fontSize: number; lineHeight: number; letterSpacing?: number; textTransform?: 'uppercase'; fontVariant?: ['tabular-nums'] };
export const type: Record<string, T> = {
  largeTitle: { fontFamily: fontFamily.bold, fontSize: 30, lineHeight: 36, letterSpacing: -0.6 },
  briefHeadline: { fontFamily: fontFamily.bold, fontSize: 28, lineHeight: 33, letterSpacing: -0.7 }, // NEW «Спокойный день.»
  briefBody: { fontFamily: fontFamily.regular, fontSize: 16, lineHeight: 23 }, // NEW summary paragraph, max 3 lines + «Подробнее»
  title1: { fontFamily: fontFamily.bold, fontSize: 24, lineHeight: 30, letterSpacing: -0.4 },
  title2: { fontFamily: fontFamily.semibold, fontSize: 20, lineHeight: 26, letterSpacing: -0.2 },
  headline: { fontFamily: fontFamily.semibold, fontSize: 17, lineHeight: 22 },
  body: { fontFamily: fontFamily.regular, fontSize: 17, lineHeight: 24 },
  bodyStrong: { fontFamily: fontFamily.semibold, fontSize: 17, lineHeight: 24 },
  callout: { fontFamily: fontFamily.regular, fontSize: 15, lineHeight: 20 },
  sectionLabel: { fontFamily: fontFamily.bold, fontSize: 15, lineHeight: 20 }, // block titles «План дня», no caps
  eyebrow: { fontFamily: fontFamily.bold, fontSize: 12, lineHeight: 16, letterSpacing: 0.8, textTransform: 'uppercase' }, // NEW tile labels / status line ONLY (≤ 3 words)
  footnote: { fontFamily: fontFamily.regular, fontSize: 13, lineHeight: 18 },
  caption: { fontFamily: fontFamily.medium, fontSize: 12, lineHeight: 16 },
  tabLabel: { fontFamily: fontFamily.medium, fontSize: 11, lineHeight: 13 },
  button: { fontFamily: fontFamily.semibold, fontSize: 17, lineHeight: 22 },
  number: { fontFamily: fontFamily.semibold, fontSize: 17, lineHeight: 24, fontVariant: ['tabular-nums'] },
  metric: { fontFamily: fontFamily.bold, fontSize: 32, lineHeight: 34, letterSpacing: -1, fontVariant: ['tabular-nums'] }, // NEW tile number
  metricUnit: { fontFamily: fontFamily.semibold, fontSize: 14, lineHeight: 18 }, // NEW «₸», «из 5»
  amount: { fontFamily: fontFamily.bold, fontSize: 40, lineHeight: 46, letterSpacing: -1.2, fontVariant: ['tabular-nums'] },
  keypadAmount: { fontFamily: fontFamily.bold, fontSize: 52, lineHeight: 58, letterSpacing: -1.6, fontVariant: ['tabular-nums'] }, // NEW
  keypadKey: { fontFamily: fontFamily.semibold, fontSize: 24, lineHeight: 28 }, // NEW
  answerValue: { fontFamily: fontFamily.bold, fontSize: 48, lineHeight: 52, letterSpacing: -1.4 }, // NEW search value «4512»
  time: { fontFamily: fontFamily.bold, fontSize: 36, lineHeight: 40, letterSpacing: -1, fontVariant: ['tabular-nums'] },
};
export const MAX_FONT_SCALE = 2.0;
export const LARGE_FONT_SCALE = 1.5;
export const HERO_MAX_SCALE = 1.4; // metric, amount, keypadAmount, answerValue, briefHeadline

/* ---------------- layout ---------------- */
export const space = { 0: 0, 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40 } as const;

export const size = {
  screenPadding: 16,
  screenPaddingWide: 20,
  maxContentWidth: 600,
  minTouch: 48,
  buttonHeight: 50,
  buttonHeightSmall: 36,
  rowHeight: 52,
  rowHeightMeta: 64,
  checkbox: 26, // was 24 — bigger circles (moodboard p350/p360)
  // floating bottom
  tabBar: 72, // capsule height (was 60)
  tabBarInset: 12,
  tabPill: { width: 68, height: 56 }, // icon + label inside the pill (p14)
  centreTab: 60, // emerald circle, raised by 20 above the bar top
  centreTabLift: 20,
  assistantCapsule: 56, // was 52
  assistantMic: 44,
  assistantPlus: 40,
  chipRow: 36, // suggestion chips above the capsule
  chipHeight: 36,
  toastMinHeight: 72, // two lines: text + actions
  // content
  metricTile: { minHeight: 132, radius: 22 },
  briefCardRadius: 26,
  keypadKey: 56,
  icon: 24,
  iconSm: 20,
  iconLg: 28,
  headerButton: 40,
  segmentedHeight: 40,
  viewToggle: { width: 76, height: 36 },
} as const;

export const radius = { xs: 6, sm: 10, md: 14, lg: 18, xl: 22, xxl: 26, sheet: 28, round: 9999 } as const;

/** Light: soft green shadows. Dark: glass = surface (80 %) + glassBorder hairline, no card shadows; floating = deep shadow. */
export const elevation = {
  light: {
    // Layered (CSS ref): 0 0 0 1px rgba(10,90,60,.07) · 0 1px 2px rgba(10,70,45,.08) · 0 6px 16px -4px rgba(10,70,45,.14)
    // RN: ring = borderWidth 1 (StyleSheet.hairlineWidth on 3x) borderColor rgba(10,90,60,0.07); two shadows = nested Views or react-native-shadow-2.
    ring: { borderWidth: 1, borderColor: 'rgba(10,90,60,0.07)' },
    card: { shadowColor: '#0A462D', shadowOffset: { width: 0, height: 6 }, shadowRadius: 16, shadowOpacity: 0.14, elevation: 3 },
    cardContact: { shadowColor: '#0A462D', shadowOffset: { width: 0, height: 1 }, shadowRadius: 2, shadowOpacity: 0.08 },
    // 0 0 0 1px rgba(10,90,60,.06) · 0 10px 28px -6px rgba(10,70,45,.22) · 0 2px 4px rgba(10,70,45,.08)
    floating: { shadowColor: '#0A462D', shadowOffset: { width: 0, height: 10 }, shadowRadius: 28, shadowOpacity: 0.22, elevation: 10 },
  },
  dark: {
    card: null,
    floating: { shadowColor: '#000000', shadowOffset: { width: 0, height: 10 }, shadowRadius: 30, shadowOpacity: 0.45, elevation: 10 },
  },
} as const;

/** Glow = coloured shadow (iOS) / shadow PNG or Skia blur (Android). Used ONLY on: centre tab, mic, voice capsule edge, status dot. */
export const glow = {
  centreTab: { radius: 18, offsetY: 6, opacity: 1 }, // colour = brandGlow
  mic: { radius: 10, offsetY: 3, opacity: 1 },
  voiceEdge: { ring: 2, radius: 26, spread: 6 }, // ring in brand + blur in brandGlow, pulses with the voice level
  statusDot: { radius: 8 },
} as const;

export const icon = { set: 'lucide', strokeWidth: 1.75, sizes: [20, 24, 28] } as const;

export const motion = {
  press: { duration: 100, easing: [0.2, 0, 0, 1] },
  fast: { duration: 150, easing: [0.2, 0, 0, 1] },
  base: { duration: 250, easing: [0.2, 0, 0, 1] },
  exit: { duration: 200, easing: [0.3, 0, 1, 1] },
  sheet: { duration: 350, easing: 'spring' },
  check: { duration: 600, easing: [0.2, 0, 0, 1] },
  toast: { duration: 250, easing: 'spring' }, // stays 6 s (two actions)
  confirmCard: { duration: 5000, easing: 'linear' }, // reminder card auto-closes; thin progress bar shows the time
  listen: { duration: 1200, easing: 'linear' }, // voice glow pulse
  metricCount: { duration: 600, easing: 'ease-out' }, // numbers count up on first show of the day
} as const;
export const springSheet = { damping: 22, stiffness: 220 } as const;
export const reducedMotionFade = 150;

export const alarmScreen = { bg: '#B4361E', text: '#FFFFFF' } as const; // unchanged
