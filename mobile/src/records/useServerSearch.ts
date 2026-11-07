import { useEffect, useState } from 'react';

import type { SearchHitOut } from '@/api/types';
import { getRecords, isTrashed, type LocalRecord } from '@/db';
import { getApi, syncBlocked } from '@/services';
import { useConnectivity } from '@/store/connectivity';
import { useOnboarding } from '@/store/onboarding';

/** What the server knows beyond the phone's own search: word forms, typos, meaning. */
export type ServerResult = {
  key: string;
  hit: SearchHitOut;
  /** The record is on this phone. */
  record: LocalRecord | null;
  /** Found only by meaning: goes under «Нашёл ещё» (US-5). */
  meaningOnly: boolean;
};

export type ServerSearchState = 'idle' | 'loading' | 'done' | 'offline';

const DEBOUNCE_MS = 400;
const MIN_CHARS = 2;
const MAX_CHARS = 200;

/**
 * GET /search while there is a connection and a consent. Failing is quiet: the phone's own results
 * are already on screen. Asks again when the connection comes back, as long as the screen is open.
 * The query is debounced: typed letter by letter, it would be a request per letter.
 */
export function useServerSearch(
  q: string,
  o: { pageServerId?: string | null; enabled?: boolean } = {},
): { results: ServerResult[]; state: ServerSearchState } {
  const query = q.trim().slice(0, MAX_CHARS);
  const enabled = o.enabled !== false;
  const pageId = o.pageServerId ?? undefined;
  const online = useConnectivity((s) => s.online);
  const hasConsent = useOnboarding((s) => s.consent !== null && s.accountConsent === null);
  const key = `${query}|${pageId ?? ''}`;
  const [answer, setAnswer] = useState<{ key: string; results: ServerResult[]; state: ServerSearchState } | null>(null);
  const askable = enabled && hasConsent && query.length >= MIN_CHARS;

  useEffect(() => {
    if (!askable || syncBlocked()) return;
    let alive = true;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const out = await getApi().search({ q: query, ...(pageId ? { page_id: pageId } : {}) });
          const records = await getRecords();
          const results: ServerResult[] = [];
          for (const hit of out.results) {
            const record = await records.findByServerId(hit.item_id);
            // Deleted or merged on this phone a moment ago, the server does not know yet.
            if (record && (isTrashed(record) || record.hiddenReason)) continue;
            const meaningOnly = hit.matched_by.length > 0 && hit.matched_by.every((m) => m === 'meaning');
            results.push({ key: hit.item_id, hit, record, meaningOnly });
          }
          if (alive) setAnswer({ key, results, state: 'done' });
        } catch {
          if (alive) setAnswer({ key, results: [], state: 'offline' });
        }
      })();
    }, DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [askable, key, online, pageId, query]);

  if (!askable) return { results: [], state: 'idle' };
  return answer?.key === key ? answer : { results: [], state: 'loading' };
}
