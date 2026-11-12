import { act, fireEvent, renderRouter, screen } from 'expo-router/testing-library';
import { AccessibilityInfo, Dimensions, StyleSheet } from 'react-native';

import { manualOut, placeOut } from '@/api/endpoints';
import { boardStats } from '@/components/page/BoardView';
import type { InMemoryOutboxRepository } from '@/db';
import { linkFrom } from '@/db/pages';
import {
  BOARD_W,
  boardHeight,
  dropPlace,
  inWindow,
  layoutBoard,
  NOTE,
  nudge,
  onTop,
  placeOf,
  readingOrder,
  swapInReading,
  toRow,
  toTop,
} from '@/pages/board';
import { catalogTemplate } from '@/pages/catalog';
import type { ItemPlacePayload } from '@/pages/manual';
import { applyChange, EMPTY_VIEW, viewBody } from '@/pages/viewModel';
import { getSyncEngine, notifyDataChanged } from '@/services';
import { usePages, type Page } from '@/store/pages';
import { useUndo } from '@/store/undo';
import { happyServer, itemOut, linkOut, type FakeServer } from '@/testing/fakeServer';
import { APP_DIR, finishOnboarding, resetApp, settle, testPages, testRecords } from '@/testing/helpers';

/**
 * Weeks 16а–16б (template-screens 2.1, 3, 5, 6; Ф-28; docs/api/views.md): the free board «Доска»
 * of «Заметки» as the second mode of the same sticker tool. Fake server only: nothing here ran
 * against the real server or on a phone. Whether the drag is smooth on a low-end Redmi needs a
 * real phone; Jest only shows that a drag does not draw the board again.
 */

const iso = (ms: number) => new Date(ms).toISOString();
/** Window 390 wide, screen padding 20 on each side (the board's width before its first layout). */
const S = (390 - 40) / BOARD_W;

function action(id: string, summary: string) {
  return {
    id,
    kind: 'screen_view_change',
    scope: 'internal',
    initiated_by: 'user',
    summary: { ru: summary, kk: null },
    page: null,
    changes: [],
    changed_item_ids: [],
    created_page_id: null,
    undoable: true,
    undoable_until: iso(Date.now() + 30 * 86_400_000),
    undone_at: null,
    undo_of: null,
    message_id: null,
    seq: 10,
    created_at: iso(Date.now()),
  };
}

function server(): FakeServer {
  const s = happyServer();
  s.on('POST /actions/*/undo', (c) => ({
    status: 200,
    body: { action: { ...action(c.path.split('/')[2]!, 'x'), undoable: false, undone_at: iso(Date.now()) }, undo: null, partial: false, repeated: false, message_ru: null, page_patches: [] },
  }))
    .on('GET /actions', () => ({ status: 200, body: { actions: [], has_more: false } }))
    .on('GET /page-templates', () => ({ status: 200, body: { templates: [] } }))
    .on('GET /collections', () => ({ status: 200, body: { collections: [] } }))
    .on('GET /duplicates/groups', () => ({ status: 200, body: { groups: [] } }))
    .on('GET /today', () => ({ status: 200, body: { sections: [], today: { reminders: [], tasks: [], shopping: null }, missed: [], done_for_you: { actions: [], count_today: 0 }, proposals: [], tip: null, empty: false } }));
  return s;
}

async function start(s: FakeServer, mode: 'full' | 'no_ai' = 'full'): Promise<InMemoryOutboxRepository> {
  const outbox = resetApp({ fetch: s.fetch });
  finishOnboarding(mode);
  await (await getSyncEngine()).run();
  return outbox;
}

async function sync(outbox: InMemoryOutboxRepository) {
  const e = await getSyncEngine();
  await e.whenIdle();
  for (const r of outbox.all()) if (r.status === 'pending') await outbox.markRetry(r.id, 'test', 0);
  await e.run();
}

