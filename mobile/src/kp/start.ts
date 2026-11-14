import { router } from 'expo-router';

import { getCapture } from '@/services';
import { usePages } from '@/store/pages';

import { newId } from '@/utils/id';

import { pumpJobs, startKp } from './service';
import { useKp } from './store';

/**
 * Ф-51 / ux-review-2 #6: a КП without hunting for screens.
 * - «Сделать документ из этого» (a shared file, a record's menu): the record is the ТЗ — `POST /v1/documents/kp`
 *   with its id (kp.md «A КП from a ТЗ»), the S16 «Что я понял» screen follows the job.
 * - «сделай КП для …» in the line: the phrase becomes the ТЗ note on «Документы» and the same job starts.
 * Online the server reads the phrase itself (chat.md, event `kp_started` → `openServerKp`); the phone's check is the
 * offline / «Без ИИ» path only.
 */
export function makeDocumentFrom(recordId: string): void {
  const job = startKp([recordId]);
  router.push({ pathname: '/kp/new', params: { job: job.id } });
}

/** «сделай КП для ТОО Арман: …», «КП для …», «составь коммерческое предложение …» (ru / kk). */
const KP_PHRASE = /^\s*(?:(?:сделай|сделать|составь|составить|подготовь|нужно|нужен|нужна|жаса|жасап\s+бер|дайында)\s+)?(?:кп|коммерческое\s+предложение|коммерциялық\s+ұсыныс)(?:\s|$|[,.:!—-])/iu;

export function looksLikeKp(text: string): boolean {
  return KP_PHRASE.test(text);
}

/** The phrase from the line: save it as the ТЗ (on «Документы» when it exists) and start the КП. */
export async function kpFromPhrase(text: string): Promise<void> {
  const docs = usePages.getState().pages.find((p) => p.templateKey === 'documents');
  const capture = await getCapture();
  const rec = await capture.saveText({ text: text.trim(), source: 'typed', ...(docs ? { pageId: docs.id } : {}) });
  makeDocumentFrom(rec.id);
}

/** `kp_started` from the line: follow the server's document on S16 like a job the phone started. */
export function openServerKp(documentId: string): void {
  const id = newId();
  useKp.setState((st) => ({
    jobs: { ...st.jobs, [id]: { id, recordIds: [], state: 'reading', documentId, message: null, createdAt: new Date().toISOString() } },
  }));
  void pumpJobs();
  router.push({ pathname: '/kp/new', params: { job: id } });
}
