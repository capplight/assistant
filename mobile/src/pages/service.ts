import { getOutbox, getPagesRepo } from '@/db';
import { kickSync } from '@/services';
import { getTemplate } from '@/pages/templates';
import { useDataVersion } from '@/store/data';
import { usePages, type Page } from '@/store/pages';

export type RenamePayload = { pageId: string; title: string | null };

/** Pages created on this phone: SQLite + outbox first, the server gets them when it can. */
export async function saveNewPages(pages: Page[]): Promise<void> {
  if (pages.length === 0) return;
  const repo = await getPagesRepo();
  const revived = await withRemovedPlaces(pages);
  for (const p of revived) await repo.insertLocal(p);
  const outbox = await getOutbox();
  await outbox.enqueue('pages.create', { pages: revived });
  kickSync();
}

/**
 * A topic page that was removed comes back on the server with its id, order and name
 * (docs/api/pages.md): show it in that place at once, so the tab does not jump after sync.
 * The removed row itself is replaced when POST /pages answers.
 */
async function withRemovedPlaces(pages: Page[]): Promise<Page[]> {
  const removed = (await (await getPagesRepo()).listAll())
    .filter((r) => r.deletedAt !== null && r.serverId !== null && getTemplate(r.templateKey).singleton)
    .sort((a, b) => (a.deletedAt ?? 0) - (b.deletedAt ?? 0)); // the last removed wins below, as on the server
  const byTemplate = new Map(removed.map((r) => [r.templateKey, r]));
  const out = pages.map((p) => {
    const old = getTemplate(p.templateKey).singleton ? byTemplate.get(p.templateKey) : undefined;
    return old ? { ...p, position: old.position, title: old.title, titleKk: old.titleKk } : p;
  });
  if (out.some((p, i) => p !== pages[i])) {
    const changed = new Map(out.map((p) => [p.id, p]));
    usePages.setState((s) => ({ pages: s.pages.map((p) => changed.get(p.id) ?? p) }));
  }
  return out;
}

/** «Своя страница» from «Ещё». Null when the limit of 20 pages is reached. */
export async function addCustomPage(title?: string): Promise<Page | null> {
  const page = usePages.getState().addPage('custom', title?.trim() || undefined);
  if (page) await saveNewPages([page]);
  return page;
}

/** Empty name = back to «Моя страница». */
export async function renamePage(pageId: string, rawTitle: string): Promise<void> {
  const title = rawTitle.trim() || null;
  usePages.getState().renamePage(pageId, title);
  const repo = await getPagesRepo();
  await repo.setTitle(pageId, title);
  const outbox = await getOutbox();
  const payload: RenamePayload = { pageId, title };
  await outbox.enqueue('pages.update', payload);
  useDataVersion.getState().bump();
  kickSync();
}
