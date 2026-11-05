import { Check } from 'lucide-react-native';
import { Pressable, StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';

import { AppText } from './AppText';

type Props = {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  testID?: string;
};

/** Whole row is one ≥56 pt target; state is announced, not only drawn. */
export function Checkbox({ label, checked, onChange, testID }: Props) {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={label}
      onPress={() => onChange(!checked)}
      style={[styles.row, { minHeight: theme.size.primaryTouch, gap: theme.space[3] }]}
    >
      <View
        style={[
          styles.box,
          {
            borderColor: checked ? theme.colors.accent : theme.colors.lineStrong,
            backgroundColor: checked ? theme.colors.accent : theme.colors.surface,
            borderRadius: 6,
          },
        ]}
      >
        {checked ? <Check size={22} color={theme.colors.onAccent} strokeWidth={3} /> : null}
      </View>
      <AppText style={styles.label}>{label}</AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  box: { width: 32, height: 32, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  label: { flex: 1 },
});
