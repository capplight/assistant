import { router, useLocalSearchParams } from 'expo-router';
import { PencilLine } from 'lucide-react-native';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, Pressable, View } from 'react-native';

import { pickRecord } from '@/chat/service';
import type { PageEntry } from '@/pages/contents';
import { useView } from '@/store/view';

import { AppText } from '@/components/AppText';
import { Button } from '@/components/Button';
import { PageIcon } from '@/components/Icon';
import { PageNameSheet } from '@/components/PageNameSheet';
import { RecordRow } from '@/components/RecordRow';
import { Screen } from '@/components/Screen';
import { FindField, SearchMore } from '@/components/SearchResults';
import { renamePage } from '@/pages/service';
import { usePageLabels } from '@/pages/usePageLabels';
import { searchRecords, snippetFor } from '@/records/search';
import { usePageEntries } from '@/records/useRecords';
import { useServerSearch } from '@/records/useServerSearch';
import { usePages } from '@/store/pages';
import { useTheme } from '@/theme';

/**
 * S37: the universal page, the same frame for every template. A view on the shared memory (R-46):
 * records come from local SQLite, online or not; the assistant line and tabs are in the layout.
 * Week 3: the list layout for all templates, «Заметки» shows it as «Последние» (stacks: F-09).
 * Week 6: after «Разложи» the rows come in groups with headings; what the assistant changed is
 * marked 600 ms (`markerSoft`); nothing moves while a finger is on the list (R-54) — the patch
 * waits for it. The rows on screen go with a request from the line (`visible_item_ids`).
 * «Найти на странице» (S10): at once by letters on the phone, online or not; the server adds word
 * forms, typos and meaning when it can. Not here yet: «Порядок» and «⋯ Ещё» (week 7), «Настроить» (week 11).
 */
