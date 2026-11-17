import type { TextStyle } from 'react-native';

/**
 * Typography v5 «Листы» (`docs/design/system/tokens-v5.ts`, design-system.md §11.6).
 * Display = Geologica 700: ONLY the big phrase (≤ 2 lines on «Сегодня» / «Расходы») and ONE big number per screen.
 * UI = Onest. Numbers everywhere: tabular. No uppercase anywhere (Ф-56). Smallest text: 13.
 * Both fonts have all 18 Kazakh letters ӘәҒғҚқҢңӨөҰұҮүҺһІі (checked 2026-11-17, `__tests__/fonts.test.ts`).
 * Sizes are the same dp on iOS and Android (the mocks are in dp).
 *
 * TODO(release-blocker): manual Kazakh glyph check for every weight on iOS + Android (Xiaomi, Samsung)
 *   at 100% and 200% with KAZAKH_GLYPH_TEST_LINE below.
 */
export const KAZAKH_GLYPH_TEST_LINE =
  'Әке, ертең сағат 10:00-де Ғалымға қоңырау шал. Ұлың үйде, һәм іс бітті. 1 240 000 ₸ №17';

export const fontFamily = {
  display: 'Geologica_700Bold',
  regular: 'Onest_400Regular',
  medium: 'Onest_500Medium',
  semibold: 'Onest_600SemiBold',
  bold: 'Onest_700Bold',
  extrabold: 'Onest_800ExtraBold',
} as const;

/** System font scale is honoured up to 2.0 (F-22, Ф-45). */
export const MAX_FONT_SCALE = 2.0;
/**
 * At or above this scale the v2 layouts switch to «large font» mode (one column of notes, two-row lists).
 * The v5 sheet has its own, lower step: `TITLE_ONLY_SCALE`.
 */
export const LARGE_FONT_SCALE = 1.5;
/** v5 (tokens-v5 LARGE_FONT_SCALE): from 1.3 the phrase is hidden (title only) and the day plan becomes rows. */
export const TITLE_ONLY_SCALE = 1.3;
/** v5: at or under this window width the phrase is hidden too. */
export const SMALL_WIDTH = 340;
/** The phrase and the big number grow with the system font at most ×1.3. */
export const HERO_MAX_SCALE = 1.3;
/** Tab labels never grow past 13 dp (12 × 1.08), or «Помощник» stops fitting into 1/5 of the width. */
export const TAB_LABEL_MAX = 13;

export type TypeToken =
  // v5
  | 'phrase'
  | 'bigNumber'
  | 'title'
  | 'stripTitle'
  | 'sheetMeta'
  | 'section'
  | 'row'
  | 'chat'
  | 'noteBody'
  | 'small'
  | 'mark'
  | 'buttonSmall'
  | 'planTime'
  // v2 names, restyled to v5
  | 'largeTitle'
  | 'title1'
  | 'title2'
  | 'headline'
  | 'body'
  | 'bodyStrong'
  | 'callout'
  | 'sectionLabel'
  | 'footnote'
  | 'caption'
  | 'tabLabel'
  | 'button'
  | 'number'
  | 'amount'
  | 'time'
  | 'briefHeadline'
  | 'briefBody'
  | 'eyebrow'
  | 'metric'
  | 'metricUnit'
  | 'keypadAmount'
  | 'keypadKey'
  | 'answerValue';

const tnum: TextStyle['fontVariant'] = ['tabular-nums'];

