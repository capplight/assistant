import { Delete } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import type { Key } from '@/expenses/expression';
import { pressScale, useTheme } from '@/theme';

import { AppText } from '../AppText';

/** Keys are 56 pt with 8 pt between (research/expenses-documents.md, pattern 3); labels grow to 1.5× at most. */
export const KEY_SIZE = 56;
const KEY_LABEL_SCALE = 1.5;

const ROWS: (Key | 'save')[][] = [
  ['7', '8', '9', '⌫'],
  ['4', '5', '6', '+'],
  ['1', '2', '3', '−'],
  ['000', '0', ',', 'save'],
];

const KEY_ID: Record<string, string> = { '⌫': 'erase', '+': 'plus', '−': 'minus', ',': 'comma', '000': '000' };

/**
 * The calculator keys of «Расходы» (pattern 3): a flat 4×4 grid of tonal keys, no borders, digits 28, «+ −» in
 * `brand`, «Записать» filled `brand`. Stays a grid at 200% (labels capped at 1.5×). Each key has a spoken name.
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
                      borderRadius: theme.radius.md,
                      backgroundColor: pressed && canSave ? theme.colors.brandPressed : theme.colors.brand,
                      opacity: !canSave ? 0.4 : 1,
                    },
                  ]}
                >
                  <AppText variant="button" color="onBrand" maxFontSizeMultiplier={KEY_LABEL_SCALE} style={styles.center}>
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
                    borderRadius: theme.radius.md,
                    backgroundColor: pressed ? theme.colors.separator : op ? theme.colors.brandTint : theme.colors.surfaceSunken,
                    transform: pressed ? [{ scale: pressScale }] : undefined,
                  },
                ]}
              >
                {k === '⌫' ? (
                  <Delete size={26} color={theme.colors.ink} strokeWidth={1.75} />
                ) : (
                  <AppText
                    variant="title2"
                    color={op ? 'brand' : 'ink'}
                    maxFontSizeMultiplier={KEY_LABEL_SCALE}
                    style={[styles.center, styles.digit]}
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
  digit: { fontSize: 28, lineHeight: 34, fontVariant: ['tabular-nums'] },
});
