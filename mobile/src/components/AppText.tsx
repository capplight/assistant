import { Text, type TextProps } from 'react-native';

import { MAX_FONT_SCALE, useTheme, type ColorTokens, type TypeToken } from '@/theme';

export type AppTextProps = TextProps & {
  variant?: TypeToken;
  color?: keyof ColorTokens;
};

/** Secondary by default: meta lines and dates. Everything else is `ink`. */
const SECONDARY: ReadonlySet<TypeToken> = new Set(['callout', 'footnote']);

/** All text goes through here: type scale, theme colour, font scaling capped at 200% (hero sums: `AmountText` fits them to their box). */
export function AppText({ variant = 'body', color, style, maxFontSizeMultiplier, ...rest }: AppTextProps) {
  const theme = useTheme();
  const defaultColor: keyof ColorTokens = SECONDARY.has(variant) ? 'ink2' : 'ink';
  return (
    <Text
      maxFontSizeMultiplier={maxFontSizeMultiplier ?? MAX_FONT_SCALE}
      style={[theme.type[variant], { color: theme.colors[color ?? defaultColor] as string }, style]}
      {...rest}
    />
  );
}
