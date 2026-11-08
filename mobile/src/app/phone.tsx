import { getLocales } from 'expo-localization';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, TextInput, View } from 'react-native';

import { confirmPhone, saveDisplayName, sendPhoneCode } from '@/account/phone';
import { s15AfterPhone } from '@/alarms/setup';
import { useAlarms } from '@/alarms/store';
import { errorMessage, NetworkError } from '@/api/errors';
import { AppText } from '@/components/AppText';
import { Button } from '@/components/Button';
import { Screen } from '@/components/Screen';
import { useOnboarding } from '@/store/onboarding';
import { useSession } from '@/store/session';
import { useToast } from '@/store/toast';
import { MAX_FONT_SCALE, useTheme } from '@/theme';

/** +7 Kazakhstan, +996 Kyrgyzstan: digits after the code. */
const COUNTRIES = [
  { code: '+7', digits: 10 },
  { code: '+996', digits: 9 },
] as const;

/** No SIM access without a native module: the phone's region is the closest thing. */
function defaultCountry(): 0 | 1 {
  try {
    return getLocales()[0]?.regionCode === 'KG' ? 1 : 0;
  } catch {
    return 0;
  }
}

type Step = 'phone' | 'code' | 'name';

/**
 * S04b «Номер и имя» (F-21): after the first result, once; later from «Ещё». «Позже» always works,
 * with the honest line about losing records. `next=home`: there is no screen to go back to.
 * `reason=expired`: the linked account's session was refused, this is the way back in; local data
 * stays and «Позже» keeps working on this phone alone. `step=name`: only «Как к вам обращаться?».
 */