export default function PageScreen() {
  const theme = useTheme();
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id: string }>();
  const page = usePages((s) => s.pages.find((p) => p.id === id));
  const { title } = usePageLabels();
  const entries = usePageEntries(page);
  const [renaming, setRenaming] = useState(false);
  // Tabs reuse one screen for all pages: what was typed on page A stays with page A.
  const [find, setFind] = useState({ pageId: id, q: '' });
  const q = find.pageId === id ? find.q : '';
  const searching = q.trim().length > 0;
  const server = useServerSearch(q, { pageServerId: page?.serverId ?? null, enabled: !!page?.serverId });
  const highlight = useView((st) => st.highlight);
  const clearHighlight = useView((st) => st.clearHighlight);
  const picking = useView((st) => (st.picking?.pageId === id ? st.picking : null));
  const setVisible = useView((st) => st.setVisible);
  const setTouching = useView((st) => st.setTouching);

  // The marker goes after 600 ms (Reduce Motion: the same, it is a colour, not a move).
  useEffect(() => {
    if (!highlight) return;
    const timer = setTimeout(clearHighlight, Math.max(0, highlight.until - Date.now()));
    return () => clearTimeout(timer);
  }, [highlight, clearHighlight]);

  // Until the list reports what is visible, the first rows count as on screen.
  useEffect(() => {
    if (!entries || !id) return;
    setVisible(
      id,
      entries.map((e) => e.record.serverId).filter((x): x is string => !!x),
    );
  }, [entries, id, setVisible]);

  // FlatList wants one callback for its whole life: the page id is read from a ref.
  const currentId = useRef(id);
  useEffect(() => {
    currentId.current = id;
  }, [id]);
  const [onViewable] = useState(() => ({ viewableItems }: { viewableItems: { item: Row }[] }) => {
    const ids = viewableItems
      .map((v) => (v.item.type === 'entry' ? v.item.entry.record.serverId : null))
      .filter((x): x is string => !!x);
    if (ids.length > 0 && currentId.current) useView.getState().setVisible(currentId.current, ids);
  });

  // Group headings after «Разложи»: a heading where the group changes (rows are in group order).
  const rows = useMemo(() => withGroups(entries ?? [], page?.groups ?? []), [entries, page?.groups]);

  if (!page) {
    return (
      <Screen testID="page-missing" edges={['top']}>
        <AppText variant="title1">{t('page.not_found')}</AppText>
      </Screen>
    );
  }

  const shown = entries ?? [];
  const hl = highlight ? new Set(highlight.ids) : null;
  const foundRecords = searching ? searchRecords(shown.map((e) => e.record), q) : null;
  const known = new Set((foundRecords ?? []).map((r) => r.serverId));
  const extra = server.results.filter((r) => !known.has(r.hit.item_id));
  const nothing = searching && foundRecords?.length === 0 && extra.length === 0 && server.state !== 'loading';

  const header = (
    <View style={{ marginBottom: theme.space[4], gap: theme.space[4] }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[3] }}>
        <PageIcon name={page.icon} color={theme.colors.ink} size={28} />
        <AppText variant="title1" accessibilityRole="header" style={{ flex: 1 }}>
          {title(page)}
        </AppText>
        {page.templateKey === 'custom' ? (
          <Pressable
            testID="page-rename"
            accessibilityRole="button"
            accessibilityLabel={t('page.rename')}
            onPress={() => setRenaming(true)}
            style={{
              width: theme.size.minTouch,
              height: theme.size.minTouch,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <PencilLine size={24} color={theme.colors.accent} />
          </Pressable>
        ) : null}
      </View>
      <FindField
        testID="page-find"
        label={t('page.find')}
        value={q}
        onChange={(value) => setFind({ pageId: id, q: value })}
      />
      {!searching && entries && entries.length > 0 ? (
        <AppText variant="section" accessibilityRole="header">
          {t('page.recent')}
        </AppText>
      ) : null}
    </View>
  );

  const example =
    page.templateKey === 'notes' || page.templateKey === 'custom'
      ? t(`page.empty_example.${page.templateKey}`)
      : t(`tpl.line_hint_now.${page.templateKey}`);

  return (
    <Screen testID={`page-${page.templateKey}`} edges={['top']} scroll={false}>
      <FlatList
        testID="page-records"
        data={foundRecords ? foundRecords.map((record): Row => ({ type: 'entry', entry: { record, link: null } })) : rows}
        keyExtractor={(r) => (r.type === 'entry' ? r.entry.record.id : `group-${r.key}`)}
        onViewableItemsChanged={onViewable}
        onTouchStart={() => setTouching(true)}
        onTouchEnd={() => setTouching(false)}
        onTouchCancel={() => setTouching(false)}
        onScrollBeginDrag={() => setTouching(true)}
        onMomentumScrollEnd={() => setTouching(false)}
        contentContainerStyle={{ paddingVertical: theme.space[4] }}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={header}
        ListFooterComponent={
          searching ? (
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
          ) : undefined
        }
        ListEmptyComponent={
          entries && !searching ? (
            <View
              testID="page-empty"
              style={{
                backgroundColor: theme.colors.surface,
                borderColor: theme.colors.line,
                borderWidth: 1,
                borderRadius: theme.radius.card,
                padding: theme.space[4],
                gap: theme.space[2],
              }}
            >
              <AppText>{t('page.empty')}</AppText>
              <AppText variant="meta">{example}</AppText>
            </View>
          ) : undefined
        }
        renderItem={({ item }) =>
          item.type === 'group' ? (
            <AppText
              testID={`group-${item.key}`}
              variant="section"
              accessibilityRole="header"
              style={{ marginTop: theme.space[3], marginBottom: theme.space[2] }}
            >
              {item.title}
            </AppText>
          ) : (
            <RecordRow
              record={item.entry.record}
              snippet={searching ? snippetFor(item.entry.record, q) : null}
              highlighted={!!item.entry.record.serverId && !!hl?.has(item.entry.record.serverId)}
              onPress={() => {
                const rec = item.entry.record;
                // «Какую? → выбрать»: this tap answers the assistant (US-30).
                if (picking && rec.serverId) {
                  void pickRecord(rec.serverId);
                  return;
                }
                router.navigate({ pathname: '/record/[id]', params: { id: rec.id, from: page.id } });
              }}
            />
          )
        }
      />
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

type Row = { type: 'entry'; entry: PageEntry } | { type: 'group'; key: string; title: string };

/** Rows with a heading wherever the group changes. Without group titles: just the rows. */
function withGroups(entries: PageEntry[], groups: { key: string; title: string }[]): Row[] {
  const titles = new Map(groups.map((g) => [g.key, g.title]));
  const out: Row[] = [];
  let last: string | null = null;
  for (const entry of entries) {
    const key = entry.link?.groupKey ?? null;
    if (titles.size > 0 && key && key !== last) out.push({ type: 'group', key, title: titles.get(key) ?? key });
    last = key;
    out.push({ type: 'entry', entry });
  }
  return out;
}
