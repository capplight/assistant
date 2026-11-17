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
import { Header } from '@/components/ui/Header';
import { Row, RowMeta } from '@/components/ui/Leaf';
import { Sheet } from '@/components/ui/Sheet';
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
  const { t, i18n } = useTranslation();
  const { group = '' } = useLocalSearchParams<{ group?: string }>();
  const fire = useAlarms((s) => s.fires[group]);
  const reminder = useAlarms((s) => (fire ? s.reminders[fire.reminder_id] : undefined));
  const local = useAlarms((s) => s.local[group]);
  const showToast = useToast((s) => s.show);
  const [other, setOther] = useState(false);
  // The ready times of «Другое время» count from when the sheet is shown (a render must not read the clock).
  const [shownAt, setShownAt] = useState(0);

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
  const tomorrow = (from: number) => Math.max(1, Math.round((Date.parse(fire.fire_at) + 24 * 60 * MIN - from) / MIN));

  // screens-v5-extra «Будильник на весь экран»: the lilac sheet of «Дела» — «Будильник-напоминание», the time as the
  // one big number (72, read from a distance), the title and the day; one main button «Сделано».
  let day = '';
  try {
    day = new Date(due).toLocaleDateString(i18n.language, { weekday: 'long', day: 'numeric', month: 'long' });
  } catch {
    day = '';
  }
  return (
    <Screen
      testID="alarm-screen"
      place="tasks"
      sheetExtra={
        <View>
          <AppText
            nativeID="v5-capped"
            maxFontSizeMultiplier={theme.m.heroMaxScale}
            style={[theme.type.bigNumber, { color: theme.colors.onSheet, fontSize: 72, lineHeight: 76, letterSpacing: -2.5, marginTop: 4 }]}
          >
            {timeText(due)}
          </AppText>
          <AppText testID="alarm-title" style={[theme.type.title, { color: theme.colors.onSheet, marginTop: 2 }]}>
            {reminder.title}
          </AppText>
          {day ? (
            <AppText variant="sheetMeta" style={{ color: theme.colors.onSheet2, marginTop: 4, lineHeight: 20 }}>
              {t('alarm.from_tasks', { day })}
            </AppText>
          ) : null}
        </View>
      }
      hideTitle
    >
      <Header title={t('alarm.heading')} meta={t('alarm.heading')} />
      <View style={{ gap: theme.space[3] }}>
        <Button testID="alarm-done" label={t('alarm.done')} onPress={() => void done()} />
        {phone ? (
          <Button
            testID="alarm-call"
            label={`${t('alarm.call')} · ${phone}`}
            variant="secondary"
            onPress={() => void Linking.openURL(`tel:${phone.replace(/[^\d+]/g, '')}`)}
          />
        ) : null}
        <Button testID="alarm-snooze" label={t('alarm.snooze')} variant="secondary" onPress={() => void snooze(10)} />
        <Button
          testID="alarm-other"
          label={t('alarm.other_time')}
          variant="link"
          onPress={() => {
            setShownAt(Date.now());
            setOther((v) => !v);
          }}
        />
      </View>
      {/* «Другое время»: the sheet with the lilac strip, the ready time on the right of each row. */}
      <Sheet testID="alarm-other-sheet" visible={other} onClose={() => setOther(false)} title={t('alarm.again')} place="tasks">
        <View>
          {[
            { id: 'alarm-in-5', label: t('alarm.in_5'), minutes: 5 },
            { id: 'alarm-in-30', label: t('alarm.in_30'), minutes: 30 },
            { id: 'alarm-in-60', label: t('alarm.in_60'), minutes: 60 },
            { id: 'alarm-tomorrow', label: t('alarm.tomorrow'), minutes: tomorrow(shownAt) },
          ].map((o, i) => (
            <Row key={o.id} first={i === 0} testID={o.id} accessibilityLabel={o.label} onPress={() => void snooze(o.minutes)}>
              <AppText style={{ flex: 1 }}>{o.label}</AppText>
              <RowMeta>{timeText(shownAt + o.minutes * MIN)}</RowMeta>
            </Row>
          ))}
        </View>
      </Sheet>
    </Screen>
  );
}
