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
 * v5 «Ляжет в …» (design-system §11.12 «Клавиатура», Ф-78): while a phrase the phone's code understood is typed, a
 * capsule 28 high above the strip — «Ляжет в Дела · будильник · завтра, 08:00». A preview only: nothing is set from
 * it; the server reads the sent phrase as before (ConfirmCard). Unknown parts are left out, never guessed.
 */
export function CaughtCard({ c }: { c: Caught }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const time = c.time ? (Number(c.time.slice(0, 2)) <= 12 && !/утра|вечера|дня/.test(c.parts.join(' ')) && c.time.endsWith(':00') ? t('line.caught_ask', { time: c.time }) : c.time) : null;
  const when = [c.day ? t(`line.caught_day.${c.day}`) : null, time].filter(Boolean).join(', ');
  const kind = (c.alarm ? t('line.caught_alarm') : t('line.caught_reminder')).toLowerCase();
  const line = [t('ask.goes_to', { place: t('tpl.short.tasks') }), kind, when].filter(Boolean).join(' · ');
  return (
    <View
      testID="caught-card"
      accessibilityLiveRegion="polite"
      style={[
        styles.row,
        {
          alignSelf: 'flex-start',
          gap: 8,
          minHeight: 28,
          paddingHorizontal: 12,
          borderRadius: 14,
          marginLeft: theme.m.ask.inset + 2,
          marginRight: theme.m.ask.inset,
          marginBottom: 6,
          backgroundColor: theme.colors.paper2,
        },
      ]}
    >
      <Icon icon={c.alarm ? AlarmClock : BellRing} size="sm" color="ink2" />
      <AppText testID="caught-line" style={{ flexShrink: 1, color: theme.colors.ink2, fontFamily: theme.type.sheetMeta.fontFamily, fontSize: 14, lineHeight: 18 }}>
        {line}
      </AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  square: { alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1 },
});
