/**
 * DRAFT design tokens — «Мята» (light) + «Глубина» (dark), decision Ф-46.
 * Not wired into the app. Target: mobile/src/theme/{colors,layout,typography}.ts.
 * See docs/design/system/design-system.md §2 for the rename map from the current tokens.
 *
 * Brand rule (both themes):
 *   brand      = sea-emerald: everything you press (primary button, mic, active tab, checkbox, links, focus).
 *   highlight  = sun/amber:   what matters now (the «Дальше» card, the week-1 tip, pinned note, «new» dot).
 *   Text on brand uses `onBrand`, text on highlight uses `onHighlight` (always dark).
 * Contrast (WCAG 2.1): ink/ink2 ≥ 4.5:1 on bg and surface; ink3 ≥ 4.5:1 on surface only
 * (on bg use ink2); brand as text ≥ 4.5:1 on bg/surface; onBrand on brand ≥ 5.5:1.
 */

export type ColorTokens = {
  /** Screen background (solid fallback) + its vertical gradient (top → bottom). */
  bg: string;
  bgGradient: readonly [string, string, string];
  /** Cards, list groups, tab bar, assistant capsule. */
  surface: string;
  /** Sheets, menus, toasts — one step above surface. */
  surfaceRaised: string;
  /** Inputs, segmented-control track, «+» circle, key caps. */
  surfaceSunken: string;
  ink: string; // text 1 — titles, body
  ink2: string; // text 2 — secondary, meta on bg
  ink3: string; // text 3 — dates/disabled, ONLY on surface (not on bg, not on surfaceRaised in dark)
  separator: string; // 0.5–1 px inset dividers
  iconSecondary: string; // ⋯, chevrons, inactive tab icons
  brand: string;
  brandPressed: string;
  brandTint: string; // selected pill, chips, icon squares in «Ещё»
  onBrand: string;
  highlight: string;
  highlightTint: string;
  onHighlight: string;
  onHighlight2: string; // secondary text on highlight
  success: string;
  successTint: string;
  warning: string; // as text
  warningTint: string;
  danger: string; // overdue, delete — text and fills
  dangerTint: string;
  onDanger: string;
  focus: string;
  scrim: string;
  /** Bottom fade behind the floating tab bar / assistant capsule (= bgGradient[2]). */
  fade: string;
};

export const lightColors: ColorTokens = {
  bg: '#E2F2E9',
  bgGradient: ['#CFEBDD', '#E2F2E9', '#EAF5EF'],
  surface: '#F9FDFA',
  surfaceRaised: '#FFFFFF',
  surfaceSunken: '#D3E8DC',
  ink: '#0E2A1F', // 13.2 bg · 14.9 surface
  ink2: '#47665A', // 5.0 bgTop · 6.2 surface
  ink3: '#587669', // 4.9 surface (4.3 bg → not on bg)
  separator: '#DAEAE1',
  iconSecondary: '#728E81', // ≥3.3 on surface (non-text)
  brand: '#0A7553', // 4.9 bg · 5.6 surface
  brandPressed: '#06573D',
  brandTint: '#D2EEDF',
  onBrand: '#FFFFFF', // 5.7
  highlight: '#FFC845',
  highlightTint: '#FFF2CC',
  onHighlight: '#0E2A1F', // 9.9
  onHighlight2: '#3D4A2A',
  success: '#0A7553',
  successTint: '#D2EEDF',
  warning: '#9A6400', // 4.9 surface
  warningTint: '#FFF2CC',
  danger: '#C4343D', // 4.6 bg · 5.2 surface
  dangerTint: '#FBE3E4',
  onDanger: '#FFFFFF',
  focus: '#0A7553',
  scrim: 'rgba(10,50,35,0.30)',
  fade: '#EAF5EF',
};

export const darkColors: ColorTokens = {
  bg: '#0F2C33',
  bgGradient: ['#14363E', '#0F2C33', '#0D272D'],
  surface: '#18414A',
  surfaceRaised: '#1F4C56',
  surfaceSunken: '#0A2328',
  ink: '#EEF6F4', // 13.4 bg · 10.1 surface
  ink2: '#A7C2BF', // 7.8 bg · 5.9 surface · 5.0 raised
  ink3: '#93B4B2', // 5.0 surface
  separator: '#24515A',
  iconSecondary: '#7FA3A3',
  brand: '#4CCB9D', // 7.2 bg · 5.5 surface
  brandPressed: '#7ADDB8',
  brandTint: '#1C4D44',
  onBrand: '#06261C', // 7.9
  highlight: '#FFB547',
  highlightTint: '#4A3C22',
  onHighlight: '#12262B', // 8.9
  onHighlight2: '#3A3420',
  success: '#4CCB9D',
  successTint: '#1C4D44',
  warning: '#FFB547',
  warningTint: '#4A3C22',
  danger: '#FF8C86', // ≥5 surface
  dangerTint: '#4A2A2E',
  onDanger: '#2A0D0F',
  focus: '#7ADDB8',
  scrim: 'rgba(0,0,0,0.45)',
  fade: '#0D272D',
};

