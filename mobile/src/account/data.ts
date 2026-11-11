import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { replan } from '@/alarms/service';
import { useAlarms } from '@/alarms/store';
import { ApiError } from '@/api/errors';
import type { DeletionStateOut, ExportOut } from '@/api/types';
import { getOutbox, getPagesRepo, getRecords } from '@/db';
import { useDedup } from '@/dedup/store';
import { useExpenses } from '@/expenses/store';
import i18n from '@/i18n';
import { getSharePort } from '@/kp/share';
import { useCatalog } from '@/pages/catalog';
import { useFacets } from '@/pages/facets';
import { useKp } from '@/kp/store';
import { getApi, getFiles, notifyDataChanged } from '@/services';
import { useAssistant } from '@/store/assistant';
import { useOnboarding } from '@/store/onboarding';
import { usePages } from '@/store/pages';
import { persistStorage } from '@/store/storage';
import { useTasks } from '@/tasks/store';
import { useToday } from '@/today/service';
import { newId } from '@/utils/id';

/**
 * Week 16 — «Мои данные» (S24, US-19) and «Удалить аккаунт и все данные» (S32, US-20, F-27),
 * contract docs/api/account.md. Both need the internet: the archive is built by the server, and
 * the deletion is the server's (SMS code or the button). Nothing here is ever done by the
 * assistant, only by the person's own taps.
 */

type DeletingState = {
  /** «Аккаунт удаляется. До 18 ноября можно передумать: …» (the server's words). */
  message: string;
  deleteAfter: string | null;
  /** From the refused sign-in (`403 account_deletion_pending`); lives 15 minutes. */
  restoreToken: string | null;
};

type AccountState = {
  exportJob: ExportOut | null;
  deleting: DeletingState | null;
  set: (p: Partial<Pick<AccountState, 'exportJob' | 'deleting'>>) => void;
  reset: () => void;
};

export const useAccount = create<AccountState>()(
  persist(
    (set) => ({
      exportJob: null,
      deleting: null,
      set: (p) => set(p),
      reset: () => set({ exportJob: null, deleting: null }),
    }),
    { name: 'account.v1', storage: persistStorage, partialize: ({ exportJob, deleting }) => ({ exportJob, deleting }) },
  ),
);

const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o);

export type Fail = { error: string };
const failOf = (e: unknown): Fail => ({
  error: e instanceof ApiError ? (i18n.language === 'kk' && e.messageKk) || e.messageRu || t('errors.generic') : t('account.offline'),
});

// --- export ---

/** «Скачать мои данные»: the server starts the archive (or returns the one being made). */
export async function startExport(): Promise<Fail | null> {
  try {
    const out = await getApi().startExport(newId());
    useAccount.getState().set({ exportJob: out });
    return null;
  } catch (e) {
    return failOf(e);
  }
}

/** Polled every 5 s while S24 is open, and on the push «Архив готов». */
export async function refreshExport(): Promise<void> {
  const job = useAccount.getState().exportJob;
  if (!job) return;
  try {
    const out = await getApi().getExport(job.id);
    if (out) useAccount.getState().set({ exportJob: out });
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) useAccount.getState().set({ exportJob: null });
  }
}

/** The link of a ready archive, if it is still alive (24 h). */
export function liveLink(job: ExportOut | null, now = Date.now()): string | null {
  if (!job || job.status !== 'ready' || !job.download_url) return null;
  if (job.expires_at && Date.parse(job.expires_at) <= now) return null;
  return job.download_url;
}

/** The link goes to the system share sheet: the person sends it to themselves, or opens it. */
export async function shareExport(): Promise<boolean> {
  const job = useAccount.getState().exportJob;
  const url = liveLink(job);
  if (!url || !job) return false;
  const port = getSharePort();
  const until = job.expires_at ? untilText(job.expires_at) : '';
  if (port.shareLink) await port.shareLink(url, t('account.share_text', { until }));
  else if (port.openUrl) await port.openUrl(url);
  return true;
}

export function untilText(iso: string): string {
  const d = new Date(iso);
  try {
    const day = d.toLocaleDateString(i18n.language, { day: 'numeric', month: 'long' });
    return `${day}, ${d.toTimeString().slice(0, 5)}`;
  } catch {
    return iso;
  }
}

// --- deletion ---

/** What S32 shows; offline the points are the bundled ones (same words as the server). */
export async function loadDeletionState(): Promise<DeletionStateOut | null> {
  try {
    return await getApi().deletionState();
  } catch {
    return null;
  }
}

export async function sendDeletionCode(phone: string): Promise<{ challengeId: string; devCode: string | null } | Fail> {
  try {
    const out = await getApi().deletionOtp(phone);
    return { challengeId: out.challenge_id, devCode: out.dev_code ?? null };
  } catch (e) {
    return failOf(e);
  }
}

