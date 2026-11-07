import { Mic } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { useTheme } from '@/theme';
import { formatTimer } from '@/voice/session';

import { AppText } from './AppText';
import { Button } from './Button';

type Props = {
  elapsedMs: number;
  /** 0…1 from metering. */
  level: number;
  continuing: boolean;
  kkBeta: boolean;
  onDone: () => void;
  onCancel: () => void;
};

/**
 * S07 «Слушаю» (2-design §4.3, S07): level ring + «Слушаю… 0:12» + «Отмена» / «Готово».
 * No live transcription (R-17). The ring is a stepped scale, not a looping animation —
 * acceptable with Reduce Motion as well.
 */
export function VoiceListening({ elapsedMs, level, continuing, kkBeta, onDone, onCancel }: Props) {
  const theme = useTheme();
  const { t } = useTranslation();
  const ring = 96;
  const timer = formatTimer(elapsedMs);
  return (
    <View testID="assistant-listening" style={{ gap: theme.space[3], paddingVertical: theme.space[2] }}>
      <View style={styles.row} accessibilityLiveRegion="polite">
        <AppText variant="bodyStrong" style={styles.flex}>
          {t('line.listening')}
        </AppText>
        <AppText variant="meta" testID="voice-timer" accessibilityLabel={t('voice.timer_a11y', { time: timer })}>
          {timer}
        </AppText>
      </View>
      <View style={[styles.center, { height: ring * 1.5 }]}>
        <View
          testID="voice-level-ring"
          style={[
            styles.abs,
            {
              width: ring,
              height: ring,
              borderRadius: ring / 2,
              borderWidth: 3,
              borderColor: theme.colors.accent,
              opacity: 0.35 + 0.5 * level,
              transform: [{ scale: 1 + 0.4 * level }],
            },
          ]}
        />
        <View
          style={[
            styles.center,
            { width: ring, height: ring, borderRadius: ring / 2, backgroundColor: theme.colors.accent },
          ]}
        >
          <Mic size={40} color={theme.colors.onAccent} />
        </View>
      </View>
      {continuing ? (
        <AppText variant="meta" accessibilityLiveRegion="polite">
          {t('voice.continue')}
        </AppText>
      ) : null}
      {kkBeta ? <AppText variant="meta">{t('voice.kk_beta')}</AppText> : null}
      <View style={[styles.row, { gap: theme.space[3] }]}>
        <Button
          testID="assistant-listening-cancel"
          label={t('voice.cancel')}
          variant="outline"
          style={styles.flex}
          onPress={onCancel}
        />
        <Button testID="assistant-listening-done" label={t('line.done')} style={styles.flex} onPress={onDone} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
  abs: { position: 'absolute' },
});
