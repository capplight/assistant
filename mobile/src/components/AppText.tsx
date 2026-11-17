import { Text, type TextProps } from 'react-native';

import { MAX_FONT_SCALE, useTheme, type ColorTokens, type TypeToken } from '@/theme';

export type AppTextProps = TextProps & {
  variant?: TypeToken;
  color?: keyof ColorTokens;
};

/** v5: `callout` / `small` are ink2, captions (`footnote`, `caption`) ink3 (≥ 4.5 on paper and paper2); the rest `ink`. */
const SECONDARY: Partial<Record<TypeToken, keyof ColorTokens>> = { callout: 'ink2', small: 'ink2', footnote: 'ink3', caption: 'ink3' };

/** All text goes through here: type scale, theme colour, font scaling capped at 200% (hero sums: `AmountText` fits them to their box). */
export function AppText({ variant = 'body', color, style, maxFontSizeMultiplier, ...rest }: AppTextProps) {
  const theme = useTheme();
  const defaultColor: keyof ColorTokens = SECONDARY[variant] ?? 'ink';
  return (
    <Text
      maxFontSizeMultiplier={maxFontSizeMultiplier ?? MAX_FONT_SCALE}
      style={[theme.type[variant], { color: theme.colors[color ?? defaultColor] as string }, style]}
      {...rest}
    />
  );
}
