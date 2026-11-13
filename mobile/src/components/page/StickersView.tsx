import { ArrowDown, ArrowUp, Check, Ellipsis, StickyNote as StickyNoteIcon } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, StyleSheet, View, type AccessibilityActionEvent } from 'react-native';
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
import { useFeatures } from '@/store/features';
import { NOTE_COLOR_KEYS, useLayout, useTheme } from '@/theme';

import { AppText } from '../AppText';
import type { MenuExtra } from '../RecordMenuSheet';
import type { RowMoves } from '../RecordRow';
import { StackCards } from '../StackCards';
import { Icon, pressedStyle, SegmentedControl, Sheet, StickyNote } from '../ui';
import { useScreenReader } from '../useScreenReader';
import { BoardView } from './BoardView';
import { EntryList, type EntryCtx } from './EntryList';
import { PageEmpty } from './PageEmpty';
import { entryRow, withGroups, type EntryRow } from './rows';
import type { ViewProps } from './registry';
import { stickerLabel } from './stickerLabel';

export { stickerLabel };

/**
 * «Заметки» — the sticker grid «Ряды» (design-system §3 StickyNote, screens.html «Заметки»; template-screens 2.1).
 * Piles of stickers for stacks on top, then the stickers in `layout.noteColumns` columns (2 · 3 from 600 · 1 at
 * ≥150 % · 1 under 360 from 130 %), left to right and top to bottom in the person's order; pinned ones first.
 * Each sticker: its colour as the fill, radius 14, no border, no «⋯» — long press opens the shared menu with
 * «Цвет» and «Приколоть наверх / Открепить» on top; screen readers get Выше / Ниже / Ещё as actions; «Порядок»
 * shows ↑ ↓ ⋯ under each. Offline and in «Без ИИ» alike.
 * «Доска» (weeks 16а–16б, `BoardView`) is behind the `board` switch (Ф-38, off for the beta): while it is off
 * there is no `Ряды | Доска` and a page saved as a board shows as rows. With it on, ≥150 % and a screen reader
 * show the board as rows by its places, and «Выше / Ниже» swap two stickers' places.
 */
