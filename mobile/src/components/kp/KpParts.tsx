import { Delete } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import type { DealStatus } from '@/api/types';
import { decToMinor } from '@/kp/calc';
import { STEPS, stepsDone, type Step } from '@/kp/view';
import { formatMinor } from '@/expenses/calc';
import { useTheme } from '@/theme';

import { AmountText } from '../AmountText';
import { AppText } from '../AppText';

/** Keys are 56 pt with 8 pt between, flat and tonal, like the calculator of «Расходы» (pattern 3). */
const KEY = 56;
const KEYS = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  [',', '0', '⌫'],
] as const;

export type DigitKey = (typeof KEYS)[number][number];

/** A typed number: digits, one comma, ≤12 digits before it and ≤3 after (quantities have three). */
export function pressDigit(text: string, k: DigitKey, decimals = 2): string {
  if (k === '⌫') return text.slice(0, -1);
  const [int = '', frac] = text.split(',');
  if (k === ',') return frac !== undefined || decimals === 0 ? text : `${text || '0'},`;
  if (frac !== undefined) return frac.length >= decimals ? text : text + k;
  if (int.length >= 12) return text;
  return int === '0' ? k : text + k;
}

/** The digits of S28 «Ввести цены подряд» and of a tap-edit (S17): big, with spoken names. */
export function DigitKeypad({ onKey, testID = 'kp-keys' }: { onKey: (k: DigitKey) => void; testID?: string }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const name = (k: DigitKey) => (k === '⌫' ? t('kp.key_erase') : k === ',' ? t('kp.key_comma') : k);
  return (
    <View testID={testID} style={{ gap: theme.space[2] }}>
      {KEYS.map((row, i) => (
        <View key={i} style={[styles.row, { gap: theme.space[2] }]}>
          {row.map((k) => (
            <Pressable
              key={k}
              testID={`${testID}-${k === '⌫' ? 'erase' : k === ',' ? 'comma' : k}`}
              accessibilityRole="button"
              accessibilityLabel={name(k)}
              onPress={() => onKey(k)}
              style={({ pressed }) => [
                styles.key,
                {
                  minHeight: KEY,
                  borderRadius: theme.radius.md,
                  backgroundColor: pressed ? theme.colors.separator : theme.colors.surfaceSunken,
                },
              ]}
            >
              {k === '⌫' ? (
                <Delete size={26} color={theme.colors.ink} strokeWidth={1.75} />
              ) : (
                <AppText variant="title2" maxFontSizeMultiplier={1.5} style={{ fontSize: 28, lineHeight: 34, fontVariant: ['tabular-nums'] }}>
                  {k}
                </AppText>
              )}
            </Pressable>
          ))}
        </View>
      ))}
    </View>
  );
}

/** «18 500 ₸» as typed, read out (live region polite). `money`: a price; else a quantity with its unit. */
export function NumberDisplay({ text, unit, money = true, testID = 'kp-display' }: { text: string; unit?: string | null; money?: boolean; testID?: string }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const minor = money && text ? decToMinor(text) : null;
  const shown = money ? (minor !== null ? formatMinor(minor) : '0 ₸') : `${text || '0'}${unit ? ` ${unit}` : ''}`;
  return (
    <View
      testID={testID}
      accessible
      accessibilityLiveRegion="polite"
      accessibilityLabel={text ? (money ? t('kp.price_a11y', { amount: shown }) : shown) : t('kp.price_empty_a11y')}
      style={{ paddingVertical: theme.space[2], alignItems: 'center' }}
    >
      <AmountText testID={`${testID}-text`} variant="amount" maxScale={1.4} inset={theme.screenPadding * 2 + theme.space[5] * 2} color={text ? 'ink' : 'ink2'} style={{ textAlign: 'center' }}>
        {shown}
      </AmountText>
    </View>
  );
}

/**
 * The status bar of a КП (template-screens 2.5): dots and words, «Черновик ● Отправлено ○ Видел ○ Принято».
 * ≥150%: one line «Статус: Отправлено ›». The whole bar is one button (the step is set in a sheet).
 */
