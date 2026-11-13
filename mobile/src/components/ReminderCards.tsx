import { router } from 'expo-router';
import { BellRing, TriangleAlert } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import { dropPhrase } from '@/alarms/service';
import { alarmRisk } from '@/alarms/setup';
import { useAlarms } from '@/alarms/store';
import { useTheme } from '@/theme';

import { AppText } from './AppText';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { Icon } from './ui/Icon';

/**
 * «Будильники могут не сработать на этом телефоне · Исправить» (alarm.risk): a narrow line, not a block
 * (ux-audit P0-3) — only once something rings (a reminder exists) or S15 was shown, and a step of S15 is not done.
 */
export function AlarmRiskBanner() {
  const theme = useTheme();
  const { t } = useTranslation();
  const show = useAlarms((s) => {
    const any = s.offeredAt !== null || Object.values(s.reminders).some((r) => r.kind === 'normal' && !r.deleted_at);
    return any && alarmRisk(s.caps, s);
  });
  if (!show) return null;
  return (
    <View
      testID="alarm-risk"
      accessibilityLiveRegion="polite"
      style={[
        styles.row,
        {
          flexWrap: 'wrap',
          gap: theme.space[2],
          paddingLeft: theme.space[3],
          marginBottom: theme.space[2],
          borderRadius: theme.radius.lg,
          backgroundColor: theme.colors.warningTint,
        },
      ]}
    >
      <Icon icon={TriangleAlert} size="sm" color="warning" />
      <AppText variant="callout" color="ink" style={[styles.flex, { minWidth: 160, paddingVertical: theme.space[2] }]}>
        {t('alarm.risk')}
      </AppText>
      <Button testID="alarm-risk-fix" label={t('alarm.fix')} variant="text" onPress={() => router.push('/alarm-setup')} />
    </View>
  );
}

/** A phrase that waited for the internet came back parsed: «Проверьте напоминание» [Проверить] → S13. */
export function ReminderDraftStrip() {
  const theme = useTheme();
  const { t } = useTranslation();
  const ready = useAlarms((s) => s.drafts[0]);
  if (!ready) return null;
  const open = () => {
    const params: Record<string, string> = { text: ready.text, phraseId: ready.id };
    if (ready.draft) params.draft = JSON.stringify(ready.draft);
    if (ready.options.length > 1) params.options = JSON.stringify(ready.options);
    if (ready.message) params.message = ready.message;
    router.push({ pathname: '/reminder-new', params });
  };
  return (
    <View testID="reminder-draft" accessibilityLiveRegion="polite">
      <Card tone="raised" style={[{ gap: theme.space[2], borderRadius: theme.radius.xl }, theme.elevation.floating]}>
        <View style={[styles.row, { gap: theme.space[2], alignItems: 'flex-start' }]}>
          <Icon icon={BellRing} size="sm" color="brand" />
          <AppText numberOfLines={3} style={styles.flex}>
            {t('rem.draft_ready', { text: ready.text })}
          </AppText>
        </View>
        <View style={[styles.row, { flexWrap: 'wrap', gap: theme.space[2] }]}>
          <Button testID="reminder-draft-open" label={t('rem.check')} variant="secondary" size="small" onPress={open} />
          <Button testID="reminder-draft-close" label={t('rem.close')} variant="text" onPress={() => dropPhrase(ready.id)} />
        </View>
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
});
