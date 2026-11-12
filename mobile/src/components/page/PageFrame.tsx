import { router } from 'expo-router';
import { PencilLine } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { renamePage } from '@/pages/service';
import { usePageLabels } from '@/pages/usePageLabels';
import { searchRecords } from '@/records/search';
import { usePageEntries } from '@/records/useRecords';
import { useServerSearch } from '@/records/useServerSearch';
import type { Page } from '@/store/pages';
import { useView } from '@/store/view';
import { useTheme } from '@/theme';

import { AppText } from '../AppText';
import { Button } from '../ui/Button';
import { PageIcon } from '../Icon';
import { PageNameSheet } from '../PageNameSheet';
import { Screen } from '../Screen';
import { FindField, SearchMore } from '../SearchResults';
import { EntryList } from './EntryList';
import { resolveView } from './registry';
import { entryRow, shownEntries, sortEntries } from './rows';

/**
 * `PageFrame` (template-screens 3): the same edges on every page so nobody gets lost — the title
 * with its icon (✎ on «Своя страница»), «Порядок», «Настроить» (S38), «Найти на странице» (S10).
 * The middle is the template's tool from the registry (`resolveView`); while searching, the frame
 * shows the found records the same way on every page. The bottom edge — answer banner, «Отменить»,
 * the assistant line, tabs — is the main layout's footer, outside the tool.
 */
export function PageFrame({ page }: { page: Page }) {
  const theme = useTheme();
  const { t } = useTranslation();
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
  const view = resolveView(page);

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
  const top = (
    <View style={{ gap: theme.space[4] }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[3], flexWrap: 'wrap' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[3], flexGrow: 1, flexShrink: 1, minWidth: '50%' }}>
          <PageIcon name={page.icon} color={theme.colors.ink} size={28} />
          <AppText testID="page-title" variant="largeTitle" accessibilityRole="header" style={{ flexShrink: 1 }}>
            {title(page)}
          </AppText>
          {page.templateKey === 'custom' ? (
            <Pressable
              testID="page-rename"
              accessibilityRole="button"
              accessibilityLabel={t('page.rename')}
              onPress={() => setRenaming(true)}
              style={{ width: theme.size.minTouch, height: theme.size.minTouch, alignItems: 'center', justifyContent: 'center' }}
            >
              <PencilLine size={24} color={theme.colors.brand} />
            </Pressable>
          ) : null}
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[1] }}>
          {(hasRecords && !searching) || ordering ? (
            <Button
              testID="page-order"
              label={ordering ? t('page.order_done') : t('page.order')}
              variant={ordering ? 'primary' : 'text'}
              minHeight={theme.size.minTouch}
              accessibilityState={{ selected: ordering }}
              onPress={() => setOrdering((o) => !o)}
            />
          ) : null}
          <Button
            testID="page-settings"
            label={t('view.settings')}
            accessibilityLabel={t('view.settings_a11y', { page: title(page) })}
            variant="text"
            minHeight={theme.size.minTouch}
            onPress={() => router.push({ pathname: '/page-settings/[id]', params: { id: page.id } })}
          />
        </View>
      </View>
      <FindField testID="page-find" label={t('page.find')} value={q} onChange={(value) => setFind({ pageId: page.id, q: value })} />
      {ordering ? (
        <AppText testID="page-order-hint" variant="callout" accessibilityLiveRegion="polite">
          {t('page.order_hint')}
        </AppText>
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
