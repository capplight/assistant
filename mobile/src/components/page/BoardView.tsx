import { router } from 'expo-router';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Ellipsis, Pin } from 'lucide-react-native';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Animated,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
  type AccessibilityActionEvent,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { pickRecord } from '@/chat/service';
import type { LocalRecord } from '@/db';
import {
  BOARD_W,
  boardHeight,
  canNudge,
  drawOrder,
  dropPlace,
  inWindow,
  layoutBoard,
  NOTE,
  nudge,
  placeOf,
  onTop,
  readingOrder,
  toRow,
  toTop,
  zNow,
  type Arrow,
  type Laid,
  type Place,
} from '@/pages/board';
import type { PageEntry } from '@/pages/contents';
import { moveToPages, placeStickers, removeFromPage } from '@/pages/manual';
import { recordTitle, sourceLine } from '@/records/format';
import { getRecordActions } from '@/services';
import type { Page } from '@/store/pages';
import { useUndo } from '@/store/undo';
import { HIGHLIGHT_MS, useView } from '@/store/view';
import { useTheme } from '@/theme';

import { AppText } from '../AppText';
import { Button } from '../ui/Button';
import { MovePageSheet, type MoveMode } from '../MovePageSheet';
import { RecordMenuSheet, type MenuExtra } from '../RecordMenuSheet';
import { stickerLabel } from './stickerLabel';

/**
 * How often the board drew (Jest reads it: a drag must not draw the whole board again). Not used
 * by the app itself.
 */
export const boardStats = { board: 0, stickers: 0 };

type Props = {
  page: Page;
  /** Every sticker of the page in «Ряды» order (pinned first, then `position`). */
  entries: PageEntry[];
  /** Stickers drawn in a pile above the board, not on it (they still take their slots). */
  hidden: ReadonlySet<string>;
  /** The frame's top, the «Ряды | Доска» switch, the piles. */
  header: ReactElement;
  empty: ReactElement | null;
  menuExtra: (record: LocalRecord) => MenuExtra[];
};

/**
 * «Заметки», mode «Доска» (template-screens 2.1, Ф-28; weeks 16а–16б): stickers lie where the
 * person put them. The board is as wide as the screen and grows down (no sideways scroll);
 * stickers 140×140 pt at 360 pt width, no tilt, may lie on top of each other.
 *
 * - Long press 400 ms → the sticker follows the finger and lies on top; let go anywhere, it sticks
 *   to the 8 pt grid. Only the dragged sticker moves meanwhile (an animated value, no React
 *   render), so the rest of the board is not drawn again.
 * - Without gestures: «⋯ Ещё → Подвинуть» opens four big arrows «Выше · Ниже · Левее · Правее»
 *   (half a sticker each, the sheet stays open) and «Положить наверх доски»; the same five are
 *   actions for screen readers on each sticker.
 * - Each move is shown at once, offline and in «Без ИИ» too, with «Отменить»; the order of the
 *   rows is never touched. Stickers that never were on the board take the first free place at the
 *   top (a new one is lit 600 ms).
 * - Only the stickers near the screen are drawn (a long board stays light).
 * ≥150% and with a screen reader the board is shown as rows by `StickersView`, not here.
 */
