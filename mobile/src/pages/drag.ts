/**
 * Dragging a row (2-design 4.7 п. 1): pure maths, so it can be tested without a finger.
 * Heights are the rows as laid out (records and group headings alike).
 */

/** The index the dragged row lands at: it passes a neighbour once it covers half of it. */
export function dropIndex(heights: readonly number[], from: number, dy: number): number {
  let to = from;
  let passed = 0;
  if (dy > 0) {
    for (let i = from + 1; i < heights.length; i++) {
      const h = heights[i] ?? 0;
      if (dy < passed + h / 2) break;
      passed += h;
      to = i;
    }
  } else if (dy < 0) {
    for (let i = from - 1; i >= 0; i--) {
      const h = heights[i] ?? 0;
      if (-dy < passed + h / 2) break;
      passed += h;
      to = i;
    }
  }
  return to;
}

/** How far a row moves aside while another is dragged from `from` to `to` («остальные расступаются»). */
export function shiftFor(index: number, from: number, to: number, draggedHeight: number): number {
  if (to > from && index > from && index <= to) return -draggedHeight;
  if (to < from && index >= to && index < from) return draggedHeight;
  return 0;
}

/**
 * Rows include group headings: where the record lands among the records only. `isEntry[i]`: row
 * i is a record. The dragged row is taken out and put at `to`, then the records before it counted.
 */
export function entryIndexAfterDrop(isEntry: readonly boolean[], from: number, to: number): number {
  const order = isEntry.map((e, i) => ({ e, i })).filter((r) => r.i !== from);
  order.splice(to, 0, { e: true, i: from });
  let n = 0;
  for (const r of order) {
    if (r.i === from) return n;
    if (r.e) n++;
  }
  return n;
}