export function StatusBar({
  status,
  onPress,
  testID,
  word,
}: {
  status: DealStatus;
  onPress: () => void;
  testID: string;
  word: string;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const done = stepsDone(status);
  const label = (s: Step) => (s === 'accepted' && status === 'declined' ? t('kp.step_declined') : t(`kp.step_${s}`));
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={t('kp.status_a11y', { status: word })}
      onPress={onPress}
      style={{ minHeight: theme.size.minTouch, justifyContent: 'center' }}
    >
      {theme.largeFont ? (
        <AppText testID={`${testID}-line`} color="brand">{`${t('kp.status_line', { status: word })} ›`}</AppText>
      ) : (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: theme.space[3], rowGap: theme.space[1] }}>
          {STEPS.map((s) => {
            const on = done.has(s) && !(s === 'accepted' && status === 'declined');
            return (
              <View key={s} style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[1] }}>
                <View
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: 6,
                    borderWidth: 2,
                    borderColor: on ? theme.colors.success : theme.colors.iconSecondary,
                    backgroundColor: on ? theme.colors.success : 'transparent',
                  }}
                />
                <AppText testID={`${testID}-${s}${on ? '-on' : ''}`} variant="callout" color={on ? 'ink' : 'ink2'}>
                  {label(s)}
                </AppText>
              </View>
            );
          })}
        </View>
      )}
    </Pressable>
  );
}

/** Status colours (pattern 8): черновик neutral, отправлено brand, видел sun, принято success, отказ danger. */
export function statusTone(theme: ReturnType<typeof useTheme>, status: DealStatus): { bg: string; fg: keyof ReturnType<typeof useTheme>['colors'] } {
  const c = theme.colors;
  switch (status) {
    case 'sent':
      return { bg: c.brandTint, fg: 'brand' };
    case 'seen':
      return { bg: c.highlightTint, fg: 'warning' };
    case 'accepted':
      return { bg: c.successTint, fg: 'success' };
    case 'declined':
      return { bg: c.dangerTint, fg: 'danger' };
    default:
      return { bg: c.surfaceSunken, fg: 'ink2' };
  }
}

/**
 * The coloured status badge of a КП row (22 tall, pattern 8). One button (48 target): the step is set in a sheet.
 * The word's test id says which step is on: `${testID}-${status}-on`.
 */
export function StatusBadge({ status, onPress, testID, word }: { status: DealStatus; onPress: () => void; testID: string; word: string }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const tone = statusTone(theme, status);
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={t('kp.status_a11y', { status: word })}
      onPress={onPress}
      hitSlop={{ top: 13, bottom: 13, left: 4, right: 4 }}
      style={({ pressed }) => [{ minHeight: 22, paddingHorizontal: theme.space[2], borderRadius: 11, backgroundColor: tone.bg, justifyContent: 'center', alignSelf: 'center', opacity: pressed ? 0.7 : 1 }]}
    >
      <AppText testID={`${testID}-${status}-on`} variant="caption" color={tone.fg}>
        {word}
      </AppText>
    </Pressable>
  );
}

/** The «лист» 36×44: a tonal mini page (3 lines), never a photo; the type is said in the row's label. */
export function MiniSheet({ type: _type }: { type: string }) {
  const theme = useTheme();
  return (
    <View
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={{ width: 36, height: 44, borderRadius: theme.radius.xs, backgroundColor: theme.colors.surfaceSunken, padding: 6, gap: 4, justifyContent: 'center' }}
    >
      {[1, 0.7, 0.85, 0.5].map((w, i) => (
        <View key={i} style={{ height: 3, width: `${w * 100}%`, backgroundColor: theme.colors.iconSecondary, opacity: 0.55, borderRadius: 2 }} />
      ))}
    </View>
  );
}

/** «проверьте» next to a number read from a photo (2-design §7 string 28). */
export function CheckBadge({ testID }: { testID?: string }) {
  const theme = useTheme();
  const { t } = useTranslation();
  return (
    <View testID={testID} style={{ backgroundColor: theme.colors.highlightTint, borderRadius: theme.radius.round, paddingHorizontal: theme.space[2], alignSelf: 'flex-start' }}>
      <AppText variant="callout" color="warning">{`⚠ ${t('kp.check')}`}</AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row' },
  key: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