const v5 = {
  phrase: { fontFamily: fontFamily.display, fontSize: 27, lineHeight: 30, letterSpacing: -0.7 },
  bigNumber: { fontFamily: fontFamily.display, fontSize: 46, lineHeight: 50, letterSpacing: -1.6, fontVariant: tnum },
  title: { fontFamily: fontFamily.extrabold, fontSize: 30, lineHeight: 34, letterSpacing: -0.6 },
  stripTitle: { fontFamily: fontFamily.bold, fontSize: 18, lineHeight: 22 },
  sheetMeta: { fontFamily: fontFamily.semibold, fontSize: 15, lineHeight: 18 },
  section: { fontFamily: fontFamily.bold, fontSize: 17, lineHeight: 20 },
  row: { fontFamily: fontFamily.regular, fontSize: 16, lineHeight: 22 },
  chat: { fontFamily: fontFamily.medium, fontSize: 16.5, lineHeight: 24 },
  noteBody: { fontFamily: fontFamily.regular, fontSize: 17, lineHeight: 27 },
  small: { fontFamily: fontFamily.regular, fontSize: 14, lineHeight: 20 },
  mark: { fontFamily: fontFamily.bold, fontSize: 13, lineHeight: 15 },
  buttonSmall: { fontFamily: fontFamily.bold, fontSize: 15, lineHeight: 18 },
  planTime: { fontFamily: fontFamily.bold, fontSize: 14, lineHeight: 18, fontVariant: tnum },
} satisfies Record<string, TextStyle>;

export const type: Record<TypeToken, TextStyle> = {
  ...v5,
  /** Screen title (= v5 `title`). */
  largeTitle: v5.title,
  /** A big line on paper («Скажите или перешлите…», a note title). */
  title1: { fontFamily: fontFamily.extrabold, fontSize: 25, lineHeight: 30, letterSpacing: -0.5 },
  title2: { fontFamily: fontFamily.bold, fontSize: 20, lineHeight: 26, letterSpacing: -0.2 },
  /** Row titles in blocks, sticker titles (h4: 700 16). */
  headline: { fontFamily: fontFamily.bold, fontSize: 16, lineHeight: 20 },
  body: v5.row,
  bodyStrong: { fontFamily: fontFamily.semibold, fontSize: 16, lineHeight: 22 },
  callout: { fontFamily: fontFamily.regular, fontSize: 15, lineHeight: 21 },
  /** Section heads «План дня», «Не забыть» (= v5 `section`; never uppercase). */
  sectionLabel: v5.section,
  /** The date / count line on a sheet (= v5 `sheetMeta`). */
  eyebrow: v5.sheetMeta,
  /** Dates, the privacy line (= v5 `caption`, the minimum). */
  footnote: { fontFamily: fontFamily.regular, fontSize: 13, lineHeight: 18 },
  caption: { fontFamily: fontFamily.medium, fontSize: 13, lineHeight: 18 },
  /** 12 (11.5 at ≤ 340 dp), active 800; capped at 13 by the tab bar. */
  tabLabel: { fontFamily: fontFamily.semibold, fontSize: 12, lineHeight: 13, letterSpacing: -0.1 },
  button: { fontFamily: fontFamily.bold, fontSize: 17, lineHeight: 20 },
  /** Ordinary sums in rows (v5 `amount` 16 bold tabular). */
  number: { fontFamily: fontFamily.bold, fontSize: 16, lineHeight: 22, fontVariant: tnum },
  /** The one big number of «Расходы» (= v5 `bigNumber`). */
  amount: v5.bigNumber,
  time: { fontFamily: fontFamily.display, fontSize: 36, lineHeight: 40, letterSpacing: -1, fontVariant: tnum },
  /** «Спокойный день.» (= v5 `phrase`). */
  briefHeadline: v5.phrase,
  briefBody: { fontFamily: fontFamily.regular, fontSize: 16, lineHeight: 22 },
  metric: { fontFamily: fontFamily.display, fontSize: 32, lineHeight: 36, letterSpacing: -1, fontVariant: tnum },
  metricUnit: { fontFamily: fontFamily.semibold, fontSize: 14, lineHeight: 18 },
  keypadAmount: { fontFamily: fontFamily.display, fontSize: 52, lineHeight: 58, letterSpacing: -1.6, fontVariant: tnum },
  keypadKey: { fontFamily: fontFamily.semibold, fontSize: 24, lineHeight: 28 },
  /** The search answer as a value («4512») = the one big number. */
  answerValue: v5.bigNumber,
};

/** Big numbers and the phrase grow with the system font at most ×1.3. */
export const HERO_TOKENS: readonly TypeToken[] = ['phrase', 'bigNumber', 'amount', 'time', 'briefHeadline', 'metric', 'keypadAmount', 'answerValue'];
