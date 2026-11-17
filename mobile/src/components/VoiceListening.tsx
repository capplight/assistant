import { Check, PencilLine, X } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';
import { formatTimer } from '@/voice/session';

import { AppText } from './AppText';
import { pressedStyle } from './ui/motion';

type Props = {
  elapsedMs: number;
  /** 0…1 from metering. */
  level: number;
  continuing: boolean;
  kkBeta: boolean;
  onDone: () => void;
  onCancel: () => void;
  /** «Текстом»: stop listening and write instead (the `full` view only). */
  onText?: () => void;
  /** `strip` (the line on a tab: ≥ 64 high) or `full` (the «Помощник» tab, screens-v5 «Помощник · голос»). */
  variant?: 'strip' | 'full';
};

const BARS = 25;

/** The level as a wave in the colour of the text (no glow); the recent part solid, the rest at 30 %. */
function Wave({ levels, height, bar, gap }: { levels: number[]; height: number; bar: number; gap: number }) {
  const theme = useTheme();
  return (
    <View testID="voice-level-ring" style={{ height }}>
      <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.wave, { height, gap }]}>
        {levels.map((l, i) => (
          <View key={i} style={{ width: bar, height: Math.max(bar, l * height), borderRadius: bar / 2, backgroundColor: theme.colors.ink, opacity: i < levels.length - 9 ? 1 : 0.3 }} />
        ))}
      </View>
    </View>
  );
}

/**
 * «Слушаю» v5 (screens-v5 «Помощник · голос», §11.12 «Голос»). No live transcription (R-17): the time and the level
 * show that it hears. `full`: the terracotta dot and «Слушаю», the wave, «Говорите сколько нужно», one main «Готово»
 * 84 between «Отмена» and «Текстом» 56. `strip`: «Отмена» · «Слушаю» + wave · «Готово» in one row.
 */
export function VoiceListening({ elapsedMs, level, continuing, kkBeta, onDone, onCancel, onText, variant = 'strip' }: Props) {
  const theme = useTheme();
  const { t } = useTranslation();
  const timer = formatTimer(elapsedMs);
  const [levels, setLevels] = useState<number[]>(() => Array.from({ length: BARS }, () => 0.1));
  const [lastLevel, setLastLevel] = useState(level);
  if (lastLevel !== level) {
    setLastLevel(level);
    setLevels((ls) => [...ls.slice(1), Math.max(0.1, Math.min(1, level))]);
  }
  const c = theme.colors;
  const round = (d: number, filled: boolean) => [styles.center, { width: d, height: d, borderRadius: d / 2 }, filled ? { backgroundColor: c.btn } : { borderWidth: 1.5, borderColor: c.ink }];
  const listeningLabel = (
    <View style={[styles.row, { gap: 8, justifyContent: variant === 'full' ? 'center' : 'flex-start' }]} accessibilityLiveRegion="polite">
      <View style={[styles.dot, { backgroundColor: c.place.assistant }]} />
      <AppText style={{ fontFamily: theme.type.headline.fontFamily, fontSize: variant === 'full' ? 15 : 14, lineHeight: 18, color: c.ink2 }}>{t('line.listening')}</AppText>
      <AppText variant="small" color="ink3" testID="voice-timer" accessibilityLabel={t('voice.timer_a11y', { time: timer })} style={{ fontVariant: ['tabular-nums'] }}>
        {timer}
      </AppText>
    </View>
  );
  const notes = (
    <>
      {continuing ? (
        <AppText variant="callout" accessibilityLiveRegion="polite" style={variant === 'full' ? styles.centerText : undefined}>
          {t('voice.continue')}
        </AppText>
      ) : null}
      {kkBeta ? (
        <AppText variant="callout" style={variant === 'full' ? styles.centerText : undefined}>
          {t('voice.kk_beta')}
        </AppText>
      ) : null}
    </>
  );

  if (variant === 'full')
    return (
      <View testID="assistant-listening" style={{ paddingTop: 4, paddingBottom: 18, gap: 18 }}>
        {listeningLabel}
        <Wave levels={levels} height={64} bar={6} gap={6} />
        <AppText variant="small" style={styles.centerText}>
          {t('voice.pauses_ok')}
        </AppText>
        {notes}
        <View style={[styles.row, { justifyContent: 'center', gap: 34, alignItems: 'flex-start' }]}>
          <Pressable testID="assistant-listening-cancel" accessibilityRole="button" accessibilityLabel={t('voice.cancel')} onPress={onCancel} style={({ pressed }) => [styles.col, pressedStyle(pressed)]}>
            <View style={round(56, false)}>
              <X size={22} color={c.ink} strokeWidth={theme.icon.strokeWidth} />
            </View>
            <AppText style={{ fontFamily: theme.type.sheetMeta.fontFamily, fontSize: 14, lineHeight: 18, color: c.ink2 }}>{t('voice.cancel')}</AppText>
          </Pressable>
          <Pressable testID="assistant-listening-done" accessibilityRole="button" accessibilityLabel={t('line.done')} onPress={onDone} style={({ pressed }) => [styles.col, pressedStyle(pressed)]}>
            <View style={round(84, true)}>
              <Check size={30} color={c.onBtn} strokeWidth={theme.icon.strokeWidth} />
            </View>
            <AppText style={{ fontFamily: theme.type.headline.fontFamily, fontSize: 15, lineHeight: 18 }}>{t('line.done')}</AppText>
          </Pressable>
          {onText ? (
            <Pressable testID="assistant-listening-text" accessibilityRole="button" accessibilityLabel={t('voice.as_text')} onPress={onText} style={({ pressed }) => [styles.col, pressedStyle(pressed)]}>
              <View style={round(56, false)}>
                <PencilLine size={22} color={c.ink} strokeWidth={theme.icon.strokeWidth} />
              </View>
              <AppText style={{ fontFamily: theme.type.sheetMeta.fontFamily, fontSize: 14, lineHeight: 18, color: c.ink2 }}>{t('voice.as_text')}</AppText>
            </Pressable>
          ) : null}
        </View>
      </View>
    );

  return (
    <View testID="assistant-listening" style={{ gap: 6, padding: 8 }}>
      <View style={[styles.row, { gap: 10, minHeight: 48 }]}>
        <Pressable testID="assistant-listening-cancel" accessibilityRole="button" accessibilityLabel={t('voice.cancel')} onPress={onCancel} hitSlop={4} style={({ pressed }) => [round(40, false), pressedStyle(pressed)]}>
          <X size={20} color={c.ink} strokeWidth={theme.icon.strokeWidth} />
        </Pressable>
        <View style={styles.flex}>
          {listeningLabel}
          <Wave levels={levels.slice(-14)} height={18} bar={3} gap={3} />
        </View>
        <Pressable testID="assistant-listening-done" accessibilityRole="button" accessibilityLabel={t('line.done')} onPress={onDone} hitSlop={4} style={({ pressed }) => [round(40, true), pressedStyle(pressed)]}>
          <Check size={20} color={c.onBtn} strokeWidth={theme.icon.strokeWidth} />
        </Pressable>
      </View>
      {notes}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  col: { alignItems: 'center', gap: 8, minWidth: 56 },
  flex: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
  centerText: { textAlign: 'center' },
  dot: { width: 9, height: 9, borderRadius: 5 },
  wave: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
});
