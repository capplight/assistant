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

/** What the list draws per line: a row, or (grid) up to `columns` records side by side. */
type Line = Row | { type: 'line'; items: EntryRow[] };

/** Records packed into lines of `columns`; a heading or a task row always starts a new line. */
export function toLines(rows: Row[], columns: number): Line[] {
  const out: Line[] = [];
  let cur: EntryRow[] = [];
  const flush = () => {
    if (cur.length > 0) out.push({ type: 'line', items: cur });
    cur = [];
  };
  for (const r of rows) {
    if (r.type !== 'entry') {
      flush();
      out.push(r);
      continue;
    }
    cur.push(r);
    if (cur.length === columns) flush();
  }
  flush();
  return out;
}

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
  renderGroup,
  today,
  columns = 1,
  onStep,
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
  /** Week 11а: a heading drawn by the tool (the shop with ↑ ↓ in «Порядок»); null = the plain one. */
  renderGroup?: (row: Extract<Row, { type: 'group' }>) => ReactElement | null;
  /** «Дела»: the day the due dates are counted from. */
  today?: string;
  /**
   * Week 11а: a grid («Заметки» rows of stickers). Records go left to right, top to bottom in the
   * same one-line order (`position`), still virtualised by line. In a grid there is no drag: «⋯»
   * Выше / Ниже and «Порядок» ↑ ↓ move a sticker one place (template-screens 2.1). Needs `renderEntry`.
   */
  columns?: number;
  /**
   * Weeks 16а–16б: «Выше / Ниже» do something else than the page order — the free board shown as
   * rows (≥150%, screen reader) swaps the places of two stickers. No drag then.
   */
  onStep?: (recordId: string, step: -1 | 1) => void;
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
  const [onViewable] = useState(() => ({ viewableItems }: { viewableItems: { item: Line }[] }) => {
    const ids = viewableItems
      .flatMap((v) => (v.item.type === 'entry' ? [v.item] : v.item.type === 'line' ? v.item.items : []))
      .map((r) => r.entry.record.serverId)
      .filter((x): x is string => !!x);
    if (ids.length > 0 && currentId.current) useView.getState().setVisible(currentId.current, ids);
  });

  const shown = shownEntries(rows);
  const canMove = !searching && shown.length > 0;
  const menuIndex = menuFor ? shown.findIndex((e) => e.record.id === menuFor) : -1;
  const menuEntry = menuIndex >= 0 ? shown[menuIndex] : undefined;
  const sheetEntry = moveSheet ? shown.find((e) => e.record.id === moveSheet.recordId) : undefined;
  const hl = highlight ? new Set(highlight.ids) : null;
  const step = (recordId: string, by: -1 | 1) => (onStep ? onStep(recordId, by) : void stepRecord(page, recordId, by));

  const open = (rec: LocalRecord) => {
    // «Какую? → выбрать»: this tap answers the assistant (US-30).
    if (picking && rec.serverId) {
      void pickRecord(rec.serverId);
      return;
    }
    router.navigate({ pathname: '/record/[id]', params: { id: rec.id, from: page.id } });
  };

  const grid = columns > 1 && !!renderEntry;
  const lines: Line[] = grid ? toLines(rows, columns) : rows;

  /** One record: the template's own drawing, a row with a box, or the plain card. */
  const renderRecord = (item: EntryRow, index: number, style: object | undefined, canDrag: boolean) => {
    const rec = item.entry.record;
    const at = shown.findIndex((e) => e.record.id === rec.id);
    const highlighted = !!rec.serverId && !!hl?.has(rec.serverId);
    const moves: RowMoves | undefined = canMove
      ? {
          onMenu: () => setMenuFor(rec.id),
          onUp: at > 0 ? () => step(rec.id, -1) : undefined,
          onDown: at >= 0 && at < shown.length - 1 ? () => step(rec.id, 1) : undefined,
          onMoveTo: () => setMoveSheet({ recordId: rec.id, mode: 'move' }),
          onDragStart: canDrag && !onStep
            ? () =>
                drag.start(index, (to) => {
                  const target = entryIndexAfterDrop(
                    rows.map((r) => r.type === 'entry'),
                    index,
                    to,
                  );
                  if (target !== at) void dropRecord(page, rec.id, target);
                })
            : undefined,
          showArrows: ordering,
        }
      : undefined;
    if (renderEntry) {
      const own = renderEntry(item, {
        index,
        at,
        moves,
        highlighted,
        lifted: canDrag && drag.isDragged(index),
        onPress: () => open(rec),
        onLayout: (e) => {
          if (canDrag) drag.measure(index, e.nativeEvent.layout.height + theme.space[3]);
        },
      });
      if (own) return <View style={style}>{own}</View>;
    }
    if (item.task) {
      const task = item.task;
      return (
        <View style={style} onLayout={(e) => drag.measure(index, e.nativeEvent.layout.height)}>
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
  };

  return (
    <>
      <View style={{ flex: 1 }} {...drag.handlers}>
        <FlatList<Line>
          testID="page-records"
          data={lines}
          keyExtractor={(r) =>
            r.type === 'entry'
              ? r.entry.record.id
              : r.type === 'task'
                ? `task-${r.task.id}`
                : r.type === 'line'
                  ? `line-${r.items[0]?.entry.record.id ?? ''}`
                  : `group-${r.key}`
          }
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
              const own = renderGroup?.(item);
              if (own) {
                return (
                  <View style={style} onLayout={measure}>
                    {own}
                  </View>
                );
              }
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
            if (item.type === 'line') {
              // A row of the grid: each cell is one record, in the page order (left to right).
              return (
                <View style={{ flexDirection: 'row', gap: theme.space[3], marginBottom: theme.space[3] }}>
                  {item.items.map((cell) => (
                    <View key={cell.entry.record.id} style={{ flex: 1 }}>
                      {renderRecord(cell, -1, undefined, false)}
                    </View>
                  ))}
                  {Array.from({ length: columns - item.items.length }, (_, i) => (
                    <View key={`gap-${i}`} style={{ flex: 1 }} />
                  ))}
                </View>
              );
            }
            return renderRecord(item, index, style, true);
          }}
        />
      </View>
      {menuEntry ? (
        <RecordMenuSheet
          title={recordTitle(menuEntry.record, t)}
          mine={!!menuEntry.link?.manualOrder}
          canUp={menuIndex > 0}
          canDown={menuIndex < shown.length - 1}
          extra={menuExtra?.(menuEntry.record).map((x) => ({
            ...x,
            // The template's item (Цвет, Приколоть…) closes the menu first: it may open its own sheet.
            onPress: () => {
              setMenuFor(null);
              x.onPress();
            },
          }))}
          onUp={() => step(menuEntry.record.id, -1)}
          onDown={() => step(menuEntry.record.id, 1)}
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