export function BoardView({ page, entries, header, empty, menuExtra, hidden }: Props) {
  useEffect(() => {
    boardStats.board += 1;
  });
  const theme = useTheme();
  const { t } = useTranslation();
  const window = useWindowDimensions();
  const picking = useView((st) => (st.picking?.pageId === page.id ? st.picking : null));
  const highlight = useView((st) => st.highlight);
  const setTouching = useView((st) => st.setTouching);
  const [width, setWidth] = useState(() => Math.max(1, window.width - theme.screenPadding * 2));
  const scale = width / BOARD_W;
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [moveFor, setMoveFor] = useState<string | null>(null);
  const [moveSheet, setMoveSheet] = useState<{ recordId: string; mode: MoveMode } | null>(null);
  // Let go: the new place is shown until the row written on the phone comes back (new entries).
  const [dropped, setDropped] = useState<{ id: string; place: Place; on: PageEntry[] } | null>(null);

  const laid = useMemo(() => {
    const mine = dropped?.on === entries ? dropped : null;
    const items = entries.map((e) => ({
      id: e.record.id,
      tie: e.record.serverId ?? e.record.id,
      place: mine?.id === e.record.id ? mine.place : placeOf(e.link),
    }));
    // Every sticker takes its slot (the server's rule); those in a pile are not drawn here.
    return layoutBoard(items).filter((l) => !hidden.has(l.id));
  }, [entries, dropped, hidden]);

  const byId = useMemo(() => new Map(entries.map((e) => [e.record.id, e])), [entries]);
  const laidById = useMemo(() => new Map(laid.map((l) => [l.id, l])), [laid]);
  const reading = useMemo(() => new Map(readingOrder(laid).map((l, i) => [l.id, i])), [laid]);
  const height = Math.max(boardHeight(laid) * scale, window.height / 2);

  // A sticker that just came lies lit for 600 ms (template-screens 2.1 «Новый стикер»).
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  useEffect(() => {
    const ids = new Set(laid.map((l) => l.id));
    const before = seen.current;
    seen.current = ids;
    if (!before) return;
    const added = [...ids].filter((id) => !before.has(id));
    if (added.length === 0) return;
    setFresh(new Set(added));
    const timer = setTimeout(() => setFresh(new Set()), HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [laid]);

  // Only the stickers near the screen are drawn: the window moves in half-screen steps.
  const [boardTop, setBoardTop] = useState(0);
  const [band, setBand] = useState(0);
  const viewport = window.height;
  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const next = Math.max(0, Math.floor(e.nativeEvent.contentOffset.y / Math.max(1, viewport / 2)));
      setBand((b) => (b === next ? b : next));
    },
    [viewport],
  );
  const shownIds = useMemo(
    () => inWindow(laid, (band * (viewport / 2) - boardTop) / scale, viewport / scale),
    [laid, band, viewport, boardTop, scale],
  );

  // The records on screen for the assistant line («эту», visible_item_ids).
  useEffect(() => {
    const ids = laid.filter((l) => shownIds.has(l.id)).flatMap((l) => byId.get(l.id)?.record.serverId ?? []);
    if (ids.length > 0) useView.getState().setVisible(page.id, ids);
  }, [shownIds, laid, byId, page.id]);

  // What the gesture and the sheets read: always the board as drawn now.
  const live = useRef({ laid, laidById, byId, scale, page, entries });
  useLayoutEffect(() => {
    live.current = { laid, laidById, byId, scale, page, entries };
  });

  const commit = useCallback(
    (id: string, place: Place) => {
      const { byId: recs, page: pg } = live.current;
      const entry = recs.get(id);
      if (!entry) return;
      setDropped({ id, place, on: live.current.entries });
      void placeStickers(pg, [{ record: entry.record, ...toRow(place) }], t('notes.board_moved', { what: recordTitle(entry.record, t) }));
    },
    [t],
  );

  const arrow = useCallback(
    (id: string, dir: Arrow | 'top') => {
      const { laid: all, laidById: map } = live.current;
      const l = map.get(id);
      if (!l) return;
      // Every place the person makes lies on top: its `z` is the time of the place (views.md).
      if (dir === 'top') {
        if (!onTop(l, all)) commit(id, toTop(l, zNow()));
        return;
      }
      const next = nudge(l, dir, zNow());
      if (next) commit(id, next);
    },
    [commit],
  );

  // --- drag: long press arms it, the board's responder follows the finger ---
  const [dragId, setDragId] = useState<string | null>(null);
  const [drag] = useState(() => new BoardDrag(setDragId));
  useEffect(() => {
    drag.onDrop((id, dx, dy) => {
      const { laidById: map, scale: s } = live.current;
      const from = map.get(id);
      if (!from) return;
      const place = dropPlace(from, dx, dy, s, zNow());
      if (place.x !== from.x || place.y !== from.y) commit(id, place);
    });
  }, [drag, commit]);
  const startDrag = useCallback((id: string) => drag.start(id), [drag]);

  const open = useCallback(
    (id: string) => {
      const rec = live.current.byId.get(id)?.record;
      if (!rec) return;
      // «Какую? → выбрать»: this tap answers the assistant (US-30).
      if (picking && rec.serverId) {
        void pickRecord(rec.serverId);
        return;
      }
      router.navigate({ pathname: '/record/[id]', params: { id: rec.id, from: live.current.page.id } });
    },
    [picking],
  );
  const onMenu = useCallback((id: string) => setMenuFor(id), []);
  const onAction = useCallback(
    (id: string, name: string) => {
      if (name === 'menu') setMenuFor(id);
      else if (name === 'up' || name === 'down' || name === 'left' || name === 'right' || name === 'top') arrow(id, name);
    },
    [arrow],
  );

  const hl = highlight ? new Set(highlight.ids) : null;
  const menuEntry = menuFor ? byId.get(menuFor) : undefined;
  const moveEntry = moveFor ? byId.get(moveFor) : undefined;
  const moveLaid = moveFor ? laidById.get(moveFor) : undefined;
  const sheetEntry = moveSheet ? byId.get(moveSheet.recordId) : undefined;
  const size = NOTE * scale;

  return (
    <>
      <ScrollView
        testID="page-records"
        scrollEnabled={dragId === null}
        onScroll={onScroll}
        scrollEventThrottle={64}
        onTouchStart={() => setTouching(true)}
        onTouchEnd={() => !drag.active() && setTouching(false)}
        onTouchCancel={() => !drag.active() && setTouching(false)}
        onScrollBeginDrag={() => setTouching(true)}
        onMomentumScrollEnd={() => setTouching(false)}
        contentContainerStyle={{ paddingVertical: theme.space[4] }}
        keyboardShouldPersistTaps="handled"
      >
        {header}
        {entries.length === 0 ? (
          empty
        ) : (
          <View
            testID="board"
            accessibilityLabel={t('notes.board_a11y', { count: entries.length })}
            onLayout={(e: LayoutChangeEvent) => {
              const { width: w, y } = e.nativeEvent.layout;
              if (w > 0 && Math.abs(w - width) > 0.5) setWidth(w);
              setBoardTop(y);
            }}
            style={{ height, position: 'relative' }}
            {...drag.handlers}
          >
            {drawOrder(laid)
              .filter((l) => shownIds.has(l.id) || l.id === dragId)
              .map((l) => {
                const entry = byId.get(l.id)!;
                const rec = entry.record;
                return (
                  <BoardSticker
                    key={l.id}
                    entry={entry}
                    x={l.x * scale}
                    y={l.y * scale}
                    z={l.z}
                    size={size}
                    index={reading.get(l.id) ?? 0}
                    total={laid.length}
                    lit={fresh.has(l.id) || (!!rec.serverId && !!hl?.has(rec.serverId))}
                    drag={dragId === l.id ? drag.pan : null}
                    canUp={canNudge(l, 'up')}
                    canLeft={canNudge(l, 'left')}
                    canRight={canNudge(l, 'right')}
                    onPress={open}
                    onLongPress={startDrag}
                    onMenu={onMenu}
                    onAction={onAction}
                  />
                );
              })}
          </View>
        )}
      </ScrollView>
      {menuEntry ? (
        <RecordMenuSheet
          title={recordTitle(menuEntry.record, t)}
          mine={!!menuEntry.link?.boardManual}
          canUp={false}
          canDown={false}
          onUp={() => undefined}
          onDown={() => undefined}
          move={{
            testID: 'menu-board-move',
            label: t('notes.board_move'),
            hint: t('notes.board_move_hint'),
            onPress: () => {
              setMenuFor(null);
              setMoveFor(menuEntry.record.id);
            },
          }}
          extra={menuExtra(menuEntry.record).map((x) => ({
            ...x,
            onPress: () => {
              setMenuFor(null);
              x.onPress();
            },
          }))}
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
      {moveEntry && moveLaid ? (
        <ArrowsSheet
          title={recordTitle(moveEntry.record, t)}
          place={moveLaid}
          onTop={onTop(moveLaid, laid)}
          onArrow={(dir) => arrow(moveEntry.record.id, dir)}
          onClose={() => setMoveFor(null)}
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

/**
 * The finger's part of a drag (like `useDrag` of the rows): armed by the long press, the board's
 * responder takes the moves, the sticker follows by an animated value (no React render), let go:
 * the drop. Nothing scrolls or changes under the finger meanwhile (R-54).
 */
class BoardDrag {
  readonly pan = new Animated.ValueXY();
  readonly handlers: ReturnType<typeof PanResponder.create>['panHandlers'] & { onTouchEnd: () => void };
  private s: { id: string; granted: boolean } | null = null;
  private drop: (id: string, dx: number, dy: number) => void = () => undefined;

  constructor(private readonly show: (id: string | null) => void) {
    const pan = PanResponder.create({
      onMoveShouldSetPanResponderCapture: () => this.s !== null,
      onPanResponderGrant: () => {
        if (this.s) this.s.granted = true;
      },
      onPanResponderTerminationRequest: () => false,
      onPanResponderMove: (_e, g) => this.pan.setValue({ x: g.dx, y: g.dy }),
      onPanResponderRelease: (_e, g) => this.end(true, g.dx, g.dy),
      onPanResponderTerminate: () => this.end(false),
    });
    // Let go without moving: the long press ends, nothing moves.
    this.handlers = { ...pan.panHandlers, onTouchEnd: () => this.s && !this.s.granted && this.end(false) };
  }

  onDrop(fn: (id: string, dx: number, dy: number) => void): void {
    this.drop = fn;
  }

  active(): boolean {
    return this.s !== null;
  }

  start(id: string): void {
    this.s = { id, granted: false };
    this.pan.setValue({ x: 0, y: 0 });
    useView.getState().setTouching(true);
    this.show(id);
  }

  private end(drop: boolean, dx = 0, dy = 0): void {
    const s = this.s;
    this.s = null;
    useView.getState().setTouching(false);
    if (s && drop && (dx !== 0 || dy !== 0)) this.drop(s.id, dx, dy);
    this.pan.setValue({ x: 0, y: 0 });
    this.show(null);
  }
}

type StickerProps = {
  entry: PageEntry;
  x: number;
  y: number;
  z: number;
  size: number;
  index: number;
  total: number;
  lit: boolean;
  /** Set only on the sticker being dragged: it follows the finger. */
  drag: Animated.ValueXY | null;
  canUp: boolean;
  canLeft: boolean;
  canRight: boolean;
  onPress: (id: string) => void;
  onLongPress: (id: string) => void;
  onMenu: (id: string) => void;
  onAction: (id: string, name: string) => void;
};

/** One sticker on the board. Drawn again only when its own props change (`memo`). */
const BoardSticker = memo(function BoardSticker({
  entry,
  x,
  y,
  z,
  size,
  index,
  total,
  lit,
  drag,
  canUp,
  canLeft,
  canRight,
  onPress,
  onLongPress,
  onMenu,
  onAction,
}: StickerProps) {
  useEffect(() => {
    boardStats.stickers += 1;
  });
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const rec = entry.record;
  const id = rec.id;
  const color = entry.link?.color ?? null;
  const pinned = !!entry.link?.pinned;
  const text = (rec.text ?? rec.title ?? '').trim() || recordTitle(rec, t);
  const [first, ...rest] = text.split('\n');
  const actions = [
    ...(canUp ? [{ name: 'up', label: t('notes.board_up') }] : []),
    { name: 'down', label: t('notes.board_down') },
    ...(canLeft ? [{ name: 'left', label: t('notes.board_left') }] : []),
    ...(canRight ? [{ name: 'right', label: t('notes.board_right') }] : []),
    { name: 'top', label: t('notes.board_top') },
    { name: 'menu', label: t('move.menu') },
  ];
  const lifted = drag !== null;
  return (
    <Animated.View
      testID={`sticker-${id}`}
      style={[
        styles.sticker,
        {
          left: x,
          top: y,
          width: size,
          height: size,
          zIndex: lifted ? 100_000 : z + 1,
          elevation: lifted ? 8 : 1,
          backgroundColor: lit ? theme.colors.highlightTint : theme.notes[color ?? 'white'],
          borderRadius: theme.radius.md,
          borderColor: lit || lifted ? theme.colors.highlight : theme.colors.separator,
          borderWidth: lit || lifted ? 3 : 1,
        },
        drag ? { transform: drag.getTranslateTransform() } : null,
      ]}
    >
      <Pressable
        testID={`record-${id}`}
        accessibilityRole="button"
        accessibilityLabel={stickerLabel(rec, { color, pinned, index, total }, t, i18n.language)}
        accessibilityHint={t('notes.board_drag_hint')}
        accessibilityActions={actions}
        onAccessibilityAction={(e: AccessibilityActionEvent) => onAction(id, e.nativeEvent.actionName)}
        onPress={() => onPress(id)}
        onLongPress={() => onLongPress(id)}
        delayLongPress={400}
        style={[styles.flex, { padding: theme.space[2], gap: 2 }]}
      >
        {pinned ? (
          <View testID={`sticker-pin-${id}`} importantForAccessibility="no-hide-descendants">
            <Pin size={18} color={theme.colors.ink} />
          </View>
        ) : null}
        <AppText variant="bodyStrong" numberOfLines={2}>
          {first}
        </AppText>
        {rest.length > 0 ? <AppText numberOfLines={2}>{rest.join('\n').trim()}</AppText> : null}
      </Pressable>
      <View style={[styles.row, { paddingLeft: theme.space[2] }]}>
        <AppText variant="callout" numberOfLines={1} style={styles.flex}>
          {sourceLine(rec, i18n.language, t)}
        </AppText>
        <Pressable
          testID={`record-menu-${id}`}
          accessibilityRole="button"
          accessibilityLabel={t('move.menu_a11y', { what: recordTitle(rec, t) })}
          onPress={() => onMenu(id)}
          style={{ width: theme.size.minTouch, height: theme.size.minTouch, alignItems: 'center', justifyContent: 'center' }}
        >
          <Ellipsis size={24} color={theme.colors.brand} />
        </Pressable>
      </View>
    </Animated.View>
  );
});

/**
 * «Подвинуть»: four big arrows (half a sticker each) and «Положить наверх доски». The sheet stays
 * open: press again and again; each press is one change with «Отменить».
 */
function ArrowsSheet({
  title,
  place,
  onTop,
  onArrow,
  onClose,
}: {
  title: string;
  place: Laid;
  onTop: boolean;
  onArrow: (dir: Arrow | 'top') => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  const { t } = useTranslation();
  const big = { minHeight: 72, flex: 1 } as const;
  const btn = (dir: Arrow, Icon: typeof ArrowUp) => (
    <Button
      testID={`board-${dir}`}
      label={t(`notes.board_${dir}`)}
      accessibilityLabel={t(`notes.board_${dir}_a11y`, { what: title })}
      variant="secondary"
      icon={<Icon size={28} color={theme.colors.brand} />}
      disabled={!canNudge(place, dir)}
      onPress={() => onArrow(dir)}
      style={big}
    />
  );
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={[styles.scrim, { backgroundColor: theme.colors.scrim }]}>
        <SafeAreaView
          edges={['bottom']}
          testID="board-move-sheet"
          style={{ backgroundColor: theme.colors.surface, borderTopLeftRadius: theme.radius.sheet, borderTopRightRadius: theme.radius.sheet, maxHeight: '90%' }}
        >
          <ScrollView contentContainerStyle={{ padding: theme.space[5], gap: theme.space[3] }}>
            <AppText variant="title2" accessibilityRole="header">
              {t('notes.board_move')}
            </AppText>
            <AppText variant="callout" numberOfLines={2}>
              {title}
            </AppText>
            {theme.largeFont ? (
              <>
                {btn('up', ArrowUp)}
                {btn('down', ArrowDown)}
                {btn('left', ArrowLeft)}
                {btn('right', ArrowRight)}
              </>
            ) : (
              <>
                <View style={[styles.row, { gap: theme.space[3] }]}>
                  {btn('up', ArrowUp)}
                  {btn('down', ArrowDown)}
                </View>
                <View style={[styles.row, { gap: theme.space[3] }]}>
                  {btn('left', ArrowLeft)}
                  {btn('right', ArrowRight)}
                </View>
              </>
            )}
            <Button testID="board-top" label={t('notes.board_top')} variant="secondary" disabled={onTop} onPress={() => onArrow('top')} />
            <Button testID="board-move-close" label={t('common.close')} variant="secondary" onPress={onClose} />
          </ScrollView>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sticker: { position: 'absolute', overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  scrim: { flex: 1, justifyContent: 'flex-end' },
});
