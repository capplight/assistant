import { Check } from 'lucide-react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AppState, Linking, View } from 'react-native';

import { timeText } from '@/alarms/format';
import { drain, refreshCaps, replan, startTest, testTimedOut } from '@/alarms/service';
import { noAlarmScreen, setupSteps, silentModeWarning, type SetupStep, type StepKey } from '@/alarms/setup';
import { useAlarms } from '@/alarms/store';
import { AppText } from '@/components/AppText';
import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/Screen';
import { Header } from '@/components/ui/Header';
import { getAlarmPort } from '@/services';
import { useTheme } from '@/theme';

/** Support chat (Ф-13: who answers and the number are not decided). Empty → no button. */
const SUPPORT_WHATSAPP = (process.env.EXPO_PUBLIC_SUPPORT_WHATSAPP ?? '').replace(/\D/g, '');

const TITLE: Record<StepKey, string> = {
  notifications: 'setup.step_notifications',
  exact: 'setup.step_exact',
  full_screen: 'setup.step_full_screen',
  autostart: 'setup.step_autostart',
  battery: 'setup.step_battery',
  alarmkit: 'setup.step_alarmkit',
};

/**
 * S15 «Надёжность будильников» (2-design S15, R-12, 3-engineering 6.6): each step opens the system
 * screen; on return the phone checks it again (✓ «Готово»). The maker's autostart cannot be
 * checked: «Я включил». «Проверить будильник» rings in 1 minute; «Позже» → the banner on «Сегодня»
 * and «Может опоздать до 10 минут». Android 14+ shows it right after S04b (`next=home`).
 */
