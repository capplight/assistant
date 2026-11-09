import type { TextStyle } from 'react-native';

/**
 * Typography (2-design §2.2). Onest via @expo-google-fonts/onest; fallback Inter → system.
 *
 * TODO(release-blocker): Kazakh glyph check for every weight (Regular, Medium, SemiBold, Bold):
 *   ә Ә ғ Ғ қ Қ ң Ң ө Ө ұ Ұ ү Ү һ Һ і І ₸ № « »
 *   Test line: KAZAKH_GLYPH_TEST_LINE below — on iOS + Android (Xiaomi, Samsung) at 100% and 200%.
 *   Glyph must be in the font itself (not system-substituted), tails of қ ң ғ ұ not clipped at line-height 1.3.
 *   If any check fails — switch to Inter and repeat. See src/__tests__/fonts.test.ts for the automated part.
 */
export const KAZAKH_GLYPH_TEST_LINE =
  'Әке, ертең сағат 10:00-де Ғалымға қоңырау шал. Ұлың үйде, һәм іс бітті. 1 240 000 ₸ №17';

export const fontFamily = {
  regular: 'Onest_400Regular',
  medium: 'Onest_500Medium',
  semibold: 'Onest_600SemiBold',
  bold: 'Onest_700Bold',
} as const;

/** Max font scale multiplier (system Dynamic Type / fontScale), 2-design §8. */
export const MAX_FONT_SCALE = 2.0;
/** At or above this system font scale layouts switch to «large font» mode (2 tabs, two-row line, 1 column). */
export const LARGE_FONT_SCALE = 1.5;

export type TypeToken =
  'display' | 'title1' | 'title2' | 'section' | 'body' | 'bodyStrong' | 'button' | 'meta' | 'number' | 'amount';

export const type: Record<TypeToken, TextStyle> = {
  display: { fontFamily: fontFamily.semibold, fontSize: 34, lineHeight: 40 },
  title1: { fontFamily: fontFamily.semibold, fontSize: 28, lineHeight: 34 },
  title2: { fontFamily: fontFamily.semibold, fontSize: 22, lineHeight: 28 },
  section: {
    fontFamily: fontFamily.bold,
    fontSize: 15,
    lineHeight: 20,
    letterSpacing: 0.6,
    textTransform: 'uppercase',
  },
  body: { fontFamily: fontFamily.regular, fontSize: 18, lineHeight: 26 },
  bodyStrong: { fontFamily: fontFamily.semibold, fontSize: 18, lineHeight: 26 },
  button: { fontFamily: fontFamily.semibold, fontSize: 20, lineHeight: 24 },
  meta: { fontFamily: fontFamily.regular, fontSize: 16, lineHeight: 22 },
  number: { fontFamily: fontFamily.semibold, fontSize: 18, lineHeight: 26, fontVariant: ['tabular-nums'] },
  /** Week 12: the board of «Расходы» (template-screens 3, `type.amount` 48/56), tabular digits; scales to 1.6× at most. */
  amount: { fontFamily: fontFamily.semibold, fontSize: 48, lineHeight: 56, fontVariant: ['tabular-nums'] },
};
