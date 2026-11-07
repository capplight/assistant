import { useEffect, useState } from 'react';
import type { TFunction } from 'i18next';

import { getRecords } from '@/db';
import { recordTitle } from '@/records/format';
import type { ChatMessage } from '@/store/assistant';
import { useDataVersion } from '@/store/data';

/** The line under (or instead of) an answer that says where it is. null: nothing to add. */
export function answerNotice(m: ChatMessage, t: TFunction): string | null {
  switch (m.status) {
    case 'streaming':
      return m.text ? null : (m.activity ?? t('answer.looking'));
    case 'queued':
      return t('answer.queued');
    case 'interrupted':
      return t('answer.interrupted');
    case 'deferred':
      return t('answer.deferred');
    case 'failed':
      return m.notice === 'limit' ? t('answer.limit') : m.notice === 'no_ai' ? t('answer.no_ai') : t('errors.generic');
    case 'done':
      if (m.notice === 'limit') return t('answer.limit');
      if (m.notice === 'not_found') return t('answer.not_found');
      return m.text || (m.sources?.length ?? 0) > 0 ? null : t('answer.not_found');
    default:
      return null;
  }
}

/** Titles of the records found on the phone (offline answer). */
export function useLocalHitTitles(ids: string[] | undefined, t: TFunction): Record<string, string> {
  const key = (ids ?? []).join(',');
  const version = useDataVersion((s) => s.version);
  const [titles, setTitles] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!key) return;
    let alive = true;
    void (async () => {
      const records = await getRecords();
      const out: Record<string, string> = {};
      for (const id of key.split(',')) {
        const r = await records.get(id);
        if (r) out[id] = recordTitle(r, t);
      }
      if (alive) setTitles(out);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version]);
  return titles;
}
