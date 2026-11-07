import { getOutbox, getPagesRepo } from '@/db';
import { kickSync } from '@/services';
import { useDataVersion } from '@/store/data';
import { usePages, type Page } from '@/store/pages';

export type RenamePayload = { pageId: string; title: string | null };

/** Pages created on this phone: SQLite + outbox first, the server gets them when it can. */
export async function saveNewPages(pages: Page[]): Promise<void> {
  if (pages.length === 0) return;
  const repo = await getPagesRepo();
  for (const p of pages) await repo.insertLocal(p);
  const outbox = await getOutbox();
  await outbox.enqueue('pages.create', { pages });
  kickSync();
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
