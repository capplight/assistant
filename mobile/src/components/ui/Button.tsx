import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme, type ColorTokens } from '@/theme';

import { AppText } from '../AppText';
import { hitSlopFor, pressedStyle } from './motion';

/**
 * - `primary`   brand fill, onBrand label — one per screen;
 * - `secondary` tonal: brandTint fill, brand label (replaces the old outline buttons);
 * - `text`      brand label only.
 * `tone="highlight"` is for buttons on the sun card «Дальше»: primary = dark `onHighlight` with sun text,
 * secondary = translucent white.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'text';

export type ButtonProps = Omit<PressableProps, 'children' | 'style'> & {
  label: string;
  variant?: ButtonVariant;
  icon?: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Defaults: 50 (primary / secondary), 36 for `size="small"`, 48 for `text`. The hit area is ≥48 anyway. */
  minHeight?: number;
  size?: 'regular' | 'small';
  /** «Удалить»: the label is `danger`. */
  labelColor?: 'danger';
  tone?: 'default' | 'highlight';
};

/** Button with a visible label; wraps text instead of truncating; press = scale 0.97 + pressed colour. */
export function Button({
  label,
  variant = 'primary',
  icon,
  style,
  minHeight,
  size = 'regular',
  labelColor,
  tone = 'default',
  disabled,
  accessibilityLabel,
  hitSlop,
  ...rest
}: ButtonProps) {
  const theme = useTheme();
  const { colors } = theme;
  const onSun = tone === 'highlight';
  const fill = (pressed: boolean): string => {
    if (variant === 'text') return pressed ? colors.surfaceSunken : 'transparent';
    if (onSun) return variant === 'primary' ? colors.onHighlight : 'rgba(255,255,255,0.45)';
    if (variant === 'primary') return pressed ? colors.brandPressed : colors.brand;
    return colors.brandTint;
  };
  const fg: keyof ColorTokens = labelColor
    ? labelColor
    : onSun
      ? variant === 'primary'
        ? 'highlight'
        : 'onHighlight'
      : variant === 'primary'
        ? 'onBrand'
        : 'brand';
  const height = minHeight ?? (variant === 'text' ? theme.size.minTouch : size === 'small' ? theme.size.buttonHeightSmall : theme.size.buttonHeight);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      hitSlop={hitSlop ?? hitSlopFor(height)}
      style={({ pressed }) => [
        styles.base,
        {
          minHeight: height,
          backgroundColor: fill(pressed),
          borderRadius: theme.radius.round,
          paddingHorizontal: variant === 'text' ? theme.space[3] : size === 'small' ? theme.space[4] : theme.space[5],
          paddingVertical: size === 'small' ? theme.space[1] : theme.space[2],
          opacity: disabled ? 0.4 : 1,
        },
        pressedStyle(pressed && !disabled),
        style,
      ]}
      {...rest}
    >
      {icon ? <View style={{ marginRight: theme.space[2] }}>{icon}</View> : null}
      <AppText variant="button" color={fg} style={styles.label}>
        {label}
      </AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  label: { textAlign: 'center', flexShrink: 1 },
});
