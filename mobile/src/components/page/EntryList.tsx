import { router } from 'expo-router';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { FlatList, View, type LayoutChangeEvent } from 'react-native';

import { pickRecord } from '@/chat/service';
import type { LocalRecord } from '@/db';
import { entryIndexAfterDrop } from '@/pages/drag';
import { dropRecord, moveToPages, removeFromPage, stepRecord } from '@/pages/manual';
import { recordTitle } from '@/records/format';
import { snippetFor } from '@/records/search';
import { getRecordActions } from '@/services';
import type { Page } from '@/store/pages';
import { useUndo } from '@/store/undo';
import { useView } from '@/store/view';
import { setDone } from '@/tasks/service';
import { useTheme } from '@/theme';

import { AppText } from '../AppText';
import { MovePageSheet, type MoveMode } from '../MovePageSheet';
import { RecordMenuSheet, type MenuExtra } from '../RecordMenuSheet';
import { RecordRow, type RowMoves } from '../RecordRow';
import { TaskRow } from '../TaskRow';
import { useDrag } from '../useDrag';
import { dueText, shownEntries, type EntryRow, type Row } from './rows';

/** What a tool gets to draw one record its own way (a notebook card, a table row, later a sticker). */
export type EntryCtx = {
  index: number;
  /** Place in the order on screen (−1: not movable). */
  at: number;
  moves: RowMoves | undefined;
  highlighted: boolean;
  lifted: boolean;
  onPress: () => void;
  onLayout: (e: LayoutChangeEvent) => void;
};

/**
 * The shared list engine of every page (template-screens 3): the rows as the person ordered them,
 * the same «⋯ Ещё» (`RecordMenuSheet`) with the template's own items on top, «Переместить…»
 * (`MovePageSheet`), long press → drag (`useDrag`), ↑ ↓ in «Порядок», the 600 ms marker, nothing
 * moving under a finger (R-54), the rows on screen for the line (`visible_item_ids`). A tool draws
 * its records with `renderEntry`; everything around stays the same.
 */
