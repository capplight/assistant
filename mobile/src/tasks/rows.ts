import type { TaskListKey, TaskOut } from '@/api/types';
import type { PageEntry } from '@/pages/contents';

import { doneAt, isDone } from './service';
import type { Tick } from './store';

/** «Дела и напоминания»: Сегодня · Скоро · Пропущено (2-design S12). */
export type Segment = 'today' | 'soon' | 'missed';

export type ListRow =
  /** A page row; `task` when its record is a task (shown with a box). */
  | { kind: 'entry'; entry: PageEntry; task: TaskOut | null; done: boolean }
  /** A task with no page row on this phone yet (added offline, or its row not synced). */
  | { kind: 'task'; task: TaskOut; done: boolean };

/** `YYYY-MM-DD` on the phone's clock (the server's `due_date` is on the person's clock). */
export function localDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function inSegment(t: TaskOut, segment: Segment | null, today: string): boolean {
  if (!segment) return true;
  if (segment === 'missed') return false;
  const soon = !!t.due_date && t.due_date > today;
  return segment === 'soon' ? soon : !soon;
}

/**
 * The rows of a list page: page order as the server keeps it (manual order is the person's),
 * open ones first, done ones at the bottom, the newest ticked first (today.md: the server does not
 * move rows on a tick; the phone shows them below). Tasks without a row on this phone come first.
 * Plain records on the page stay where they are; on «Дела» they show under «Сегодня» only.
 */
export function listRows(
  entries: PageEntry[],
  tasks: TaskOut[],
  ticks: Record<string, Tick>,
  o: { lists: TaskListKey[]; segment?: Segment | null; today: string },
): { open: ListRow[]; done: ListRow[] } {
  const segment = o.segment ?? null;
  const mine = tasks.filter((t) => o.lists.includes(t.list_key) && !t.deleted_at);
  const byItem = new Map<string, TaskOut>();
  for (const t of mine) if (t.item_id) byItem.set(t.item_id, t);
  // A task of another list (moved to «Покупки») does not show here even if its row is still here.
  const other = new Set(tasks.filter((t) => !o.lists.includes(t.list_key) && t.item_id).map((t) => t.item_id!));
  const used = new Set<string>();
  const open: ListRow[] = [];
  const done: ListRow[] = [];
  for (const entry of entries) {
    const sid = entry.record.serverId;
    if (sid && other.has(sid)) continue;
    const task = sid ? (byItem.get(sid) ?? null) : null;
    if (task) used.add(task.id);
    if (!task) {
      if (!segment || segment === 'today') open.push({ kind: 'entry', entry, task: null, done: false });
      continue;
    }
    const d = isDone(task, ticks);
    if (d) done.push({ kind: 'entry', entry, task, done: true });
    else if (inSegment(task, segment, o.today)) open.push({ kind: 'entry', entry, task, done: false });
  }
  const loose = mine
    .filter((t) => !used.has(t.id))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const looseOpen: ListRow[] = [];
  for (const task of loose) {
    const d = isDone(task, ticks);
    if (d) done.push({ kind: 'task', task, done: true });
    else if (inSegment(task, segment, o.today)) looseOpen.push({ kind: 'task', task, done: false });
  }
  const at = (r: ListRow) => (r.kind === 'entry' ? r.task : r.task);
  done.sort((a, b) => doneAt(at(b)!, ticks) - doneAt(at(a)!, ticks));
  // «Выполненное» only under «Сегодня» on «Дела» (the other segments are about what is ahead).
  return { open: [...looseOpen, ...open], done: segment && segment !== 'today' ? [] : done };
}
