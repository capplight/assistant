import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme, type ColorTokens } from '@/theme';

import { AppText } from '../AppText';
import { Icon, type LucideIcon } from './Icon';
import { hitSlopFor, pressedStyle } from './motion';

/**
 * - `tonal`    brandTint + brand (suggestions, actions in the answer);
 * - `neutral`  surfaceSunken + ink;
 * - `selected` brand + onBrand (the chosen filter).
 */
export type ChipVariant = 'tonal' | 'neutral' | 'selected';

type Props = {
  label: string;
  variant?: ChipVariant;
  icon?: LucideIcon;
  onPress?: () => void;
  accessibilityLabel?: string;
  /** Filters: announced as selected. */
  selected?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/** Height 32 (hit 48), radius round, padding 12, `callout` 600 (design-system §3 Chip). Wraps, never cut. */
export function Chip({ label, variant = 'tonal', icon, onPress, accessibilityLabel, selected, style, testID }: Props) {
  const theme = useTheme();
  const bg = { tonal: theme.colors.brandTint, neutral: theme.colors.surfaceSunken, selected: theme.colors.brand }[variant];
  const fg: keyof ColorTokens = variant === 'tonal' ? 'brand' : variant === 'selected' ? 'onBrand' : 'ink';
  const inner = (
    <>
      {icon ? <Icon icon={icon} size="sm" color={fg} /> : null}
      <AppText variant="callout" color={fg} style={[styles.label, { fontFamily: theme.type.sectionLabel.fontFamily }]}>
        {label}
      </AppText>
    </>
  );
  const box: StyleProp<ViewStyle> = [
    styles.chip,
    { minHeight: theme.size.chipHeight, backgroundColor: bg, paddingHorizontal: theme.space[3], gap: theme.space[1], borderRadius: theme.radius.round },
    style,
  ];
  if (!onPress)
    return (
      <View testID={testID} style={box}>
        {inner}
      </View>
    );
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={selected !== undefined ? { selected } : undefined}
      hitSlop={hitSlopFor(theme.size.chipHeight)}
      onPress={onPress}
      style={({ pressed }) => [box, pressedStyle(pressed)]}
    >
      {inner}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', paddingVertical: 4 },
  label: { flexShrink: 1 },
});
