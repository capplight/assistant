import { ArrowDown, ArrowUp, Check, Ellipsis, Pin } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Pressable, ScrollView, StyleSheet, View, type AccessibilityActionEvent } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useShallow } from 'zustand/react/shallow';

import type { NoteColor } from '@/api/types';
import type { LocalRecord } from '@/db';
import { refreshCollections, refreshGroups, stacksOf } from '@/dedup/service';
import { useDedup } from '@/dedup/store';
import { layoutBoard, placeOf, readingOrder, swapInReading, toRow, zNow } from '@/pages/board';
import type { PageEntry } from '@/pages/contents';
import { placeStickers, setRowLook } from '@/pages/manual';
import { changeView } from '@/pages/viewService';
import { recordTitle, sourceLine, statusLine } from '@/records/format';
import { unverifiedCount } from '@/records/review';
import { NOTE_COLOR_KEYS, useTheme } from '@/theme';

import { AppText } from '../AppText';
import { Button } from '../Button';
import type { MenuExtra } from '../RecordMenuSheet';
import type { RowMoves } from '../RecordRow';
import { StackCards } from '../StackCards';
import { useScreenReader } from '../useScreenReader';
import { BoardView } from './BoardView';
import { EntryList, type EntryCtx } from './EntryList';
import { entryRow, withGroups, type EntryRow } from './rows';
import type { ViewProps } from './registry';
import { stickerLabel } from './stickerLabel';

export { stickerLabel };

/**
 * «Заметки» — the wall of stickers, mode «Ряды» (template-screens 2.1, Ф-28; week 11а). Piles of
 * stickers for stacks on top (colour of the top sticker, two lines of it), then the stickers in
 * two columns, left to right and top to bottom in the person's order (`position`); pinned ones
 * first. Each sticker: its colour, ≤5 lines, the date, [⋯ Ещё] with «Цвет» and «Приколоть наверх /
 * Открепить» on top of the shared menu. All of it works offline and in «Без ИИ»; «раскрась по
 * темам» comes from the assistant line as a view change with «Что изменилось» / «Отменить».
 * ≥150%: one column, a sticker as wide as the screen and as tall as its text, the colour as an
 * 8 pt band on the left plus the background.
 * Weeks 16а–16б: the second mode «Доска» (`view_state.board`; the switch `[Ряды | Доска]` under
 * «Найти», also in S38) is the free board (`BoardView`). Both layouts are kept: the rows by
 * `position`, the board by `board_*`; a move in one never changes the other. ≥150% and with a
 * screen reader the board is shown as rows top to bottom, left to right by its places, with a line
 * saying so; «Выше / Ниже» there swap two stickers' places on the board.
 */
