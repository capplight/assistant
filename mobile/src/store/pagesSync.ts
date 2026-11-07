import type { PagesRepository } from '@/db/pages';

import { usePages, type Page } from './pages';

const byId = (pages: Page[]) => [...pages].sort((a, b) => (a.id < b.id ? -1 : 1));

/**
 * SQLite is the source of truth for pages; the zustand store is what tabs read synchronously.
 * Pages only in the store (written before week 3) are copied to SQLite. Seed placeholders are not:
 * onboarding replaces them, and they stay in the store until then.
 */
export async function syncPagesStore(repo: PagesRepository): Promise<void> {
  for (const p of usePages.getState().pages) {
    if (p.createdBy !== 'seed') await repo.insertLocal(p);
  }
  const rows = await repo.listAll();
  const inDb = new Set(rows.map((r) => r.id));
  const live: Page[] = rows
    .filter((r) => r.deletedAt === null && r.hiddenAt === null)
    .map(({ deletedAt: _d, hiddenAt: _h, titleDirty: _t, positionDirty: _p, removedDirty: _r, ...page }) => page);
  const current = usePages.getState().pages;
  const next = [...live, ...current.filter((p) => !inDb.has(p.id))];
  if (JSON.stringify(byId(next)) !== JSON.stringify(byId(current))) usePages.setState({ pages: next });
}
