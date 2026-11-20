/**
 * Ф-89 / calendar-time.md §3–§4 («Лист дня»): every position of the grid comes from these numbers, never from a
 * measure (QA v5-device-3: no jumps). 60 dp an hour (`plan.dpPerMinute: 1`), a 56 time column, 8 dp above 00:00,
 * blocks inset 3 and 6 apart, at least 28 high. Pure, for tests.
 */

export const GRID = {
  /** dp per minute (`plan.dpPerMinute`). */
  perMinute: 1,
  /** Room above 00:00 and under 24:00 so the first and last hour labels are not cut. */
  pad: 8,
  timeColumn: 56,
  /** The «весь день» strip and its top margin (always this high: «ничего» when empty). */
  allDay: 44,
  allDayTop: 10,
  /** «3 дня»: the column heads (only the number). */
  colHead: 30,
  colHeadTop: 10,
  /** Block inset from its column edge and the gap between two side by side. */
  inset: 3,
  gap: 6,
  minBlock: 28,
  /** A to-do without a duration is a point: drawn as 30 min, thinner. */
  pointMinutes: 30,
  /** «+N» of an hour with more than two at once. */
  more: { width: 36, height: 44, right: 6, gap: 4 },
  /** The draft's resize knob and the reminder capsule. */
  knob: 22,
  capsule: 26,
  /** Steps of a drag (min). */
  step: 15,
  /** The bottom room under the assistant strip (`listBottomPadding`). */
  bottomRoom: 70,
  /** The window «окно 1 ч 40 мин» shows from 30 min. */
  minWindow: 30,
} as const;

export const DAY_MINUTES = 1440;

/** The whole day's grid height. */
export const gridHeight = () => GRID.pad * 2 + DAY_MINUTES * GRID.perMinute;

/** y of a minute of the day in the grid. */
export const yOf = (minute: number) => GRID.pad + minute * GRID.perMinute;

/** The minute under a y of the grid, clamped to the day. */
export function minuteAt(y: number): number {
  return Math.min(DAY_MINUTES - 1, Math.max(0, Math.floor((y - GRID.pad) / GRID.perMinute)));
}

/** The nearest step (15 min). */
export const snap = (minute: number, step: number = GRID.step) => Math.round(minute / step) * step;

/** A tap on empty time: the draft starts at the start of that half hour (§4). */
export const halfHourOf = (minute: number) => Math.floor(minute / 30) * 30;

/** Top and height of a block (inset 1 from its hour lines, at least 28). */
export function blockBox(start: number, duration: number | null | undefined): { top: number; height: number } {
  const d = duration ?? GRID.pointMinutes;
  return { top: yOf(start) + 1, height: Math.max(GRID.minBlock, d * GRID.perMinute - 2) };
}

/**
 * Left and width of a block in a grid of `cols` day columns over `width` (incl. the time column): lane `lane` of
 * `lanes` side by side; `narrow` leaves the room of the «+N» button.
 */
export function blockX(o: { width: number; col: number; cols: number; lane: number; lanes: number; narrow?: boolean }): { left: number; width: number } {
  const colW = (o.width - GRID.timeColumn) / o.cols;
  const laneW = colW / o.lanes;
  const left = GRID.timeColumn + colW * o.col + laneW * o.lane + GRID.inset;
  const w = laneW - GRID.gap - (o.narrow ? GRID.more.width + GRID.more.gap : 0);
  return { left, width: Math.max(0, w) };
}

/** A move by `dy` dp of a block that started at `start`, in 15-min steps, kept inside the day. */
export function dragStart(start: number, dy: number, duration: number | null | undefined): number {
  const d = duration ?? GRID.pointMinutes;
  const to = snap(start + dy / GRID.perMinute);
  return Math.min(DAY_MINUTES - Math.min(d, GRID.step), Math.max(0, to));
}

/** A stretch by `dy` dp of the knob of a block, in 15-min steps: at least 15 min, never past midnight. */
export function dragDuration(start: number, duration: number | null | undefined, dy: number): number {
  const d = duration ?? GRID.pointMinutes;
  const to = snap(d + dy / GRID.perMinute);
  return Math.min(DAY_MINUTES - start, Math.max(GRID.step, to));
}

/** A long press and pull on empty time: from the pressed step to the finger, at least 15 min. */
export function drawnSpan(pressMinute: number, dy: number): { start: number; duration: number } {
  const start = Math.min(DAY_MINUTES - GRID.step, Math.max(0, Math.floor(pressMinute / GRID.step) * GRID.step));
  const end = snap(pressMinute + dy / GRID.perMinute);
  return { start, duration: Math.min(DAY_MINUTES - start, Math.max(GRID.step, end - start)) };
}

/**
 * Where the grid opens (§9.4): today — «сейчас» at a third of the visible height; another day — the first block minus
 * 30 min at the top; an empty day — 9:00 at the top. Clamped to the grid.
 */
export function initialScroll(o: { viewport: number; now: number | null; first: number | null }): number {
  const max = Math.max(0, gridHeight() - o.viewport + GRID.bottomRoom);
  const y = o.now !== null ? yOf(o.now) - o.viewport / 3 : o.first !== null ? yOf(Math.max(0, o.first - 30)) : yOf(9 * 60);
  return Math.round(Math.min(max, Math.max(0, y)));
}

/** The scroll that brings a block into the middle of the visible grid (the assistant's new block, §5). */
export function centerScroll(o: { viewport: number; start: number; duration: number | null | undefined }): number {
  const { top, height } = blockBox(o.start, o.duration);
  const max = Math.max(0, gridHeight() - o.viewport + GRID.bottomRoom);
  return Math.round(Math.min(max, Math.max(0, top + height / 2 - o.viewport / 2)));
}

/** Columns of the multi-day view: «3 дня» on phones, «Неделя» from 600 dp (§3). */
export const multiDayColumns = (width: number) => (width >= 600 ? 7 : 3);

/** The grid or rows (§6: large font ≥ 1.3 and ≤ 340 dp read as «время — дело» rows). */
export const gridAsRows = (m: { largeText: boolean; width: number }) => m.largeText || m.width <= 340;
