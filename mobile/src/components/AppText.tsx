import { Text, type TextProps } from 'react-native';

import { MAX_FONT_SCALE, useTheme, type ColorTokens, type TypeToken } from '@/theme';

export type AppTextProps = TextProps & {
  variant?: TypeToken;
  color?: keyof ColorTokens;
};

/** All text goes through here: type scale, theme colour, font scaling capped at 200%. */
export function AppText({ variant = 'body', color, style, ...rest }: AppTextProps) {
  const theme = useTheme();
  const defaultColor: keyof ColorTokens = variant === 'meta' ? 'ink2' : 'ink';
  return (
    <Text
      maxFontSizeMultiplier={MAX_FONT_SCALE}
      style={[theme.type[variant], { color: theme.colors[color ?? defaultColor] }, style]}
      {...rest}
    />
  );
}
