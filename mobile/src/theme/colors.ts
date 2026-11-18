/**
 * Colour tokens v5 — «Листы» (Ф-79, `docs/design/system/tokens-v5.ts`, design-system.md §11).
 *
 * The screen is a stack of sheets on a dark «tray»: a coloured sheet of the PLACE on top, a light `paper` sheet with
 * the details under it (dark in the dark theme).
 *   place     = the 5 sheet colours belong ONLY to places: today · notes · assistant · expenses · tasks.
 *               «Ещё», search, settings, import, documents, trash → `stone` (graphite in dark). «История» → assistant.
 *   assistant = terracotta is the assistant's colour only (its sheet, «изменил помощник», «Отменить», the marker).
 *   action    = buttons, links, toggles, the mic, checks → `btn` / `onBtn` (black in light, light in dark).
 *   danger    = only irreversible actions («Удалить навсегда», «Удалить все данные»).
 * Contrast (WCAG 2.1): ink / ink2 / ink3 ≥ 4.5:1 on paper AND paper2; onSheet / onSheet2 ≥ 4.5:1 on every sheet
 * (onSheet on terracotta is large text only). Checked by `__tests__/ui.test.tsx` and `__tests__/v5.test.tsx`.
 *
 * Legacy names (v2 «Мята / Глубина»: bg, surface, brand, …) stay as aliases of the v5 roles, so every screen speaks
 * the new palette; new code uses the v5 names.
 */
export type PlaceKey = 'today' | 'notes' | 'assistant' | 'expenses' | 'tasks' | 'stone';
export const PLACE_KEYS: readonly PlaceKey[] = ['today', 'notes', 'assistant', 'expenses', 'tasks', 'stone'];

type V5Tokens = {
  /** The dark «table» behind the sheets: status bar, tab bar, peeking stack. */
  tray: string;
  trayInk: string;
  /** Inactive tab labels (≥ 4.5 on tray). */
  trayInk2: string;
  /** The details sheet under the coloured sheet. */
  paper: string;
  /** Inset blocks on paper: banners, progress card, receipt, plan blocks. */
  paper2: string;
  /** Row separators. */
  line: string;
  /** Chip outlines, the grabber, the dashed «free time». */
  line2: string;
  ink: string;
  ink2: string;
  /** Smallest grey text; ≥ 4.5 on paper AND paper2. */
  ink3: string;
  place: Record<PlaceKey, string>;
  /** Text / icons on today · notes · assistant · expenses · tasks. */
  onSheet: string;
  /** Secondary text on those sheets (not on assistant: there use onSheet ≥ 17 semibold). */
  onSheet2: string;
  onStone: string;
  onStone2: string;
  /** Terracotta as text on paper («Отменить», «изменил помощник»). */
  assistantText: string;
  /** The highlighter behind text the assistant changed (tokens-v5 `highlight`; never yellow). */
  marker: string;
  btn: string;
  onBtn: string;
  danger: string;
  onDanger: string;
  /** The top notice capsule (inverse of paper). */
  noticeBg: string;
  noticeInk: string;
  /** «Отменить» inside the notice (the assistant's action). */
  noticeUndo: string;
  scrim: string;
  /** A document page: always white. */
  a4: string;
  a4Ink: string;
};

/** v2 names kept as aliases of v5 roles (see the mapping in `withLegacy`). */
type LegacyTokens = {
  bg: string;
  bgGradient: readonly [string, string];
  bgGlow: string;
  surface: string;
  surfaceSolid: string;
  surfaceRaised: string;
  surfaceSunken: string;
  glassBorder: string | null;
  separator: string;
  iconSecondary: string;
  brand: string;
  brandPressed: string;
  brandTint: string;
  onBrand: string;
  brandGlow: string;
  /** v2 «sun»: now the «Сегодня» sheet colour. */
  highlight: string;
  highlightTint: string;
  onHighlight: string;
  onHighlight2: string;
  success: string;
  successTint: string;
  warning: string;
  warningTint: string;
  dangerTint: string;
  focus: string;
  fade: string;
  tabBar: string;
  tabPill: string;
  track: string;
  linkOnBg: string;
};

export type ColorTokens = V5Tokens & LegacyTokens;