export function StickersView({ page, entries, frameTop, ordering }: ViewProps) {
  const theme = useTheme();
  const layout = useLayout();
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
  // Ф-38: the board is hidden while the switch is off (its code and the saved places stay).
  const boardOn = useFeatures((f) => f.board);
  const board = boardOn && page.view?.mode === 'board';
  const boardAsRows = board && (theme.largeFont || screenReader);

  // Every sticker in «Ряды» order (pinned first, a stable split, R-54): the board's slots follow it.
  const all = useMemo(() => {
    const list = entries ?? [];
    return [...list.filter((e) => e.link?.pinned), ...list.filter((e) => !e.link?.pinned)];
  }, [entries]);
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
    <View style={{ marginBottom: theme.space[3], gap: theme.space[3] }}>
      {frameTop}
      {boardOn ? <ModeSwitch board={board} onPick={(on) => void changeView(page, { kind: 'board', on })} /> : null}
      {boardAsRows ? (
        <AppText testID="notes-board-rows" variant="callout" accessibilityLiveRegion="polite">
          {t(theme.largeFont ? 'notes.board_as_rows_large' : 'notes.board_as_rows_reader')}
        </AppText>
      ) : null}
      <StackCards page={page} entries={entries} piles />
      {rows.length > 0 && pileTitles.size > 0 ? (
        <AppText variant="sectionLabel" accessibilityRole="header">
          {t('notes.stickers')}
        </AppText>
      ) : null}
    </View>
  );

  const renderEntry = (row: EntryRow, ctx: EntryCtx) => (
    <Sticker entry={row.entry} ctx={ctx} index={order.indexOf(row.entry.record.id)} total={order.length} />
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
          columns={layout.noteColumns}
          gap={theme.space[2]}
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

function Sticker({ entry, ctx, index, total }: { entry: PageEntry; ctx: EntryCtx; index: number; total: number }) {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const rec = entry.record;
  const color = entry.link?.color ?? null;
  const pinned = !!entry.link?.pinned;
  const text = (rec.text ?? rec.title ?? '').trim() || recordTitle(rec, t);
  const [first = '', ...rest] = text.split('\n');
  const body = rest.join('\n').trim();
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
  const title = recordTitle(rec, t);
  const status = statusLine(rec, t);
  const toCheck = unverifiedCount(rec) > 0;
  const square = { width: theme.size.minTouch, height: theme.size.minTouch, alignItems: 'center', justifyContent: 'center' } as const;

  return (
    <View testID={`sticker-${rec.id}`} onLayout={ctx.onLayout} style={{ gap: theme.space[1] }}>
      <StickyNote
        testID={`record-${rec.id}`}
        title={body ? first : undefined}
        text={body || first}
        date={sourceLine(rec, i18n.language, t)}
        color={color ?? 'white'}
        pinned={pinned}
        highlighted={ctx.highlighted}
        accessibilityLabel={stickerLabel(rec, { color, pinned, index, total }, t, i18n.language)}
        accessibilityActions={actions}
        onAccessibilityAction={actions ? onAction : undefined}
        onPress={ctx.onPress}
        onLongPress={moves?.onMenu}
      >
        {status ? <AppText variant="footnote">{status}</AppText> : null}
        {rec.aiGenerated ? <AppText variant="footnote">{t('ai.label_short')}</AppText> : null}
        {toCheck ? (
          <View
            testID={`record-check-${rec.id}`}
            style={{ alignSelf: 'flex-start', backgroundColor: theme.colors.highlightTint, borderRadius: theme.radius.round, paddingHorizontal: theme.space[2] }}
          >
            <AppText variant="footnote" color="warning">
              {t('check.badge')}
            </AppText>
          </View>
        ) : null}
      </StickyNote>
      {moves?.showArrows ? (
        <View style={[styles.row, { justifyContent: 'center' }]}>
          <Pressable
            testID={`record-up-${rec.id}`}
            accessibilityRole="button"
            accessibilityLabel={t('move.up_a11y', { what: title })}
            accessibilityState={{ disabled: !moves.onUp }}
            disabled={!moves.onUp}
            onPress={moves.onUp}
            style={[square, { opacity: moves.onUp ? 1 : 0.35 }]}
          >
            <Icon icon={ArrowUp} color="brand" />
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
            <Icon icon={ArrowDown} color="brand" />
          </Pressable>
          <Pressable
            testID={`record-menu-${rec.id}`}
            accessibilityRole="button"
            accessibilityLabel={t('move.menu_a11y', { what: title })}
            onPress={moves.onMenu}
            style={square}
          >
            <Icon icon={Ellipsis} color="iconSecondary" />
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

/** `Ряды | Доска` (Ф-28) — only while the `board` switch is on (Ф-38). */
function ModeSwitch({ board, onPick }: { board: boolean; onPick: (board: boolean) => void }) {
  const { t } = useTranslation();
  return (
    <SegmentedControl<'rows' | 'board'>
      testID="notes-mode"
      segments={[
        { key: 'rows', label: t('notes.mode_rows'), testID: 'notes-mode-rows' },
        { key: 'board', label: t('notes.mode_board'), testID: 'notes-mode-board' },
      ]}
      value={board ? 'board' : 'rows'}
      onChange={(k) => {
        if ((k === 'board') !== board) onPick(k === 'board');
      }}
    />
  );
}

/** «Цвет»: six round swatches in the one sheet, each with its name (colour never carries meaning alone). */
function ColorSheet({ title, current, onPick, onClose }: { title: string; current: NoteColor | null; onPick: (c: NoteColor) => void; onClose: () => void }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const selected = current ?? 'white';
  const d = theme.size.headerButton + 4;
  return (
    <Sheet visible testID="color-sheet" title={t('notes.color_title')} onClose={onClose}>
      <AppText variant="callout" numberOfLines={2}>
        {title}
      </AppText>
      <View accessibilityRole="radiogroup" style={[styles.row, { flexWrap: 'wrap', gap: theme.space[2] }]}>
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
              style={({ pressed }) => [
                { alignItems: 'center', gap: theme.space[1], minWidth: 72, minHeight: theme.size.minTouch, paddingVertical: theme.space[1] },
                pressedStyle(pressed),
              ]}
            >
              <View
                style={[
                  { width: d, height: d, borderRadius: d / 2, backgroundColor: theme.notes[c], alignItems: 'center', justifyContent: 'center' },
                  c === 'white' ? theme.elevation.card : null,
                ]}
              >
                {on ? <Icon icon={Check} color="brand" /> : null}
              </View>
              <AppText
                variant="footnote"
                color={on ? 'ink' : 'ink2'}
                style={on ? { fontFamily: theme.type.sectionLabel.fontFamily } : undefined}
              >
                {name}
              </AppText>
            </Pressable>
          );
        })}
      </View>
    </Sheet>
  );
}

/** Empty: the icon, the phrase and what to say (design-system §3 EmptyState — no fake stickers). */
function EmptyWall() {
  const { t } = useTranslation();
  return <PageEmpty icon={StickyNoteIcon} lines={[t('notes.empty'), t('notes.example_1'), t('notes.example_2')]} />;
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
});
