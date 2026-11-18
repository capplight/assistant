/**
 * DRAFT design tokens v5 — «Листы» (light + dark). Ф-79 (replaces «Мята / Глубина» from Ф-46 / tokens.ts).
 * Not wired into the app. Target: mobile/src/theme/{colors,layout,typography}.ts.
 * Mocks: docs/design/system/screens-v5.html. Rules: design-system.md §11 «v5 · Листы».
 *
 * Colour rules (both themes):
 *   place     = the 5 sheet colours belong ONLY to places: today · notes · assistant · expenses · tasks.
 *               «Ещё», search, settings, import, documents, trash → `stone` (neutral). «История» → assistant.
 *               Bottom sheets → `paper` + 6 dp strip in the colour of the place they were opened from.
 *               Documents (КП, счёт, акт) → white A4 (`a4`) in both themes.
 *   assistant = terracotta is the assistant's colour only: its sheet, «изменил помощник», «Отменить», edit highlighter.
 *               Text in terracotta on paper → `assistantText`. No text smaller than 17 semibold ON the terracotta sheet.
 *   action    = ordinary buttons, links, toggles, mic, checkboxes → `btn` / `onBtn` (black in light, light in dark).
 *   danger    = only irreversible actions («Удалить навсегда», «Удалить все данные»).
 *   Category palette never reuses place hues. Stickers (QA-2): multicoloured pastels, never a place hex, never terracotta.
 * Contrast (WCAG 2.1): ink/ink2/ink3 ≥ 4.5:1 on paper AND paper2; onSheet/onSheet2 ≥ 4.5:1 on every place sheet.
 */

export type PlaceKey = 'today' | 'notes' | 'assistant' | 'expenses' | 'tasks' | 'stone';

export type ColorTokens = {
  tray: string; // the dark «table» behind the sheets: status bar, tab bar, peeking stack
  trayInk: string; // status bar, active tab label
  trayInk2: string; // inactive tab labels (≥ 4.5 on tray)
  paper: string; // the details sheet under the coloured sheet
  paper2: string; // inset blocks on paper: banners, progress card, receipt, plan blocks
  line: string; // row separators
  line2: string; // chip outlines, grabber, dashed «free time»
  ink: string;
  ink2: string;
  ink3: string; // smallest grey text; ≥ 4.5 on paper AND paper2
  place: Record<PlaceKey, string>; // coloured sheets + tab capsules
  onSheet: string; // text/icons on today·notes·assistant·expenses·tasks
  onSheet2: string; // secondary text on those sheets (NOT used on assistant: use onSheet, ≥ 17 semibold)
  onStone: string;
  onStone2: string;
  assistantText: string; // terracotta as text on paper («Отменить», «изменил помощник»)
  highlight: string; // highlighter behind text the assistant changed (never yellow)
  btn: string;
  onBtn: string;
  danger: string;
  onDanger: string;
  noticeBg: string; // top notice capsule (inverse of paper)
  noticeInk: string;
  noticeUndo: string; // «Отменить» inside the notice
  scrim: string;
  a4: string; // document page, always white
  a4Ink: string;
  askBg: string; // LEGACY: docked strip of variant A (not chosen, Ф-82). The chosen strip C uses paper + ink border.
  askLine: string; // LEGACY: variant A outline
};

export const lightColors: ColorTokens = {
  tray: '#1A191E',
  trayInk: '#F4F1EA', // 15.5 on tray
  trayInk2: '#B9B4AA', // 8.5 on tray
  paper: '#FBF8F2',
  paper2: '#F1ECE2',
  line: '#E6DFD3',
  line2: '#CFC8BB',
  ink: '#1A191E', // 16.5 on paper
  ink2: '#55525C', // 7.2 on paper · 6.5 on paper2
  ink3: '#6B6774', // 5.2 on paper · 4.7 on paper2 (was #8B8794 in the concept = 3.4, failed)
  place: {
    today: '#F6D35B',
    notes: '#A9CCF4',
    assistant: '#E0592C',
    expenses: '#B6D89C',
    tasks: '#CDBFF5',
    stone: '#D8D2C6',
  },
  onSheet: '#1A191E', // 4.7 on assistant (large text only), ≥ 9 on the rest
  onSheet2: '#3D3A42', // ≥ 6.5 on today/notes/expenses/tasks/stone
  onStone: '#1A191E',
  onStone2: '#3D3A42',
  assistantText: '#B23E14', // 5.5 on paper · 5.0 on paper2
  highlight: '#F7D9CC', // ink on it 13.1
  btn: '#1A191E',
  onBtn: '#FBF8F2',
  danger: '#B42335', // 6.1 on paper; white on it 6.5
  onDanger: '#FFFFFF',
  noticeBg: '#1A191E',
  noticeInk: '#F4F1EA',
  noticeUndo: '#FF8A5C', // 7.5 on noticeBg
  scrim: 'rgba(26,25,30,0.38)',
  a4: '#FFFFFF',
  a4Ink: '#1A191E',
  askBg: '#FBF8F2', // legacy (variant A)
  askLine: 'transparent', // legacy (variant A)
};

