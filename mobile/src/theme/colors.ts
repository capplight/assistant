/**
 * Colour tokens v2 — «Мята» (light) + «Глубина» (dark): Ф-46, Ф-55 (`docs/design/system/design-system.md` v2, `tokens.ts`).
 *
 * Roles, same in both themes:
 *   brand      = emerald / mint: everything you press (primary button, mic, centre tab «Расходы», check, links, focus).
 *   highlight  = sun / amber: what matters now (the current item of the day, «Ждёт» badge). One sun fill per screen.
 *   Text on brand is `onBrand`; text on highlight is always dark `onHighlight`.
 *   Red (`danger`) only for «просрочено» and «удалить».
 * Contrast (WCAG 2.1): ink / ink2 ≥ 4.5:1 on bg and surface; ink3 ≥ 4.5:1 on `surface` only (on bg use ink2);
 * brand as text ≥ 4.5:1 on bg / surface; onBrand on brand ≥ 5.5:1. Checked by `__tests__/ui.test.tsx`.
 * Dark `surface` is glass (80 %): contrast is checked on it composited over `bg`.
 */
export type ColorTokens = {
  /** Screen background (solid fallback) + its vertical gradient (top → bottom). */
  bg: string;
  bgGradient: readonly [string, string];
  /** v2: the radial glow over the top ~40 % of the screen (alpha included). */
  bgGlow: string;
  /** Cards, list groups, tiles. Dark: glass (semi-transparent) + `glassBorder`. */
  surface: string;
  /** `surface` without translucency (the assistant capsule, sheets, low-end Android). */
  surfaceSolid: string;
  /** Sheets, menus, toasts, confirmation cards — one step above surface. */
  surfaceRaised: string;
  /** Inputs, segmented-control track, «+» circle, key caps. Brand text is not placed on it. */
  surfaceSunken: string;
  /** 1 px hairline on dark glass cards; null in light (the light ring lives in `elevation.ring`). */
  glassBorder: string | null;
  /** Text 1 — titles, body. */
  ink: string;
  /** Text 2 — secondary, meta on bg. */
  ink2: string;
  /** Text 3 — dates / disabled, ONLY on `surface`. */
  ink3: string;
  /** Inset row dividers (0.5–1 px). Cards have no borders. */
  separator: string;
  /** ⋯, chevrons, inactive tab icons, checkbox outlines (≥3:1, non-text). */
  iconSecondary: string;
  brand: string;
  brandPressed: string;
  /** Selected pill, tonal chips and buttons, icon squares in «Ещё». */
  brandTint: string;
  onBrand: string;
  /** Coloured shadow: the centre tab, the mic, the voice edge, the status dot only. */
  brandGlow: string;
  highlight: string;
  highlightTint: string;
  onHighlight: string;
  /** Secondary text on highlight. */
  onHighlight2: string;
  success: string;
  successTint: string;
  /** As text. */
  warning: string;
  warningTint: string;
  /** Overdue, delete — text and fills. */
  danger: string;
  dangerTint: string;
  onDanger: string;
  focus: string;
  /** Sheet scrim. */
  scrim: string;
  /** Bottom fade behind the floating tab bar / assistant capsule (= bgGradient[1]). */
  fade: string;
  /** The floating tab capsule and its active pill (p14). */
  tabBar: string;
  tabPill: string;
  /** Progress-bar track. */
  track: string;
  /** The A4 document preview (always light). */
  paper: string;
  /** «‹ Назад» and links placed right on the page background. */
  linkOnBg: string;
};

/** «Глубина» is built on one tonal scale (design-system v2 §1 п. 4). */
export const deepScale = {
  0: '#051F20',
  1: '#0B2B26',
  2: '#163832',
  3: '#235347',
  4: '#3E6B5A',
  5: '#8EB69B',
  6: '#DAF1DE',
} as const;

/** v2.1: deeper mint page, pure white cards with a green ring and two green shadows. */
export const lightColors: ColorTokens = {
  bg: '#D3ECDE',
  bgGradient: ['#D3ECDE', '#DEEFE5'],
  bgGlow: 'rgba(196,232,211,1)',
  surface: '#FFFFFF',
  surfaceSolid: '#FFFFFF',
  surfaceRaised: '#FFFFFF',
  surfaceSunken: '#C5E1D1',
  glassBorder: null,
  ink: '#0E2A1F',
  ink2: '#47665A',
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
  fade: '#DEEFE5',
  tabBar: 'rgba(255,255,255,0.97)',
  tabPill: '#D2EEDF',
  track: '#E1EEE6',
  paper: '#FFFFFF',
  linkOnBg: '#06573D',
};

