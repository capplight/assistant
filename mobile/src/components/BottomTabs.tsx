import { router, usePathname } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';

import { MAX_TAB_PAGES, MAX_TAB_PAGES_LARGE_FONT, type IconKey } from '@/pages/templates';
import { usePageLabels } from '@/pages/usePageLabels';
import { selectSortedPages, usePages } from '@/store/pages';
import { useTheme } from '@/theme';

import { pageIcon } from './ui/Icon';
import { TabBar } from './ui/TabBar';
import { useCurrentPage } from './useCurrentPage';

type Tab = { key: string; label: string; icon: IconKey | 'more'; href: string };

/**
 * «Сегодня» + up to 2 user pages + «Ещё» — never more than 4 tabs (design-system §3 TabBar, ux-audit §3:
 * «Сегодня · Заметки · Дела · Ещё»). At font ≥150 %: «Сегодня» + 1 page + «Ещё». Other pages lead «Ещё».
 */
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

export function BottomTabs({ bottomInset = 0 }: { bottomInset?: number }) {
  const { t } = useTranslation();
  const tabs = useTabs();
  const current = useCurrentPage();
  const pathname = usePathname();
  const activeKey = current.kind === 'page' ? current.id : current.kind === 'more' ? 'more' : 'today';
  return (
    <TabBar
      bottomInset={bottomInset}
      tabs={tabs.map((tab) => ({
        key: tab.key,
        label: tab.label,
        icon: pageIcon(tab.icon),
        active: tab.key === activeKey,
        accessibilityLabel: t('tabs.a11y', { name: tab.label }),
        // Also on a record card opened from this page: the tab leads back to the page.
        onPress: () => {
          if (pathname !== tab.href) router.navigate(tab.href);
        },
      }))}
    />
  );
}
