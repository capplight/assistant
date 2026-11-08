import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';
import { useShallow } from 'zustand/react/shallow';

import { dayText, timeText } from '@/alarms/format';
import { lateRisk, upcoming } from '@/alarms/plan';
import { dropPhrase } from '@/alarms/service';
import { alarmRisk } from '@/alarms/setup';
import { useAlarms } from '@/alarms/store';
import { useTheme } from '@/theme';

import { AppText } from './AppText';
import { Button } from './Button';

/**
 * «Будильники могут не сработать на этом телефоне [Исправить]» (alarm.risk, 2-design 4.8): a step
 * of S15 is not done. Only once there is something to ring or S15 was shown.
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
      style={{
        flexDirection: theme.largeFont ? 'column' : 'row',
        alignItems: theme.largeFont ? 'stretch' : 'center',
        gap: theme.space[2],
        padding: theme.space[3],
        marginBottom: theme.space[4],
        borderRadius: theme.radius.card,
        backgroundColor: theme.colors.markerSoft,
      }}
    >
      <AppText style={{ flex: theme.largeFont ? undefined : 1 }}>{`⚠ ${t('alarm.risk')}`}</AppText>
      <Button testID="alarm-risk-fix" label={t('alarm.fix')} variant="outline" minHeight={theme.size.minTouch} onPress={() => router.push('/alarm-setup')} />
    </View>
  );
}

/** The next reminders (24 h) on «Сегодня»: «Будильник · 10:00 · Позвонить Ерлану». Week 9 brings the full list. */
export function UpcomingReminders() {
  const theme = useTheme();
  const { t } = useTranslation();
  const src = useAlarms(useShallow((s) => ({ reminders: s.reminders, fires: s.fires, local: s.local, deviceId: s.deviceId })));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const list = upcoming({ ...src, now }, 24 * 60 * 60_000);
  const late = useAlarms((s) => lateRisk(s.caps));
  return (
    <View style={{ marginBottom: theme.space[6] }}>
      <AppText variant="section" accessibilityRole="header" style={{ marginBottom: theme.space[3] }}>
        {t('today.upcoming')}
      </AppText>
      {list.map((a) => {
        const level = a.level === 'alarm' ? t('alarm.level_alarm') : t('alarm.level_notification');
        const line = `${a.level === 'alarm' ? '🔔 ' : ''}${level} · ${timeText(a.fireAt)} · ${a.title}`;
        return (
          <Pressable
            key={a.group}
            testID={`upcoming-${a.group}`}
            accessibilityLabel={`${level}. ${timeText(a.fireAt)}. ${a.title}. ${dayText(a.fireAt, now)}`}
            style={{ minHeight: theme.size.minTouch, justifyContent: 'center', borderBottomWidth: 1, borderBottomColor: theme.colors.line, paddingVertical: theme.space[2] }}
          >
            <AppText color={a.level === 'alarm' ? 'alarm' : 'ink'}>{line}</AppText>
            {late ? (
              <AppText variant="meta" color="warnText">
                {t('rem.late_risk')}
              </AppText>
            ) : null}
          </Pressable>
        );
      })}
      <Button
        testID="today-new-reminder"
        label={t('today.new_reminder')}
        variant="outline"
        style={{ marginTop: theme.space[3] }}
        onPress={() => router.push('/reminder-new')}
      />
    </View>
  );
}

/** A phrase that waited for the internet came back parsed: «Проверьте напоминание» → S13. */
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
    <View
      testID="reminder-draft"
      accessibilityLiveRegion="polite"
      style={{ marginHorizontal: theme.space[3], marginBottom: theme.space[2], padding: theme.space[3], gap: theme.space[2], borderRadius: theme.radius.card, backgroundColor: theme.colors.surface, borderWidth: 1, borderColor: theme.colors.line }}
    >
      <AppText numberOfLines={3}>{t('rem.draft_ready', { text: ready.text })}</AppText>
      <View style={{ flexDirection: theme.largeFont ? 'column' : 'row', gap: theme.space[2] }}>
        <Button testID="reminder-draft-open" label={t('rem.check')} variant="outline" style={theme.largeFont ? undefined : { flex: 1 }} onPress={open} />
        <Button testID="reminder-draft-close" label={t('rem.close')} variant="text" style={theme.largeFont ? undefined : { flex: 1 }} onPress={() => dropPhrase(ready.id)} />
      </View>
    </View>
  );
}
