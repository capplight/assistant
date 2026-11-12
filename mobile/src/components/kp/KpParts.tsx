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

/** Keys are 64 pt with 8 pt between (template-screens 5), like the calculator of «Расходы». */
const KEY = 64;
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
                  borderRadius: theme.radius.button,
                  borderWidth: 1,
                  borderColor: theme.colors.lineStrong,
                  backgroundColor: pressed ? theme.colors.line : theme.colors.surface,
                },
              ]}
            >
              {k === '⌫' ? (
                <Delete size={28} color={theme.colors.ink} />
              ) : (
                <AppText variant="title2" maxFontSizeMultiplier={1.5} style={{ fontVariant: ['tabular-nums'] }}>
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
      style={{ borderWidth: 1, borderColor: theme.colors.lineStrong, borderRadius: theme.radius.input, padding: theme.space[3], backgroundColor: theme.colors.bg, alignItems: 'flex-end' }}
    >
      <AmountText testID={`${testID}-text`} variant="title1" maxScale={1.6} inset={theme.screenPadding * 2 + theme.space[3] * 2 + 2} style={{ textAlign: 'right' }}>
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
        <AppText testID={`${testID}-line`} color="accent">{`${t('kp.status_line', { status: word })} ›`}</AppText>
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
                    borderColor: on ? theme.colors.done : theme.colors.lineStrong,
                    backgroundColor: on ? theme.colors.done : 'transparent',
                  }}
                />
                <AppText testID={`${testID}-${s}${on ? '-on' : ''}`} variant="meta" color={on ? 'ink' : 'ink2'}>
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

/** The «лист» 48×64: a mini page drawn from the text (3 grey lines and the type in a word), never a photo. */
export function MiniSheet({ type }: { type: string }) {
  const theme = useTheme();
  return (
    <View
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={{ width: 48, height: 64, borderWidth: 1, borderColor: theme.colors.lineStrong, borderRadius: 4, backgroundColor: theme.colors.surface, padding: 6, gap: 5 }}
    >
      {[1, 0.8, 0.9].map((w, i) => (
        <View key={i} style={{ height: 3, width: `${w * 100}%`, backgroundColor: theme.colors.line, borderRadius: 2 }} />
      ))}
      <AppText variant="meta" maxFontSizeMultiplier={1} style={{ fontSize: 11, lineHeight: 14, marginTop: 2 }} numberOfLines={1}>
        {type}
      </AppText>
    </View>
  );
}

/** «проверьте» next to a number read from a photo (2-design §7 string 28). */
export function CheckBadge({ testID }: { testID?: string }) {
  const theme = useTheme();
  const { t } = useTranslation();
  return (
    <View testID={testID} style={{ backgroundColor: theme.colors.markerSoft, borderRadius: theme.radius.chip, paddingHorizontal: theme.space[2], alignSelf: 'flex-start' }}>
      <AppText variant="meta" color="warnText">{`⚠ ${t('kp.check')}`}</AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row' },
  key: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