export function EntryList({
  page,
  rows,
  header,
  footer,
  empty,
  ordering,
  searchQuery,
  renderEntry,
  menuExtra,
  groupTitle,
  today,
}: {
  page: Page;
  rows: Row[];
  header: ReactElement;
  footer?: ReactElement;
  empty?: ReactElement | null;
  ordering: boolean;
  /** Search results: show where it matched; no moves. */
  searchQuery?: string;
  renderEntry?: (row: EntryRow, ctx: EntryCtx) => ReactElement | null;
  /** ≤2 items of the template on top of «⋯ Ещё» (template-screens 3). */
  menuExtra?: (record: LocalRecord) => MenuExtra[];
  groupTitle?: (row: Extract<Row, { type: 'group' }>) => string;
  /** «Дела»: the day the due dates are counted from. */
  today?: string;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const highlight = useView((st) => st.highlight);
  const picking = useView((st) => (st.picking?.pageId === page.id ? st.picking : null));
  const setTouching = useView((st) => st.setTouching);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [moveSheet, setMoveSheet] = useState<{ recordId: string; mode: MoveMode } | null>(null);
  const drag = useDrag();
  const searching = searchQuery !== undefined && searchQuery.trim().length > 0;

  // FlatList wants one callback for its whole life: the page id is read from a ref.
  const currentId = useRef(page.id);
  useEffect(() => {
    currentId.current = page.id;
  }, [page.id]);
  const [onViewable] = useState(() => ({ viewableItems }: { viewableItems: { item: Row }[] }) => {
    const ids = viewableItems
      .map((v) => (v.item.type === 'entry' ? v.item.entry.record.serverId : null))
      .filter((x): x is string => !!x);
    if (ids.length > 0 && currentId.current) useView.getState().setVisible(currentId.current, ids);
  });

  const shown = shownEntries(rows);
  const canMove = !searching && shown.length > 0;
  const menuIndex = menuFor ? shown.findIndex((e) => e.record.id === menuFor) : -1;
  const menuEntry = menuIndex >= 0 ? shown[menuIndex] : undefined;
  const sheetEntry = moveSheet ? shown.find((e) => e.record.id === moveSheet.recordId) : undefined;
  const hl = highlight ? new Set(highlight.ids) : null;

  const open = (rec: LocalRecord) => {
    // «Какую? → выбрать»: this tap answers the assistant (US-30).
    if (picking && rec.serverId) {
      void pickRecord(rec.serverId);
      return;
    }
    router.navigate({ pathname: '/record/[id]', params: { id: rec.id, from: page.id } });
  };

  return (
    <>
      <View style={{ flex: 1 }} {...drag.handlers}>
        <FlatList
          testID="page-records"
          data={rows}
          keyExtractor={(r) => (r.type === 'entry' ? r.entry.record.id : r.type === 'task' ? `task-${r.task.id}` : `group-${r.key}`)}
          onViewableItemsChanged={onViewable}
          scrollEnabled={!drag.active}
          onTouchStart={() => setTouching(true)}
          onTouchEnd={() => setTouching(false)}
          onTouchCancel={() => setTouching(false)}
          onScrollBeginDrag={() => setTouching(true)}
          onMomentumScrollEnd={() => setTouching(false)}
          contentContainerStyle={{ paddingVertical: theme.space[4] }}
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={header}
          ListFooterComponent={footer}
          ListEmptyComponent={empty ?? undefined}
          renderItem={({ item, index }) => {
            const shift = drag.shift(index);
            const style = shift ? { transform: [{ translateY: shift }], zIndex: drag.isDragged(index) ? 10 : 0 } : undefined;
            const measure = (e: LayoutChangeEvent) => drag.measure(index, e.nativeEvent.layout.height);
            if (item.type === 'group') {
              return (
                <View style={style} onLayout={measure}>
                  <AppText
                    testID={`group-${item.key}`}
                    variant="section"
                    accessibilityRole="header"
                    style={{ paddingTop: theme.space[3], paddingBottom: theme.space[2] }}
                  >
                    {groupTitle ? groupTitle(item) : item.title}
                  </AppText>
                </View>
              );
            }
            if (item.type === 'task') {
              // Added on this phone, its page row not here yet: a box, no moves until the server has it.
              return (
                <View style={style} onLayout={measure}>
                  <TaskRow
                    task={item.task}
                    done={item.done}
                    showReturn={item.task.list_key === 'shopping'}
                    meta={t('queue')}
                    onToggle={() => void setDone(item.task.id, !item.done)}
                  />
                </View>
              );
            }
            const rec = item.entry.record;
            const at = shown.findIndex((e) => e.record.id === rec.id);
            const highlighted = !!rec.serverId && !!hl?.has(rec.serverId);
            const moves: RowMoves | undefined = canMove
              ? {
                  onMenu: () => setMenuFor(rec.id),
                  onUp: at > 0 ? () => void stepRecord(page, rec.id, -1) : undefined,
                  onDown: at >= 0 && at < shown.length - 1 ? () => void stepRecord(page, rec.id, 1) : undefined,
                  onMoveTo: () => setMoveSheet({ recordId: rec.id, mode: 'move' }),
                  onDragStart: () =>
                    drag.start(index, (to) => {
                      const target = entryIndexAfterDrop(
                        rows.map((r) => r.type === 'entry'),
                        index,
                        to,
                      );
                      if (target !== at) void dropRecord(page, rec.id, target);
                    }),
                  showArrows: ordering,
                }
              : undefined;
            if (renderEntry) {
              const own = renderEntry(item, {
                index,
                at,
                moves,
                highlighted,
                lifted: drag.isDragged(index),
                onPress: () => open(rec),
                onLayout: (e) => drag.measure(index, e.nativeEvent.layout.height + theme.space[3]),
              });
              if (own) return <View style={style}>{own}</View>;
            }
            if (item.task) {
              const task = item.task;
              return (
                <View style={style} onLayout={measure}>
                  <TaskRow
                    task={task}
                    done={item.done}
                    showReturn={task.list_key === 'shopping'}
                    meta={task.due_date && task.list_key === 'todo' && today ? dueText(task.due_date, today, t) : null}
                    highlighted={highlighted}
                    onToggle={() => void setDone(task.id, !item.done)}
                    onMenu={canMove ? () => setMenuFor(rec.id) : undefined}
                  />
                </View>
              );
            }
            return (
              <View style={style}>
                <RecordRow
                  record={rec}
                  snippet={searching && searchQuery ? snippetFor(rec, searchQuery) : null}
                  highlighted={highlighted}
                  lifted={drag.isDragged(index)}
                  onLayout={(e) => drag.measure(index, e.nativeEvent.layout.height + theme.space[3])}
                  moves={moves}
                  onPress={() => open(rec)}
                />
              </View>
            );
          }}
        />
      </View>
      {menuEntry ? (
        <RecordMenuSheet
          title={recordTitle(menuEntry.record, t)}
          mine={!!menuEntry.link?.manualOrder}
          canUp={menuIndex > 0}
          canDown={menuIndex < shown.length - 1}
          extra={menuExtra?.(menuEntry.record)}
          onUp={() => void stepRecord(page, menuEntry.record.id, -1)}
          onDown={() => void stepRecord(page, menuEntry.record.id, 1)}
          onMoveTo={() => {
            setMenuFor(null);
            setMoveSheet({ recordId: menuEntry.record.id, mode: 'move' });
          }}
          onAlso={() => {
            setMenuFor(null);
            setMoveSheet({ recordId: menuEntry.record.id, mode: 'also_show' });
          }}
          onRemove={() => {
            setMenuFor(null);
            void removeFromPage(menuEntry.record, page);
          }}
          onDelete={() => {
            const id = menuEntry.record.id;
            setMenuFor(null);
            void getRecordActions()
              .then((a) => a.remove(id))
              .then(() => useUndo.getState().showDeleted(id));
          }}
          onClose={() => setMenuFor(null)}
        />
      ) : null}
      {moveSheet && sheetEntry ? (
        <MovePageSheet
          record={sheetEntry.record}
          recordTitle={recordTitle(sheetEntry.record, t)}
          current={page}
          initialMode={moveSheet.mode}
          onClose={() => setMoveSheet(null)}
          onDone={(mode, targets) => {
            setMoveSheet(null);
            void moveToPages(sheetEntry.record, page, targets, mode);
          }}
        />
      ) : null}
    </>
  );
}
