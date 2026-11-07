import { router, usePathname } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View } from 'react-native';
import { useShallow } from 'zustand/react/shallow';

import { MAX_TAB_PAGES, MAX_TAB_PAGES_LARGE_FONT, type IconKey } from '@/pages/templates';
import { usePageLabels } from '@/pages/usePageLabels';
import { selectSortedPages, usePages } from '@/store/pages';
import { useTheme } from '@/theme';

import { AppText } from './AppText';
import { PageIcon } from './Icon';
import { useCurrentPage } from './useCurrentPage';

type Tab = { key: string; label: string; icon: IconKey | 'more'; href: string };

/** «Сегодня» + up to 3 user pages (2 at font ≥150%) + «Ещё» (R-57). No swipe between pages. */
export function useTabs(): Tab[] {
  const { t } = useTranslation();
  const { largeFont } = useTheme();
  const { tabLabel } = usePageLabels();
  const pages = usePages(useShallow(selectSortedPages));
  const n = largeFont ? MAX_TAB_PAGES_LARGE_FONT : MAX_TAB_PAGES;
  return [
    { key: 'today', label: t('tpl.short.today'), icon: 'today', href: '/' },
    ...pages.slice(0, n).map((p) => ({ key: p.id, label: tabLabel(p), icon: p.icon, href: `/page/${p.id}` })),
    { key: 'more', label: t('tabs.more'), icon: 'more', href: '/more' },
  ];
}

export function BottomTabs() {
  const theme = useTheme();
  const { t } = useTranslation();
  const tabs = useTabs();
  const current = useCurrentPage();
  const pathname = usePathname();
  const activeKey = current.kind === 'page' ? current.id : current.kind === 'more' ? 'more' : 'today';

  return (
    <View
      accessibilityRole="tablist"
      testID="bottom-tabs"
      style={[
        styles.bar,
        {
          minHeight: theme.largeFont ? theme.size.tabBarLarge : theme.size.tabBar,
          backgroundColor: theme.colors.surface,
          borderTopColor: theme.colors.line,
        },
      ]}
    >
      {tabs.map((tab) => {
        const active = tab.key === activeKey;
        const color = active ? theme.colors.accent : theme.colors.ink2;
        return (
          <Pressable
            key={tab.key}
            testID={`tab-${tab.key}`}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={t('tabs.a11y', { name: tab.label })}
            onPress={() => {
              // Also on a record card opened from this page: the tab leads back to the page.
              if (pathname !== tab.href) router.navigate(tab.href);
            }}
            style={[styles.tab, { minHeight: theme.size.primaryTouch }]}
          >
            <View
              style={[
                styles.indicator,
                { height: theme.size.activeTabBar, backgroundColor: active ? theme.colors.accent : 'transparent' },
              ]}
            />
            <PageIcon name={tab.icon} size={theme.size.tabIcon} color={color} />
            <AppText
              variant="meta"
              style={[
                styles.label,
                { color, fontFamily: active ? theme.type.bodyStrong.fontFamily : theme.type.meta.fontFamily },
              ]}
            >
              {tab.label}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', borderTopWidth: 1 },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'flex-start', paddingBottom: 6, paddingHorizontal: 2 },
  indicator: { alignSelf: 'stretch', marginBottom: 6 },
  // Long labels wrap to two lines — never ellipsis (2-design §4.2).
  label: { textAlign: 'center' },
});