export default function PhoneScreen() {
  const theme = useTheme();
  const { t } = useTranslation();
  const { next, reason, step: startStep } = useLocalSearchParams<{ next?: string; reason?: string; step?: string }>();
  const expired = reason === 'expired';
  const markPhoneAsked = useOnboarding((s) => s.markPhoneAsked);
  const language = useOnboarding((s) => s.language);
  const showToast = useToast((s) => s.show);

  const [step, setStep] = useState<Step>(startStep === 'name' ? 'name' : 'phone');
  const [country, setCountry] = useState<0 | 1>(defaultCountry);
  const [number, setNumber] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [challengeId, setChallengeId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** S04b opened by itself for the first time (not from «Ещё», not a sign-in again). */
  const firstTime = useRef(useOnboarding.getState().phoneAskedAt === null);

  useEffect(() => {
    markPhoneAsked();
  }, [markPhoneAsked]);

  const leave = () => {
    if (useSession.getState().needsSignIn) useSession.getState().postponeSignIn();
    const a = useAlarms.getState();
    if (!expired && firstTime.current && !a.offeredAt && s15AfterPhone(a.caps)) {
      // Back to where S04b was opened from (the page), or «Сегодня» at the end of the first launch.
      router.replace({ pathname: '/alarm-setup', params: next === 'home' || !router.canGoBack() ? { next: 'home' } : {} });
      return;
    }
    if (expired || next === 'home' || !router.canGoBack()) router.replace('/');
    else router.back();
  };

  const { code: dial, digits } = COUNTRIES[country];
  const phone = `${dial}${number}`;

  const failed = (e: unknown) =>
    setError(e instanceof NetworkError ? t('phone.offline') : errorMessage(e, language, t));

  const requestCode = async () => {
    if (number.length !== digits) {
      setError(t('phone.bad_number', { n: digits }));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const out = await sendPhoneCode(phone);
      setChallengeId(out.challenge_id);
      setCode(out.dev_code ?? '');
      setStep('code');
    } catch (e) {
      failed(e);
    } finally {
      setBusy(false);
    }
  };

  const verify = async () => {
    setBusy(true);
    setError(null);
    try {
      const out = await confirmPhone({ challengeId, phone, code });
      if (out.needsConsent) {
        router.replace('/account-consent'); // it asks for the name afterwards
        return;
      }
      if (out.switched) showToast(t('phone.switched'), 4000);
      if (expired && out.user.display_name) {
        leave(); // back to where they were: nothing to ask
        return;
      }
      setName(out.user.display_name ?? '');
      setStep('name');
    } catch (e) {
      failed(e);
    } finally {
      setBusy(false);
    }
  };

  const fieldStyle = [
    theme.type.body,
    {
      minHeight: theme.size.primaryTouch,
      borderWidth: 1,
      borderColor: theme.colors.lineStrong,
      borderRadius: theme.radius.input,
      paddingHorizontal: theme.space[3],
      color: theme.colors.ink,
      backgroundColor: theme.colors.surface,
    },
  ];

  const errorLine = error ? (
    <AppText testID="phone-error" color="alarm" accessibilityLiveRegion="polite">
      {error}
    </AppText>
  ) : null;

  return (
    <Screen testID="phone-screen">
      {step === 'phone' ? (
        <View style={{ gap: theme.space[4] }}>
          <AppText variant="title1" accessibilityRole="header">
            {expired ? t('phone.expired_title') : t('phone.title')}
          </AppText>
          {expired ? <AppText testID="phone-expired">{t('phone.expired_body')}</AppText> : null}
          <View style={{ flexDirection: 'row', gap: theme.space[2] }}>
            <Pressable
              testID="phone-country"
              accessibilityRole="button"
              accessibilityLabel={t('phone.country', { code: dial })}
              onPress={() => {
                setCountry(country === 0 ? 1 : 0);
                setError(null);
              }}
              style={{
                minHeight: theme.size.primaryTouch,
                minWidth: theme.size.primaryTouch,
                paddingHorizontal: theme.space[3],
                alignItems: 'center',
                justifyContent: 'center',
                borderWidth: 1,
                borderColor: theme.colors.lineStrong,
                borderRadius: theme.radius.input,
              }}
            >
              <AppText variant="number">{dial}</AppText>
            </Pressable>
            <TextInput
              testID="phone-number"
              accessibilityLabel={t('phone.number_label')}
              placeholder={t('phone.number_label')}
              placeholderTextColor={theme.colors.ink2}
              keyboardType="phone-pad"
              autoComplete="tel-national"
              textContentType="telephoneNumber"
              value={number}
              onChangeText={(v) => setNumber(v.replace(/\D/g, '').slice(0, digits))}
              maxFontSizeMultiplier={MAX_FONT_SCALE}
              style={[fieldStyle, { flex: 1 }]}
            />
          </View>
          {errorLine}
          <Button testID="phone-get-code" label={t('phone.get_code')} disabled={busy || !number} onPress={requestCode} />
          <Button testID="phone-later" label={t('phone.later')} variant="outline" onPress={leave} />
          <AppText variant="meta">{expired ? t('phone.expired_later') : t('phone.warn')}</AppText>
        </View>
      ) : null}

      {step === 'code' ? (
        <View style={{ gap: theme.space[4] }}>
          <AppText variant="title1" accessibilityRole="header">
            {t('phone.code_title')}
          </AppText>
          <AppText>{t('phone.code_sent', { phone })}</AppText>
          <TextInput
            testID="phone-code"
            accessibilityLabel={t('phone.code_title')}
            keyboardType="number-pad"
            autoComplete="sms-otp"
            textContentType="oneTimeCode"
            value={code}
            onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))}
            maxFontSizeMultiplier={MAX_FONT_SCALE}
            style={fieldStyle}
          />
          {errorLine}
          <Button
            testID="phone-verify"
            label={t('phone.confirm')}
            disabled={busy || code.length !== 6}
            onPress={verify}
          />
          <Button testID="phone-resend" label={t('phone.resend')} variant="text" disabled={busy} onPress={requestCode} />
          <Button
            testID="phone-change"
            label={t('phone.change')}
            variant="text"
            onPress={() => {
              setError(null);
              setStep('phone');
            }}
          />
          <Button testID="phone-code-later" label={t('phone.later')} variant="outline" onPress={leave} />
        </View>
      ) : null}

      {step === 'name' ? (
        <View style={{ gap: theme.space[4] }}>
          <AppText variant="title1" accessibilityRole="header">
            {t('phone.name_title')}
          </AppText>
          <TextInput
            testID="phone-name"
            accessibilityLabel={t('phone.name_title')}
            placeholder={t('phone.name_placeholder')}
            placeholderTextColor={theme.colors.ink2}
            autoComplete="name"
            textContentType="name"
            value={name}
            onChangeText={setName}
            maxLength={60}
            maxFontSizeMultiplier={MAX_FONT_SCALE}
            style={fieldStyle}
          />
          <Button
            testID="phone-name-done"
            label={t('phone.done')}
            disabled={!name.trim()}
            onPress={() => {
              void saveDisplayName(name);
              leave();
            }}
          />
          <Button testID="phone-name-skip" label={t('phone.skip')} variant="text" onPress={leave} />
        </View>
      ) : null}
    </Screen>
  );
}
