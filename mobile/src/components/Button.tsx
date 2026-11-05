import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme } from '@/theme';

import { AppText } from './AppText';

export type ButtonVariant = 'primary' | 'outline' | 'text';

type Props = Omit<PressableProps, 'children' | 'style'> & {
  label: string;
  variant?: ButtonVariant;
  icon?: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Defaults to 56 (main button). */
  minHeight?: number;
};

/** Button with visible label, ≥56 pt by default, wraps text instead of truncating. */
export function Button({
  label,
  variant = 'primary',
  icon,
  style,
  minHeight,
  disabled,
  accessibilityLabel,
  ...rest
}: Props) {
  const theme = useTheme();
  const { colors } = theme;
  const bg = variant === 'primary' ? colors.accent : 'transparent';
  const fg = variant === 'primary' ? 'onAccent' : 'accent';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      style={({ pressed }) => [
        styles.base,
        {
          minHeight: minHeight ?? theme.size.primaryTouch,
          backgroundColor: bg,
          borderRadius: theme.radius.button,
          borderColor: variant === 'outline' ? colors.accent : 'transparent',
          borderWidth: variant === 'outline' ? 2 : 0,
          paddingHorizontal: theme.space[4],
          opacity: disabled ? 0.45 : pressed ? 0.85 : 1,
        },
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
  base: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 12 },
  label: { textAlign: 'center', flexShrink: 1 },
});
