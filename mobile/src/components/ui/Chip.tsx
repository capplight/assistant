import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme, type ColorTokens } from '@/theme';

import { AppText } from '../AppText';
import { Icon, type LucideIcon } from './Icon';
import { hitSlopFor, pressedStyle } from './motion';

/**
 * v5 chip (screens-v5 `.chip`): 38 high, radius 19, 1.5 `line2` outline, Onest 600 15 `ink`;
 * `selected` = `btn` fill + `onBtn`. `tonal` / `neutral` are v2 names of the outlined chip.
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
  const on = variant === 'selected';
  const bg = on ? theme.colors.btn : 'transparent';
  const fg: keyof ColorTokens = on ? 'onBtn' : 'ink';
  const inner = (
    <>
      {icon ? <Icon icon={icon} size="sm" color={fg} /> : null}
      <AppText variant="callout" color={fg} style={[styles.label, { fontFamily: theme.type.sheetMeta.fontFamily, lineHeight: 19 }]}>
        {label}
      </AppText>
    </>
  );
  const box: StyleProp<ViewStyle> = [
    styles.chip,
    {
      minHeight: theme.size.chipHeight,
      backgroundColor: bg,
      paddingHorizontal: 15,
      gap: 6,
      borderRadius: theme.size.chipHeight / 2,
      borderWidth: on ? 0 : 1.5,
      borderColor: theme.colors.line2,
    },
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