export default function AlarmSetupScreen() {
  const theme = useTheme();
  const { t } = useTranslation();
  const { next } = useLocalSearchParams<{ next?: string }>();
  const caps = useAlarms((s) => s.caps);
  const autostartConfirmedAt = useAlarms((s) => s.autostartConfirmedAt);
  const batteryConfirmedAt = useAlarms((s) => s.batteryConfirmedAt);
  const test = useAlarms((s) => s.test);
  const [opened, setOpened] = useState<StepKey[]>([]);

  useEffect(() => {
    if (!useAlarms.getState().offeredAt) useAlarms.getState().set({ offeredAt: new Date().toISOString() });
    void refreshCaps();
    // Back from a system screen: check the steps again, plan with what is now allowed.
    const sub = AppState.addEventListener('change', (s) => {
      if (s !== 'active') return;
      void refreshCaps().then(() => replan());
      void drain();
    });
    return () => sub.remove();
  }, []);

  useEffect(() => {
    if (test.state !== 'waiting') return;
    const timer = setInterval(() => {
      void drain();
      testTimedOut();
    }, 5_000);
    return () => clearInterval(timer);
  }, [test.state]);

  const leave = () => {
    if (next === 'home' || !router.canGoBack()) router.replace('/');
    else router.back();
  };

  const later = () => {
    useAlarms.getState().set({ laterAt: new Date().toISOString() });
    leave();
  };

  const run = async (step: SetupStep) => {
    const port = getAlarmPort();
    if (step.key === 'notifications' && step.target === null) await port.requestNotifications();
    else if (step.key === 'alarmkit' && step.target === null) await port.requestAlarmKit();
    else if (step.target) await port.openSettings(step.target);
    setOpened((o) => (o.includes(step.key) ? o : [...o, step.key]));
    await refreshCaps();
    await replan();
  };

  const confirm = (key: StepKey) => {
    const at = new Date().toISOString();
    useAlarms.getState().set(key === 'autostart' ? { autostartConfirmedAt: at } : { batteryConfirmedAt: at });
    void refreshCaps();
  };

  const steps = caps ? setupSteps(caps, { autostartConfirmedAt, batteryConfirmedAt }) : [];
  const hint = (k: StepKey) =>
    k === 'battery' && caps?.vendor === 'xiaomi' ? t('setup.hint_battery_xiaomi') : t(`setup.hint_${k}`);

  return (
    // screens-v5-extra «Будильник · настройка телефона»: the stone strip, steps as numbered circles (done = a black
    // circle with a tick), «Открыть» beside each, «Проверить будильник» at the end.
    <Screen
      testID="setup-screen"
      mode="strip"
      footer={
        <View style={{ gap: theme.space[2] }}>
          <Button testID="setup-test" label={t('setup.test')} onPress={() => void startTest()} disabled={test.state === 'waiting'} />
          {steps.length > 0 && steps.every((s) => s.done) ? (
            <Button testID="setup-close" label={t('setup.close')} variant="text" onPress={leave} />
          ) : (
            <Button testID="setup-later" label={t('setup.later')} variant="text" onPress={later} />
          )}
        </View>
      }
    >
      <Header title={t('setup.strip_title')} back={{ onPress: leave, label: t('more.settings'), testID: 'setup-back' }} />
      <AppText variant="title1" accessibilityRole="header" style={{ marginBottom: theme.space[4] }}>
        {t('setup.title')}
      </AppText>
      {caps && noAlarmScreen(caps) ? (
        <AppText testID="setup-no-module" color="warning" style={{ marginBottom: theme.space[4] }}>
          {t('setup.no_module')}
        </AppText>
      ) : null}
      {caps && silentModeWarning(caps) ? (
        <AppText testID="setup-ios-silent" color="warning" style={{ marginBottom: theme.space[4] }}>
          {t('setup.ios_silent')}
        </AppText>
      ) : null}
      {steps.map((s, i) => (
        <View
          key={s.key}
          testID={`setup-step-${s.key}`}
          accessible={false}
          style={{ paddingVertical: theme.space[3], borderTopWidth: i === 0 ? 0 : 1, borderTopColor: theme.colors.line, flexDirection: 'row', gap: 12 }}
        >
          <View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={{ width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: s.done ? theme.colors.btn : 'transparent', borderWidth: s.done ? 0 : 1.5, borderColor: theme.colors.ink }}
          >
            {s.done ? <Check size={16} color={theme.colors.onBtn} strokeWidth={3} /> : <AppText variant="buttonSmall">{String(i + 1)}</AppText>}
          </View>
          <View style={{ flex: 1, gap: theme.space[2] }}>
          <AppText
            variant="bodyStrong"
            accessibilityLabel={t(s.done ? 'setup.step_a11y_done' : 'setup.step_a11y_todo', { n: i + 1, step: t(TITLE[s.key]) })}
          >
            {t(TITLE[s.key])}
          </AppText>
          {s.done ? (
            <AppText testID={`setup-done-${s.key}`} variant="footnote">
              {t('setup.step_done')}
            </AppText>
          ) : (
            <>
              <AppText variant="footnote">{hint(s.key)}</AppText>
              <Button
                testID={`setup-open-${s.key}`}
                label={s.target === null ? t('setup.allow') : t('setup.open')}
                variant="secondary"
                size="small"
                style={{ alignSelf: 'flex-start' }}
                onPress={() => void run(s)}
              />
              {s.confirmByHand && opened.includes(s.key) ? (
                <Button testID={`setup-confirm-${s.key}`} label={t('setup.confirm')} variant="link" size="small" onPress={() => confirm(s.key)} />
              ) : null}
            </>
          )}
          </View>
        </View>
      ))}
      <View style={{ marginTop: theme.space[5], gap: theme.space[2] }} accessibilityLiveRegion="polite">
        {test.state === 'idle' ? <AppText variant="callout">{t('setup.test_hint')}</AppText> : null}
        {test.state === 'waiting' ? (
          <AppText testID="setup-test-waiting">{t('setup.test_waiting', { time: timeText(test.dueAt) })}</AppText>
        ) : null}
        {test.state === 'ok' ? (
          <AppText testID="setup-test-ok" variant="bodyStrong">
            {t('setup.test_ok')}
          </AppText>
        ) : null}
        {test.state === 'failed' ? (
          <>
            <AppText testID="setup-test-failed" color="danger">
              {t('setup.test_failed')}
            </AppText>
            {SUPPORT_WHATSAPP ? (
              <Button
                testID="setup-write"
                label={t('setup.write_wa')}
                variant="secondary"
                onPress={() => void Linking.openURL(`https://wa.me/${SUPPORT_WHATSAPP}`)}
              />
            ) : null}
          </>
        ) : null}
        {useAlarms.getState().laterAt && steps.some((s) => !s.done) ? (
          <AppText variant="callout" color="warning">
            {t('setup.later_line')}
          </AppText>
        ) : null}
      </View>
    </Screen>
  );
}