/** Dark: yellow and green toned down more than in the concept (#D9AE32 → #C9A23A, #7DB866 → #6FA35C); sheets 6 dp shorter. */
export const darkColors: ColorTokens = {
  tray: '#0F0E12',
  trayInk: '#F1EEE8',
  trayInk2: '#9A95A2', // 6.6 on tray
  paper: '#1E1D23',
  paper2: '#2A2930',
  line: '#34323A',
  line2: '#4A4752',
  ink: '#F1EEE8', // 14.5 on paper
  ink2: '#C2BDC8', // 9.1
  ink3: '#A29DAA', // 6.3 on paper · 5.4 on paper2
  place: {
    today: '#C9A23A',
    notes: '#5E93DC',
    assistant: '#E0592C', // brand colour, same in both themes
    expenses: '#6FA35C',
    tasks: '#9683E6',
    stone: '#42404A', // graphite
  },
  onSheet: '#16151A', // 4.9 on assistant (large only), ≥ 5.8 on the rest
  onSheet2: '#1F1D24', // ≥ 5.3 on every dark sheet
  onStone: '#F1EEE8', // stone is dark here → light text
  onStone2: '#C2BDC8', // 5.5 on stone
  assistantText: '#FF8A5C', // 7.2 on paper
  highlight: '#5A2E20', // ink on it 9.8
  btn: '#F1EEE8',
  onBtn: '#16151A',
  danger: '#FF6B78', // 6.1 on paper
  onDanger: '#16151A', // 6.6 on danger
  noticeBg: '#F1EEE8',
  noticeInk: '#16151A',
  noticeUndo: '#B23E14', // 5.1 on noticeBg
  scrim: 'rgba(0,0,0,0.55)',
  a4: '#FFFFFF',
  a4Ink: '#1A191E',
  askBg: '#2A2930', // legacy (variant A)
  askLine: '#34323A', // legacy (variant A)
};

/** Tab order (Ф-58). Every tab shows icon + word (older users). «Дела» is reached from «Сегодня» and «Ещё». */
export const tabs = {
  order: ['today', 'notes', 'assistant', 'expenses', 'more'] as const,
  label: { today: 'Сегодня', notes: 'Заметки', assistant: 'Помощник', expenses: 'Расходы', more: 'Ещё' },
  place: { today: 'today', notes: 'notes', assistant: 'assistant', expenses: 'expenses', more: 'stone' } as Record<string, PlaceKey>,
  capsule: { width: 46, widthActive: 58, widthSmall: 42, widthSmallActive: 52, height: 30, radius: 15 },
  activeRing: { gap: 2, width: 1.5 }, // ring in trayInk around the active capsule
  labelMaxSize: 13, // tab labels never scale above 13, or «Помощник» stops fitting
} as const;

/** Screens that are not tabs → which sheet colour they use. */
export const screenPlace: Record<string, PlaceKey | 'paper' | 'a4'> = {
  tasks: 'tasks',
  noteDetail: 'notes',
  expenseCategory: 'expenses',
  receipt: 'expenses',
  history: 'assistant',
  more: 'stone',
  search: 'stone',
  settings: 'stone',
  chatgptImport: 'stone', // «Переписки с ChatGPT»
  documents: 'stone',
  trash: 'stone',
  bottomSheet: 'paper', // + strip in the colour of the place it was opened from
  document: 'a4',
};

