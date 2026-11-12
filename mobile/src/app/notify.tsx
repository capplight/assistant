import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { refreshCaps } from '@/alarms/service';
import { useAlarms } from '@/alarms/store';
import { AppText } from '@/components/AppText';
import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/Screen';
import { getAlarmPort } from '@/services';
import { useTheme } from '@/theme';

/**
 * S04 (R-12): only the notification window. Path 3 shows it after the first phrase (`next=gallery`
 * with the S35 params); any path shows it after the first reminder. Asked by itself once; a refusal
 * is said plainly (2-design 7, «Нет уведомлений»), the steps of S15 come later.
 */
export default function NotifyScreen() {
  const theme = useTheme();
  const { t } = useTranslation();
  const { saved, next, mark } = useLocalSearchParams<{ saved?: string; next?: string; mark?: string }>();
  const [state, setState] = useState(useAlarms.getState().caps?.notifications ?? 'undetermined');

  const go = () => {
    useAlarms.getState().set({ notifyAskedAt: useAlarms.getState().notifyAskedAt ?? new Date().toISOString() });
    if (next === 'gallery') router.replace({ pathname: '/gallery', params: { from: 'phrase', mark: mark ?? '' } });
    else if (router.canGoBack()) router.back();
    else router.replace('/');
  };

  const allow = async () => {
    useAlarms.getState().set({ notifyAskedAt: new Date().toISOString() });
    const answer = await getAlarmPort().requestNotifications();
    setState(answer);
    await refreshCaps();
    if (answer === 'granted') go();
  };

  return (
    <Screen
      testID="notify-screen"
      footer={
        <View style={{ gap: theme.space[2] }}>
          {state !== 'granted' ? <Button testID="notify-allow" label={t('notify.allow')} onPress={() => void allow()} /> : null}
          <Button testID="notify-next" label={next === 'gallery' ? t('notify.next') : t('notify.later')} variant="text" onPress={go} />
        </View>
      }
    >
      {saved ? (
        <>
          <AppText variant="largeTitle" accessibilityRole="header">
            {t('notify.title')}
          </AppText>
          <View
            style={{
              marginTop: theme.space[3],
              marginBottom: theme.space[6],
              padding: theme.space[4],
              borderRadius: theme.radius.lg,
              borderWidth: 1,
              borderColor: theme.colors.separator,
              backgroundColor: theme.colors.surface,
            }}
          >
            <AppText testID="notify-saved">{saved}</AppText>
          </View>
        </>
      ) : null}
      <AppText variant="title2" accessibilityRole={saved ? undefined : 'header'}>
        {t('notify.block')}
      </AppText>
      {state === 'denied' ? (
        <AppText testID="notify-denied" color="warning" style={{ marginTop: theme.space[3] }}>
          {t('notify.denied')}
        </AppText>
      ) : null}
      {state === 'granted' ? (
        <AppText testID="notify-granted" color="success" style={{ marginTop: theme.space[3] }}>
          {t('notify.granted')}
        </AppText>
      ) : null}
    </Screen>
  );
}
