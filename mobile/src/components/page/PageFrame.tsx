import { router } from 'expo-router';
import { ArrowUpDown, Ellipsis, LayoutGrid, List, PencilLine, Plus, Search, SlidersHorizontal, X } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { renamePage } from '@/pages/service';
import { usePageLabels } from '@/pages/usePageLabels';
import { searchRecords } from '@/records/search';
import { usePageEntries } from '@/records/useRecords';
import { useServerSearch } from '@/records/useServerSearch';
import type { Page } from '@/store/pages';
import { useNotesLook } from '@/store/notesLook';
import { useView } from '@/store/view';
import { useTheme } from '@/theme';

import { AppText } from '../AppText';
import { ActionList, Button, Header, Icon, Sheet, ViewToggle, type SheetAction } from '../ui';
import { PageNameSheet } from '../PageNameSheet';
import { Screen } from '../Screen';
import { FindField, SearchMore } from '../SearchResults';
import { EntryList } from './EntryList';
import { resolveView } from './registry';
import { entryRow, shownEntries, sortEntries } from './rows';

/**
 * `PageFrame` (template-screens 3): the same edges on every page so nobody gets lost — one header line
 * (ux-audit P0-2, design-system §3 Header): the title, 🔍 «Найти на странице» (S10, the field opens on
 * tap) and ⋯ with «Порядок», «Переименовать» (custom pages) and «Настроить» (S38).
 * The middle is the template's tool from the registry (`resolveView`); while searching, the frame
 * shows the found records the same way on every page. The bottom edge — answer banner, «Отменить»,
 * the assistant line, tabs — is the main layout's footer, outside the tool.
 */