/** «Расходы» categories: deep muted hues, never a place hue. Used as 12 dp square, bar segment, progress fill — never as a background. */
export type CategoryKey = 'food' | 'transport' | 'home' | 'cafe' | 'health' | 'kids' | 'other';
export const categoryColors: Record<'light' | 'dark', Record<CategoryKey, string>> = {
  light: { food: '#2F7F70', transport: '#4F5D86', home: '#8C6A43', cafe: '#B05A78', health: '#9B3F4C', kids: '#737A35', other: '#8A857B' },
  dark: { food: '#5FB3A3', transport: '#8E9BC8', home: '#C29C70', cafe: '#DB8CA8', health: '#D97A86', kids: '#AEB65E', other: '#A8A397' },
};
export const categoryLabel: Record<CategoryKey, string> = {
  food: 'Продукты', transport: 'Транспорт', home: 'Дом', cafe: 'Кафе', health: 'Здоровье', kids: 'Дети', other: 'Другое',
};

/** Note stickers — multicoloured palette of 8 (founder, QA-2 point 3; replaces the muted 5 of Ф-79).
 * Stickers MAY use the hue families of places, but never their hex: light stickers are pastel and much lighter
 * than the sheets (relative luminance 0.71–0.86 vs 0.57–0.67 for place sheets), dark stickers are deep and darker
 * than the dark sheets. A sticker is a small card r20 on paper, a sheet is full width — they do not compete.
 * New note → next colour in STICKER_KEYS order, skipping the colours of its two neighbours (no two equal colours side by side).
 * Old v2/v5 keys are mapped on read (stored values stay). */
export type StickerKey = 'paper' | 'lemon' | 'apricot' | 'rose' | 'lilac' | 'sky' | 'aqua' | 'mint';
export const STICKER_KEYS: readonly StickerKey[] = ['lemon', 'sky', 'rose', 'mint', 'lilac', 'apricot', 'aqua', 'paper'];
export const stickerColors: Record<'light' | 'dark', Record<StickerKey, string>> = {
  light: { paper: '#FFFFFF', lemon: '#FFEFA6', apricot: '#FFD8B5', rose: '#FFCFD8', lilac: '#E4DAFF', sky: '#CDE5FF', aqua: '#C2EDE6', mint: '#D6F0C2' },
  dark: { paper: '#2A2930', lemon: '#4F4419', apricot: '#673F24', rose: '#6A3040', lilac: '#463B74', sky: '#24476E', aqua: '#1A4F4B', mint: '#2D4E27' },
};
export const stickerInk = {
  light: { ink: '#1A191E', ink2: '#4D4A52' }, // ink ≥ 12.6, ink2 ≥ 6.3 on every sticker
  dark: { ink: '#F1EEE8', ink2: '#C9C4CE' }, // ink ≥ 7.8, ink2 ≥ 5.3 on every sticker; sticker vs paper ≥ 1.7
} as const;
/** v2 NoteColorKey and Ф-79 v5 keys → current StickerKey. */
export const legacyStickerMap: Record<string, StickerKey> = {
  white: 'paper', yellow: 'lemon', peach: 'apricot', pink: 'rose', lilac: 'lilac', blue: 'sky', green: 'mint',
  sand: 'lemon', mist: 'aqua', graphite: 'lilac',
};
/** Notes list mode (QA-2 point 4): full-width stickers with a gap; grid keeps 10 × 10. */
export const stickerLayout = { gridGap: 10, listGap: 10, listPadding: { h: 16, v: 14 }, listMinHeight: 64 } as const;

/* ---------------- typography ----------------
 * Kazakh check (2026-11-17, Google Fonts cmap + headless Chrome render):
 *   Unbounded — missing Ә ә Ғ ғ Қ қ Ң ң Ө ө Ұ ұ Ү ү Һ һ (only І і present) → NOT used.
 *   Manrope   — missing Ә ә Ғ ғ Қ қ Ң ң Ұ ұ → NOT used (the concept's UI font).
 *   Geologica, Onest — all 18 letters present.
 * Display = Geologica 700: ONLY the big phrase (3–4 words + numbers, ≤ 2 lines) on «Сегодня» / «Расходы» and ONE big number per screen.
 * UI = Onest. Numbers everywhere: fontVariant ['tabular-nums']. No uppercase anywhere (Ф-56).
 */
