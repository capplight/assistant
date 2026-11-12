import type { PageLink } from '@/db/pages';

/**
 * «Заметки», mode «Доска» (template-screens 2.1, Ф-28; weeks 16а–16б; docs/api/views.md «Доска»):
 * the free board as plain data, so it can be tested without a finger.
 *
 * Board space is the server's: the board is 360 board points wide and grows down. `board_x` is the
 * sticker's left edge as a share of the width (0 … 220/360), `board_y` its top edge in board
 * points, a sticker is 140 × 140. `board_z` is the time (ms) of the winning place: higher lies on
 * top, null lowest, ties by item id. On the phone everything is counted in board points and drawn
 * at `s = board width on screen / 360`, so the board looks the same on every phone.
 */

/** The board's width, board points. */
export const BOARD_W = 360;
/** A sticker: 140 × 140 board points, no tilt. */
export const NOTE = 140;
/** The invisible grid a sticker sticks to (the phone's; the server does not snap). */
export const GRID = 8;
/** One arrow press: half a sticker, then the grid (so ±72). */
export const STEP = NOTE / 2;
const MAX_X = BOARD_W - NOTE;
const MAX_Y = 100_000;
/** The server's slots for stickers without a place: x 24 and 196, rows at 16 + 156·k. */
const COLS = [24, 196] as const;
const TOP = 16;
const PITCH = 156;
/** Under the lowest sticker (views.md: `max(board_y) + 140 + 16`). */
const BOTTOM = 16;

/** A place in board points; `z` = stacking (the time of the place, 0 = none). */
export type Place = { x: number; y: number; z: number };

/**
 * A sticker as the board sees it, in «Ряды» order: its id, its stored place (null: never put on
 * the board), and the key that breaks ties in stacking (the server's item id).
 */
export type BoardItem = { id: string; place: Place | null; tie?: string };

/** Where a sticker lies now; `stored` = false when it has no place yet (drawn in a free slot). */
export type Laid = Place & { id: string; stored: boolean; tie: string };

export const snap = (v: number) => Math.round(v / GRID) * GRID;

/** Inside the board: never off it sideways, nothing above the top. */
export function clampPlace(p: Place): Place {
  return { x: Math.max(0, Math.min(MAX_X, snap(p.x))), y: Math.max(0, Math.min(MAX_Y, snap(p.y))), z: p.z };
}

/** The stored place of a row, in board points; null when it has none. */
export function placeOf(link: Pick<PageLink, 'boardX' | 'boardY' | 'boardZ'> | null | undefined): Place | null {
  if (!link || link.boardX == null || link.boardY == null) return null;
  return { x: Math.round(link.boardX * BOARD_W), y: link.boardY, z: link.boardZ ?? 0 };
}

/** What goes into the row and to the server: `board_x` as the server stores it (whole points / 360). */
export function toRow(p: Place): { boardX: number; boardY: number; boardZ: number } {
  return { boardX: Math.round(p.x) / BOARD_W, boardY: Math.round(p.y), boardZ: p.z };
}

/** The rectangles share some area (views.md: a slot is free when no placed sticker overlaps it). */
const hits = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  a.x < b.x + NOTE && b.x < a.x + NOTE && a.y < b.y + NOTE && b.y < a.y + NOTE;

/**
 * The board as drawn, by the server's rule: stickers with a place lie there; the others, in
 * «Ряды» order, take the first free slot (row by row, left then right). Turning the board on, the
 * server stores these same slots; a new sticker in board mode lies in the first free one. Nothing
 * with a place ever moves.
 */
export function layoutBoard(items: readonly BoardItem[]): Laid[] {
  const taken: { x: number; y: number }[] = items.flatMap((it) => (it.place ? [it.place] : []));
  const out: Laid[] = [];
  let slot = 0;
  for (const it of items) {
    const tie = it.tie ?? it.id;
    if (it.place) {
      out.push({ ...it.place, id: it.id, stored: true, tie });
      continue;
    }
    for (;;) {
      const at = { x: COLS[slot % COLS.length]!, y: TOP + Math.floor(slot / COLS.length) * PITCH };
      slot++;
      if (taken.some((t) => hits(t, at))) continue;
      taken.push(at);
      out.push({ ...at, z: 0, id: it.id, stored: false, tie });
      break;
    }
  }
  return out;
}

