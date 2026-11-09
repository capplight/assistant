import type { TaskOut } from '@/api/types';
import type { PageEntry } from '@/pages/contents';
import type { ListRow } from '@/tasks/rows';

/** One row of a page list: a record (maybe a task's), a task not on the page yet, a heading. */
export type Row =
  | { type: 'entry'; entry: PageEntry; task: TaskOut | null; done: boolean }
  | { type: 'task'; task: TaskOut; done: boolean }
  | { type: 'group'; key: string; title: string };

export type EntryRow = Extract<Row, { type: 'entry' }>;

export const fromList = (r: ListRow): Row =>
  r.kind === 'entry' ? { type: 'entry', entry: r.entry, task: r.task, done: r.done } : { type: 'task', task: r.task, done: r.done };

export const entryRow = (entry: PageEntry): Row => ({ type: 'entry', entry, task: null, done: false });

/** Rows with a heading wherever the group changes. Without group titles: just the rows. */
export function withGroups(entries: PageEntry[], groups: { key: string; title: string }[]): Row[] {
  const titles = new Map(groups.map((g) => [g.key, g.title]));
  const out: Row[] = [];
  let last: string | null = null;
  for (const entry of entries) {
    const key = entry.link?.groupKey ?? null;
    if (titles.size > 0 && key && key !== last) out.push({ type: 'group', key, title: titles.get(key) ?? key });
    last = key;
    out.push(entryRow(entry));
  }
  return out;
}

/**
 * `view_state.sort` (S38): `newest` / `oldest` by the record's date, `title` A→Я; anything else
 * (and `position`) keeps the page order (pages.md «Page order»).
 */
export function sortEntries(entries: PageEntry[], sort: string | null): PageEntry[] {
  if (!sort || sort === 'position') return entries;
  const at = (e: PageEntry) => Date.parse(e.record.occurredAt) || e.record.createdAt;
  const name = (e: PageEntry) => (e.record.title ?? e.record.text ?? '').trim().toLowerCase();
  // Pinned first, then by the value (views.md «Rows and contents»).
  const out = [...entries];
  if (sort === 'newest') out.sort((a, b) => at(b) - at(a));
  else if (sort === 'oldest') out.sort((a, b) => at(a) - at(b));
  else if (sort === 'title' || sort === 'name' || sort === 'what') out.sort((a, b) => (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0));
  return out.sort((a, b) => Number(!!b.link?.pinned) - Number(!!a.link?.pinned));
}

/** The records in the order on screen (the menu's «Выше / Ниже» count in it). */
export const shownEntries = (rows: Row[]): PageEntry[] => rows.flatMap((r) => (r.type === 'entry' ? [r.entry] : []));

/** «Когда» of a to-do: «Сегодня», «Завтра», «Просрочено · 5 нояб.», or the date. */
export function dueText(due: string, today: string, t: (k: string, o?: Record<string, unknown>) => string): string {
  const d = new Date(`${due}T12:00:00`);
  const t0 = new Date(`${today}T12:00:00`);
  const days = Math.round((d.getTime() - t0.getTime()) / 86_400_000);
  if (days === 0) return t('rem.today');
  if (days === 1) return t('rem.tomorrow');
  const date = `${d.getDate()}.${String(d.getMonth() + 1).padStart(2, '0')}`;
  return days < 0 ? t('tasks.overdue', { date }) : date;
}