/** «Заметки» made a server page `srv-notes` with records on it (in this order in the rows). */
async function notesPage(records: { id: string; text: string; link?: Record<string, unknown> }[]): Promise<Page> {
  const local = usePages.getState().pages.find((p) => p.templateKey === 'notes')!;
  const synced: Page = { ...local, serverId: 'srv-notes', syncState: 'synced' };
  usePages.setState((st) => ({ pages: st.pages.map((p) => (p.id === local.id ? synced : p)) }));
  await testPages.insertLocal(synced);
  for (const [i, r] of records.entries()) {
    await testRecords.applyRemote(itemOut(r.id, 50 + i, { text: r.text, status: 'ready' }));
    await testPages.applyLink(linkOut('srv-notes', `srv-${r.id}`, 60 + i, { position: String.fromCharCode(85 + i), ...(r.link ?? {}) }));
  }
  return synced;
}

/** The page already in «Доска» (as the server sent it). */
async function boardMode(page: Page) {
  const look = { layout: page.layout, icon: page.icon, view: { ...EMPTY_VIEW, mode: 'board' } };
  usePages.getState().setLook(page.id, look);
  await testPages.setLook(page.id, look, false);
}

const flat = (id: string) => StyleSheet.flatten(screen.getByTestId(id).props.style) as { left: number; top: number; zIndex: number };
const at = (id: string) => {
  const st = flat(`sticker-${id}`);
  return { x: Math.round(st.left / S), y: Math.round(st.top / S) };
};
const stripText = () => {
  const s = useUndo.getState().strip;
  return s?.kind === 'custom' ? s.text : null;
};
const places = (outbox: InMemoryOutboxRepository) => outbox.all().filter((r) => r.kind === 'page.item_place');
const order = () =>
  screen
    .getAllByTestId(/^record-n\d$/)
    .map((e) => e.props.testID.replace('record-', ''));

/** A touch for PanResponder: one finger at (x, y), moved from (px, py). */
function touch(x: number, y: number, px: number, py: number, ts: number) {
  return {
    nativeEvent: { touches: [], changedTouches: [], pageX: x, pageY: y, locationX: x, locationY: y, timestamp: ts, identifier: 1 },
    touchHistory: {
      numberActiveTouches: 1,
      indexOfSingleActiveTouch: 0,
      mostRecentTimeStamp: ts,
      touchBank: [
        { touchActive: true, startPageX: 100, startPageY: 100, startTimeStamp: 1, currentPageX: x, currentPageY: y, currentTimeStamp: ts, previousPageX: px, previousPageY: py, previousTimeStamp: ts - 1 },
      ],
    },
  };
}

afterEach(() => {
  // spyOn on a jest mock returns that mock: restoring does not undo the value, so set it back.
  jest.spyOn(AccessibilityInfo, 'isScreenReaderEnabled').mockResolvedValue(false);
  Dimensions.set({ window: { width: 390, height: 844, scale: 3, fontScale: 1 }, screen: { width: 390, height: 844, scale: 3, fontScale: 1 } });
  jest.restoreAllMocks();
});

