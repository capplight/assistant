import { GRID } from './geometry';

/**
 * calendar-time.md §3 «Наложения»: on a phone at most TWO blocks stand side by side (equal width, gap 6); the rest of
 * that hour is one «+N» button (36 wide, at the right) that opens the list of the hour. Three columns on 360 dp read
 * «Сове…». Pure, for tests.
 */
export type LayoutIn = { key: string; start: number; duration: number | null | undefined };

export type Placed = {
  key: string;
  /** 0 or 1. */
  lane: number;
  /** 1 or 2: how many stand side by side in its group. */
  lanes: number;
  /** Leaves the room of a «+N» at its side. */
  narrow: boolean;
};

export type More = { start: number; keys: string[] };

const endOf = (x: LayoutIn) => x.start + Math.max(GRID.pointMinutes, x.duration ?? GRID.pointMinutes);

export function layoutColumn(items: readonly LayoutIn[], maxLanes = 2): { placed: Placed[]; more: More[] } {
  const sorted = [...items].sort((a, b) => a.start - b.start || endOf(b) - endOf(a) || a.key.localeCompare(b.key));
  const placed: Placed[] = [];
  const more: More[] = [];
  let i = 0;
  while (i < sorted.length) {
    // One group: everything that overlaps, directly or through another one.
    const group: LayoutIn[] = [sorted[i]!];
    let end = endOf(sorted[i]!);
    i += 1;
    while (i < sorted.length && sorted[i]!.start < end) {
      group.push(sorted[i]!);
      end = Math.max(end, endOf(sorted[i]!));
      i += 1;
    }
    const laneEnds: number[] = [];
    const lanesOf = new Map<string, number>();
    for (const x of group) {
      let lane = laneEnds.findIndex((e) => e <= x.start);
      if (lane < 0) {
        lane = laneEnds.length;
        laneEnds.push(0);
      }
      laneEnds[lane] = endOf(x);
      lanesOf.set(x.key, lane);
    }
    const shown = Math.min(maxLanes, laneEnds.length);
    const hidden = group.filter((x) => lanesOf.get(x.key)! >= maxLanes);
    // «+N» per hour of the hidden ones, at the first hidden start of that hour.
    const byHour = new Map<number, LayoutIn[]>();
    for (const x of hidden) byHour.set(Math.floor(x.start / 60), [...(byHour.get(Math.floor(x.start / 60)) ?? []), x]);
    const groupMore: More[] = [...byHour.values()].map((xs) => ({ start: Math.min(...xs.map((x) => x.start)), keys: xs.map((x) => x.key) }));
    more.push(...groupMore);
    for (const x of group) {
      const lane = lanesOf.get(x.key)!;
      if (lane >= maxLanes) continue;
      const narrow =
        lane === shown - 1 &&
        groupMore.some((m) => x.start < m.start + GRID.more.height / GRID.perMinute && m.start < endOf(x));
      placed.push({ key: x.key, lane, lanes: shown, narrow });
    }
  }
  return { placed, more };
}
