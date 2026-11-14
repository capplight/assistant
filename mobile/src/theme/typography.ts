import { Platform, type TextStyle } from 'react-native';

/**
 * Typography «Мята / Глубина» (`docs/design/system/design-system.md` §2, Ф-45: platform sizes).
 * Onest via @expo-google-fonts/onest (loaded in `app/_layout.tsx`); Kazakh ӘҒҚҢӨҰҮҺІ / әғқңөұүһі are in
 * the font's cmap. Line heights leave room for the tails of қ ң ғ ұ. No uppercase labels anywhere.
 *
 * TODO(release-blocker): manual Kazakh glyph check for every weight on iOS + Android (Xiaomi, Samsung)
 *   at 100% and 200% with KAZAKH_GLYPH_TEST_LINE below; see src/__tests__/fonts.test.ts for the automated part.
 */
export const KAZAKH_GLYPH_TEST_LINE =
  'Әке, ертең сағат 10:00-де Ғалымға қоңырау шал. Ұлың үйде, һәм іс бітті. 1 240 000 ₸ №17';

export const fontFamily = {
  regular: 'Onest_400Regular',
  medium: 'Onest_500Medium',
  semibold: 'Onest_600SemiBold',
  bold: 'Onest_700Bold',
} as const;

/** System font scale is honoured up to 2.0 (F-22, Ф-45). */
export const MAX_FONT_SCALE = 2.0;
/** At or above this scale layouts switch to «large font» mode (fewer tabs, two-row capsule, 1 column). */
export const LARGE_FONT_SCALE = 1.5;
/** Hero numbers (`amount`, `time`) grow with the system font at most ×1.4. */
export const HERO_MAX_SCALE = 1.4;

export type TypeToken =
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

/** iOS pt; on Android body / bodyStrong / button are 16/24 (Material bodyLarge). */
const android = Platform.OS === 'android';
const bodySize = android ? { fontSize: 16, lineHeight: 24 } : { fontSize: 17, lineHeight: 24 };

export const type: Record<TypeToken, TextStyle> = {
  /** Screen title. */
  largeTitle: { fontFamily: fontFamily.bold, fontSize: 30, lineHeight: 36, letterSpacing: -0.6 },
  /** Welcome, sheet hero. */
  title1: { fontFamily: fontFamily.bold, fontSize: 24, lineHeight: 30, letterSpacing: -0.4 },
  /** «Дальше» text, card hero. */
  title2: { fontFamily: fontFamily.semibold, fontSize: 20, lineHeight: 26, letterSpacing: -0.2 },
  /** Sheet title, sticky-note title. */
  headline: { fontFamily: fontFamily.semibold, fontSize: 17, lineHeight: 22 },
  body: { fontFamily: fontFamily.regular, ...bodySize },
  bodyStrong: { fontFamily: fontFamily.semibold, ...bodySize },
  /** Row meta, note body. */
  callout: { fontFamily: fontFamily.regular, fontSize: 15, lineHeight: 20 },
  /** Block titles «План дня», «Ждёт вас» — never uppercase (v2: 700). */
  sectionLabel: { fontFamily: fontFamily.bold, fontSize: 15, lineHeight: 20 },
  /** v2: tile labels and the brief's status line ONLY (≤3 words), caps. */
  eyebrow: { fontFamily: fontFamily.bold, fontSize: 12, lineHeight: 16, letterSpacing: 0.8, textTransform: 'uppercase' },
  /** Dates, the privacy line. */
  footnote: { fontFamily: fontFamily.regular, fontSize: 13, lineHeight: 18 },
  /** Chips. */
  caption: { fontFamily: fontFamily.medium, fontSize: 12, lineHeight: 16 },
  tabLabel: { fontFamily: fontFamily.medium, fontSize: 11, lineHeight: 13 },
  /** Every button: = body, never larger. */
  button: { fontFamily: fontFamily.semibold, ...(android ? { fontSize: 16, lineHeight: 22 } : { fontSize: 17, lineHeight: 22 }) },
  number: { fontFamily: fontFamily.semibold, fontSize: 17, lineHeight: 24, fontVariant: ['tabular-nums'] },
  /** The «Расходы» total; scales ≤ HERO_MAX_SCALE. */
  amount: { fontFamily: fontFamily.bold, fontSize: 40, lineHeight: 46, letterSpacing: -1.2, fontVariant: ['tabular-nums'] },
  /** «Дальше 14:30»; scales ≤ HERO_MAX_SCALE. */
  time: { fontFamily: fontFamily.bold, fontSize: 36, lineHeight: 40, letterSpacing: -1, fontVariant: ['tabular-nums'] },
  /** «Спокойный день.»; scales ≤ HERO_MAX_SCALE. */
  briefHeadline: { fontFamily: fontFamily.bold, fontSize: 28, lineHeight: 33, letterSpacing: -0.7 },
  /** The day summary: ≤3 lines + «Подробнее». */
  briefBody: { fontFamily: fontFamily.regular, fontSize: 16, lineHeight: 23 },
  /** The number of a tile; scales ≤ HERO_MAX_SCALE. */
  metric: { fontFamily: fontFamily.bold, fontSize: 32, lineHeight: 34, letterSpacing: -1, fontVariant: ['tabular-nums'] },
  metricUnit: { fontFamily: fontFamily.semibold, fontSize: 14, lineHeight: 18 },
  keypadAmount: { fontFamily: fontFamily.bold, fontSize: 52, lineHeight: 58, letterSpacing: -1.6, fontVariant: ['tabular-nums'] },
  keypadKey: { fontFamily: fontFamily.semibold, fontSize: 24, lineHeight: 28 },
  /** The search answer as a value («4512»); scales ≤ HERO_MAX_SCALE. */
  answerValue: { fontFamily: fontFamily.bold, fontSize: 48, lineHeight: 52, letterSpacing: -1.4 },
};

/** Big numbers grow with the system font at most ×1.4 (design-system v2 §3). */
export const HERO_TOKENS: readonly TypeToken[] = ['amount', 'time', 'briefHeadline', 'metric', 'keypadAmount', 'answerValue'];
