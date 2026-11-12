import { router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { kickSync } from '@/services';
import { restoreAccount, startOver, untilText, useAccount } from '@/account/data';
import { AppText } from '@/components/AppText';
import { Button } from '@/components/ui/Button';
import { Screen } from '@/components/Screen';
import { useTheme } from '@/theme';

/**
 * After the «Да» of S32 (and when a sign-in meets an account being deleted): «Аккаунт удаляется.
 * До 18 ноября можно передумать» [Восстановить]. Nothing of the account is left on this phone;
 * «Восстановить» brings it back with all its data through /sync. After the date: «Начать заново».
 */
export default function AccountDeletingScreen() {
  const theme = useTheme();
  const { t } = useTranslation();
  const deleting = useAccount((s) => s.deleting);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [openedAt] = useState(() => Date.now());
  const over = !deleting || (deleting.deleteAfter !== null && Date.parse(deleting.deleteAfter) <= openedAt);

  const restore = async () => {
    setBusy(true);
    setNote(null);
    const r = await restoreAccount();
    setBusy(false);
    if (r === 'restored') {
      kickSync();
      router.replace('/');
    } else if (r === 'need_sms') router.push({ pathname: '/phone', params: { reason: 'expired' } });
    else if (r === 'done') setNote(t('account.gone'));
    else setNote(r.error);
  };

  return (
    <Screen testID="account-deleting-screen">
      <AppText variant="largeTitle" accessibilityRole="header" style={{ marginBottom: theme.space[3] }}>
        {over ? t('account.gone_title') : t('account.deleting_title')}
      </AppText>
      <AppText testID="deleting-message">
        {over ? t('account.gone') : deleting?.message || t('account.deleting')}
      </AppText>
      {!over && deleting?.deleteAfter ? (
        <AppText variant="callout" style={{ marginTop: theme.space[2] }}>
          {t('account.restore_until', { until: untilText(deleting.deleteAfter) })}
        </AppText>
      ) : null}
      {note ? (
        <AppText testID="deleting-note" color="danger" accessibilityLiveRegion="polite" style={{ marginTop: theme.space[3] }}>
          {note}
        </AppText>
      ) : null}
      <View style={{ marginTop: theme.space[6], gap: theme.space[3] }}>
        {!over ? <Button testID="deleting-restore" label={t('account.restore')} disabled={busy} onPress={() => void restore()} /> : null}
        {over ? (
          <Button
            testID="deleting-start-over"
            label={t('account.start_over')}
            variant="secondary"
            onPress={() => void startOver().then(() => router.replace('/welcome'))}
          />
        ) : null}
      </View>
    </Screen>
  );
}
