import Constants from 'expo-constants';
import { router } from 'expo-router';
import {
  AlarmClock,
  Copy,
  Download,
  FileText,
  Files,
  Info,
  Languages,
  LifeBuoy,
  Mail,
  MessagesSquare,
  Moon,
  Phone,
  Repeat,
  Send,
  ShieldCheck,
  Trash2,
  UserX,
} from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Linking, View } from 'react-native';

import { getAppVersion } from '@/api/config';
import { allDone } from '@/alarms/setup';
import { useAlarms } from '@/alarms/store';
import { Screen } from '@/components/Screen';
import { Header } from '@/components/ui/Header';
import { ListGroup, ListRow } from '@/components/ui/Card';
import { CheckMark } from '@/components/ui/Check';
import { Sheet } from '@/components/ui/Sheet';
import { repeatsCount, visibleGroups } from '@/dedup/service';
import { useDedup } from '@/dedup/store';
import { LANGUAGES } from '@/i18n';
import { useFeatures } from '@/store/features';
import { useOnboarding } from '@/store/onboarding';
import { useSession } from '@/store/session';
import { useSchemePreference, useTheme, type SchemePreference } from '@/theme';

/** Where «Поддержка» goes: `expo.extra.supportUrl` (a mailto: or https link). No link configured → no row. */
function supportUrl(): string | null {
  const v = (Constants.expoConfig?.extra as { supportUrl?: unknown } | undefined)?.supportUrl;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

const SCHEMES: SchemePreference[] = ['system', 'light', 'dark'];

/**
 * «Настройки» (Ф-41): everything service-like in one screen, grouped — account, data (export, all records,
 * deleted, repeats), the assistant (conversation, learned rules, alarms), look (language, theme), about
 * (Privacy policy, Terms, consents, support, version) and «Удалить аккаунт» last. Telegram sign-in and the
 * personal mail show only with their switches (Ф-43).
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
  const [themeOpen, setThemeOpen] = useState(false);
  const nextLang = LANGUAGES.find((l) => l !== language) ?? 'ru';
  const support = supportUrl();
  const back = () => (router.canGoBack() ? router.back() : router.replace('/more'));
  const schemeLabel = (s: SchemePreference) => t(`settings.theme_${s}`);

  return (
    <Screen testID="settings-screen">
      <Header title={t('more.settings')} back={{ onPress: back }} />
      <View style={{ gap: theme.space[5] }}>
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

        <ListGroup title={t('settings.data')}>
          <ListRow testID="settings-my_data" icon={Download} title={t('account.export')} meta={t('account.my_data_hint')} chevron onPress={() => router.push('/my-data')} />
          <ListRow testID="settings-all_records" icon={Files} title={t('more.all_records')} chevron onPress={() => router.navigate('/records')} />
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

        <ListGroup title={t('settings.assistant')}>
          <ListRow testID="settings-chat" icon={MessagesSquare} title={t('more.chat')} chevron onPress={() => router.push('/chat')} />
          <ListRow testID="settings-habits" icon={Repeat} title={t('habits.title')} chevron onPress={() => router.push('/habits')} />
          <ListRow
            testID="settings-alarms"
            icon={AlarmClock}
            title={t('more.alarms')}
            meta={alarmsOk ? t('more.alarms_ok') : t('more.alarms_fix')}
            chevron
            onPress={() => router.push('/alarm-setup')}
          />
        </ListGroup>

        <ListGroup title={t('settings.look')}>
          <ListRow
            testID="settings-lang"
            icon={Languages}
            title={t('lang.choose')}
            meta={t(`lang.${language}`)}
            accessibilityHint={t(`lang.${nextLang}`)}
            chevron
            onPress={() => setLanguage(nextLang)}
          />
          <ListRow testID="settings-theme" icon={Moon} title={t('settings.theme')} meta={schemeLabel(scheme)} chevron onPress={() => setThemeOpen(true)} />
        </ListGroup>

        <ListGroup title={t('settings.about')}>
          <ListRow testID="settings-policy" icon={ShieldCheck} title={t('legal.policy')} chevron onPress={() => router.push({ pathname: '/legal', params: { doc: 'policy' } })} />
          <ListRow testID="settings-terms" icon={FileText} title={t('legal.terms')} chevron onPress={() => router.push({ pathname: '/legal', params: { doc: 'terms' } })} />
          <ListRow
            testID="settings-consents"
            icon={ShieldCheck}
            title={t('legal.consents')}
            chevron
            onPress={() => router.push({ pathname: '/legal', params: { doc: 'consents' } })}
          />
          {support ? (
            <ListRow testID="settings-support" icon={LifeBuoy} title={t('settings.support')} chevron onPress={() => void Linking.openURL(support).catch(() => undefined)} />
          ) : null}
          <ListRow testID="settings-version" icon={Info} title={t('settings.version')} value={getAppVersion()} />
        </ListGroup>

        <ListGroup>
          <ListRow testID="settings-delete_account" icon={UserX} title={t('account.delete')} danger onPress={() => router.push('/delete-account')} />
        </ListGroup>
      </View>

      <Sheet testID="theme-sheet" visible={themeOpen} onClose={() => setThemeOpen(false)} title={t('settings.theme')}>
        <View accessibilityRole="radiogroup">
          {SCHEMES.map((s, i) => (
            <ListRow
              key={s}
              testID={`theme-${s}`}
              accessibilityRole="radio"
              selected={scheme === s}
              title={schemeLabel(s)}
              right={<CheckMark checked={scheme === s} />}
              separator={i < SCHEMES.length - 1}
              onPress={() => {
                setScheme(s);
                setThemeOpen(false);
              }}
            />
          ))}
        </View>
      </Sheet>
    </Screen>
  );
}
