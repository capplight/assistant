import { Delete } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import type { Key } from '@/expenses/expression';
import { useTheme } from '@/theme';

import { AppText } from '../AppText';

/** Keys are 64 pt with ≥8 pt between (template-screens 5); their labels grow to 1.5× at most. */
export const KEY_SIZE = 64;
const KEY_LABEL_SCALE = 1.5;

const ROWS: (Key | 'save')[][] = [
  ['7', '8', '9', '⌫'],
  ['4', '5', '6', '+'],
  ['1', '2', '3', '−'],
  ['000', '0', ',', 'save'],
];

const KEY_ID: Record<string, string> = { '⌫': 'erase', '+': 'plus', '−': 'minus', ',': 'comma', '000': '000' };

/**
 * The calculator keys of «Расходы» (template-screens 2.2): a 4×4 grid that stays a grid at 200%
 * (the keys are 64 pt already), «Записать» is the one accent button. Each key has a spoken name.
 */
export function ExpenseKeypad({
  onKey,
  onSave,
  saveLabel,
  canSave,
  testID = 'exp-keypad',
}: {
  onKey: (k: Key) => void;
  onSave: () => void;
  saveLabel: string;
  canSave: boolean;
  testID?: string;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const name = (k: Key) =>
    k === '+' ? t('exp.key_plus') : k === '−' ? t('exp.key_minus') : k === '⌫' ? t('exp.key_erase') : k === ',' ? t('exp.key_comma') : k === '000' ? t('exp.key_000') : k;
  return (
    <View testID={testID} style={{ gap: theme.space[2] }}>
      {ROWS.map((row, i) => (
        <View key={i} style={[styles.row, { gap: theme.space[2] }]}>
          {row.map((k) => {
            if (k === 'save') {
              return (
                <Pressable
                  key={k}
                  testID={`${testID}-save`}
                  accessibilityRole="button"
                  accessibilityLabel={t('exp.save_a11y')}
                  accessibilityState={{ disabled: !canSave }}
                  onPress={onSave}
                  style={({ pressed }) => [
                    styles.key,
                    {
                      minHeight: KEY_SIZE,
                      borderRadius: theme.radius.button,
                      backgroundColor: theme.colors.accent,
                      opacity: !canSave ? 0.45 : pressed ? 0.85 : 1,
                    },
                  ]}
                >
                  <AppText variant="button" color="onAccent" maxFontSizeMultiplier={KEY_LABEL_SCALE} style={styles.center}>
                    {saveLabel}
                  </AppText>
                </Pressable>
              );
            }
            const op = k === '+' || k === '−';
            return (
              <Pressable
                key={k}
                testID={`${testID}-${KEY_ID[k] ?? k}`}
                accessibilityRole="button"
                accessibilityLabel={name(k)}
                onPress={() => onKey(k)}
                style={({ pressed }) => [
                  styles.key,
                  {
                    minHeight: KEY_SIZE,
                    borderRadius: theme.radius.button,
                    borderWidth: op ? 2 : 1,
                    borderColor: op ? theme.colors.accent : theme.colors.lineStrong,
                    backgroundColor: pressed ? theme.colors.line : theme.colors.surface,
                  },
                ]}
              >
                {k === '⌫' ? (
                  <Delete size={28} color={theme.colors.ink} />
                ) : (
                  <AppText
                    variant="title2"
                    color={op ? 'accent' : 'ink'}
                    maxFontSizeMultiplier={KEY_LABEL_SCALE}
                    style={[styles.center, { fontVariant: ['tabular-nums'] }]}
                  >
                    {k}
                  </AppText>
                )}
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row' },
  key: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  center: { textAlign: 'center' },
});
