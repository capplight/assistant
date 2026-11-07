import { useEffect, useState } from 'react';

import { getPagesRepo, getRecords, type LocalRecord } from '@/db';
import { pageEntries, type PageEntry } from '@/pages/contents';
import { useDataVersion } from '@/store/data';
import type { Page } from '@/store/pages';

/** Upper bound for one screen; the list itself is virtualized. Search and paging come in week 4. */
const LIST_LIMIT = 2000;

/** Loads from local SQLite only, again after every local change. null = not loaded yet. */
function useLocalQuery<T>(load: () => Promise<T>, deps: unknown[]): T | null {
  const version = useDataVersion((s) => s.version);
  // Keyed: tabs reuse one screen for all pages, and page B must not flash page A's records.
  const key = JSON.stringify(deps);
  const [state, setState] = useState<{ key: string; value: T } | null>(null);
  useEffect(() => {
    let alive = true;
    load()
      .then((value) => {
        if (alive) setState({ key, value });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, key]);
  return state?.key === key ? state.value : null;
}

export function usePageEntries(page: Page | undefined): PageEntry[] | null {
  return useLocalQuery(async () => {
    if (!page) return [];
    const [records, repo] = await Promise.all([getRecords(), getPagesRepo()]);
    const [list, links] = await Promise.all([
      records.list(LIST_LIMIT),
      page.serverId ? repo.linksFor(page.serverId) : Promise.resolve([]),
    ]);
    return pageEntries(page, list, links);
  }, [page?.id, page?.serverId, page?.templateKey]);
}

export function useAllRecords(): LocalRecord[] | null {
  return useLocalQuery(async () => (await getRecords()).list(LIST_LIMIT), []);
}

/** undefined = still loading; null = there is no such record. */
export function useRecord(id: string | undefined): LocalRecord | null | undefined {
  const value = useLocalQuery(async () => ({ rec: id ? await (await getRecords()).get(id) : null }), [id]);
  return value === null ? undefined : value.rec;
}