export function StickersView({ page, entries, frameTop, ordering }: ViewProps) {
  const theme = useTheme();
  const { t } = useTranslation();
  const [colorFor, setColorFor] = useState<PageEntry | null>(null);
  const dedup = useDedup(useShallow((s) => ({ collections: s.collections, gone: s.goneCollections })));

  useEffect(() => {
    void refreshCollections();
    void refreshGroups();
  }, [page.id]);

  // Stickers that lie in a pile are in the pile, not on the wall too.
  const pileTitles = useMemo(() => {
    const groups = (page.groups ?? []).map((g) => g.title);
    return new Set(stacksOf(dedup.collections, dedup.gone, page.serverId, groups).map((c) => c.title));
  }, [dedup.collections, dedup.gone, page.serverId, page.groups]);

  const screenReader = useScreenReader();
  const board = page.view?.mode === 'board';
  // ≥150% and with a screen reader the board is drawn as rows (template-screens 2.1, 5).
  const boardAsRows = board && (theme.largeFont || screenReader);

  // Every sticker in «Ряды» order (pinned first, a stable split, R-54): the board's slots follow it.
  const all = useMemo(() => {
    const list = entries ?? [];
    return [...list.filter((e) => e.link?.pinned), ...list.filter((e) => !e.link?.pinned)];
  }, [entries]);
  // Stickers in a pile are drawn in the pile above (they still take their slot on the board).
  const inPile = useMemo(
    () => new Set(all.filter((e) => e.link?.groupKey && pileTitles.has(e.link.groupKey)).map((e) => e.record.id)),
    [all, pileTitles],
  );
  const inRows = useMemo(() => all.filter((e) => !inPile.has(e.record.id)), [all, inPile]);
  const laid = useMemo(
    () =>
      board
        ? layoutBoard(all.map((e) => ({ id: e.record.id, tie: e.record.serverId ?? e.record.id, place: placeOf(e.link) }))).filter(
            (l) => !inPile.has(l.id),
          )
        : [],
    [board, all, inPile],
  );

  const rows = useMemo(() => {
    if (boardAsRows) {
      const byRec = new Map(inRows.map((e) => [e.record.id, e]));
      return readingOrder(laid).flatMap((l) => {
        const e = byRec.get(l.id);
        return e ? [entryRow(e)] : [];
      });
    }
    const pinned = inRows.filter((e) => e.link?.pinned);
    const rest = inRows.filter((e) => !e.link?.pinned);
    // «Разложи» groups that are not piles keep their headings (week 6).
    return [...pinned.map(entryRow), ...withGroups(rest, page.groups ?? [])];
  }, [boardAsRows, inRows, laid, page.groups]);

  /** The board as rows: «Выше / Ниже» swap the places of two neighbours (the board is counted again). */
  const swap = (recordId: string, step: -1 | 1) => {
    // One call with two places, each sticker getting the other's (views.md «the board as rows»).
    const pair = swapInReading(laid, recordId, step, zNow());
    if (!pair) return;
    const byRec = new Map(inRows.map((e) => [e.record.id, e]));
    const a = byRec.get(pair.a.id);
    const b = byRec.get(pair.b.id);
    if (!a || !b) return;
    void placeStickers(
      page,
      [
        { record: a.record, ...toRow(pair.a) },
        { record: b.record, ...toRow(pair.b) },
      ],
      t('notes.board_moved', { what: recordTitle(a.record, t) }),
    );
  };

  // «Стикер 3 из 12»: the place among the stickers, headings not counted.
  const order = useMemo(() => rows.flatMap((r) => (r.type === 'entry' ? [r.entry.record.id] : [])), [rows]);
  const byId = useMemo(() => new Map((entries ?? []).map((e) => [e.record.id, e])), [entries]);
  const large = theme.largeFont;

  const menuExtra = (record: LocalRecord): MenuExtra[] => {
    const entry = byId.get(record.id);
    if (!entry) return [];
    const pinned = !!entry.link?.pinned;
    const color = entry.link?.color ?? null;
    const what = recordTitle(record, t);
    return [
      {
        testID: 'menu-color',
        label: t('notes.color'),
        hint: t(`notes.colors.${color ?? 'white'}`),
        onPress: () => setColorFor(entry),
      },
      {
        testID: 'menu-pin',
        label: pinned ? t('notes.unpin') : t('notes.pin'),
        onPress: () => void setRowLook(record, page, { pinned: !pinned }, t(pinned ? 'notes.unpinned' : 'notes.pinned', { what })),
      },
    ];
  };

  const header = (
    <View style={{ marginBottom: theme.space[4], gap: theme.space[4] }}>
      {frameTop}
      <ModeSwitch board={board} onPick={(on) => void changeView(page, { kind: 'board', on })} />
      {boardAsRows ? (
        <AppText testID="notes-board-rows" variant="meta" accessibilityLiveRegion="polite">
          {t(theme.largeFont ? 'notes.board_as_rows_large' : 'notes.board_as_rows_reader')}
        </AppText>
      ) : null}
      <StackCards page={page} entries={entries} piles />
      {rows.length > 0 && pileTitles.size > 0 ? (
        <AppText variant="section" accessibilityRole="header">
          {t('notes.stickers')}
        </AppText>
      ) : null}
    </View>
  );

  const renderEntry = (row: EntryRow, ctx: EntryCtx) => (
    <Sticker
      entry={row.entry}
      ctx={ctx}
      large={large}
      index={order.indexOf(row.entry.record.id)}
      total={order.length}
    />
  );

  return (
    <>
      {board && !boardAsRows ? (
        <BoardView page={page} entries={all} hidden={inPile} header={header} menuExtra={menuExtra} empty={entries ? <EmptyWall /> : null} />
      ) : (
        <EntryList
          page={page}
          rows={rows}
          header={header}
          ordering={ordering}
          renderEntry={renderEntry}
          menuExtra={menuExtra}
          columns={large ? 1 : 2}
          empty={entries ? <EmptyWall /> : null}
          {...(boardAsRows ? { onStep: swap } : {})}
        />
      )}
      {colorFor ? (
        <ColorSheet
          title={recordTitle(colorFor.record, t)}
          current={colorFor.link?.color ?? null}
          onClose={() => setColorFor(null)}
          onPick={(c) => {
            const e = colorFor;
            setColorFor(null);
            const value = c === 'white' ? null : c;
            if ((e.link?.color ?? null) === value) return;
            void setRowLook(e.record, page, { color: value }, t('notes.colored', { color: t(`notes.colors.${c}`), what: recordTitle(e.record, t) }));
          }}
        />
      ) : null}
    </>
  );
}