export const fontFamily = {
  display: 'Geologica_700Bold',
  regular: 'Onest_400Regular',
  medium: 'Onest_500Medium',
  semibold: 'Onest_600SemiBold',
  bold: 'Onest_700Bold',
  extrabold: 'Onest_800ExtraBold',
} as const;

type T = { fontFamily: string; fontSize: number; lineHeight: number; letterSpacing?: number; fontVariant?: ['tabular-nums'] };
export const type: Record<string, T> = {
  phrase: { fontFamily: fontFamily.display, fontSize: 27, lineHeight: 30, letterSpacing: -0.7 }, // 23 at ≤ 340 dp, 30 at ≥ 420 dp, 25 in dark
  bigNumber: { fontFamily: fontFamily.display, fontSize: 46, lineHeight: 46, letterSpacing: -1.6, fontVariant: ['tabular-nums'] },
  title: { fontFamily: fontFamily.extrabold, fontSize: 30, lineHeight: 34, letterSpacing: -0.6 }, // screens without a phrase
  stripTitle: { fontFamily: fontFamily.bold, fontSize: 18, lineHeight: 22 }, // collapsed sheet
  sheetMeta: { fontFamily: fontFamily.semibold, fontSize: 15, lineHeight: 18 }, // date / count on the sheet
  section: { fontFamily: fontFamily.bold, fontSize: 17, lineHeight: 20 },
  row: { fontFamily: fontFamily.regular, fontSize: 16, lineHeight: 22 },
  chat: { fontFamily: fontFamily.medium, fontSize: 16.5, lineHeight: 24 },
  noteBody: { fontFamily: fontFamily.regular, fontSize: 17, lineHeight: 27 },
  callout: { fontFamily: fontFamily.regular, fontSize: 15, lineHeight: 21 },
  small: { fontFamily: fontFamily.regular, fontSize: 14, lineHeight: 20 },
  caption: { fontFamily: fontFamily.regular, fontSize: 13, lineHeight: 18 }, // minimum size in the app
  mark: { fontFamily: fontFamily.bold, fontSize: 13, lineHeight: 15 }, // «изменил помощник»
  tabLabel: { fontFamily: fontFamily.semibold, fontSize: 12, lineHeight: 13 }, // active: extrabold; 11.5 at ≤ 340 dp; max 13
  button: { fontFamily: fontFamily.bold, fontSize: 17, lineHeight: 20 },
  buttonSmall: { fontFamily: fontFamily.bold, fontSize: 15, lineHeight: 18 },
  amount: { fontFamily: fontFamily.bold, fontSize: 16, lineHeight: 22, fontVariant: ['tabular-nums'] },
  planTime: { fontFamily: fontFamily.bold, fontSize: 14, lineHeight: 18, fontVariant: ['tabular-nums'] },
};
/** At fontScale ≥ LARGE_FONT_SCALE or window width ≤ SMALL_WIDTH the phrase is hidden, only `title` stays; the day plan becomes rows. */
export const LARGE_FONT_SCALE = 1.3;
export const SMALL_WIDTH = 340;
export const MAX_FONT_SCALE = 2.0;
export const HERO_MAX_SCALE = 1.3; // phrase, bigNumber

/* ---------------- layout ---------------- */
export const space = { 0: 0, 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32 } as const;

export const size = {
  gutter: 20, // 16 at ≤ 340 dp, 24 at ≥ 420 dp
  minTouch: 44,
  statusBar: 46,
  peek: 14, // two strips of other places peeking above the sheet (tabs' root screens only)
  sheetTopRow: 40,
  sheetBottomOverlap: 28, // the paper sheet overlaps the coloured one by this much
  sheetPadBottom: { light: 44, dark: 38 }, // dark sheets are 6 dp shorter
  strip: 44, // collapsed sheet height (content)
  row: 54,
  rowLarge: 68, // fontScale ≥ 1.3
  checkbox: 26,
  button: 52,
  buttonSmall: 42,
  roundButton: 42, // mic, send
  micHero: 84, // voice «Готово», onboarding mic 88
  askCapsule: 56, // chat input on the «Помощник» tab only
  tabBar: 68,
  homeIndicator: 24,
  notice: 54,
  bottomSheetStrip: 6,
  categorySquare: 12,
  placeTab: { width: 16, height: 22 }, // small tab in place colour at the start of list rows
  plan: { timeColumn: 56, dpPerMinute: 1, minBlock: 40 },
} as const;