/** Sticky-note fills. Keys unchanged (stored with notes). No mint «green» on mint bg → lime. */
export type NoteColorKey = 'yellow' | 'pink' | 'green' | 'blue' | 'peach' | 'white';
export const NOTE_COLOR_KEYS: readonly NoteColorKey[] = ['yellow', 'pink', 'green', 'blue', 'peach', 'white'];
export const lightNoteColors: Record<NoteColorKey, string> = {
  yellow: '#FFF1C7', pink: '#FCE4E6', green: '#E4F0C8', blue: '#DDEBFA', peach: '#FFE6D8', white: '#F9FDFA',
};
export const darkNoteColors: Record<NoteColorKey, string> = {
  yellow: '#4A3C22', pink: '#4A2E33', green: '#3A4424', blue: '#263F5A', peach: '#4A3523', white: '#18414A',
};

/** «Расходы» categories: solid = dot/bar/icon, tint = solid at 12% (light) / 22% (dark) behind the icon. */
export type CategoryKey = 'food' | 'transport' | 'home' | 'cafe' | 'health' | 'kids' | 'bills' | 'other';
export const categoryColors: Record<'light' | 'dark', Record<CategoryKey, string>> = {
  light: { food: '#2E9F6A', transport: '#3E7BEA', home: '#D98A0B', cafe: '#E36A5A', health: '#D9467A', kids: '#00A3B4', bills: '#56708F', other: '#8A9A93' },
  dark: { food: '#5CC98F', transport: '#78A6FF', home: '#FFC061', cafe: '#FF9585', health: '#FF85AE', kids: '#4FD3E0', bills: '#93A9C6', other: '#A9BAB3' },
};
export const categoryTintAlpha = { light: 0.12, dark: 0.22 } as const;

/** Page label colours — only the small page icon / chip, never titles or backgrounds. */
export type PageKey = 'today' | 'notes' | 'tasks' | 'shopping' | 'expenses' | 'documents';
export const pageColors: Record<'light' | 'dark', Record<PageKey, string>> = {
  light: { today: '#FFC845', notes: '#E9A800', tasks: '#0A7553', shopping: '#3E7BEA', expenses: '#D9822B', documents: '#56708F' },
  dark: { today: '#FFB547', notes: '#FFC845', tasks: '#4CCB9D', shopping: '#78A6FF', expenses: '#FFA65C', documents: '#93A9C6' },
};

/* ---------------- typography ---------------- */

/** Onest (already in the app via @expo-google-fonts/onest). Kazakh ӘҒҚҢӨҰҮҺІ ә…і present (cmap checked). */
export const fontFamily = {
  regular: 'Onest_400Regular',
  medium: 'Onest_500Medium',
  semibold: 'Onest_600SemiBold',
  bold: 'Onest_700Bold',
} as const;

export type TypeToken =
  | 'largeTitle' | 'title1' | 'title2' | 'headline' | 'body' | 'bodyStrong' | 'callout'
  | 'sectionLabel' | 'footnote' | 'caption' | 'tabLabel' | 'button' | 'number' | 'amount' | 'time';

/** Sizes are iOS pt. On Android use body/bodyStrong/button = 16/24 (Material bodyLarge); others unchanged. */
type T = { fontFamily: string; fontSize: number; lineHeight: number; letterSpacing?: number; fontVariant?: ['tabular-nums'] };
export const type: Record<TypeToken, T> = {
  largeTitle: { fontFamily: fontFamily.bold, fontSize: 30, lineHeight: 36, letterSpacing: -0.6 }, // screen title
  title1: { fontFamily: fontFamily.bold, fontSize: 24, lineHeight: 30, letterSpacing: -0.4 }, // welcome, sheet hero
  title2: { fontFamily: fontFamily.semibold, fontSize: 20, lineHeight: 26, letterSpacing: -0.2 }, // card hero text
  headline: { fontFamily: fontFamily.semibold, fontSize: 17, lineHeight: 22 }, // sheet title, note title
  body: { fontFamily: fontFamily.regular, fontSize: 17, lineHeight: 24 },
  bodyStrong: { fontFamily: fontFamily.semibold, fontSize: 17, lineHeight: 24 },
  callout: { fontFamily: fontFamily.regular, fontSize: 15, lineHeight: 20 }, // row meta, note body
  sectionLabel: { fontFamily: fontFamily.semibold, fontSize: 15, lineHeight: 20 }, // NO uppercase
  footnote: { fontFamily: fontFamily.regular, fontSize: 13, lineHeight: 18 }, // dates, privacy line
  caption: { fontFamily: fontFamily.medium, fontSize: 12, lineHeight: 16 },
  tabLabel: { fontFamily: fontFamily.medium, fontSize: 11, lineHeight: 13 },
  button: { fontFamily: fontFamily.semibold, fontSize: 17, lineHeight: 22 }, // = body, never larger
  number: { fontFamily: fontFamily.semibold, fontSize: 17, lineHeight: 24, fontVariant: ['tabular-nums'] },
  amount: { fontFamily: fontFamily.bold, fontSize: 40, lineHeight: 46, letterSpacing: -1.2, fontVariant: ['tabular-nums'] },
  time: { fontFamily: fontFamily.bold, fontSize: 36, lineHeight: 40, letterSpacing: -1, fontVariant: ['tabular-nums'] }, // «Дальше 14:30»
};
/** System font scale is honoured up to 2.0; layouts switch to large-font mode at 1.5 (keep current constants). */
export const MAX_FONT_SCALE = 2.0;
export const LARGE_FONT_SCALE = 1.5;
/** Hero numbers (amount, time) scale at most ×1.4 so they never push content off screen. */
export const HERO_MAX_SCALE = 1.4;

