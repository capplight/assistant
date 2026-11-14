import { router, usePathname } from 'expo-router';
import { CalendarDays, CircleCheck, LayoutGrid, StickyNote, WalletCards } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';

import { ensureTemplatePage } from '@/pages/service';
import { mainTabs } from '@/pages/tabs';
import { usePageLabels } from '@/pages/usePageLabels';
import { useFeatures } from '@/store/features';
import { selectSortedPages, usePages, type Page } from '@/store/pages';
import { useToast } from '@/store/toast';
import { useView } from '@/store/view';
import { useTheme } from '@/theme';

import type { LucideIcon } from './ui/Icon';
import { TabBar } from './ui/TabBar';
import { useCurrentPage } from './useCurrentPage';

export type MainTab = {
  key: string;
  label: string;
  icon: LucideIcon;
  /** The page of a slot; null for «Сегодня», «Ещё» and a «Расходы» not made yet. */
  page: Page | null;
  centre: boolean;
  href: string | null;
};

const SLOT_ICON = { notes: StickyNote, expenses: WalletCards, tasks: CircleCheck } as const;

/**
 * Ф-48: «Сегодня · Заметки · Расходы · Дела · Ещё» (`pages/tabs.ts`); at font ≥150 % «Сегодня · Расходы · Дела · Ещё».
 * The labels are the template's short names (a renamed page keeps its own).
 */
export function useTabs(): MainTab[] {
  const { t } = useTranslation();
  const { largeFont } = useTheme();
  const { tabLabel } = usePageLabels();
  const shopping = useFeatures((f) => f.shopping);
  const pages = usePages(useShallow(selectSortedPages));
  const { slots } = mainTabs(pages, { largeFont, shopping });
  return [
    { key: 'today', label: t('tpl.short.today'), icon: CalendarDays, page: null, centre: false, href: '/' },
    ...slots.map((s) => ({
      key: s.page?.id ?? s.key,
      label: s.page ? tabLabel(s.page) : t(`tpl.short.${s.key}`),
      icon: SLOT_ICON[s.key],
      page: s.page,
      centre: s.centre,
      href: s.page ? `/page/${s.page.id}` : null,
    })),
    { key: 'more', label: t('tabs.more'), icon: LayoutGrid, page: null, centre: false, href: '/more' },
  ];
}

export function BottomTabs({ bottomInset = 0 }: { bottomInset?: number }) {
  const { t } = useTranslation();
  const tabs = useTabs();
  const current = useCurrentPage();
  const pathname = usePathname();
  const showToast = useToast((s) => s.show);
  const activeKey = current.kind === 'page' ? current.id : current.kind === 'more' ? 'more' : current.kind === 'today' ? 'today' : null;
  const open = async (tab: MainTab) => {
    if (tab.centre) {
      // A second tap on «Расходы» while it is open: the expense keypad (design-system v2 TabBar).
      if (tab.page && current.kind === 'page' && current.id === tab.page.id) {
        useView.getState().requestKeypad();
        return;
      }
      const page = tab.page ?? (await ensureTemplatePage('expenses'));
      if (!page) {
        showToast(t('gallery.limit'), 4000);
        return;
      }
      router.navigate({ pathname: '/page/[id]', params: { id: page.id } });
      return;
    }
    // Also on a record card opened from this page: the tab leads back to the page.
    if (tab.href && pathname !== tab.href) router.navigate(tab.href);
  };
  return (
    <TabBar
      bottomInset={bottomInset}
      tabs={tabs.map((tab) => ({
        key: tab.key,
        testID: tab.centre ? 'tab-expenses' : undefined,
        label: tab.label,
        icon: tab.icon,
        centre: tab.centre,
        active: tab.key === activeKey,
        accessibilityLabel: t('tabs.a11y', { name: tab.label }),
        onPress: () => void open(tab),
      }))}
    />
  );
}
