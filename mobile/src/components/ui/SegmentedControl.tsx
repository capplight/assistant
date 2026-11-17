import { Pressable, StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';

import { AppText } from '../AppText';

export type Segment<K extends string> = { key: K; label: string; count?: number; testID?: string; accessibilityLabel?: string };

type Props<K extends string> = {
  segments: Segment<K>[];
  value: K;
  onChange: (k: K) => void;
  /** Spoken name of the whole control. */
  accessibilityLabel?: string;
  testID?: string;
};

/**
 * Height 36, `surfaceSunken` track radius 10, `surface` thumb radius 8 + shadow, `callout` (selected 600 ink, the
 * rest ink2). The count is inside the label («Сегодня · 4»). At ≥150 % font the segments stack in a column.
 * One component instead of the four (ReminderLists, Stickers «Ряды | Доска», Documents filter, Expenses period).
 */
export function SegmentedControl<K extends string>({ segments, value, onChange, accessibilityLabel, testID }: Props<K>) {
  const theme = useTheme();
  const column = theme.largeFont;
  return (
    <View
      testID={testID}
      accessibilityRole="tablist"
      accessibilityLabel={accessibilityLabel}
      style={[
        styles.track,
        {
          flexDirection: column ? 'column' : 'row',
          // v5: chips on the paper («Неделя · Месяц · Год»): outlined, the chosen one `btn`.
          backgroundColor: 'transparent',
          borderRadius: 0,
          padding: 0,
          gap: 8,
        },
      ]}
    >
      {segments.map((s) => {
        const on = s.key === value;
        const label = s.count !== undefined ? `${s.label} · ${s.count}` : s.label;
        return (
          <Pressable
            key={s.key}
            testID={s.testID}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            accessibilityLabel={s.accessibilityLabel ?? label}
            onPress={() => onChange(s.key)}
            hitSlop={column ? undefined : { top: 6, bottom: 6 }}
            style={[
              styles.segment,
              column ? null : styles.flex,
              {
                minHeight: theme.size.chipHeight,
                borderRadius: theme.size.chipHeight / 2,
                paddingHorizontal: 15,
                backgroundColor: on ? theme.colors.btn : 'transparent',
                borderWidth: on ? 0 : 1.5,
                borderColor: theme.colors.line2,
              },
            ]}
          >
            <AppText variant="callout" color={on ? 'onBtn' : 'ink'} style={[styles.label, { fontFamily: theme.type.sheetMeta.fontFamily }]}>
              {label}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: { alignSelf: 'stretch' },
  flex: { flex: 1 },
  segment: { alignItems: 'center', justifyContent: 'center', paddingVertical: 4 },
  label: { textAlign: 'center' },
});
