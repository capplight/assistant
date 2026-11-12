import { useWindowDimensions, type TextStyle } from 'react-native';

import { MAX_FONT_SCALE, useTheme } from '@/theme';

import { AppText, type AppTextProps } from './AppText';

/**
 * Week 17: a total or a price never truncates and never breaks inside the number at 200%
 * («1 240 / 000 ₸»). The digits are tabular, so the width is known before layout: the text grows
 * with the system font up to its cap (`type.amount` ≤1.6×, 2-design §2.2) only while it still fits
 * one line of the box; a very long sum on a narrow phone gets a smaller size instead of a cut
 * (no `numberOfLines`, no `adjustsFontSizeToFit`: if the estimate is ever short, it wraps, it never hides).
 */

/** Width of a character in em for Onest SemiBold tabular digits, rounded up (digits ≈ 0.58, ₸ ≈ 0.62). */
const em = (ch: string) => (ch === ' ' || ch === ' ' || ch === ' ' ? 0.3 : ch === ',' || ch === '.' ? 0.3 : 0.64);

export function amountEm(text: string): number {
  return [...text].reduce((w, ch) => w + em(ch), 0);
}

/** The multiplier the text may grow to, or a smaller size when even 100% would not fit. Never under 18 pt. */
export function fitAmount(
  text: string,
  o: { fontSize: number; lineHeight: number; available: number; maxScale: number },
): { maxFontSizeMultiplier: number; style?: Pick<TextStyle, 'fontSize' | 'lineHeight'> } {
  const width = amountEm(text) * o.fontSize;
  const fit = width > 0 ? o.available / width : o.maxScale;
  if (fit >= 1) return { maxFontSizeMultiplier: Math.max(1, Math.min(o.maxScale, Math.floor(fit * 100) / 100)) };
  const size = Math.max(18, Math.floor(o.fontSize * fit));
  return { maxFontSizeMultiplier: 1, style: { fontSize: size, lineHeight: Math.ceil((o.lineHeight / o.fontSize) * size) } };
}

/** Marks a sum sized by `fitAmount` (the 200% audit knows a cap under 1.5 is deliberate there). */
export const AMOUNT_FIT_ID = 'amount-fit';

type Props = AppTextProps & {
  children: string;
  /** Points of the window's width the box takes around the text (paddings, borders, the screen edges). */
  inset: number;
  /** The design cap of this text's growth (1.6 for `amount` / `title1` sums). */
  maxScale?: number;
};

export function AmountText({ children, inset, maxScale = MAX_FONT_SCALE, variant = 'title1', style, ...rest }: Props) {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const base = theme.type[variant];
  const fit = fitAmount(children, {
    fontSize: base.fontSize ?? 18,
    lineHeight: base.lineHeight ?? 26,
    available: Math.min(width, theme.size.maxContentWidth) - inset,
    maxScale,
  });
  return (
    <AppText nativeID={AMOUNT_FIT_ID} variant={variant} maxFontSizeMultiplier={fit.maxFontSizeMultiplier} style={[{ fontVariant: ['tabular-nums'] }, style, fit.style]} {...rest}>
      {children}
    </AppText>
  );
}
