import { getOutbox, getPagesRepo } from '@/db';
import i18n from '@/i18n';
import { getSyncEngine, kickSync } from '@/services';
import { useUndo } from '@/store/undo';
import { undoServerAction } from '@/tasks/actions';
import { newId } from '@/utils/id';
import { getTemplate } from '@/pages/templates';
import { useDataVersion } from '@/store/data';
import { usePages, type Page } from '@/store/pages';

export type RenamePayload = {
  pageId: string;
  title: string | null;
  /** Week 11: `client_id` of `PATCH /pages/{id}` (a repeat returns the first action), and that action. */
  clientId?: string;
  actionId?: string | null;
  /** What the page was called before, for «Отменить» while it waits. */
  before?: string | null;
};

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
  const before = usePages.getState().pages.find((p) => p.id === pageId)?.title ?? null;
  if (before === title) return;
  usePages.getState().renamePage(pageId, title);
  const repo = await getPagesRepo();
  await repo.setTitle(pageId, title);
  const outbox = await getOutbox();
  const payload: RenamePayload = { pageId, title, clientId: newId(), before };
  const row = await outbox.enqueue('pages.update', payload);
  useDataVersion.getState().bump();
  const key = usePages.getState().pages.find((p) => p.id === pageId)?.templateKey ?? 'custom';
  const name = title ?? i18n.t(key === 'custom' ? 'tpl.custom_default' : `tpl.${key}`);
  useUndo.getState().showCustom(i18n.t('view.renamed', { title: name }), () => void undoRename(row.id));
  kickSync();
}

/** «Отменить» of a rename: still waiting → dropped, the old name back; sent → the undo of its action. */
async function undoRename(outboxId: string): Promise<void> {
  const engine = await getSyncEngine();
  await engine.hold(outboxId);
  try {
    const outbox = await getOutbox();
    const row = await outbox.get(outboxId);
    if (!row || row.status === 'failed') return;
    const p = row.payload as RenamePayload;
    const repo = await getPagesRepo();
    usePages.getState().renamePage(p.pageId, p.before ?? null);
    if (row.status === 'pending') {
      await outbox.markFailed(row.id, 'undone');
      await repo.setTitle(p.pageId, p.before ?? null);
      await repo.clearTitleDirty(p.pageId);
    } else if (p.actionId) {
      await undoServerAction(p.actionId);
    } else {
      await repo.setTitle(p.pageId, p.before ?? null);
      await outbox.enqueue('pages.update', { pageId: p.pageId, title: p.before ?? null, clientId: newId() } satisfies RenamePayload);
    }
    useDataVersion.getState().bump();
  } finally {
    engine.release(outboxId);
    kickSync();
  }
}