const lightV5: V5Tokens = {
  tray: '#1A191E',
  trayInk: '#F4F1EA',
  trayInk2: '#B9B4AA',
  paper: '#FBF8F2',
  paper2: '#F1ECE2',
  line: '#E6DFD3',
  line2: '#CFC8BB',
  ink: '#1A191E',
  ink2: '#55525C',
  ink3: '#6B6774',
  place: {
    today: '#F6D35B',
    notes: '#A9CCF4',
    assistant: '#E0592C',
    expenses: '#B6D89C',
    tasks: '#CDBFF5',
    stone: '#D8D2C6',
  },
  onSheet: '#1A191E',
  onSheet2: '#3D3A42',
  onStone: '#1A191E',
  onStone2: '#3D3A42',
  assistantText: '#B23E14',
  marker: '#F7D9CC',
  btn: '#1A191E',
  onBtn: '#FBF8F2',
  danger: '#B42335',
  onDanger: '#FFFFFF',
  noticeBg: '#1A191E',
  noticeInk: '#F4F1EA',
  noticeUndo: '#FF8A5C',
  scrim: 'rgba(26,25,30,0.38)',
  a4: '#FFFFFF',
  a4Ink: '#1A191E',
};

const darkV5: V5Tokens = {
  tray: '#0F0E12',
  trayInk: '#F1EEE8',
  trayInk2: '#9A95A2',
  // Ф-84 / QA v5-device-1 A8 (approved): the paper one step lighter, so its edge and rounded corners show over the
  // tray on a phone (#1E1D23 merged with #0F0E12); ink3 5.8 on paper · 5.0 on paper2, assistantText 6.5.
  paper: '#26252B',
  paper2: '#312F37',
  line: '#3B3942',
  line2: '#504D58',
  ink: '#F1EEE8',
  ink2: '#C2BDC8',
  ink3: '#A29DAA',
  place: {
    today: '#C9A23A',
    notes: '#5E93DC',
    assistant: '#E0592C',
    expenses: '#6FA35C',
    tasks: '#9683E6',
    stone: '#42404A',
  },
  onSheet: '#16151A',
  onSheet2: '#1F1D24',
  onStone: '#F1EEE8',
  onStone2: '#C2BDC8',
  assistantText: '#FF8A5C',
  marker: '#5A2E20',
  btn: '#F1EEE8',
  onBtn: '#16151A',
  danger: '#FF6B78',
  onDanger: '#16151A',
  noticeBg: '#F1EEE8',
  noticeInk: '#16151A',
  noticeUndo: '#B23E14',
  scrim: 'rgba(0,0,0,0.55)',
  a4: '#FFFFFF',
  a4Ink: '#1A191E',
};

/** v2 roles → v5 roles: flat sheets, no glass, no glow; «brand» buttons are `btn`; tints are `paper2`. */
function withLegacy(c: V5Tokens): ColorTokens {
  return {
    ...c,
    bg: c.paper,
    bgGradient: [c.paper, c.paper],
    bgGlow: 'rgba(0,0,0,0)',
    surface: c.paper2,
    surfaceSolid: c.paper2,
    surfaceRaised: c.paper,
    surfaceSunken: c.paper2,
    glassBorder: null,
    separator: c.line,
    iconSecondary: c.ink3,
    brand: c.btn,
    brandPressed: c.ink2,
    brandTint: c.paper2,
    onBrand: c.onBtn,
    brandGlow: 'rgba(0,0,0,0)',
    highlight: c.place.today,
    highlightTint: c.paper2,
    onHighlight: c.onSheet,
    onHighlight2: c.onSheet2,
    success: c.ink,
    successTint: c.paper2,
    warning: c.ink,
    warningTint: c.paper2,
    dangerTint: c.paper2,
    focus: c.btn,
    fade: c.tray,
    tabBar: c.tray,
    tabPill: 'transparent',
    track: c.line,
    linkOnBg: c.ink,
  };
}

export const lightColors: ColorTokens = withLegacy(lightV5);
export const darkColors: ColorTokens = withLegacy(darkV5);

/** Text on a place sheet: dark on the five places; on stone light in the dark theme. */
export function onPlace(c: ColorTokens, place: PlaceKey): { ink: string; ink2: string } {
  if (place === 'stone') return { ink: c.onStone, ink2: c.onStone2 };
  // Terracotta: no secondary grey (only ≥ 17 semibold in onSheet).
  if (place === 'assistant') return { ink: c.onSheet, ink2: c.onSheet };
  return { ink: c.onSheet, ink2: c.onSheet2 };
}