/**
 * The «Да»: SMS code (an account with a number) or the button (anonymous). From the server's 202
 * on, sign-in is closed and every session revoked: this phone cancels its alarms, forgets its copy
 * and shows «Аккаунт удаляется…». The device key stays, so «Восстановить» can sign in again.
 */
export async function confirmDeletion(o: { challengeId: string; code: string } | { confirm: true }): Promise<Fail | null> {
  let out;
  try {
    out = await getApi().requestDeletion('confirm' in o ? { confirm: true } : { challenge_id: o.challengeId, code: o.code });
  } catch (e) {
    return failOf(e);
  }
  await forgetLocalCopy();
  useAccount.getState().set({
    deleting: { message: out.message_ru || t('account.deleting'), deleteAfter: out.delete_after, restoreToken: null },
  });
  return null;
}

/**
 * Everything of the account goes from this phone: records and their files on disk (shares, photos,
 * voice, КП files, the cache), pages, outbox, alarms, the archive link, the session. Kept: only
 * the restore token (`deleting`) and the install's device key, which «Восстановить» needs.
 */
export async function forgetLocalCopy(): Promise<void> {
  const alarms = useAlarms.getState();
  alarms.set({ reminders: {}, fires: {}, local: {} });
  await replan(); // nothing to ring any more
  const [outbox, records, pages] = await Promise.all([getOutbox(), getRecords(), getPagesRepo()]);
  await outbox.wipe();
  await records.wipe();
  await pages.wipe();
  await getFiles().wipeAll?.();
  useTasks.getState().reset();
  useExpenses.getState().reset();
  useKp.getState().reset();
  useDedup.getState().reset();
  useCatalog.getState().reset();
  useFacets.getState().reset();
  useAssistant.getState().reset();
  useToday.setState({ last: null, answered: [] });
  usePages.setState({ pages: [] });
  useAccount.getState().set({ exportJob: null });
  useOnboarding.getState().setDisplayName(null);
  await getApi().client.tokens.clearSession();
  notifyDataChanged();
}

/**
 * «Восстановить» (within the grace days): sign in with this phone's device key → the server says
 * `403 account_deletion_pending` with a restore token → `POST /me/deletion/cancel` gives a new
 * session; the account and all its data come back through /sync. An account with a number that
 * this phone cannot reach by the device key signs in by SMS (S04b) instead.
 */
export async function restoreAccount(): Promise<'restored' | 'need_sms' | 'done' | Fail> {
  const api = getApi();
  let token = useAccount.getState().deleting?.restoreToken ?? null;
  if (!token) {
    try {
      await api.client.signInAnonymous();
      // A new anonymous account: the old one was not this device's. Sign out of it again.
      await api.client.tokens.clearSession();
      return 'need_sms';
    } catch (e) {
      const t0 = deletionPendingFrom(e);
      if (!t0) return e instanceof ApiError && e.code === 'deletion_done' ? 'done' : failOf(e);
      token = t0.restoreToken;
    }
  }
  try {
    const pair = await api.cancelDeletion(token);
    await api.client.tokens.saveTokens(pair);
  } catch (e) {
    if (e instanceof ApiError && e.code === 'deletion_done') return 'done';
    if (e instanceof ApiError && e.code === 'restore_invalid') {
      useAccount.getState().set({ deleting: { ...useAccount.getState().deleting!, restoreToken: null } });
    }
    return failOf(e);
  }
  useAccount.getState().set({ deleting: null });
  return 'restored';
}

/** A sign-in refused because the account is being deleted (account.md): its restore token. */
export function deletionPendingFrom(e: unknown): { restoreToken: string; deleteAfter: string | null } | null {
  if (!(e instanceof ApiError) || e.code !== 'account_deletion_pending') return null;
  const token = e.details?.restore_token;
  if (typeof token !== 'string') return null;
  const after = e.details?.delete_after;
  return { restoreToken: token, deleteAfter: typeof after === 'string' ? after : null };
}

/** The phone's sign-in (S04b) met an account being deleted: show «Восстановить?». */
export function noteDeletionPending(e: unknown): boolean {
  const p = deletionPendingFrom(e);
  if (!p) return false;
  useAccount.getState().set({
    deleting: { message: t('account.deleting_ask'), deleteAfter: p.deleteAfter, restoreToken: p.restoreToken },
  });
  return true;
}

/** «Начать заново» after the account is gone: the first launch again on this phone. */
export async function startOver(): Promise<void> {
  await forgetLocalCopy();
  useAccount.getState().reset();
  useOnboarding.getState().reset();
}
