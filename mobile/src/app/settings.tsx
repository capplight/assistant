import { router } from 'expo-router';
import { AlarmClock, Copy, Download, Info, Languages, LifeBuoy, Mail, Phone, Repeat, Send, ShieldCheck, Trash2, UserX, Wallet } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Linking, View } from 'react-native';

import { getAppVersion } from '@/api/config';
import { allDone } from '@/alarms/setup';
import { useAlarms } from '@/alarms/store';
import { AppText } from '@/components/AppText';
import { BudgetSheet } from '@/components/BudgetSheet';
import { LanguageSheet } from '@/components/LanguageSheet';
import { Screen } from '@/components/Screen';
import { supportUrl } from '@/components/support';
import { ListGroup, ListRow } from '@/components/ui/Card';
import { Header } from '@/components/ui/Header';
import { ThemePicker } from '@/components/ui/ThemePicker';
import { repeatsCount, visibleGroups } from '@/dedup/service';
import { useDedup } from '@/dedup/store';
import { formatMinor } from '@/expenses/calc';
import { budgetMinor, useBudget } from '@/store/budget';
import { useFeatures } from '@/store/features';
import { useOnboarding } from '@/store/onboarding';
import { useSession } from '@/store/session';
import { useSchemePreference, useTheme } from '@/theme';

/**
 * «Настройки» v2 (screens-v2 «Настройки · тема»): the theme as two preview cards + «Как в телефоне» first; then
 * language (with a confirmation in both languages, Ф-50), alarms, «Бюджет на месяц», «Мои данные», «Политика и
 * условия»; the assistant's learned rules, repeats and the trash; the account; about; «Удалить аккаунт» last.
 * «Переписка» and «Все записи» moved to «Ещё» (one «История», one search). Telegram sign-in and the personal mail
 * show only with their switches (Ф-43).
 */
export default function SettingsScreen() {
  const theme = useTheme();
  const { t } = useTranslation();
  const features = useFeatures();
  const language = useOnboarding((s) => s.language);
  const setLanguage = useOnboarding((s) => s.setLanguage);
  const phoneLinked = useOnboarding((s) => s.phoneLinkedAt !== null);
  const needsSignIn = useSession((s) => s.needsSignIn);
  const scheme = useSchemePreference((s) => s.preference);
  const setScheme = useSchemePreference((s) => s.set);
  const alarmsOk = useAlarms((s) => (s.caps ? allDone(s.caps, s) && s.test.state === 'ok' : false));
  const repeats = useDedup((s) => repeatsCount(visibleGroups(s.groups, s.decided)));
  const budget = useBudget(budgetMinor);
  const [langOpen, setLangOpen] = useState(false);
  const [budgetOpen, setBudgetOpen] = useState(false);
  const support = supportUrl();
  const back = () => (router.canGoBack() ? router.back() : router.replace('/more'));

  return (
    <Screen testID="settings-screen">
      <Header title={t('more.settings')} back={{ onPress: back, label: t('more.title') }} />
      <View style={{ gap: theme.space[5] }}>
        <View style={{ gap: theme.space[2] }}>
          <AppText variant="eyebrow" color="ink2" accessibilityRole="header" style={{ paddingHorizontal: theme.space[1] }}>
            {t('settings.theme')}
          </AppText>
          <ThemePicker
            preference={scheme}
            onChange={setScheme}
            labels={{ light: t('settings.theme_light'), dark: t('settings.theme_dark'), system: t('settings.theme_system'), systemHint: t('settings.theme_system_hint') }}
          />
        </View>

        <ListGroup>
          <ListRow testID="settings-lang" icon={Languages} title={t('lang.choose')} value={t(`lang.${language}`)} chevron onPress={() => setLangOpen(true)} />
          <ListRow
            testID="settings-alarms"
            icon={AlarmClock}
            title={t('more.alarms')}
            meta={alarmsOk ? t('more.alarms_ok') : t('more.alarms_fix')}
            chevron
            onPress={() => router.push('/alarm-setup')}
          />
          <ListRow
            testID="settings-budget"
            icon={Wallet}
            title={t('budget.title')}
            meta={budget !== null ? formatMinor(budget) : t('budget.none')}
            chevron
            onPress={() => setBudgetOpen(true)}
          />
          <ListRow testID="settings-my_data" icon={Download} title={t('account.my_data_row')} meta={t('account.my_data_short')} chevron onPress={() => router.push('/my-data')} />
          <ListRow testID="settings-policy" icon={ShieldCheck} title={t('legal.policy_terms')} chevron onPress={() => router.push({ pathname: '/legal', params: { doc: 'policy' } })} />
        </ListGroup>

        <ListGroup title={t('settings.assistant')}>
          <ListRow testID="settings-habits" icon={Repeat} title={t('habits.title')} chevron onPress={() => router.push('/habits')} />
          <ListRow
            testID="settings-duplicates"
            icon={Copy}
            title={t('more.duplicates')}
            meta={repeats > 0 ? t('more.duplicates_meta', { count: repeats }) : undefined}
            chevron
            onPress={() => router.push('/duplicates')}
          />
          <ListRow testID="settings-trash" icon={Trash2} title={t('trash.title')} chevron onPress={() => router.navigate('/trash')} />
        </ListGroup>

        <ListGroup title={t('settings.account')}>
          {needsSignIn ? (
            <ListRow testID="settings-sign_in" icon={Phone} title={t('phone.sign_in_row')} meta={t('phone.sign_in_hint')} chevron onPress={() => router.push('/phone?reason=expired')} />
          ) : phoneLinked ? (
            <ListRow testID="settings-phone" icon={Phone} title={t('phone.linked')} />
          ) : (
            <ListRow testID="settings-phone" icon={Phone} title={t('phone.more_row')} meta={t('phone.more_hint')} chevron onPress={() => router.push('/phone')} />
          )}
          {features.telegram_login ? <ListRow testID="settings-telegram" icon={Send} title={t('settings.telegram')} meta={t('settings.soon')} disabled /> : null}
          {features.personal_mail ? <ListRow testID="settings-mail" icon={Mail} title={t('settings.mail')} meta={t('settings.soon')} disabled /> : null}
        </ListGroup>

        <ListGroup title={t('settings.about')}>
          <ListRow testID="settings-consents" icon={ShieldCheck} title={t('legal.consents')} chevron onPress={() => router.push({ pathname: '/legal', params: { doc: 'consents' } })} />
          {support ? (
            <ListRow testID="settings-support" icon={LifeBuoy} title={t('settings.support')} chevron onPress={() => void Linking.openURL(support).catch(() => undefined)} />
          ) : null}
          <ListRow testID="settings-version" icon={Info} title={t('settings.version')} value={getAppVersion()} />
        </ListGroup>

        <ListGroup>
          <ListRow testID="settings-delete_account" icon={UserX} title={t('account.delete')} danger onPress={() => router.push('/delete-account')} />
        </ListGroup>
      </View>

      <LanguageSheet visible={langOpen} current={language} onClose={() => setLangOpen(false)} onPick={setLanguage} />
      {budgetOpen ? <BudgetSheet visible onClose={() => setBudgetOpen(false)} /> : null}
    </Screen>
  );
}