/** Drawing order: lower `z` first (none lowest), ties by item id. */
export function drawOrder(laid: readonly Laid[]): Laid[] {
  return [...laid].sort((a, b) => a.z - b.z || (a.tie < b.tie ? -1 : a.tie > b.tie ? 1 : 0));
}

/**
 * Reading order (screen readers, the rows at ≥150%; views.md): by band `floor((y + 70) / 140)`,
 * then x, then y, then «Ряды» order; stickers without a place last, in «Ряды» order.
 */
export function readingOrder(laid: readonly Laid[]): Laid[] {
  const band = (l: Laid) => Math.floor((l.y + NOTE / 2) / NOTE);
  const placed = laid.map((l, i) => ({ l, i })).filter((x) => x.l.stored);
  placed.sort((a, b) => band(a.l) - band(b.l) || Math.round(a.l.x) - Math.round(b.l.x) || a.l.y - b.l.y || a.i - b.i);
  return [...placed.map((x) => x.l), ...laid.filter((l) => !l.stored)];
}

export const topZ = (laid: readonly Laid[]) => laid.reduce((m, l) => Math.max(m, l.z), 0);

/** The board's height in board points: `max(board_y) + 140 + 16`, at least `min`. */
export function boardHeight(laid: readonly Laid[], min = 0): number {
  const low = laid.reduce((m, l) => Math.max(m, l.y), 0);
  return Math.max(low + NOTE + BOTTOM, min);
}

export type Arrow = 'up' | 'down' | 'left' | 'right';

/** «Выше · Ниже · Левее · Правее»: ±70 snapped to 8, clamped; null when it cannot move that way. */
export function nudge(p: Place, dir: Arrow, z: number): Place | null {
  // Only the moved axis goes to the grid: a slot at y 172 stays at 172 when moved sideways.
  const sideways = dir === 'left' || dir === 'right';
  const sign = dir === 'left' || dir === 'up' ? -1 : 1;
  const next = sideways
    ? { x: Math.max(0, Math.min(MAX_X, snap(p.x + sign * STEP))), y: p.y, z }
    : { x: p.x, y: Math.max(0, Math.min(MAX_Y, snap(p.y + sign * STEP))), z };
  return next.x === p.x && next.y === p.y ? null : next;
}

export const canNudge = (p: Place, dir: Arrow) => nudge(p, dir, p.z) !== null;

/** Lies on top of every other sticker and is the person's: «Положить наверх доски» does nothing. */
export const onTop = (l: Laid, laid: readonly Laid[]) => l.stored && laid.every((o) => o.id === l.id || o.z < l.z);

/** «Положить наверх доски»: where it is, on top of the others (views.md: its current x, y). */
export function toTop(p: Place, z: number): Place {
  return { x: p.x, y: p.y, z };
}

/** Let go after a drag of `dx`, `dy` screen pt at `scale` (screen pt per board point). */
export function dropPlace(from: Place, dx: number, dy: number, scale: number, z: number): Place {
  return clampPlace({ x: from.x + dx / scale, y: from.y + dy / scale, z });
}

/**
 * The board as rows (≥150%, screen reader): «Выше / Ниже» swap places with the previous / next
 * sticker in reading order, each getting the other's x, y. Null at the ends.
 */
export function swapInReading(laid: readonly Laid[], id: string, step: -1 | 1, z: number): { a: Laid; b: Laid } | null {
  const order = readingOrder(laid);
  const i = order.findIndex((l) => l.id === id);
  const j = i + step;
  if (i < 0 || j < 0 || j >= order.length) return null;
  const me = order[i]!;
  const other = order[j]!;
  return { a: { ...me, x: other.x, y: other.y, z, stored: true }, b: { ...other, x: me.x, y: me.y, z, stored: true } };
}

/**
 * The stickers worth drawing for a scroll offset (board points): a screen above and two below, so
 * a long board does not draw a thousand stickers at once.
 */
export function inWindow(laid: readonly Laid[], top: number, height: number): Set<string> {
  const lo = top - height;
  const hi = top + height * 2;
  return new Set(laid.filter((l) => l.y + NOTE >= lo && l.y <= hi).map((l) => l.id));
}

/** The stacking of a place made now: the time of the place in ms (the server gives the same). */
export const zNow = (at: string | number = Date.now()) => (typeof at === 'number' ? at : Date.parse(at) || Date.now());
