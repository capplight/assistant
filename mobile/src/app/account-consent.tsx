import { Redirect, router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { acceptAccountConsent } from '@/account/switch';
import { AppText } from '@/components/AppText';
import { Button } from '@/components/Button';
import { ConsentForm } from '@/consent/ConsentForm';
import { useOnboarding } from '@/store/onboarding';
import { useSession } from '@/store/session';
import { useToast } from '@/store/toast';
import { useTheme } from '@/theme';

/**
 * S05 again: this account has no consent of its own, and what was accepted on another account is
 * never reused (docs/api/auth.md). Nothing goes to or comes from it until the person agrees.
 * «Позже» is real: a consent one cannot put off is not free. The app then works on this phone alone,
 * and S05 comes back at the next launch and from «Ещё».
 */
export default function AccountConsentScreen() {
  const theme = useTheme();
  const { t } = useTranslation();
  const showToast = useToast((s) => s.show);
  const postpone = useSession((s) => s.postponeConsent);
  const [needed] = useState(() => useOnboarding.getState().accountConsent);
  if (!needed) return <Redirect href="/" />;

  return (
    <ConsentForm
      intro={
        needed.switched ? (
          <View testID="account-consent-intro" style={{ gap: theme.space[2], marginBottom: theme.space[5] }}>
            <AppText variant="title2" accessibilityRole="header">
              {t('account_consent.title')}
            </AppText>
            <AppText>{t('account_consent.body')}</AppText>
          </View>
        ) : null
      }
      footer={
        <Button
          testID="account-consent-later"
          label={t('account_consent.later')}
          variant="text"
          onPress={() => {
            postpone();
            router.replace('/');
          }}
        />
      }
      onAccept={async (mode, request) => {
        await acceptAccountConsent(mode, request);
        if (needed.switched) showToast(t('phone.switched'), 4000);
        // Asked here, not before: a name typed earlier would have gone to the wrong account.
        if (useOnboarding.getState().displayName) router.replace('/');
        else router.replace('/phone?step=name&next=home');
      }}
    />
  );
}