describe('the board as plain data (pure)', () => {
  it('first time: the rows as a grid in their order; a stored place stays; a new sticker takes the first free cell', () => {
    const first = layoutBoard([{ id: 'a', place: null }, { id: 'b', place: null }, { id: 'c', place: null }]);
    expect(first.map((l) => [l.id, l.x, l.y, l.stored])).toEqual([
      ['a', 24, 16, false],
      ['b', 196, 16, false],
      ['c', 24, 172, false],
    ]);
    // «a» was put lower by hand: its cell at the top is free for the new «n».
    const later = layoutBoard([
      { id: 'n', place: null },
      { id: 'a', place: { x: 200, y: 400, z: 3 } },
      { id: 'b', place: { x: 196, y: 16, z: 1 } },
      { id: 'c', place: { x: 24, y: 172, z: 2 } },
    ]);
    expect(later.find((l) => l.id === 'n')).toMatchObject({ x: 24, y: 16, z: 0, stored: false });
    expect(later.find((l) => l.id === 'a')).toMatchObject({ x: 200, y: 400, z: 3, stored: true });
    // views.md: max(board_y) + 140 + 16.
    expect(boardHeight(later)).toBe(400 + NOTE + 16);
  });

  it('server coordinates: x is a share of the width, y pt at 360; round trip', () => {
    const row = toRow({ x: 180, y: 300, z: 4 });
    expect(row).toEqual({ boardX: 0.5, boardY: 300, boardZ: 4 });
    expect(placeOf(row)).toEqual({ x: 180, y: 300, z: 4 });
    expect(placeOf({ boardX: null, boardY: null, boardZ: null })).toBeNull();
  });

  it('arrows move half a sticker, stop at the edges; «наверх доски»; a drop sticks to the 8 pt grid', () => {
    // 70 pt, stuck to the 8 pt grid.
    expect(nudge({ x: 24, y: 16, z: 0 }, 'right', 5)).toEqual({ x: 96, y: 16, z: 5 });
    // A slot off the grid (x 196, y 172) keeps the axis that does not move.
    expect(nudge({ x: 196, y: 172, z: 0 }, 'down', 5)).toEqual({ x: 196, y: 240, z: 5 });
    expect(nudge({ x: 0, y: 16, z: 0 }, 'left', 5)).toBeNull();
    expect(nudge({ x: BOARD_W - NOTE, y: 16, z: 0 }, 'right', 5)).toBeNull();
    // Partly at the edge: as far as it goes.
    expect(nudge({ x: 24, y: 16, z: 0 }, 'up', 5)).toEqual({ x: 24, y: 0, z: 5 });
    // «Положить наверх доски»: where it is, on top (views.md: its current x, y).
    expect(toTop({ x: 24, y: 300, z: 1 }, 6)).toEqual({ x: 24, y: 300, z: 6 });
    const two = layoutBoard([
      { id: 'a', place: { x: 24, y: 16, z: 5 } },
      { id: 'b', place: { x: 60, y: 40, z: 9 } },
    ]);
    expect(onTop(two[1]!, two)).toBe(true);
    expect(onTop(two[0]!, two)).toBe(false);
    // 37 pt on screen at scale 1 → 40 (grid), never off the board sideways.
    expect(dropPlace({ x: 24, y: 16, z: 0 }, 13, 37, 1, 9)).toEqual({ x: 40, y: 56, z: 9 });
    expect(dropPlace({ x: 24, y: 16, z: 0 }, 900, -900, 1, 9)).toEqual({ x: BOARD_W - NOTE, y: 0, z: 9 });
  });

  it('reading order is top to bottom, left to right; «Выше / Ниже» in rows swap places', () => {
    const laid = layoutBoard([
      { id: 'a', place: { x: 200, y: 20, z: 1 } },
      { id: 'b', place: { x: 10, y: 30, z: 1 } },
      { id: 'c', place: { x: 10, y: 300, z: 1 } },
    ]);
    // «b» is 10 pt lower but on the same line: it reads first (left).
    expect(readingOrder(laid).map((l) => l.id)).toEqual(['b', 'a', 'c']);
    const pair = swapInReading(laid, 'c', -1, 7)!;
    expect(pair.a).toMatchObject({ id: 'c', x: 200, y: 20 });
    expect(pair.b).toMatchObject({ id: 'a', x: 10, y: 300 });
    expect(pair.a.z).toBe(7);
    expect(swapInReading(laid, 'b', -1, 7)).toBeNull();
  });

  it('a long board draws only what is near the screen', () => {
    const items = Array.from({ length: 1000 }, (_, i) => ({ id: `s${i}`, place: null }));
    const laid = layoutBoard(items);
    const shown = inWindow(laid, 0, 800);
    expect(shown.size).toBeLessThan(60);
    expect(shown.has('s0')).toBe(true);
    expect(shown.has('s999')).toBe(false);
  });

  it('contract: `board_*` read from a row; «Ряды / Доска» is a view key of «Заметки» only', () => {
    // `items/place` answers with `placed` + `links` (read as the other changes by hand).
    const placed = placeOut({ placed: false, reason: 'newer_move', links: [{ id: 'l2', page_id: 'p', item_id: 'j', board_x: 0.5, board_y: 16, seq: 9 }] });
    expect(placed).toMatchObject({ moved: false, reason: 'newer_move' });
    expect(placed.rows[0]).toMatchObject({ item_id: 'j', board_x: 0.5 });
    const out = manualOut({
      moved: true,
      link: { id: 'l1', page_id: 'p', item_id: 'i', position: 'U', board_x: 0.25, board_y: 120, board_z: 3, board_manual: true, seq: 5 },
    });
    expect(out.rows[0]).toMatchObject({ board_x: 0.25, board_y: 120, board_z: 3, board_manual: true });
    expect(linkFrom(out.rows[0]!)).toMatchObject({ boardX: 0.25, boardY: 120, boardZ: 3, boardManual: true });
    // An older server: no keys = never placed.
    const old = manualOut({ link: { id: 'l1', page_id: 'p', item_id: 'i', seq: 5 } });
    expect(linkFrom(old.rows[0]!)).toMatchObject({ boardX: null, boardY: null, boardManual: false });

    const look = { layout: 'builtin:notes_board' as const, icon: 'documents' as const, view: EMPTY_VIEW };
    const r = applyChange(catalogTemplate('notes'), look, { kind: 'board', on: true }, 'documents');
    if (!('look' in r)) throw new Error('board refused');
    expect(r.look.view.mode).toBe('board');
    expect(r.look.view.setBy.board).toBe('user');
    expect(viewBody({ kind: 'board', on: true }, r.look)).toEqual({ board: true });
    expect(applyChange(catalogTemplate('tasks'), look, { kind: 'board', on: true }, 'documents')).toEqual({ error: 'layout_not_allowed' });
  });
});