export const radius = { tag: 4, placeTab: 5, a4: 4, inset: 16, card: 18, sticker: 20, button: 26, buttonSmall: 21, confirm: 26, sheet: 28, phone: 44, round: 9999 } as const;

/** Flat sheets: no card shadows. Depth = overlap + stack. Only floating layers get a shadow. */
export const elevation = {
  notice: { shadowColor: '#000000', shadowOffset: { width: 0, height: 14 }, shadowRadius: 30, shadowOpacity: 0.5, elevation: 12 },
  bottomSheet: { shadowColor: '#000000', shadowOffset: { width: 0, height: -10 }, shadowRadius: 30, shadowOpacity: 0.25, elevation: 16 },
  confirm: { shadowColor: '#000000', shadowOffset: { width: 0, height: 18 }, shadowRadius: 40, shadowOpacity: 0.35, elevation: 16 },
  stackPeekDark: { brightness: 0.62 }, // back sheets darker in the dark theme
} as const;

export const icon = { set: 'lucide', strokeWidth: 1.8, sizes: [15, 18, 22, 26, 30] } as const;

export const motion = {
  press: { duration: 100, easing: [0.2, 0, 0, 1] },
  sheetCollapse: { duration: 200, easing: [0.2, 0, 0, 1] }, // follows the finger, this is the snap
  tabSwitch: { duration: 320, easing: 'spring', damping: 26, stiffness: 260 }, // sheet slides out of the stack
  noticeIn: { duration: 220, easing: 'spring' },
  noticeHold: { duration: 3000 }, // Ф-67, Ф-75: all notices incl. «Удалено · Восстановить»
  noticeOut: { duration: 180, easing: [0.3, 0, 1, 1] },
  bottomSheet: { duration: 320, easing: 'spring', damping: 24, stiffness: 240 },
  confirm: { duration: 220, easing: [0.2, 0, 0, 1] },
  deleteToStack: { duration: 240, easing: [0.3, 0, 1, 1] },
  check: { duration: 300, easing: [0.2, 0, 0, 1] },
  askCollapse: { duration: 260, easing: [0.2, 0, 0, 1] }, // assistant strip → circle (Ф-82; QA-2: 200 → 260, one morphing view)
  askExpand: { duration: 280, easing: [0.2, 0, 0, 1] }, // circle → strip
  dayChange: { duration: 180, easing: [0.2, 0, 0, 1] }, // «Сегодня» week: content cross-fade + 8 dp slide toward the tapped day (QA-2 point 8)
  reducedMotionFade: 150,
} as const;

/** Top notice (Ф-65…Ф-67). «Отменить» = noticeUndo (assistant); «Восстановить» = noticeInk underlined (person's own action). */
export const notice = { position: 'top', top: 50, inset: 10, minHeight: 54, radius: 18, ms: 3000, dots: 3, maxLines: 2 } as const;
export const changedMark = { dot: 9, label: 'изменил помощник', ttlHours: 24, stickerFold: 24, highlighter: 'highlight', strike: 'ink3' } as const;
export const confirm = { inset: 10, radius: 26, onlyFor: ['deleteForever', 'sendToClient', 'deleteAllData'] } as const;
export const chat = {
  userBubble: { bg: 'btn', text: 'onBtn', radius: [20, 20, 6, 20], maxWidth: '82%' },
  assistantText: { type: 'chat', color: 'ink' }, // no bubble
  resultCard: { radius: 18, bg: 'place of the result', text: 'onSheet' }, // «Дела · завтра, 10:00 — Позвонить в ЦОН»
  inputPlaceholder: 'Спросите или запишите…',
  emptyLine: 'Скажите или перешлите — я разложу по местам и найду, когда понадобится.',
} as const;