export const darkColors: ColorTokens = {
  bg: deepScale[0],
  bgGradient: [deepScale[1], deepScale[0]],
  bgGlow: 'rgba(52,180,120,0.34)',
  surface: 'rgba(22,56,50,0.80)',
  surfaceSolid: deepScale[2],
  surfaceRaised: '#1D4239',
  surfaceSunken: deepScale[1],
  glassBorder: 'rgba(218,241,222,0.09)',
  ink: deepScale[6],
  ink2: '#A9CDB4',
  ink3: deepScale[5],
  separator: 'rgba(218,241,222,0.10)',
  iconSecondary: '#6F9A80',
  brand: '#5FD6A8',
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

/** Metric tiles (p14): the big coloured number of each tile, same meaning in both themes (≥4.5:1 on surface). */
export type MetricKey = 'tasks' | 'spent' | 'reminders' | 'new';
export const metricColors: Record<'light' | 'dark', Record<MetricKey, string>> = {
  light: { tasks: '#0A7553', spent: '#A65A08', reminders: '#2F6FD6', new: '#8A6200' },
  dark: { tasks: '#5FD6A8', spent: '#FFB547', reminders: '#8DB4FF', new: '#FFD36B' },
};

/** Sticky-note fills: a fixed palette of 7. Keys are stored with notes (`lilac` is new in v2). */
export type NoteColorKey = 'white' | 'yellow' | 'peach' | 'pink' | 'lilac' | 'blue' | 'green';

/** The order of the colour picker (design-system v2 §2). */
export const NOTE_COLOR_KEYS: readonly NoteColorKey[] = ['white', 'yellow', 'peach', 'pink', 'lilac', 'blue', 'green'];

/** Text on every fill is `noteInk` (checked ≥4.5:1 by a test). */
export const lightNoteColors: Record<NoteColorKey, string> = {
  white: '#FFFFFF',
  yellow: '#FFEDB0',
  peach: '#FFDCC7',
  pink: '#FBD5DC',
  lilac: '#E6DDFB',
  blue: '#D4E6FB',
  green: '#DDEFC4',
};

/** Ф-57: one step brighter than v2 (they looked muddy on the A23); `noteInk.dark` stays ≥ 4.5:1 on each. */
export const darkNoteColors: Record<NoteColorKey, string> = {
  white: '#1D4239',
  yellow: '#5A4A22',
  peach: '#5A3C29',
  pink: '#5A3340',
  lilac: '#443C60',
  blue: '#284A68',
  green: '#3D5530',
};

export const noteInk = { light: { ink: '#1F2B24', ink2: '#4A5A50' }, dark: { ink: '#DAF1DE', ink2: '#B9D5C1' } } as const;

/** «Расходы» categories: solid = dot / bar / icon, tint = solid at 12% (light) / 22% (dark) behind the icon. */
export type CategoryKey = 'food' | 'transport' | 'home' | 'cafe' | 'health' | 'kids' | 'bills' | 'other';
export const categoryColors: Record<'light' | 'dark', Record<CategoryKey, string>> = {
  light: { food: '#2E9F6A', transport: '#3E7BEA', home: '#D98A0B', cafe: '#8A63D2', health: '#D9467A', kids: '#00A3B4', bills: '#56708F', other: '#8A9A93' },
  dark: { food: '#5CC98F', transport: '#78A6FF', home: '#FFC061', cafe: '#C3A6FF', health: '#FF85AE', kids: '#4FD3E0', bills: '#93A9C6', other: '#A9BAB3' },
};
export const categoryTintAlpha = { light: 0.15, dark: 0.22 } as const;
/** Darker variants for amounts on a light card (≥4.5:1); the dark theme uses `categoryColors.dark`. */
export const categoryText: Record<CategoryKey, string> = {
  food: '#1E7F52',
  transport: '#2F6FD6',
  home: '#A65A08',
  cafe: '#7650C4',
  health: '#B23462',
  kids: '#00788A',
  bills: '#4A6280',
  other: '#5E6E67',
};

/** Page label colours — only the small page icon / chip, never titles or backgrounds. */
export type PageColorKey = 'today' | 'notes' | 'tasks' | 'shopping' | 'expenses' | 'documents';
export const pageColors: Record<'light' | 'dark', Record<PageColorKey, string>> = {
  light: { today: '#FFC845', notes: '#E9A800', tasks: '#0A7553', shopping: '#3E7BEA', expenses: '#D9822B', documents: '#56708F' },
  dark: { today: '#FFB547', notes: '#FFC845', tasks: '#5FD6A8', shopping: '#78A6FF', expenses: '#FFA65C', documents: '#93A9C6' },
};

/** `#RRGGBB` + alpha → `rgba(…)` (category tints, 96% tab bar). */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** Full-screen Android alarm (S14) keeps its fixed colours in both themes — not part of this redesign. */
export const alarmScreen = { bg: '#B4361E', text: '#FFFFFF' } as const;
