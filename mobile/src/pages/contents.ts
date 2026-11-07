import type { PageLink } from '@/db/pages';
import type { LocalRecord } from '@/db/records';
import type { Page } from '@/store/pages';

import { compareRank } from './lexorank';
import { getTemplate } from './templates';

export type PageEntry = { record: LocalRecord; link: PageLink | null };

/**
 * Keys of a row in `page_links`: the server ids, or — for a page or record not on the server yet,
 * moved by hand offline — `local:<local id>`. The outbox sends it once both are there.
 */
export const pageKey = (p: { id: string; serverId: string | null }) => p.serverId ?? `local:${p.id}`;
export const itemKey = (r: { id: string; serverId: string | null }) => r.serverId ?? `local:${r.id}`;

/** The row of this record: a change by hand still on its way wins over the server's row. */
function linkOf(byItem: Map<string, PageLink>, record: LocalRecord): PageLink | undefined {
  const server = record.serverId ? byItem.get(record.serverId) : undefined;
  const local = byItem.get(`local:${record.id}`);
  if (local && (!server || ((local.pending ?? 0) > 0 && !(server.pending ?? 0)))) return local;
  return server;
}

const dateOf = (r: LocalRecord): number => Date.parse(r.occurredAt) || r.createdAt;

/** The page order from docs/api/pages.md: position by bytes (null last), newest first, item id. */
export function comparePageEntries(a: PageEntry, b: PageEntry): number {
  return (
    compareRank(a.link?.position ?? null, b.link?.position ?? null) ||
    dateOf(b.record) - dateOf(a.record) ||
    ((a.record.serverId ?? a.record.id) < (b.record.serverId ?? b.record.id) ? -1 : 1)
  );
}

/**
 * What a page shows, from local data only: rows linked by the server; plus, until the server has
 * answered, what was saved on this page and what the template rule places here (only «always»
 * can be decided on the phone, the other conditions need the record's meaning).
 * A row the person removed from the page never comes back.
 *
 * Records without a link have no key yet: they go where their date puts them, below rows placed
 * by hand. The server gives them the same place, so nothing jumps after sync.
 */
export function pageEntries(page: Page, records: LocalRecord[], links: PageLink[]): PageEntry[] {
  const byItem = new Map<string, PageLink>();
  // A page made offline has rows under both keys once it is on the server: pending ones win.
  for (const l of links) {
    const old = byItem.get(l.itemServerId);
    if (!old || ((l.pending ?? 0) > 0 && !(old.pending ?? 0))) byItem.set(l.itemServerId, l);
  }
  const always = getTemplate(page.templateKey).placeAll;
  const linked: PageEntry[] = [];
  const loose: PageEntry[] = [];
  for (const record of records) {
    const link = linkOf(byItem, record);
    if (link) {
      if (!link.removedAt) linked.push({ record, link });
    } else if (always || record.pageId === page.id) {
      loose.push({ record, link: null });
    }
  }
  const out = linked.sort(comparePageEntries);
  for (const entry of loose.sort(comparePageEntries)) {
    const at = out.findIndex((e) => !e.link?.manualOrder && !e.link?.pinned && dateOf(e.record) < dateOf(entry.record));
    out.splice(at < 0 ? out.length : at, 0, entry);
  }
  return out;
}
