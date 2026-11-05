import { router } from 'expo-router';
import { ChevronRight } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';
import { useShallow } from 'zustand/react/shallow';

import { AppText } from '@/components/AppText';
import { PageIcon } from '@/components/Icon';
import { Screen } from '@/components/Screen';
import { LANGUAGES } from '@/i18n';
import { MAX_TAB_PAGES, MAX_TAB_PAGES_LARGE_FONT } from '@/pages/templates';
import { usePageLabels } from '@/pages/usePageLabels';
import { useOnboarding } from '@/store/onboarding';
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
      {row('my_pages', t('more.my_pages'), undefined, t('more.later'))}
      {row('all_records', t('more.all_records'), undefined, t('more.later'))}
      {row('did', t('more.did'), undefined, t('more.later'))}
      {row('chat', t('more.chat'), () => router.push('/chat'))}
      {row('import', t('more.import'), undefined, t('more.later'))}
      {row('lang', `${t('lang.choose')}: ${t(`lang.${language}`)}`, () => setLanguage(nextLang), t(`lang.${nextLang}`))}
      {row('settings', t('more.settings'), undefined, t('more.later'))}
      {row('help', t('more.help'), undefined, t('more.later'))}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1 },
  flex: { flex: 1 },
});