/* ---------------- layout ---------------- */

export const space = { 0: 0, 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40 } as const;

export const size = {
  screenPadding: 16, // width < 600
  screenPaddingWide: 20, // width ≥ 600
  maxContentWidth: 600,
  minTouch: 48, // hit area (hitSlop), Android 48 / iOS 44
  buttonHeight: 50, // primary / secondary
  buttonHeightSmall: 36, // chips-as-buttons, «Готово» on cards
  rowHeight: 52, // one-line list row
  rowHeightMeta: 64, // row with meta line
  assistantCapsule: 52,
  assistantMic: 40, // visible circle; hit 48
  assistantPlus: 36,
  tabBar: 60, // floating capsule
  tabBarInset: 12, // left/right/bottom gap of the floating tab bar (+ safe area)
  tabPill: { width: 56, height: 30 },
  checkbox: 24, // circle; hit 48
  iconSm: 20,
  icon: 24,
  iconLg: 28,
  headerButton: 36,
  segmentedHeight: 36,
  sheetHandle: { width: 36, height: 4 },
} as const;

export const radius = {
  xs: 6, // tiny badges
  sm: 10, // inputs, segmented thumb
  md: 14, // sticky note, small cards, rectangular buttons
  lg: 16, // cards, list groups
  xl: 20, // «Дальше» card, toast
  sheet: 24,
  round: 9999, // capsules, pills, mic
} as const;

/** Light: soft green-tinted shadows. Dark: no card shadows — depth = surface → surfaceRaised. */
export const elevation = {
  light: {
    card: { shadowColor: '#0A462D', shadowOffset: { width: 0, height: 2 }, shadowRadius: 8, shadowOpacity: 0.06, elevation: 1 },
    floating: { shadowColor: '#0A462D', shadowOffset: { width: 0, height: 8 }, shadowRadius: 24, shadowOpacity: 0.16, elevation: 8 },
  },
  dark: {
    card: null,
    floating: { shadowColor: '#000000', shadowOffset: { width: 0, height: 8 }, shadowRadius: 24, shadowOpacity: 0.35, elevation: 8 },
  },
} as const;

/** Lucide (lucide-react-native, already installed): stroke 1.75, round caps; sizes 20/24/28 only. */
export const icon = { set: 'lucide', strokeWidth: 1.75, sizes: [20, 24, 28] } as const;

export type Easing = readonly [number, number, number, number] | 'linear' | 'spring';
export const motion = {
  press: { duration: 100, easing: [0.2, 0, 0, 1] }, // scale 0.97 + tint
  fast: { duration: 150, easing: [0.2, 0, 0, 1] },
  base: { duration: 250, easing: [0.2, 0, 0, 1] },
  exit: { duration: 200, easing: [0.3, 0, 1, 1] },
  sheet: { duration: 350, easing: 'spring' }, // damping 22, stiffness 220
  check: { duration: 600, easing: [0.2, 0, 0, 1] }, // fill + haptic, then row leaves to «Сделано»
  toast: { duration: 250, easing: 'spring' }, // stays 5 s, «Отменить» always
  listen: { duration: 1200, easing: 'linear' }, // mic pulse
} as const;
export const springSheet = { damping: 22, stiffness: 220 } as const;
export const reducedMotionFade = 150;

/** Full-screen alarm keeps its current fixed colours (same in both themes) — unchanged, not part of this redesign. */
export const alarmScreen = { bg: '#B4361E', text: '#FFFFFF' } as const;
