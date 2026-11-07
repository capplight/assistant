import type { PageLink } from '@/db/pages';
import type { LocalRecord } from '@/db/records';
import type { Page } from '@/store/pages';

import { compareRank } from './lexorank';
import { getTemplate } from './templates';

export type PageEntry = { record: LocalRecord; link: PageLink | null };

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
  const byItem = new Map(links.map((l) => [l.itemServerId, l]));
  const always = getTemplate(page.templateKey).placeAll;
  const linked: PageEntry[] = [];
  const loose: PageEntry[] = [];
  for (const record of records) {
    const link = record.serverId ? byItem.get(record.serverId) : undefined;
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