export function PageFrame({ page }: { page: Page }) {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const { title } = usePageLabels();
  const loaded = usePageEntries(page);
  // Sort by a field (S38 / the assistant): the phone orders the same way the server does.
  const entries = useMemo(() => (loaded ? sortEntries(loaded, page.view?.sort ?? null) : null), [loaded, page.view?.sort]);
  const [renaming, setRenaming] = useState(false);
  // Tabs reuse one screen for all pages: what was typed on page A stays with page A.
  const [find, setFind] = useState({ pageId: page.id, q: '' });
  const q = find.pageId === page.id ? find.q : '';
  const searching = q.trim().length > 0;
  const server = useServerSearch(q, { pageServerId: page.serverId ?? null, enabled: !!page.serverId });
  const highlight = useView((st) => st.highlight);
  const clearHighlight = useView((st) => st.clearHighlight);
  const setVisible = useView((st) => st.setVisible);
  const [ordering, setOrdering] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const view = resolveView(page);
  const notesLook = useNotesLook((st) => st.look);
  const setNotesLook = useNotesLook((st) => st.set);
  const isNotes = page.templateKey === 'notes';

  // The marker goes after 600 ms (Reduce Motion: the same, it is a colour, not a move).
  useEffect(() => {
    if (!highlight) return;
    const timer = setTimeout(clearHighlight, Math.max(0, highlight.until - Date.now()));
    return () => clearTimeout(timer);
  }, [highlight, clearHighlight]);

  // Until the list reports what is visible, the first rows count as on screen.
  useEffect(() => {
    if (!entries) return;
    setVisible(
      page.id,
      entries.map((e) => e.record.serverId).filter((x): x is string => !!x),
    );
  }, [entries, page.id, setVisible]);

  const hasRecords = (entries?.length ?? 0) > 0;
  const searchShown = searchOpen || searching;
  const closeSearch = () => {
    setSearchOpen(false);
    setFind({ pageId: page.id, q: '' });
  };
  const menuActions: SheetAction[] = [
    ...(hasRecords && !searching
      ? [{ key: 'order', testID: 'page-order', label: t('page.order'), icon: ArrowUpDown, onPress: () => (setMenuOpen(false), setOrdering(true)) }]
      : []),
    ...(page.templateKey === 'custom'
      ? [{ key: 'rename', testID: 'page-rename', label: t('page.rename'), icon: PencilLine, onPress: () => (setMenuOpen(false), setRenaming(true)) }]
      : []),
    {
      key: 'settings',
      testID: 'page-settings',
      label: t('view.settings'),
      hint: t('view.settings_a11y', { page: title(page) }),
      icon: SlidersHorizontal,
      onPress: () => {
        setMenuOpen(false);
        router.push({ pathname: '/page-settings/[id]', params: { id: page.id } });
      },
    },
  ];
  // One line (ux-audit P0-2): the title, 🔍 and ⋯; «Порядок», «Настроить» live in ⋯; the field opens on 🔍.
  const top = (
    <View style={{ gap: theme.space[2] }}>
      <Header
        testID="page-header"
        title={title(page)}
        // «Дела» are not a tab any more (VISION-2026-11): «‹ Сегодня» leads back to where they come from.
        back={page.templateKey === 'tasks' ? { onPress: () => router.navigate('/'), label: t('today.today'), testID: 'page-back' } : undefined}
        meta={
          isNotes && entries
            ? t(notesLook === 'list' ? 'notes.count_list' : 'notes.count', { count: entries.length })
            : page.templateKey === 'tasks'
              ? todayLine(i18n.language)
              : undefined
        }
        accessory={
          page.templateKey === 'expenses' ? (
            <Button testID="exp-enter" label={t('exp.add_short')} size="small" icon={<Icon icon={Plus} size="sm" color="onBrand" />} onPress={() => useView.getState().requestKeypad()} />
          ) : isNotes ? (
            <ViewToggle
              testID="notes-look"
              value={notesLook}
              onChange={setNotesLook}
              options={[
                { key: 'grid', icon: LayoutGrid, label: t('notes.look_grid'), testID: 'notes-look-grid' },
                { key: 'list', icon: List, label: t('notes.look_list'), testID: 'notes-look-list' },
              ]}
            />
          ) : undefined
        }
        titleTestID="page-title"
        actions={[
          ...(page.templateKey === 'expenses'
            ? []
            : [
                {
                  key: 'search',
            testID: 'page-search',
            icon: searchShown ? X : Search,
            label: searchShown ? t('common.close') : t('page.find'),
            onPress: () => (searchShown ? closeSearch() : router.navigate({ pathname: '/search', params: { page: page.id } })),
          },
              ]),
          ...(page.templateKey === 'expenses'
            ? []
            : [{ key: 'menu', testID: 'page-menu', icon: Ellipsis, label: t('move.menu_a11y', { what: title(page) }), onPress: () => setMenuOpen(true) }]),
        ]}
      />
      {searchShown ? (
        <FindField testID="page-find" label={t('page.find')} value={q} onChange={(value) => setFind({ pageId: page.id, q: value })} />
      ) : null}
      {ordering ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[2], flexWrap: 'wrap' }}>
          <AppText testID="page-order-hint" variant="callout" accessibilityLiveRegion="polite" style={{ flex: 1, minWidth: '50%' }}>
            {t('page.order_hint')}
          </AppText>
          <Button
            testID="page-order"
            label={t('page.order_done')}
            size="small"
            accessibilityState={{ selected: true }}
            onPress={() => setOrdering(false)}
          />
        </View>
      ) : null}
    </View>
  );

  let middle;
  if (searching) {
    const found = searchRecords(
      shownEntries((entries ?? []).map(entryRow)).map((e) => e.record),
      q,
    );
    const known = new Set(found.map((r) => r.serverId));
    const extra = server.results.filter((r) => !known.has(r.hit.item_id));
    const nothing = found.length === 0 && extra.length === 0 && server.state !== 'loading';
    middle = (
      <EntryList
        page={page}
        rows={found.map((record) => entryRow({ record, link: null }))}
        header={<View style={{ marginBottom: theme.space[4] }}>{top}</View>}
        ordering={false}
        searchQuery={q}
        footer={
          <View style={{ gap: theme.space[3] }}>
            <SearchMore rows={extra} state={server.state} pageId={page.id} q={q} />
            {nothing ? (
              <AppText testID="page-find-none" accessibilityLiveRegion="polite">
                {t('page.find_none')}
              </AppText>
            ) : null}
            <Button
              testID="page-find-all"
              label={t('page.find_all')}
              variant="text"
              onPress={() => router.navigate({ pathname: '/search', params: { q } })}
            />
          </View>
        }
      />
    );
  } else {
    const Tool = view.Component;
    middle = <Tool page={page} entries={entries} frameTop={top} ordering={ordering} />;
  }

  return (
    <Screen testID={`page-${page.templateKey}`} edges={['top']} scroll={false}>
      <View testID={`page-view-${view.key}`} style={{ flex: 1 }}>
        {middle}
      </View>
      {menuOpen ? (
        <Sheet testID="page-menu-sheet" visible onClose={() => setMenuOpen(false)} title={title(page)}>
          <ActionList actions={menuActions} />
        </Sheet>
      ) : null}
      {renaming ? (
        <PageNameSheet
          initial={page.title ?? ''}
          onClose={() => setRenaming(false)}
          onSave={(name) => {
            setRenaming(false);
            void renamePage(page.id, name);
          }}
        />
      ) : null}
    </Screen>
  );
}

/** «суббота, 14 ноября» above the title of «Дела» (QA v2 §4.1). */
function todayLine(lang: string): string {
  try {
    return new Date().toLocaleDateString(lang, { weekday: 'long', day: 'numeric', month: 'long' });
  } catch {
    return new Date().toDateString();
  }
}