/* ---------------- assistant on other tabs (Ф-81, Ф-82: variant C «Строка, которая сворачивается») ----------------
 * Same assistant and same conversation as the «Помощник» tab. Mocks: screens-v5.html (main screens, «Размеры»).
 * Rules: design-system.md §11.12. Components: AskBar (strip), AskBubble (circle), QuickAnswerCard, TopNotice position 'aboveAskBar'.
 * Shown on: today, notes, expenses, tasks, more (Ф-82: kept on «Ещё» for now) + inside places: note, category, receipt.
 * Not shown on: assistant tab (own input), settings, search, history, chatgptImport, document (A4), onboarding, bottom sheets, confirms.
 * Offline: shown; the phrase is saved as a note and parsed later (Ф-69).
 * Colour: 9 dp dot = place.assistant (the assistant's mark); strip/circle = paper + 1.5 ink border; mic / send = btn.
 * All sizes in dp; `bottom` is measured from the bottom edge of the screen (tabBar 68 + homeIndicator 24 + 10 = 102).
 */
export const assistantEntry = {
  variant: 'C',
  placeholder: {
    today: 'Скажите или напишите…',
    notes: 'Сохранить в Заметки…',
    expenses: 'Записать трату…',
    tasks: 'Добавить дело…',
    more: 'Скажите или напишите…',
    noteDetail: 'Попросите поменять заметку…',
    expenseCategory: 'Записать в {category}…', // «Записать в Транспорт…»
    receipt: 'Спросите про этот чек…',
  },
  dot: 9,
  // expanded state: strip lying over the paper sheet, above the tab bar
  bar: {
    height: 48, heightLarge: 56, radius: 24, radiusLarge: 28,
    aboveTabBar: 10, bottom: 102, // 68 + 24 + 10
    inset: { default: 12, small: 8, large: 16 }, // left = right; window ≤ 340 → small, ≥ 420 → large
    padding: { left: 16, right: 6 }, gap: 10, smallPaddingLeft: 14, smallGap: 8,
    bg: 'paper',
    border: { width: 1.5, color: 'ink' },
    elevation: { shadowColor: '#000000', shadowOffset: { width: 0, height: 10 }, shadowRadius: 22, shadowOpacity: 0.2, elevation: 6 },
    text: { fontFamily: fontFamily.medium, fontSize: 16, small: 15, large: 19, maxSize: 20, color: 'ink3' }, // 5.2:1 light, 6.3:1 dark; one line, ellipsis
    mic: 36, micLarge: 44, micColor: 'btn', // becomes «send» (arrow up) when there is text
    bottomFade: 34, // paper gradient (transparent → paper at 70 %) at the bottom of the paper sheet: no text in the 10 dp gap
  },
  // collapsed state: circle at the right end of the strip
  bubble: {
    size: 48, sizeLarge: 56, align: 'right', // same right inset and same bottom as the bar
    bg: 'paper',
    border: { width: 1.5, color: 'ink' },
    icon: 22, iconColor: 'ink', // lucide message-square, as on the «Помощник» tab
    dot: { size: 9, color: 'place.assistant', corner: 'topRight', offset: 3, ring: { width: 2, color: 'paper' } },
  },
  scroll: {
    collapseAfterDownDp: 24, // continuous downward scroll before collapsing (ignores jitter); not while scrollY ≤ 24
    expandAfterIdleMs: 600, // after the scroll (incl. momentum) stops
    expandOnUpDp: 24, // immediately on upward scroll
    expandNearEndDp: 24, // distance to the end of the list
    expandOnScreenChange: true, // every tab / screen opens with the bar expanded
    neverCollapseWhen: ['contentFits', 'focused', 'hasDraftText', 'voice', 'savedNoticeVisible', 'answerCardVisible', 'screenReaderEnabled'],
    followsFinger: false, // event-driven, not scroll-linked
  },
  suggestions: false, // QA-2 point 2: NO suggestion chips above the bar («Новая заметка», «Что на завтра?») in any state
  motion: {
    // QA-2 point 1: ONE view morphs (width + radius), no second circle underneath; shadow lives on that view only and
    // is off (elevation 0) during the morph, back on at the end. Bar and bubble are never rendered at the same time.
    collapse: { duration: 260, easing: [0.2, 0, 0, 1], width: 'full → bubble, anchored right', textOutMs: [0, 90], iconInMs: [150, 260], shadowOffDuringMorph: true },
    expand: { duration: 280, easing: [0.2, 0, 0, 1], iconOutMs: [0, 90], textInMs: [150, 280], shadowOffDuringMorph: true },
    reducedMotion: { crossFade: 150, easing: 'linear' }, // no width morph: strip and circle cross-fade
  },
  listBottomPadding: 70, // 48 + 10 + 12, from the top of the tab bar
  listBottomPaddingLarge: 78, // 56 + 10 + 12
  keyboard: {
    aboveKeyboard: 8, // tap on bar or bubble → focus + keyboard; bar rides 8 dp above the keyboard with the keyboard animation
    tabsUnderKeyboard: true,
    collapseSheet: true,
    destination: { height: 28, gap: 6, radius: 14, bg: 'paper2', color: 'ink2', text: 'Ляжет в {place} · {category}' }, // code parser (Ф-78)
    onHide: 'back above the tab bar, expanded; draft text is kept',
  },
  voice: { minHeight: 64, cancel: 36, done: 36 },
  savedNotice: { place: 'above the bar', gap: 8, bottom: 158, bottomLarge: 166, inset: 'same as bar', ms: 3000, text: 'Записал в {place}', action: 'Отменить' }, // bar stays expanded while shown
  answerCard: { gap: 8, radius: 20, maxLines: 3, bg: 'paper', elevation: 'notice', action: 'Продолжить в чате', dismiss: ['x', 'swipeDown', 'tapOutside'] },
  newItemRing: { color: 'place.assistant', width: 2, ms: 1500 },
  a11y: {
    barLabel: 'Строка помощника', // TextInput; the placeholder is read as the hint
    micLabel: 'Сказать голосом',
    sendLabel: 'Записать',
    bubbleRole: 'button',
    bubbleLabel: 'Помощник. {placeholder without «…»}', // «Помощник. Записать трату»
    bubbleHint: 'Открывает строку, чтобы записать или спросить',
    minTouch: 48,
  },
} as const;