/** @deprecated v2 metric tiles were removed in v5 (§11.11); kept for old imports, all = ink. */
export type MetricKey = 'tasks' | 'spent' | 'reminders' | 'new';
export const metricColors: Record<'light' | 'dark', Record<MetricKey, string>> = {
  light: { tasks: lightV5.ink, spent: lightV5.ink, reminders: lightV5.ink, new: lightV5.ink },
  dark: { tasks: darkV5.ink, spent: darkV5.ink, reminders: darkV5.ink, new: darkV5.ink },
};

/* ---------------- stickers ---------------- */

/**
 * Ф-85 / QA v5-device-2 A3 (tokens-v5 `stickerColors`): multicoloured stickers, 7 pastels + paper (replaces the muted
 * 5 of Ф-79). Light: much lighter than the place sheets; dark: deep tones, ≥ 1.7 : 1 from the paper.
 * New notes take the next colour of STICKER_KEYS, skipping their two neighbours' colours.
 */
export type StickerKey = 'paper' | 'lemon' | 'apricot' | 'rose' | 'lilac' | 'sky' | 'aqua' | 'mint';
export const STICKER_KEYS: readonly StickerKey[] = [
  'lemon',
  'sky',
  'rose',
  'mint',
  'lilac',
  'apricot',
  'aqua',
  'paper',
];
export const stickerColors: Record<'light' | 'dark', Record<StickerKey, string>> = {
  light: {
    paper: '#FFFFFF',
    lemon: '#FFEFA6',
    apricot: '#FFD8B5',
    rose: '#FFCFD8',
    lilac: '#E4DAFF',
    sky: '#CDE5FF',
    aqua: '#C2EDE6',
    mint: '#D6F0C2',
  },
  dark: {
    paper: '#2A2930',
    lemon: '#4F4419',
    apricot: '#673F24',
    rose: '#6A3040',
    lilac: '#463B74',
    sky: '#24476E',
    aqua: '#1A4F4B',
    mint: '#2D4E27',
  },
};
export const stickerInk = {
  light: { ink: '#1A191E', ink2: '#4D4A52' },
  dark: { ink: '#F1EEE8', ink2: '#C9C4CE' },
} as const;

/**
 * Sticky-note keys stored with notes (v2). They are NOT rewritten: on read `legacyStickerMap` turns them into a v5
 * sticker, so saved data stays as it is.
 */
export type NoteColorKey = 'white' | 'yellow' | 'peach' | 'pink' | 'lilac' | 'blue' | 'green';
/** Every stored key (the data domain). */
export const NOTE_COLOR_KEYS: readonly NoteColorKey[] = ['white', 'yellow', 'peach', 'pink', 'lilac', 'blue', 'green'];
/** v2 NoteColorKey and the Ф-79 v5 keys → the current StickerKey (tokens-v5 `legacyStickerMap`). */
export const legacyStickerMap: Record<string, StickerKey> = {
  white: 'paper',
  yellow: 'lemon',
  peach: 'apricot',
  pink: 'rose',
  lilac: 'lilac',
  blue: 'sky',
  green: 'mint',
  sand: 'lemon',
  mist: 'aqua',
  graphite: 'lilac',
};
/**
 * The colour picker: the stored keys the server knows (views.md `color.note.*`), one per sticker — 7 of the 8
 * (aqua has no stored key yet; it comes only by the automatic round).
 */
export const STICKER_PICKER_KEYS: readonly NoteColorKey[] = [
  'yellow',
  'blue',
  'pink',
  'green',
  'lilac',
  'peach',
  'white',
];
/** A stored key (old or new) → its sticker. Unknown keys are paper. */
export function stickerOf(key: string | null | undefined): StickerKey {
  if (!key) return 'paper';
  if ((STICKER_KEYS as readonly string[]).includes(key)) return key as StickerKey;
  return legacyStickerMap[key] ?? 'paper';
}

/** A colour of a sticker: a stored key or a sticker key. */
export type StickerColor = NoteColorKey | StickerKey;
const noteFills = (scheme: 'light' | 'dark') =>
  Object.fromEntries(
    [...NOTE_COLOR_KEYS, ...STICKER_KEYS].map((k) => [k, stickerColors[scheme][stickerOf(k)]]),
  ) as Record<StickerColor, string>;
