import * as Haptics from 'expo-haptics';
import { Check } from 'lucide-react-native';
import { Pressable, StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';

import { AppText } from '../AppText';
import { useReducedMotion } from './motion';

type CircleProps = {
  checked: boolean;
  /** Without it the circle is drawn only (inside a row that is the target). */
  onChange?: (v: boolean) => void;
  /** Spoken name: the task's text. */
  label: string;
  disabled?: boolean;
  testID?: string;
};

/** The 24 circle itself: outline 1.75 `iconSecondary`; checked = `brand` fill + `onBrand` check. */
export function CheckMark({ checked }: { checked: boolean }) {
  const theme = useTheme();
  const s = theme.size.checkbox;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.circle,
        {
          width: s,
          height: s,
          borderRadius: s / 2,
          borderWidth: checked ? 0 : theme.icon.strokeWidth,
          borderColor: theme.colors.iconSecondary,
          backgroundColor: checked ? theme.colors.brand : 'transparent',
        },
      ]}
    >
      {checked ? <Check size={16} color={theme.colors.onBrand} strokeWidth={2.5} /> : null}
    </View>
  );
}

/** A light tick when something gets checked; none with «Уменьшить движение» or where haptics are unavailable. */
function tick(reduced: boolean) {
  if (reduced) return;
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
}

/**
 * Round check (design-system §3 Checkbox): 24 visible, 48 target, a light haptic on check. Overdue colours the
 * time, never the circle. Replaces the 32 / 40 / 44 squares and the glyphs.
 */
export function CheckCircle({ checked, onChange, label, disabled, testID }: CircleProps) {
  const theme = useTheme();
  const reduced = useReducedMotion();
  if (!onChange) return <CheckMark checked={checked} />;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled: !!disabled }}
      accessibilityLabel={label}
      disabled={disabled}
      onPress={() => {
        if (!checked) tick(reduced);
        onChange(!checked);
      }}
      style={[styles.target, { width: theme.size.minTouch, height: theme.size.minTouch }]}
    >
      <CheckMark checked={checked} />
    </Pressable>
  );
}

/** A labelled check: the whole row is one ≥48 target; state is announced, not only drawn. */
export function CheckRow({ label, checked, onChange, testID, disabled }: Required<Pick<CircleProps, 'onChange'>> & Omit<CircleProps, 'onChange'>) {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled: !!disabled }}
      accessibilityLabel={label}
      disabled={disabled}
      onPress={() => onChange(!checked)}
      style={[styles.row, { minHeight: theme.size.minTouch, gap: theme.space[3] }]}
    >
      <CheckMark checked={checked} />
      <AppText style={styles.label}>{label}</AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  circle: { alignItems: 'center', justifyContent: 'center' },
  target: { alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center' },
  label: { flex: 1 },
});
