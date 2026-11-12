/**
 * Colour tokens — «Мята» (light) + «Глубина» (dark), decision Ф-46 (`docs/design/system/design-system.md` §2).
 *
 * Roles, same in both themes:
 *   brand      = sea-emerald: everything you press (primary button, mic, active tab, check, links, focus).
 *   highlight  = sun / amber: what matters now («Дальше», the week-1 tip, a pinned note, the «new» dot).
 *   Text on brand is `onBrand`; text on highlight is always dark `onHighlight`. One sun fill per screen.
 *   Red (`danger`) only for «просрочено» and «удалить».
 * Contrast (WCAG 2.1): ink / ink2 ≥ 4.5:1 on bg and surface; ink3 ≥ 4.5:1 on `surface` only (on bg use ink2);
 * brand as text ≥ 4.5:1 on bg / surface; onBrand on brand ≥ 5.5:1. Checked by `__tests__/ui.test.tsx`.
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
  /** Bottom fade behind the floating tab bar / assistant capsule (= bgGradient[2]). */
  fade: string;
};

export const lightColors: ColorTokens = {
  bg: '#E2F2E9',
  bgGradient: ['#CFEBDD', '#E2F2E9', '#EAF5EF'],
  surface: '#F9FDFA',
  surfaceRaised: '#FFFFFF',
  surfaceSunken: '#D3E8DC',
  ink: '#0E2A1F',
  ink2: '#47665A',
  ink3: '#587669',
  separator: '#DAEAE1',
  iconSecondary: '#728E81',
  brand: '#0A7553',
  brandPressed: '#06573D',
  // #CDEBDB in tokens.ts gave brand text 4.48:1; a touch lighter keeps the look at 4.63:1 (AA).
  brandTint: '#D2EEDF',
  onBrand: '#FFFFFF',
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
  scrim: 'rgba(10,50,35,0.30)',
  fade: '#EAF5EF',
};

export const darkColors: ColorTokens = {
  bg: '#0F2C33',
  bgGradient: ['#14363E', '#0F2C33', '#0D272D'],
  surface: '#18414A',
  surfaceRaised: '#1F4C56',
  surfaceSunken: '#0A2328',
  ink: '#EEF6F4',
  ink2: '#A7C2BF',
  ink3: '#93B4B2',
  separator: '#24515A',
  iconSecondary: '#7FA3A3',
  brand: '#4CCB9D',
  brandPressed: '#7ADDB8',
  // #1E5248 in tokens.ts gave brand text 4.39:1; a touch deeper keeps the look at 4.71:1 (AA).
  brandTint: '#1C4D44',
  onBrand: '#06261C',
  highlight: '#FFB547',
  highlightTint: '#4A3C22',
  onHighlight: '#12262B',
  onHighlight2: '#3A3420',
  success: '#4CCB9D',
  successTint: '#1C4D44',
  warning: '#FFB547',
  warningTint: '#4A3C22',
  danger: '#FF8C86',
  dangerTint: '#4A2A2E',
  onDanger: '#2A0D0F',
  focus: '#7ADDB8',
  scrim: 'rgba(0,0,0,0.45)',
  fade: '#0D272D',
};

/** Sticky-note fills. Keys unchanged (stored with notes); values new. No mint «green» on the mint bg → lime. */
export type NoteColorKey = 'yellow' | 'pink' | 'green' | 'blue' | 'peach' | 'white';

/** The order of the colour picker: «Жёлтый» first (the classic sticky note). */
export const NOTE_COLOR_KEYS: readonly NoteColorKey[] = ['yellow', 'pink', 'green', 'blue', 'peach', 'white'];

/** `white` = `surface` (+ card shadow). Ink and ink2 on each are checked by a test (≥4.5:1). */
export const lightNoteColors: Record<NoteColorKey, string> = {
  yellow: '#FFF1C7',
  pink: '#FCE4E6',
  green: '#E4F0C8',
  blue: '#DDEBFA',
  peach: '#FFE6D8',
  white: '#F9FDFA',
};

export const darkNoteColors: Record<NoteColorKey, string> = {
  yellow: '#4A3C22',
  pink: '#4A2E33',
  green: '#3A4424',
  blue: '#263F5A',
  peach: '#4A3523',
  white: '#18414A',
};

/** «Расходы» categories: solid = dot / bar / icon, tint = solid at 12% (light) / 22% (dark) behind the icon. */
export type CategoryKey = 'food' | 'transport' | 'home' | 'cafe' | 'health' | 'kids' | 'bills' | 'other';
export const categoryColors: Record<'light' | 'dark', Record<CategoryKey, string>> = {
  light: { food: '#2E9F6A', transport: '#3E7BEA', home: '#D98A0B', cafe: '#E36A5A', health: '#D9467A', kids: '#00A3B4', bills: '#56708F', other: '#8A9A93' },
  dark: { food: '#5CC98F', transport: '#78A6FF', home: '#FFC061', cafe: '#FF9585', health: '#FF85AE', kids: '#4FD3E0', bills: '#93A9C6', other: '#A9BAB3' },
};
export const categoryTintAlpha = { light: 0.12, dark: 0.22 } as const;

/** Page label colours — only the small page icon / chip, never titles or backgrounds. */
export type PageColorKey = 'today' | 'notes' | 'tasks' | 'shopping' | 'expenses' | 'documents';
export const pageColors: Record<'light' | 'dark', Record<PageColorKey, string>> = {
  light: { today: '#FFC845', notes: '#E9A800', tasks: '#0A7553', shopping: '#3E7BEA', expenses: '#D9822B', documents: '#56708F' },
  dark: { today: '#FFB547', notes: '#FFC845', tasks: '#4CCB9D', shopping: '#78A6FF', expenses: '#FFA65C', documents: '#93A9C6' },
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
