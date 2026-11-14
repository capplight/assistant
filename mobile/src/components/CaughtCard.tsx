import { AlarmClock, BellRing } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import type { Caught } from '@/chat/caught';
import { useTheme } from '@/theme';

import { AppText } from './AppText';
import { Icon } from './ui/Icon';

/** The text split into plain and lit runs (the parts the phone understood), in order, case kept. */
export function litSegments(text: string, parts: string[]): { text: string; lit: boolean }[] {
  const lower = text.toLowerCase();
  const marks: [number, number][] = [];
  for (const p of parts) {
    const at = lower.indexOf(p.toLowerCase());
    if (at >= 0) marks.push([at, at + p.length]);
  }
  marks.sort((a, b) => a[0] - b[0]);
  const out: { text: string; lit: boolean }[] = [];
  let pos = 0;
  for (const [a, b] of marks) {
    if (a < pos) continue;
    if (a > pos) out.push({ text: text.slice(pos, a), lit: false });
    out.push({ text: text.slice(a, b), lit: true });
    pos = b;
  }
  if (pos < text.length) out.push({ text: text.slice(pos), lit: false });
  return out;
}

/**
 * «Поймал так» (design-system v2 AssistantCapsule «ввод»): «ПОЙМАЛ ТАК / Будильник · завтра, 08:00 · Дела» above the
 * line while a reminder phrase is typed. «в 7» without «утра / вечера» says it will ask (the ConfirmCard asks).
 */
export function CaughtCard({ c }: { c: Caught }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const time = c.time ? (Number(c.time.slice(0, 2)) <= 12 && !/утра|вечера|дня/.test(c.parts.join(' ')) && c.time.endsWith(':00') ? t('line.caught_ask', { time: c.time }) : c.time) : null;
  const when = [c.day ? t(`line.caught_day.${c.day}`) : null, time].filter(Boolean).join(', ');
  const line = [c.alarm ? t('line.caught_alarm') : t('line.caught_reminder'), when, t('tpl.short.tasks')].filter(Boolean).join(' · ');
  return (
    <View
      testID="caught-card"
      accessibilityLiveRegion="polite"
      style={[
        styles.row,
        { gap: theme.space[3], marginHorizontal: theme.size.tabBarInset, marginBottom: theme.space[2], padding: theme.space[3], borderRadius: theme.radius.xl, backgroundColor: theme.colors.surfaceRaised },
        theme.elevation.floating,
      ]}
    >
      <View style={[styles.square, { width: 36, height: 36, borderRadius: theme.radius.sm, backgroundColor: theme.colors.brandTint }]}>
        <Icon icon={c.alarm ? AlarmClock : BellRing} size="sm" color="brand" />
      </View>
      <View style={styles.flex}>
        <AppText variant="eyebrow" color="brand">
          {t('line.caught')}
        </AppText>
        <AppText testID="caught-line" variant="bodyStrong">
          {line}
        </AppText>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  square: { alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1 },
});
