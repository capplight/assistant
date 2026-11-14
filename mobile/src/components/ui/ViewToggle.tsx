import { Pressable, StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';

import { Icon, type LucideIcon } from './Icon';
import { pressedStyle } from './motion';

export type ToggleOption<K extends string> = { key: K; icon: LucideIcon; label: string; testID?: string };

/**
 * ViewToggle (design-system v2 §5): a `surfaceSunken` track 76×36 with two icons 30×28; the chosen one sits on a
 * `surface` thumb. Each half is a 48 target (hit slop), labelled for the screen reader.
 */
export function ViewToggle<K extends string>({
  options,
  value,
  onChange,
  testID,
}: {
  options: readonly [ToggleOption<K>, ToggleOption<K>];
  value: K;
  onChange: (k: K) => void;
  testID?: string;
}) {
  const theme = useTheme();
  const { width, height } = theme.size.viewToggle;
  return (
    <View
      testID={testID}
      accessibilityRole="radiogroup"
      style={[styles.track, { width, height, borderRadius: theme.radius.sm, backgroundColor: theme.colors.surfaceSunken, marginBottom: 6 }]}
    >
      {options.map((o) => {
        const on = o.key === value;
        return (
          <Pressable
            key={o.key}
            testID={o.testID}
            accessibilityRole="radio"
            accessibilityLabel={o.label}
            accessibilityState={{ checked: on }}
            hitSlop={{ top: 6, bottom: 6, left: 2, right: 2 }}
            onPress={() => onChange(o.key)}
            style={({ pressed }) => [styles.half, pressedStyle(pressed)]}
          >
            <View
              style={[
                styles.thumb,
                { borderRadius: theme.radius.xs + 2, backgroundColor: on ? theme.colors.surface : 'transparent' },
                on ? theme.elevation.card : null,
              ]}
            >
              <Icon icon={o.icon} size="sm" color={on ? 'ink' : 'iconSecondary'} />
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around', paddingHorizontal: 3 },
  half: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  thumb: { width: 30, height: 28, alignItems: 'center', justifyContent: 'center' },
});
