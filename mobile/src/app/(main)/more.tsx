import { router } from 'expo-router';
import { useState } from 'react';
import { ChevronRight } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';
import { useShallow } from 'zustand/react/shallow';

import { AppText } from '@/components/AppText';
import { PageIcon } from '@/components/Icon';
import { PageNameSheet } from '@/components/PageNameSheet';
import { Screen } from '@/components/Screen';
import { LANGUAGES } from '@/i18n';
import { addCustomPage } from '@/pages/service';
import { MAX_TAB_PAGES, MAX_TAB_PAGES_LARGE_FONT } from '@/pages/templates';
import { usePageLabels } from '@/pages/usePageLabels';
import { allDone } from '@/alarms/setup';
import { useAlarms } from '@/alarms/store';
import { useOnboarding } from '@/store/onboarding';
import { useSession } from '@/store/session';
import { useToast } from '@/store/toast';
import { selectSortedPages, usePages } from '@/store/pages';
import { useTheme } from '@/theme';

/** S42 «Ещё»: pages that do not fit in tabs + service entries (2-design §4.2). Most entries are stubs in week 1. */
export default function MoreScreen() {
  const theme = useTheme();
  const { t } = useTranslation();
  const { title } = usePageLabels();
  const pages = usePages(useShallow(selectSortedPages));
  const language = useOnboarding((s) => s.language);
  const setLanguage = useOnboarding((s) => s.setLanguage);
  const phoneLinked = useOnboarding((s) => s.phoneLinkedAt !== null);
  const needsConsent = useOnboarding((s) => s.accountConsent !== null);
  const needsSignIn = useSession((s) => s.needsSignIn);
  const showToast = useToast((s) => s.show);
  const [naming, setNaming] = useState(false);
  const alarmsOk = useAlarms((s) => (s.caps ? allDone(s.caps, s) && s.test.state === 'ok' : false));
  const overflow = pages.slice(theme.largeFont ? MAX_TAB_PAGES_LARGE_FONT : MAX_TAB_PAGES);

  const row = (key: string, label: string, onPress?: () => void, meta?: string) => (
    <Pressable
      key={key}
      testID={`more-${key}`}
      accessibilityRole="button"
      accessibilityState={{ disabled: !onPress }}
      accessibilityHint={onPress ? undefined : t('more.later')}
      onPress={onPress}
      style={[
        styles.row,
        {
          minHeight: theme.size.primaryTouch,
          borderBottomColor: theme.colors.line,
          gap: theme.space[3],
          paddingVertical: theme.space[2],
        },
      ]}
    >
      <View style={styles.flex}>
        <AppText color={onPress ? 'ink' : 'ink2'}>{label}</AppText>
        {meta ? <AppText variant="meta">{meta}</AppText> : null}
      </View>
      {onPress ? <ChevronRight size={22} color={theme.colors.ink2} /> : null}
    </Pressable>
  );

  const nextLang = LANGUAGES.find((l) => l !== language) ?? 'ru';

  return (
    <Screen testID="page-more" edges={['top']}>
      <AppText variant="title1" accessibilityRole="header" style={{ marginBottom: theme.space[4] }}>
        {t('more.title')}
      </AppText>
      {overflow.length > 0 ? (
        <View style={{ marginBottom: theme.space[6] }}>
          <AppText variant="section" accessibilityRole="header">
            {t('more.other_pages')}
          </AppText>
          {overflow.map((p) => (
            <Pressable
              key={p.id}
              testID={`more-page-${p.id}`}
              accessibilityRole="button"
              onPress={() => router.navigate({ pathname: '/page/[id]', params: { id: p.id } })}
              style={[
                styles.row,
                { minHeight: theme.size.primaryTouch, borderBottomColor: theme.colors.line, gap: theme.space[3] },
              ]}
            >
              <PageIcon name={p.icon} color={theme.colors.ink} size={24} />
              <AppText style={styles.flex}>{title(p)}</AppText>
              <ChevronRight size={22} color={theme.colors.ink2} />
            </Pressable>
          ))}
        </View>
      ) : null}
      {needsSignIn
        ? row('sign_in', t('phone.sign_in_row'), () => router.push('/phone?reason=expired'), t('phone.sign_in_hint'))
        : null}
      {needsConsent
        ? row('consent', t('account_consent.row'), () => router.push('/account-consent'), t('account_consent.row_hint'))
        : null}
      {row('add_page', t('more.add_page'), () => setNaming(true), t('tpl.hint.custom'))}
      {row('my_pages', t('more.my_pages'), () => router.navigate('/my-pages'))}
      {row('all_records', t('more.all_records'), () => router.navigate('/records'))}
      {row('trash', t('trash.title'), () => router.navigate('/trash'), t('trash.hint'))}
      {row('did', t('more.did'), () => router.push('/did'))}
      {row('habits', t('habits.title'), () => router.push('/habits'))}
      {row('chat', t('more.chat'), () => router.push('/chat'))}
      {row('alarms', t('more.alarms'), () => router.push('/alarm-setup'), alarmsOk ? t('more.alarms_ok') : t('more.alarms_fix'))}
      {row('import', t('more.import'), undefined, t('more.later'))}
      {row('lang', `${t('lang.choose')}: ${t(`lang.${language}`)}`, () => setLanguage(nextLang), t(`lang.${nextLang}`))}
      {needsSignIn
        ? null
        : phoneLinked
        ? row('phone', t('phone.linked'))
        : row('phone', t('phone.more_row'), () => router.push('/phone'), t('phone.more_hint'))}
      {row('settings', t('more.settings'), undefined, t('more.later'))}
      {row('help', t('more.help'), undefined, t('more.later'))}
      {naming ? (
        <PageNameSheet
          onClose={() => setNaming(false)}
          onSave={(name) => {
            setNaming(false);
            void addCustomPage(name).then((page) => {
              if (page) router.navigate({ pathname: '/page/[id]', params: { id: page.id } });
              else showToast(t('gallery.limit'), 4000);
            });
          }}
        />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1 },
  flex: { flex: 1 },
});
