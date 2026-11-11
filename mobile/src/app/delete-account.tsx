import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, TextInput, View } from 'react-native';

import { confirmDeletion, loadDeletionState, sendDeletionCode } from '@/account/data';
import type { DeletionStateOut } from '@/api/types';
import { AppText } from '@/components/AppText';
import { Button } from '@/components/Button';
import { Screen } from '@/components/Screen';
import { useOnboarding } from '@/store/onboarding';
import { MAX_FONT_SCALE, useTheme } from '@/theme';

/**
 * S32 «Удалить аккаунт и все данные» (US-20, F-27, account.md). First «Скачать мои данные»; then
 * what will happen, in plain words, with what cannot be undone said outright; then the «Да»: an
 * SMS code for an account with a number, the button «Да, удалить всё» for an anonymous one.
 * [Отмена] is first and focused; nothing is confirmed by itself. Needs the internet.
 */
export default function DeleteAccountScreen() {
  const theme = useTheme();
  const { t } = useTranslation();
  const linked = useOnboarding((s) => s.phoneLinkedAt !== null);
  const language = useOnboarding((s) => s.language);
  const [state, setState] = useState<DeletionStateOut | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [phone, setPhone] = useState('');
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void loadDeletionState().then((s) => {
      setState(s);
      setLoaded(true);
    });
  }, []);

  const needsSms = state ? state.needs_sms : linked;
  const graceDays = state?.grace_days ?? 7;
  const points =
    // The server's words in Russian; Kazakh (draft) and offline: the bundled ones, the same points.
    state && state.points_ru.length > 0 && language === 'ru'
      ? state.points_ru
      : [
          t('account.p_closed'),
          ...(graceDays > 0 ? [t(needsSms ? 'account.p_grace_sms' : 'account.p_grace_app', { count: graceDays })] : []),
          graceDays > 0 ? t('account.p_then') : t('account.p_now'),
          t('account.p_backups'),
          t('account.p_support'),
        ];

  const run = async (f: () => Promise<{ error: string } | null>) => {
    setBusy(true);
    setError(null);
    const fail = await f();
    setBusy(false);
    if (fail) setError(fail.error);
    else router.replace('/account-deleting');
  };

  const getCode = async () => {
    setBusy(true);
    setError(null);
    const out = await sendDeletionCode(phone.trim());
    setBusy(false);
    if ('error' in out) setError(out.error);
    else {
      setChallengeId(out.challengeId);
      setCode(out.devCode ?? '');
    }
  };

  const field = [
    theme.type.body,
    {
      minHeight: theme.size.primaryTouch,
      borderWidth: 1,
      borderColor: theme.colors.lineStrong,
      borderRadius: theme.radius.input,
      paddingHorizontal: theme.space[3],
      color: theme.colors.ink,
      backgroundColor: theme.colors.surface,
      marginTop: theme.space[2],
    },
  ];

  const alarmButton = (testID: string, label: string, onPress: () => void, disabled: boolean) => (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={{
        minHeight: theme.size.primaryTouch,
        borderRadius: theme.radius.button,
        backgroundColor: theme.colors.alarm,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: theme.space[4],
        opacity: disabled ? 0.5 : 1,
        marginTop: theme.space[3],
      }}
    >
      <AppText variant="button" style={{ color: '#FFFFFF', textAlign: 'center' }}>
        {label}
      </AppText>
    </Pressable>
  );

  return (
    <Screen testID="delete-account-screen">
      <Button testID="delete-cancel" label={t('account.cancel')} variant="text" minHeight={theme.size.minTouch} onPress={() => router.back()} style={{ alignSelf: 'flex-start' }} />
      <AppText variant="title1" accessibilityRole="header" style={{ marginBottom: theme.space[3] }}>
        {t('account.delete')}
      </AppText>
      <AppText>{t('account.first_download')}</AppText>
      <Button testID="delete-download" label={t('account.export')} variant="outline" onPress={() => router.push('/my-data')} style={{ marginTop: theme.space[2] }} />

      <AppText variant="section" accessibilityRole="header" style={{ marginTop: theme.space[6], marginBottom: theme.space[2] }}>
        {t('account.what_happens')}
      </AppText>
      <View testID="delete-points" style={{ gap: theme.space[2] }}>
        {points.map((p, i) => (
          <AppText key={i}>{`• ${p}`}</AppText>
        ))}
      </View>
      <AppText testID="delete-irreversible" variant="bodyStrong" color="alarm" style={{ marginTop: theme.space[4] }}>
        {graceDays > 0 ? t('account.irreversible', { count: graceDays }) : t('account.irreversible_now')}
      </AppText>

      {loaded && !state ? (
        <AppText testID="delete-offline" color="alarm" style={{ marginTop: theme.space[4] }}>
          {t('account.offline')}
        </AppText>
      ) : null}

      {needsSms ? (
        challengeId === null ? (
          <View style={{ marginTop: theme.space[4] }}>
            <AppText>{t('account.sms_phone')}</AppText>
            <TextInput
              testID="delete-phone"
              accessibilityLabel={t('account.sms_phone')}
              keyboardType="phone-pad"
              placeholder="+7 701 123 45 67"
              placeholderTextColor={theme.colors.ink2}
              value={phone}
              onChangeText={setPhone}
              maxFontSizeMultiplier={MAX_FONT_SCALE}
              style={field}
            />
            {alarmButton('delete-get-code', t('account.sms_get'), () => void getCode(), busy || phone.replace(/\D/g, '').length < 10 || !state)}
          </View>
        ) : (
          <View style={{ marginTop: theme.space[4] }}>
            <AppText>{t('account.sms_code')}</AppText>
            <TextInput
              testID="delete-code"
              accessibilityLabel={t('account.sms_code')}
              keyboardType="number-pad"
              textContentType="oneTimeCode"
              autoComplete="sms-otp"
              value={code}
              onChangeText={setCode}
              maxFontSizeMultiplier={MAX_FONT_SCALE}
              style={field}
            />
            {alarmButton('delete-confirm', t('account.delete'), () => void run(() => confirmDeletion({ challengeId, code: code.trim() })), busy || code.trim().length < 4)}
          </View>
        )
      ) : (
        alarmButton('delete-confirm', t('account.yes_delete'), () => void run(() => confirmDeletion({ confirm: true })), busy || !state)
      )}
      {error ? (
        <AppText testID="delete-error" color="alarm" accessibilityLiveRegion="polite" style={{ marginTop: theme.space[2] }}>
          {error}
        </AppText>
      ) : null}
      <Button testID="delete-cancel-bottom" label={t('account.cancel')} variant="outline" onPress={() => router.back()} style={{ marginTop: theme.space[4] }} />
    </Screen>
  );
}
