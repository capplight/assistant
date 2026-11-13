import { router } from 'expo-router';
import { FolderInput, LayoutGrid, ListChecks, Phone, Plus, Settings, ShieldAlert, UserRound } from 'lucide-react-native';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';
import { useShallow } from 'zustand/react/shallow';

import { PageNameSheet } from '@/components/PageNameSheet';
import { Screen } from '@/components/Screen';
import { ListGroup, ListRow } from '@/components/ui/Card';
import { Header } from '@/components/ui/Header';
import { Icon, PageIcon } from '@/components/ui/Icon';
import { addCustomPage } from '@/pages/service';
import { MAX_TAB_PAGES, MAX_TAB_PAGES_LARGE_FONT } from '@/pages/templates';
import { usePageLabels } from '@/pages/usePageLabels';
import { useOnboarding } from '@/store/onboarding';
import { selectSortedPages, usePages } from '@/store/pages';
import { useSession } from '@/store/session';
import { useToast } from '@/store/toast';
import { useTheme } from '@/theme';

/**
 * S42 «Ещё» (Ф-41, design-system §4 mock): the profile, «Ваши страницы» (pages that do not fit in the tabs) and
 * six rows in one card — Новая страница, Мои страницы, Что я сделал, Принести заметки, Настройки (the profile is
 * the sixth: it opens «Настройки» too). Everything service-like lives in «Настройки»; no «Появится позже» stubs.
 * A sign-in that expired or a consent another account needs comes first, as a row of its own.
 */
export default function MoreScreen() {
  const theme = useTheme();
  const { t } = useTranslation();
  const { title } = usePageLabels();
  const pages = usePages(useShallow(selectSortedPages));
  const name = useOnboarding((s) => s.displayName);
  const phoneLinked = useOnboarding((s) => s.phoneLinkedAt !== null);
  const needsConsent = useOnboarding((s) => s.accountConsent !== null);
  const needsSignIn = useSession((s) => s.needsSignIn);
  const showToast = useToast((s) => s.show);
  const [naming, setNaming] = useState(false);
  const overflow = pages.slice(theme.largeFont ? MAX_TAB_PAGES_LARGE_FONT : MAX_TAB_PAGES);
  const avatar = (
    <View style={[styles.avatar, { backgroundColor: theme.colors.brand }]}>
      <Icon icon={UserRound} color="onBrand" />
    </View>
  );

  return (
    <Screen testID="page-more" edges={['top']}>
      <Header title={t('more.title')} />
      <View style={{ gap: theme.space[5] }}>
        {needsSignIn || needsConsent ? (
          <ListGroup>
            {needsSignIn ? (
              <ListRow testID="more-sign_in" icon={Phone} title={t('phone.sign_in_row')} meta={t('phone.sign_in_hint')} chevron onPress={() => router.push('/phone?reason=expired')} />
            ) : null}
            {needsConsent ? (
              <ListRow testID="more-consent" icon={ShieldAlert} title={t('account_consent.row')} meta={t('account_consent.row_hint')} chevron onPress={() => router.push('/account-consent')} />
            ) : null}
          </ListGroup>
        ) : null}

        <ListGroup>
          <ListRow
            testID="more-profile"
            left={avatar}
            title={name ?? t('more.profile')}
            meta={phoneLinked ? t('phone.linked') : t('more.profile_hint')}
            chevron
            onPress={() => router.push('/settings')}
          />
        </ListGroup>

        {overflow.length > 0 ? (
          <ListGroup title={t('more.your_pages')}>
            {overflow.map((p) => (
              <ListRow
                key={p.id}
                testID={`more-page-${p.id}`}
                left={
                  <View style={[styles.square, { backgroundColor: theme.colors.brandTint, borderRadius: theme.radius.sm }]}>
                    <PageIcon name={p.icon} color={theme.colors.brand} size={20} />
                  </View>
                }
                title={title(p)}
                chevron
                onPress={() => router.navigate({ pathname: '/page/[id]', params: { id: p.id } })}
              />
            ))}
          </ListGroup>
        ) : null}

        <ListGroup>
          <ListRow testID="more-add_page" icon={Plus} title={t('more.add_page')} chevron onPress={() => setNaming(true)} />
          <ListRow testID="more-my_pages" icon={LayoutGrid} title={t('more.my_pages')} chevron onPress={() => router.navigate('/my-pages')} />
          <ListRow testID="more-did" icon={ListChecks} title={t('more.did')} chevron onPress={() => router.push('/did')} />
          <ListRow testID="more-import" icon={FolderInput} title={t('more.import')} chevron onPress={() => router.push('/import')} />
          <ListRow testID="more-settings" icon={Settings} title={t('more.settings')} chevron onPress={() => router.push('/settings')} />
        </ListGroup>
      </View>
      {naming ? (
        <PageNameSheet
          onClose={() => setNaming(false)}
          onSave={(pageName) => {
            setNaming(false);
            void addCustomPage(pageName).then((page) => {
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
  avatar: { width: 46, height: 46, borderRadius: 23, alignItems: 'center', justifyContent: 'center' },
  square: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },
});