function Sticker({ entry, ctx, large, index, total }: { entry: PageEntry; ctx: EntryCtx; large: boolean; index: number; total: number }) {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const rec = entry.record;
  const color = entry.link?.color ?? null;
  const pinned = !!entry.link?.pinned;
  // ≥150% the colour is an 8 pt band on paper: full-width blocks of colour would be a rainbow.
  const bg = large ? theme.colors.surface : theme.notes[color ?? 'white'];
  const text = (rec.text ?? rec.title ?? '').trim() || recordTitle(rec, t);
  const [first, ...rest] = text.split('\n');
  const moves: RowMoves | undefined = ctx.moves;
  const actions = moves
    ? [
        ...(moves.onUp ? [{ name: 'up', label: t('move.up') }] : []),
        ...(moves.onDown ? [{ name: 'down', label: t('move.down') }] : []),
        ...(moves.onMoveTo ? [{ name: 'moveTo', label: t('move.to') }] : []),
        { name: 'menu', label: t('move.menu') },
      ]
    : undefined;
  const onAction = (e: AccessibilityActionEvent) => {
    const name = e.nativeEvent.actionName;
    if (name === 'up') moves?.onUp?.();
    else if (name === 'down') moves?.onDown?.();
    else if (name === 'moveTo') moves?.onMoveTo?.();
    else if (name === 'menu') moves?.onMenu();
  };
  const square = { width: theme.size.minTouch, height: theme.size.minTouch, alignItems: 'center', justifyContent: 'center' } as const;
  const title = recordTitle(rec, t);
  const status = statusLine(rec, t);
  const toCheck = unverifiedCount(rec) > 0;

  return (
    <View
      testID={`sticker-${rec.id}`}
      onLayout={ctx.onLayout}
      style={[
        styles.sticker,
        {
          backgroundColor: bg,
          borderRadius: theme.radius.note,
          borderColor: ctx.highlighted ? theme.colors.marker : theme.colors.line,
          borderWidth: ctx.highlighted ? 3 : 1,
          minHeight: large ? theme.size.primaryTouch : 160,
          marginBottom: large ? theme.space[3] : 0,
        },
      ]}
    >
      {large && color && color !== 'white' ? (
        <View testID={`sticker-band-${rec.id}`} style={[styles.band, { backgroundColor: theme.notes[color], borderRightWidth: 1, borderRightColor: theme.colors.lineStrong }]} />
      ) : null}
      <Pressable
        testID={`record-${rec.id}`}
        accessibilityRole="button"
        accessibilityLabel={stickerLabel(rec, { color, pinned, index, total }, t, i18n.language)}
        accessibilityActions={actions}
        onAccessibilityAction={actions ? onAction : undefined}
        onPress={ctx.onPress}
        onLongPress={moves?.onMenu}
        delayLongPress={400}
        style={({ pressed }) => [
          styles.flex,
          {
            padding: theme.space[3],
            paddingLeft: large ? theme.space[4] + 8 : theme.space[3],
            gap: theme.space[1],
            opacity: pressed ? 0.85 : 1,
            // Changed by the assistant: `markerSoft` for 600 ms (2-design `motion.highlight`).
            ...(ctx.highlighted ? { backgroundColor: theme.colors.markerSoft } : {}),
          },
        ]}
      >
        {pinned ? (
          <View testID={`sticker-pin-${rec.id}`} style={styles.row} importantForAccessibility="no-hide-descendants">
            <Pin size={20} color={theme.colors.ink} />
          </View>
        ) : null}
        <AppText variant="bodyStrong" numberOfLines={large ? undefined : 2}>
          {first}
        </AppText>
        {rest.length > 0 ? <AppText numberOfLines={large ? undefined : 3}>{rest.join('\n').trim()}</AppText> : null}
        {status ? <AppText variant="meta">{status}</AppText> : null}
        {rec.aiGenerated ? <AppText variant="meta">{t('ai.label_short')}</AppText> : null}
        {toCheck ? (
          <View testID={`record-check-${rec.id}`} style={{ alignSelf: 'flex-start', backgroundColor: theme.colors.markerSoft, borderRadius: theme.radius.chip, paddingHorizontal: theme.space[2] }}>
            <AppText variant="meta" color="warnText">
              {t('check.badge')}
            </AppText>
          </View>
        ) : null}
      </Pressable>
      <View style={[styles.row, { paddingLeft: large ? theme.space[4] + 8 : theme.space[3], flexWrap: 'wrap' }]}>
        <AppText variant="meta" style={styles.flex}>
          {sourceLine(rec, i18n.language, t)}
        </AppText>
        {moves?.showArrows ? (
          <>
            <Pressable
              testID={`record-up-${rec.id}`}
              accessibilityRole="button"
              accessibilityLabel={t('move.up_a11y', { what: title })}
              accessibilityState={{ disabled: !moves.onUp }}
              disabled={!moves.onUp}
              onPress={moves.onUp}
              style={[square, { opacity: moves.onUp ? 1 : 0.35 }]}
            >
              <ArrowUp size={24} color={theme.colors.accent} />
            </Pressable>
            <Pressable
              testID={`record-down-${rec.id}`}
              accessibilityRole="button"
              accessibilityLabel={t('move.down_a11y', { what: title })}
              accessibilityState={{ disabled: !moves.onDown }}
              disabled={!moves.onDown}
              onPress={moves.onDown}
              style={[square, { opacity: moves.onDown ? 1 : 0.35 }]}
            >
              <ArrowDown size={24} color={theme.colors.accent} />
            </Pressable>
          </>
        ) : null}
        {moves ? (
          <Pressable
            testID={`record-menu-${rec.id}`}
            accessibilityRole="button"
            accessibilityLabel={t('move.menu_a11y', { what: title })}
            onPress={moves.onMenu}
            style={square}
          >
            <Ellipsis size={24} color={theme.colors.accent} />
          </Pressable>
        ) : null}
      </View>
      {/* the bent corner: decoration only */}
      <View
        importantForAccessibility="no-hide-descendants"
        accessibilityElementsHidden
        style={[styles.fold, { backgroundColor: theme.colors.bg, borderColor: theme.colors.line }]}
      />
    </View>
  );
}

