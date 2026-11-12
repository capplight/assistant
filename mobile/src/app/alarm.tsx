import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Linking, View } from 'react-native';

import { phoneIn, timeText } from '@/alarms/format';
import { isOpen } from '@/alarms/plan';
import { clampSnoozeMinutes } from '@/alarms/port';
import { act } from '@/alarms/service';
import { useAlarms } from '@/alarms/store';
import { AppText } from '@/components/AppText';
import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/Screen';
import { useToast } from '@/store/toast';
import { useTheme } from '@/theme';

const MIN = 60_000;

/**
 * Our S14 in the app (2-design S14): after the system alarm on iOS (variant C, «без фона-тревоги»),
 * after a tap on the notification (variants B/D, Expo Go), from the Android notification of an
 * «Уведомление». The full-screen S14 over the lock screen (variant A) is native (AlarmActivity.kt).
 */
export default function AlarmScreen() {
  const theme = useTheme();
  const { t } = useTranslation();
  const { group = '' } = useLocalSearchParams<{ group?: string }>();
  const fire = useAlarms((s) => s.fires[group]);
  const reminder = useAlarms((s) => (fire ? s.reminders[fire.reminder_id] : undefined));
  const local = useAlarms((s) => s.local[group]);
  const showToast = useToast((s) => s.show);
  const [other, setOther] = useState(false);

  const leave = () => (router.canGoBack() ? router.back() : router.replace('/'));
  const open = !!fire && isOpen(fire, reminder, local);

  if (!fire || !reminder || !open) {
    return (
      <Screen testID="alarm-screen" footer={<Button testID="alarm-close" label={t('alarm.close')} onPress={leave} />}>
        <AppText testID="alarm-closed">{t('alarm.closed')}</AppText>
      </Screen>
    );
  }

  const due = local?.snoozedUntil ?? Date.parse(fire.fire_at);
  const phone = phoneIn(reminder.title);
  const done = async () => {
    await act(group, 'done');
    showToast(t('alarm.done_toast'), 2000);
    leave();
  };
  const snooze = async (chosen: number) => {
    const minutes = clampSnoozeMinutes(chosen, useAlarms.getState().snoozeMaxHours);
    await act(group, 'snooze', minutes);
    showToast(t('alarm.snoozed_toast', { time: timeText(Date.now() + minutes * MIN) }), 3000);
    leave();
  };
  const tomorrow = () => Math.max(1, Math.round((Date.parse(fire.fire_at) + 24 * 60 * MIN - Date.now()) / MIN));

  return (
    <Screen testID="alarm-screen">
      <AppText variant="callout" color="danger" accessibilityRole="header">
        {`🔔 ${t('alarm.heading')}`}
      </AppText>
      <AppText style={{ fontSize: 72, lineHeight: 80, fontFamily: theme.type.largeTitle.fontFamily }}>{timeText(due)}</AppText>
      <AppText testID="alarm-title" variant="largeTitle" style={{ marginBottom: theme.space[6] }}>
        {reminder.title}
      </AppText>
      <View style={{ gap: theme.space[3] }}>
        <Button testID="alarm-done" label={t('alarm.done')} minHeight={72} onPress={() => void done()} />
        <Button testID="alarm-snooze" label={t('alarm.snooze')} variant="secondary" minHeight={64} onPress={() => void snooze(10)} />
        {phone ? (
          <Button
            testID="alarm-call"
            label={`${t('alarm.call')} ${phone}`}
            variant="secondary"
            onPress={() => void Linking.openURL(`tel:${phone.replace(/[^\d+]/g, '')}`)}
          />
        ) : null}
        <Button testID="alarm-other" label={t('alarm.other_time')} variant="text" onPress={() => setOther((v) => !v)} />
        {other ? (
          <View style={{ gap: theme.space[2] }}>
            <Button testID="alarm-in-5" label={t('alarm.in_5')} variant="secondary" onPress={() => void snooze(5)} />
            <Button testID="alarm-in-30" label={t('alarm.in_30')} variant="secondary" onPress={() => void snooze(30)} />
            <Button testID="alarm-in-60" label={t('alarm.in_60')} variant="secondary" onPress={() => void snooze(60)} />
            <Button testID="alarm-tomorrow" label={t('alarm.tomorrow')} variant="secondary" onPress={() => void snooze(tomorrow())} />
          </View>
        ) : null}
      </View>
    </Screen>
  );
}
