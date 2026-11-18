import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme, type ColorTokens } from '@/theme';

import { AppText } from '../AppText';
import { hitSlopFor, pressedStyle } from './motion';

/**
 * v5 buttons (design-system §11.3, screens-v5 `.btn`): everything you press is `btn` — black in light, light in dark.
 * - `primary`   `btn` fill, `onBtn` label, 52 / radius 26 (small 42 / 21) — one per screen;
 * - `secondary` outline 1.5 `ink`, `ink` label («Не удалять», «Изменить»);
 * - `text`      `ink` label 700 only («Закрыть»); `link` adds the underline («Восстановить», «Переложить»);
 * - `danger`    `danger` fill — ONLY irreversible actions («Удалить навсегда»).
 * `tone` is a v2 prop and is ignored.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'text' | 'link' | 'danger';

export type ButtonProps = Omit<PressableProps, 'children' | 'style'> & {
  label: string;
  variant?: ButtonVariant;
  icon?: ReactNode;
  style?: StyleProp<ViewStyle>;
  /** Defaults: 52, 42 for `size="small"`, 48 for `text`. The hit area is ≥ 48 anyway. */
  minHeight?: number;
  size?: 'regular' | 'small';
  /** «Удалить»: the label is `danger`. */
  labelColor?: 'danger';
  tone?: 'default' | 'highlight';
};

/** Button with a visible label; wraps text instead of truncating; press = scale 0.97. */
export function Button({
  label,
  variant = 'primary',
  icon,
  style,
  minHeight,
  size = 'regular',
  labelColor,
  disabled,
  accessibilityLabel,
  hitSlop,
  tone: _tone,
  ...rest
}: ButtonProps) {
  const theme = useTheme();
  const { colors } = theme;
  const plain = variant === 'text' || variant === 'link';
  const fill = (pressed: boolean): string => {
    if (plain) return pressed ? colors.paper2 : 'transparent';
    if (variant === 'primary') return pressed ? colors.ink2 : colors.btn;
    if (variant === 'danger') return colors.danger;
    return pressed ? colors.paper2 : 'transparent';
  };
  const fg: keyof ColorTokens = labelColor ? labelColor : variant === 'primary' ? 'onBtn' : variant === 'danger' ? 'onDanger' : 'ink';
  const small = size === 'small';
  const height = minHeight ?? (plain ? theme.size.minTouch : small ? theme.size.buttonHeightSmall : theme.size.buttonHeight);
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
          borderRadius: plain ? theme.radius.round : height / 2,
          paddingHorizontal: plain ? theme.space[2] : small ? theme.space[4] : 22,
          minWidth: plain ? undefined : 88,
          paddingVertical: small ? theme.space[1] : theme.space[2],
          opacity: disabled ? 0.4 : 1,
          gap: theme.space[2],
        },
        variant === 'secondary' ? { borderWidth: 1.5, borderColor: labelColor ? colors.danger : colors.ink } : null,
        pressedStyle(pressed && !disabled),
        style,
      ]}
      {...rest}
    >
      {icon ? <View>{icon}</View> : null}
      {/* QA v5-device-1 A6: a button label never wraps; the button grows to its text (min 88). */}
      <AppText
        nativeID="v5-one-line"
        numberOfLines={1}
        variant={small ? 'buttonSmall' : 'button'}
        color={fg}
        style={[styles.label, variant === 'link' ? styles.link : null, plain && !small ? { fontSize: 16 } : null]}
      >
        {label}
      </AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  label: { textAlign: 'center', flexShrink: 0 },
  link: { textDecorationLine: 'underline' },
});