/** `[Ряды | Доска]` (48 pt, Ф-28): «Ряды» by default; the same choice is in S38 → «Вид». */
function ModeSwitch({ board, onPick }: { board: boolean; onPick: (board: boolean) => void }) {
  const theme = useTheme();
  const { t } = useTranslation();
  return (
    <View accessibilityRole="tablist" style={[styles.row, { gap: theme.space[2] }]}>
      {([false, true] as const).map((on) => (
        <Button
          key={String(on)}
          testID={`notes-mode-${on ? 'board' : 'rows'}`}
          label={t(on ? 'notes.mode_board' : 'notes.mode_rows')}
          variant={on === board ? 'primary' : 'outline'}
          minHeight={theme.size.minTouch}
          accessibilityRole="tab"
          accessibilityState={{ selected: on === board }}
          style={styles.flex}
          onPress={() => {
            if (on !== board) onPick(on);
          }}
        />
      ))}
    </View>
  );
}

/** «Цвет»: six round 48 pt buttons, each with its name (colour never carries meaning alone). */
function ColorSheet({ title, current, onPick, onClose }: { title: string; current: NoteColor | null; onPick: (c: NoteColor) => void; onClose: () => void }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const selected = current ?? 'white';
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <View style={[styles.scrim, { backgroundColor: theme.colors.scrim }]}>
        <SafeAreaView
          edges={['bottom']}
          testID="color-sheet"
          style={{ backgroundColor: theme.colors.surface, borderTopLeftRadius: theme.radius.sheet, borderTopRightRadius: theme.radius.sheet, maxHeight: '90%' }}
        >
          <ScrollView contentContainerStyle={{ padding: theme.space[5], gap: theme.space[4] }}>
            <AppText variant="title2" accessibilityRole="header">
              {t('notes.color_title')}
            </AppText>
            <AppText variant="meta" numberOfLines={2}>
              {title}
            </AppText>
            <View accessibilityRole="radiogroup" style={[styles.row, { flexWrap: 'wrap', gap: theme.space[3] }]}>
              {NOTE_COLOR_KEYS.map((c) => {
                const on = c === selected;
                const name = t(`notes.colors.${c}`);
                return (
                  <Pressable
                    key={c}
                    testID={`color-${c}`}
                    accessibilityRole="radio"
                    accessibilityLabel={name}
                    accessibilityState={{ checked: on }}
                    onPress={() => onPick(c)}
                    style={{ alignItems: 'center', gap: theme.space[1], minWidth: 72, minHeight: theme.size.primaryTouch }}
                  >
                    <View
                      style={{
                        width: theme.size.minTouch,
                        height: theme.size.minTouch,
                        borderRadius: theme.radius.round,
                        backgroundColor: theme.notes[c],
                        borderWidth: on ? 3 : 1,
                        borderColor: on ? theme.colors.accent : theme.colors.lineStrong,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {on ? <Check size={24} color={theme.colors.ink} strokeWidth={3} /> : null}
                    </View>
                    <AppText variant={on ? 'bodyStrong' : 'meta'} color="ink">
                      {name}
                    </AppText>
                  </Pressable>
                );
              })}
            </View>
            <Button testID="color-close" label={t('common.close')} variant="outline" onPress={onClose} />
          </ScrollView>
        </SafeAreaView>
      </View>
    </Modal>
  );
}

/** Empty: one pale example sticker and what to say (template-screens 2.1). */
function EmptyWall() {
  const theme = useTheme();
  const { t } = useTranslation();
  return (
    <View testID="page-empty" style={{ gap: theme.space[3] }}>
      <View
        style={[
          styles.sticker,
          { backgroundColor: theme.notes.yellow, borderRadius: theme.radius.note, borderColor: theme.colors.line, borderWidth: 1, opacity: 0.7, padding: theme.space[4], minHeight: 120 },
        ]}
      >
        <AppText>{t('notes.empty')}</AppText>
      </View>
      <AppText variant="meta">{t('notes.example_1')}</AppText>
      <AppText variant="meta">{t('notes.example_2')}</AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  sticker: { overflow: 'hidden' },
  band: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 8 },
  row: { flexDirection: 'row', alignItems: 'center' },
  flex: { flex: 1 },
  fold: { position: 'absolute', right: -1, bottom: -1, width: 14, height: 14, borderTopWidth: 1, borderLeftWidth: 1, borderTopLeftRadius: 4 },
  scrim: { flex: 1, justifyContent: 'flex-end' },
});
