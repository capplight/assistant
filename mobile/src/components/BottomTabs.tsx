import { router, useGlobalSearchParams, usePathname } from 'expo-router';
import { CreditCard, Ellipsis, MessageSquareText, StickyNote, Sun } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';

import { ensureTemplatePage } from '@/pages/service';
import { mainTabs } from '@/pages/tabs';
import { usePageLabels } from '@/pages/usePageLabels';
import { useFeatures } from '@/store/features';
import { selectSortedPages, usePages, type Page } from '@/store/pages';
import { useToast } from '@/store/toast';
import { useView } from '@/store/view';
import { type PlaceKey } from '@/theme';

import type { LucideIcon } from './ui/Icon';
import { TabBar } from './ui/TabBar';
import { useCurrentPage } from './useCurrentPage';

export type MainTab = {
  key: string;
  label: string;
  icon: LucideIcon;
  /** The page of a slot; null for «Сегодня», «Помощник», «Ещё» and a «Расходы» not made yet. */
  page: Page | null;
  centre: boolean;
  /** v5: the colour of the capsule. */
  place: PlaceKey;
  href: string | null;
  /** «Расходы» made on the first tap (Ф-48). */
  ensure?: 'expenses';
};

const SLOT_ICON = { notes: StickyNote, expenses: CreditCard, assistant: MessageSquareText } as const;

/**
 * Ф-58: «Сегодня · Заметки · Помощник · Расходы · Ещё» (`pages/tabs.ts`), the same five at every font size (v5).
 * The labels are the template's short names (a renamed page keeps its own).
 */
export function useTabs(): MainTab[] {
  const { t } = useTranslation();
  const { tabLabel } = usePageLabels();
  const shopping = useFeatures((f) => f.shopping);
  const pages = usePages(useShallow(selectSortedPages));
  const { slots } = mainTabs(pages, { largeFont: false, shopping });
  return [
    { key: 'today', label: t('tpl.short.today'), icon: Sun, page: null, centre: false, place: 'today', href: '/' },
    ...slots.map((s): MainTab => {
      if (s.key === 'assistant') return { key: 'assistant', label: t('tabs.assistant'), icon: SLOT_ICON.assistant, page: null, centre: true, place: 'assistant', href: '/assistant' };
      return {
        key: s.page?.id ?? s.key,
        label: s.page ? tabLabel(s.page) : t(`tpl.short.${s.key}`),
        icon: SLOT_ICON[s.key],
        page: s.page,
        centre: false,
        place: s.key,
        href: s.page ? `/page/${s.page.id}` : null,
        ...(s.key === 'expenses' ? { ensure: 'expenses' as const } : {}),
      };
    }),
    { key: 'more', label: t('tabs.more'), icon: Ellipsis, page: null, centre: false, place: 'stone', href: '/more' },
  ];
}

export function BottomTabs({ bottomInset = 0 }: { bottomInset?: number }) {
  const { t } = useTranslation();
  const tabs = useTabs();
  const current = useCurrentPage();
  const pathname = usePathname();
  const { from: fromParam } = useGlobalSearchParams<{ from?: string }>();
  const showToast = useToast((s) => s.show);
  // «Дела» and other pages opened from «Сегодня» / «Ещё» keep their home tab lit (design-system v3 §9.1).
  const activeKey =
    current.kind === 'assistant'
      ? 'assistant'
      : current.kind === 'page'
        ? tabs.some((x) => x.key === current.id)
          ? current.id
          : current.page.templateKey === 'tasks' && fromParam !== 'more'
            ? 'today'
            : 'more'
        : current.kind === 'more'
          ? 'more'
          : current.kind === 'today'
            ? 'today'
            : null;
  const open = async (tab: MainTab) => {
    if (tab.ensure === 'expenses') {
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
        testID: tab.ensure === 'expenses' ? 'tab-expenses' : tab.centre ? 'tab-assistant' : undefined,
        label: tab.label,
        icon: tab.icon,
        centre: tab.centre,
        place: tab.place,
        active: tab.key === activeKey,
        accessibilityLabel: t('tabs.a11y', { name: tab.label }),
        onPress: () => void open(tab),
      }))}
    />
  );
}