describe('«Заметки» — «Ряды» and «Доска»', () => {
  it('switching keeps both layouts; offline and in «Без ИИ»; the switch goes as `board` with «Отменить»', async () => {
    const s = server();
    const outbox = await start(s, 'no_ai');
    s.offline = true;
    const notes = await notesPage([
      { id: 'n1', text: 'Код домофона\n4512' },
      { id: 'n2', text: 'Купить грунтовку' },
      { id: 'n3', text: 'Размер окна' },
    ]);
    await renderRouter(APP_DIR, { initialUrl: `/page/${notes.id}` });
    await settle(() => screen.queryByTestId('sticker-n1') !== null);
    expect(screen.getByTestId('notes-mode-rows').props.accessibilityState).toMatchObject({ selected: true });
    expect(order()).toEqual(['n1', 'n2', 'n3']);

    await fireEvent.press(screen.getByTestId('notes-mode-board'));
    await settle(() => screen.queryByTestId('board') !== null);
    expect(stripText()).toBe('Вид: Доска');
    expect(outbox.all().find((r) => r.kind === 'page.view')!.payload).toMatchObject({ change: { kind: 'board', on: true } });
    // First time on the board: the rows as a grid, nothing lost.
    expect([at('n1'), at('n2'), at('n3')]).toEqual([
      { x: 24, y: 16 },
      { x: 196, y: 16 },
      { x: 24, y: 172 },
    ]);
    expect(screen.getByTestId('record-n3').props.accessibilityLabel).toMatch(/^Стикер 3 из 3/);

    // «⋯ → Подвинуть → Правее»: n3 moves right at once; the sheet stays open.
    await fireEvent.press(screen.getByTestId('record-menu-n3'));
    expect(screen.queryByTestId('record-menu-up')).toBeNull(); // «Подвинуть» stands there instead
    await fireEvent.press(screen.getByTestId('menu-board-move'));
    await settle(() => screen.queryByTestId('board-move-sheet') !== null);
    await fireEvent.press(screen.getByTestId('board-right'));
    await settle(() => at('n3').x === 96); // half a sticker, on the 8 pt grid
    expect(screen.getByTestId('board-move-sheet')).toBeTruthy();
    expect(stripText()).toBe('Подвинул: Размер окна');
    const row = places(outbox)[0]!;
    const p = row.payload as ItemPlacePayload;
    // Only the moved sticker goes: turning the board on gave the others the server's slots here.
    expect(p.items).toHaveLength(1);
    expect(p.items[0]).toMatchObject({ recordId: 'n3', y: 172 });
    expect(p.items[0]!.x).toBeCloseTo(96 / BOARD_W, 6);
    expect(at('n1')).toEqual({ x: 24, y: 16 });
    await fireEvent.press(screen.getByTestId('board-move-close'));

    // Back to «Ряды»: the order of the rows is as it was; back on the board: the place is kept.
    await fireEvent.press(screen.getByTestId('notes-mode-rows'));
    await settle(() => screen.queryByTestId('board') === null);
    expect(order()).toEqual(['n1', 'n2', 'n3']);
    await fireEvent.press(screen.getByTestId('notes-mode-board'));
    await settle(() => screen.queryByTestId('board') !== null);
    expect(at('n3')).toEqual({ x: 96, y: 172 });
    // No place change was ever sent as a page order change.
    expect(outbox.all().some((r) => r.kind === 'page.item_move')).toBe(false);
  });

  it('every move has «Отменить»: waiting → dropped; sent → the undo of its action', async () => {
    const s = server();
    const outbox = await start(s);
    s.offline = true;
    const notes = await notesPage([
      { id: 'n1', text: 'Первая', link: { board_x: 24 / BOARD_W, board_y: 16, board_z: 1, board_manual: true } },
      { id: 'n2', text: 'Вторая', link: { board_x: 196 / BOARD_W, board_y: 16, board_z: 2, board_manual: true } },
    ]);
    await boardMode(notes);
    await renderRouter(APP_DIR, { initialUrl: `/page/${notes.id}` });
    await settle(() => screen.queryByTestId('board') !== null);

    await fireEvent.press(screen.getByTestId('record-menu-n1'));
    await fireEvent.press(screen.getByTestId('menu-board-move'));
    await settle(() => screen.queryByTestId('board-down') !== null);
    await fireEvent.press(screen.getByTestId('board-left'));
    await settle(() => at('n1').x === 0);
    // At the left edge: «Левее» cannot any more.
    expect(screen.getByTestId('board-left').props.accessibilityState).toMatchObject({ disabled: true });
    // n1 now lies on top (z above n2).
    expect(flat('sticker-n1').zIndex).toBeGreaterThan(flat('sticker-n2').zIndex);
    await fireEvent.press(screen.getByTestId('board-move-close'));
    await fireEvent.press(screen.getByTestId('undo-strip-undo'));
    await settle(() => at('n1').x === 24);
    expect((await outbox.get(places(outbox)[0]!.id))?.status).toBe('failed');

    // Online: one call `items/place`, the row comes back; «Отменить» = the undo of its action.
    s.on('POST /pages/*/items/place', () => ({
      status: 200,
      body: {
        placed: true,
        reason: null,
        repeated: false,
        rebased: false,
        links: [linkOut('srv-notes', 'srv-n2', 99, { position: 'V', board_x: 196 / BOARD_W, board_y: 88, board_z: Date.now(), board_manual: true })],
        kept_item_ids: [],
        action: action('aplace', 'Переставил «Вторая» на доске'),
        page_patch: null,
      },
    }));
    s.offline = false;
    await fireEvent.press(screen.getByTestId('record-menu-n2'));
    await fireEvent.press(screen.getByTestId('menu-board-move'));
    await settle(() => screen.queryByTestId('board-down') !== null);
    await fireEvent.press(screen.getByTestId('board-down'));
    await fireEvent.press(screen.getByTestId('board-move-close'));
    await act(async () => {
      await sync(outbox);
    });
    await settle(() => s.callsTo('POST /pages/srv-notes/items/place').length === 1);
    const sent = s.callsTo('POST /pages/srv-notes/items/place')[0]!.body as Record<string, unknown>;
    // One sticker goes alone (schemas.py `ItemPlaceIn`): absolute x share, y board points.
    expect(sent).toMatchObject({ item_id: 'srv-n2', y: 88, client_ts: expect.any(String) });
    expect(sent.x).toBeCloseTo(196 / BOARD_W, 6);
    expect(sent.places).toBeUndefined();
    expect(at('n2')).toEqual({ x: 196, y: 88 });
    await fireEvent.press(screen.getByTestId('undo-strip-undo'));
    await act(async () => {
      await sync(outbox);
    });
    await settle(() => s.callsTo('POST /actions/aplace/undo').length === 1);
    await settle(() => at('n2').y === 16);
  });

  it('drag: long press, the sticker follows the finger without drawing the board again, let go on the 8 pt grid', async () => {
    const s = server();
    const outbox = await start(s);
    s.offline = true;
    const notes = await notesPage(Array.from({ length: 6 }, (_, i) => ({ id: `n${i + 1}`, text: `Заметка ${i + 1}` })));
    await boardMode(notes);
    await renderRouter(APP_DIR, { initialUrl: `/page/${notes.id}` });
    await settle(() => screen.queryByTestId('sticker-n6') !== null);
    const board = screen.getByTestId('board');

    await fireEvent(screen.getByTestId('record-n1'), 'longPress');
    await settle(() => flat('sticker-n1').zIndex === 100_000);
    const before = { ...boardStats };
    await act(async () => {
      board.props.onResponderGrant(touch(100, 100, 100, 100, 2));
    });
    let x = 100;
    let y = 100;
    for (let i = 0; i < 20; i++) {
      await act(async () => {
        board.props.onResponderMove(touch(x + 6, y + 12, x, y, 3 + i));
      });
      x += 6;
      y += 12;
    }
    // Twenty moves: neither the board nor any sticker was drawn again.
    expect(boardStats.board - before.board).toBe(0);
    expect(boardStats.stickers - before.stickers).toBe(0);
    await act(async () => {
      board.props.onResponderRelease(touch(x, y, x, y, 30));
    });
    // dx 120, dy 240 on screen → reference pt / scale, stuck to 8 pt.
    const want = { x: Math.round((24 + 120 / S) / 8) * 8, y: Math.round((16 + 240 / S) / 8) * 8 };
    await settle(() => at('n1').x === want.x && at('n1').y === want.y);
    // Let go: only the moved sticker and the ones whose row was written are drawn again.
    const p = places(outbox)[0]!.payload as ItemPlacePayload;
    expect(p.items[0]).toMatchObject({ recordId: 'n1', y: want.y });
    expect(p.items).toHaveLength(1);
    expect(stripText()).toBe('Подвинул: Заметка 1');
  });

  it('≥150%: the board as rows, top to bottom and left to right; «Выше» swaps two places', async () => {
    Dimensions.set({ window: { width: 390, height: 844, scale: 3, fontScale: 1.6 }, screen: { width: 390, height: 844, scale: 3, fontScale: 1.6 } });
    const s = server();
    const outbox = await start(s);
    s.offline = true;
    const notes = await notesPage([
      { id: 'n1', text: 'Внизу', link: { board_x: 0.1, board_y: 400, board_z: 1 } },
      { id: 'n2', text: 'Справа', link: { board_x: 0.6, board_y: 20, board_z: 1 } },
      { id: 'n3', text: 'Слева', link: { board_x: 0.05, board_y: 30, board_z: 1 } },
    ]);
    await boardMode(notes);
    await renderRouter(APP_DIR, { initialUrl: `/page/${notes.id}` });
    await settle(() => screen.queryByTestId('sticker-n1') !== null);
    expect(screen.queryByTestId('board')).toBeNull();
    expect(screen.getByTestId('notes-board-rows')).toHaveTextContent('При крупном шрифте доска показана рядами. Места стикеров сохранены.');
    expect(order()).toEqual(['n3', 'n2', 'n1']);
    expect(screen.getByTestId('record-n3').props.accessibilityLabel).toMatch(/^Стикер 1 из 3/);

    await fireEvent.press(screen.getByTestId('record-menu-n1'));
    await fireEvent.press(screen.getByTestId('record-menu-up'));
    await settle(() => order().join() === 'n3,n1,n2');
    const p = places(outbox)[0]!.payload as ItemPlacePayload;
    expect(p.items.map((i) => [i.recordId, i.y])).toEqual([
      ['n1', 20],
      ['n2', 400],
    ]);
  });

  it('with a screen reader the board is rows too, with the places kept', async () => {
    jest.spyOn(AccessibilityInfo, 'isScreenReaderEnabled').mockResolvedValue(true);
    const s = server();
    await start(s);
    s.offline = true;
    const notes = await notesPage([
      { id: 'n1', text: 'Вторая', link: { board_x: 0.5, board_y: 200, board_z: 1 } },
      { id: 'n2', text: 'Первая', link: { board_x: 0.1, board_y: 10, board_z: 1 } },
    ]);
    await boardMode(notes);
    await renderRouter(APP_DIR, { initialUrl: `/page/${notes.id}` });
    await settle(() => screen.queryByTestId('notes-board-rows') !== null);
    expect(screen.queryByTestId('board')).toBeNull();
    expect(order()).toEqual(['n2', 'n1']);
    expect(screen.getByTestId('notes-board-rows')).toHaveTextContent(/сверху вниз, слева направо/);
  });

  it('two phones offline: mine shows until it is sent; then the server decides (the later place wins)', async () => {
    const s = server();
    const outbox = await start(s);
    s.offline = true;
    const notes = await notesPage([
      { id: 'n1', text: 'Код', link: { board_x: 24 / BOARD_W, board_y: 16, board_z: 1, board_manual: true } },
    ]);
    await boardMode(notes);
    await renderRouter(APP_DIR, { initialUrl: `/page/${notes.id}` });
    await settle(() => screen.queryByTestId('board') !== null);
    await fireEvent.press(screen.getByTestId('record-menu-n1'));
    await fireEvent.press(screen.getByTestId('menu-board-move'));
    await settle(() => screen.queryByTestId('board-right') !== null);
    await fireEvent.press(screen.getByTestId('board-right'));
    await fireEvent.press(screen.getByTestId('board-move-close'));
    await settle(() => at('n1').x === 96);

    // The other phone's place arrives by /sync meanwhile: this phone keeps showing its own.
    await act(async () => {
      await testPages.applyLink(linkOut('srv-notes', 'srv-n1', 120, { position: 'U', board_x: 200 / BOARD_W, board_y: 300, board_z: 4, board_manual: true }));
      notifyDataChanged();
    });
    await settle(() => true, 5);
    expect(at('n1')).toEqual({ x: 96, y: 16 });

    // Sent: the other phone moved it later, so the server keeps that place and says so.
    s.on('POST /pages/*/items/place', () => ({
      status: 200,
      body: {
        placed: false,
        reason: 'newer_move',
        repeated: false,
        rebased: false,
        links: [linkOut('srv-notes', 'srv-n1', 121, { position: 'U', board_x: 200 / BOARD_W, board_y: 300, board_z: 4, board_manual: true })],
        kept_item_ids: ['srv-n1'],
        action: null,
        page_patch: null,
      },
    }));
    s.offline = false;
    await act(async () => {
      await sync(outbox);
    });
    await settle(() => s.callsTo('POST /pages/srv-notes/items/place').length === 1);
    expect(s.callsTo('POST /pages/srv-notes/items/place')[0]!.body).toMatchObject({ client_ts: expect.any(String) });
    await settle(() => at('n1').x === 200 && at('n1').y === 300);
  });
});