/** Stored key (or sticker key) → fill (through `legacyStickerMap`). */
export const lightNoteColors: Record<StickerColor, string> = noteFills('light');
export const darkNoteColors: Record<StickerColor, string> = noteFills('dark');

/**
 * The automatic colours of notes nobody coloured (A3): by creation order the next colour of the round, skipping
 * the colours of the two notes before it on the wall (left and above in two columns), so no two neighbours match.
 * `ordered` is the wall order; `explicit` the stored colour (null = automatic); `createdAt` gives the round.
 */
export function roundStickerColors(
  ordered: { id: string; explicit: string | null; createdAt: number }[],
): Map<string, StickerKey> {
  const autos = ordered
    .filter((x) => !x.explicit)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const rank = new Map(autos.map((x, i) => [x.id, i] as const));
  const out = new Map<string, StickerKey>();
  const shown: StickerKey[] = [];
  ordered.forEach((x, i) => {
    let key: StickerKey;
    if (x.explicit) key = stickerOf(x.explicit);
    else {
      const avoid = new Set([shown[i - 1], shown[i - 2]].filter(Boolean));
      const start = rank.get(x.id) ?? 0;
      key = STICKER_KEYS[start % STICKER_KEYS.length]!;
      for (let k = 0; k < STICKER_KEYS.length && avoid.has(key); k += 1)
        key = STICKER_KEYS[(start + k + 1) % STICKER_KEYS.length]!;
    }
    shown.push(key);
    out.set(x.id, key);
  });
  return out;
}
export const noteInk = stickerInk;

/* ---------------- expense categories ---------------- */

/**
 * «Расходы» categories: deep muted hues, never a place hue. Used as a 12 dp square, a bar segment, a progress fill —
 * never as a background. `bills` (a v2 key) keeps the slate family.
 */
export type CategoryKey = 'food' | 'transport' | 'home' | 'cafe' | 'health' | 'kids' | 'bills' | 'other';
export const categoryColors: Record<'light' | 'dark', Record<CategoryKey, string>> = {
  light: {
    food: '#2F7F70',
    transport: '#4F5D86',
    home: '#8C6A43',
    cafe: '#B05A78',
    health: '#9B3F4C',
    kids: '#737A35',
    bills: '#5B6A78',
    other: '#8A857B',
  },
  dark: {
    food: '#5FB3A3',
    transport: '#8E9BC8',
    home: '#C29C70',
    cafe: '#DB8CA8',
    health: '#D97A86',
    kids: '#AEB65E',
    bills: '#9AA9B8',
    other: '#A8A397',
  },
};
/** v5: category colour is never a background; the tint is only a faint square behind an icon. */
export const categoryTintAlpha = { light: 0.14, dark: 0.22 } as const;
/** Amounts are `ink` in v5; kept for old imports (= the light category colour). */
export const categoryText: Record<CategoryKey, string> = categoryColors.light;

/** Page label colours → the place sheet colour of the page (only the small `PlaceTab` / icon). */
export type PageColorKey = 'today' | 'notes' | 'tasks' | 'shopping' | 'expenses' | 'documents';
export const pageColors: Record<'light' | 'dark', Record<PageColorKey, string>> = {
  light: {
    today: lightV5.place.today,
    notes: lightV5.place.notes,
    tasks: lightV5.place.tasks,
    shopping: lightV5.place.stone,
    expenses: lightV5.place.expenses,
    documents: lightV5.place.stone,
  },
  dark: {
    today: darkV5.place.today,
    notes: darkV5.place.notes,
    tasks: darkV5.place.tasks,
    shopping: darkV5.place.stone,
    expenses: darkV5.place.expenses,
    documents: darkV5.place.stone,
  },
};

/** A page template → the place whose colour it carries. */
export function placeOfTemplate(templateKey: string | null | undefined): PlaceKey {
  switch (templateKey) {
    case 'notes':
      return 'notes';
    case 'expenses':
      return 'expenses';
    case 'tasks':
      return 'tasks';
    case 'today':
      return 'today';
    default:
      return 'stone';
  }
}

/** `#RRGGBB` + alpha → `rgba(…)`. */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** Full-screen Android alarm (S14) keeps its fixed colours in both themes. */
export const alarmScreen = { bg: '#B4361E', text: '#FFFFFF' } as const;