/** NOT CHOSEN (Ф-82). Variants A and B — only for the history mocks in screens-v5.html → «Чат на других экранах — варианты». Do not implement. */
export const assistantEntryLegacy = {
  A: { height: 48, heightLarge: 56, radius: 24, gapAbove: 8, inset: { default: 12, small: 8, large: 16 }, bg: 'askBg', border: 'askLine', scroll: 'fixed', listBottomPadding: 16 },
  B: { button: 56, color: 'place.assistant', aboveTabBar: 14, hideOnScrollDown: true, showAfterStopMs: 400, listBottomPadding: 84, panel: { heightPct: 56, maxPct: 90 } },
} as const;

/* ---------------- «Сегодня» · day in place (QA-2 point 8). Mock: today-day-view.html ----------------
 * Tapping a day in the week NEVER navigates to «Дела». The yellow sheet stays, the content below shows that day.
 */
export const dayView = {
  week: {
    cell: { width: 'equal 1/7', height: 64, radius: 18 },
    selected: { bg: 'onSheet', ink: 'place.today' }, // the chosen day = dark pill (as today's pill now)
    today: { ring: 1.5, color: 'onSheet' }, // today when another day is selected: outline pill, word «сегодня» not needed
    dot: { size: 5, gap: 4, color: 'onSheet' }, // under the number: the day has something (task, event, reminder)
    swipe: 'horizontal swipe on the week = previous / next week',
  },
  phrase: {
    past: '{weekday}, {d month}. Было {n} дел, сделано {m}.',
    future: '{Weekday}. {n} дела, {k} встреча.', // ≤ 2 lines, plural forms via i18n
    empty: '{Weekday} свободен.', // «Пятница свободна.» — gender by weekday
  },
  backToToday: { label: 'К сегодня', height: 36, radius: 18, bg: 'paper', ink: 'ink', place: 'sheet meta row, right, instead of the search icon' },
  empty: {
    illustration: { size: 112, kind: 'blank sticker card with a folded corner + a small sun or moon (by weekday), lucide-style line 1.8, ink on paper2' },
    title: 'На {день} пока ничего', // «На пятницу пока ничего»
    text: 'Скажите «в пятницу в 10 — стоматолог», и я поставлю сюда.',
    actions: [{ label: 'Добавить на {день}', kind: 'primary btn', height: 52 }],
    pastTitle: 'В этот день записей нет',
    pastText: 'Здесь будет всё, что вы сделали и записали в этот день.',
  },
  motion: 'motion.dayChange',
} as const;
