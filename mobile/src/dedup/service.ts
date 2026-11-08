import { ApiError, NetworkError, SignInRequiredError } from '@/api/errors';
import { cleanupPreview } from '@/api/endpoints';
import type {
  ActionOut,
  CollectionOut,
  ConsentTextOut,
  DuplicateGroupOut,
  ImportOut,
  PendingActionOut,
} from '@/api/types';
import { getOutbox } from '@/db';
import i18n from '@/i18n';
import { getApi, getFiles, kickSync, notifyDataChanged, syncBlocked } from '@/services';
import { useOnboarding } from '@/store/onboarding';
import { useToast } from '@/store/toast';
import { useUndo } from '@/store/undo';
import type { DedupSink, ImportPayload } from '@/sync/engine';
import { undoServerAction } from '@/tasks/actions';
import { rememberActions } from '@/tasks/service';
import { newId } from '@/utils/id';

import { dedupState, type ImportRow } from './store';

/**
 * Week 10: repeats, stacks and the Telegram import (2-design 3, S11, S21, S25, S26; 3-engineering
 * 6.3, 6.10). Binding rules (R-31, Ф-3): nothing is merged or hidden without the person's «Да»,
 * except an exact repeat on save (automatic, with «Отменить»); every change here has «Отменить»
 * (the undo of the server's action); the order of a page stays the person's (the server keeps
 * `manual_order` rows where they are). Merging is the server's work (code joins the texts), so it
 * needs the internet: offline the person is told so and nothing changes.
 */

const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o);
const canTalk = () => useOnboarding.getState().consent !== null && !syncBlocked();
const toast = (k: string, o?: Record<string, unknown>) => useToast.getState().show(t(k, o), 4000);
const summaryOf = (a: ActionOut) => (i18n.language === 'kk' && a.summary.kk) || a.summary.ru;
const offline = (e: unknown) => e instanceof NetworkError || e instanceof SignInRequiredError;

/** A `cleanup_batch` that can still get its «Да». */
export function liveCleanup(p: PendingActionOut | null, now = Date.now()): PendingActionOut | null {
  if (!p || p.kind !== 'cleanup_batch' || p.status !== 'proposed') return null;
  if (p.expires_at && Date.parse(p.expires_at) <= now) return null;
  return cleanupPreview(p) ? p : null;
}

/** Groups to show: `suggested`, not decided here, with something left to merge. */
export function visibleGroups(groups: Record<string, DuplicateGroupOut>, decided: string[]): DuplicateGroupOut[] {
  return Object.values(groups)
    .filter((g) => g.status === 'suggested' && !decided.includes(g.id) && g.members.length > 1)
    .sort((a, b) => b.member_count - a.member_count || (b.created_at ?? '').localeCompare(a.created_at ?? ''));
}

/** «Повторы (12)»: how many records would go if every group were merged. */
export function repeatsCount(groups: DuplicateGroupOut[]): number {
  return groups.reduce((n, g) => n + Math.max(0, g.members.length - 1), 0);
}

/** Stacks shown on a page (server id), in the page's group order, then the newest. */
export function stacksOf(
  collections: Record<string, CollectionOut>,
  gone: string[],
  pageServerId: string | null,
  groupOrder: string[] = [],
): CollectionOut[] {
  if (!pageServerId) return [];
  const at = (c: CollectionOut) => {
    const i = groupOrder.indexOf(c.title);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  return Object.values(collections)
    .filter((c) => c.page_id === pageServerId && !c.deleted_at && !c.hidden_at && !gone.includes(c.id))
    .sort((a, b) => at(a) - at(b) || (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
}

function putGroups(list: DuplicateGroupOut[], replace = false): void {
  const s = dedupState();
  const groups = replace ? {} : { ...s.groups };
  for (const g of list) {
    const prev = groups[g.id];
    if (prev && prev.seq > g.seq) continue;
    if (g.status === 'suggested') groups[g.id] = g;
    else delete groups[g.id];
  }
  // A group the server decided is no longer «decided here».
  s.set({ groups, decided: s.decided.filter((id) => groups[id]) });
}

function putCollections(list: CollectionOut[]): void {
  const s = dedupState();
  const collections = { ...s.collections };
  for (const c of list) {
    const prev = collections[c.id];
    if (prev && prev.seq > c.seq) continue;
    if (c.deleted_at) delete collections[c.id];
    else collections[c.id] = c;
  }
  s.set({ collections, goneCollections: s.goneCollections.filter((id) => collections[id]) });
}

function putImport(out: ImportOut): void {
  const s = dedupState();
  const prev = s.imports[out.id];
  if (prev && prev.seq > out.seq && out.seq > 0) return;
  s.set({ imports: { ...s.imports, [out.id]: out } });
  if (out.cleanup) putPending([out.cleanup]);
}

function putPending(list: PendingActionOut[]): void {
  const s = dedupState();
  let cleanup = s.cleanup;
  for (const p of list) {
    if (p.kind !== 'cleanup_batch') continue;
    if (cleanup?.id === p.id || !cleanup || (cleanup.seq ?? 0) <= p.seq) cleanup = p;
  }
  s.set({ cleanup: liveCleanup(cleanup) });
}

export const dedupSink: DedupSink = {
  apply: ({ groups, collections, imports, pending }) => {
    if (groups.length > 0) putGroups(groups);
    if (collections.length > 0) putCollections(collections);
    for (const imp of imports) putImport(imp);
    if (pending.length > 0) putPending(pending);
  },
  importStarted: (clientId, out) => {
    const s = dedupState();
    putImport(out);
    if (s.importRow?.clientId === clientId) s.set({ importRow: { ...s.importRow, importId: out.id, error: null } });
  },
  importFailed: (clientId, code) => {
    const s = dedupState();
    if (s.importRow?.clientId === clientId) s.set({ importRow: { ...s.importRow, error: code } });
  },
};

// --- «Объединить?» (S26) ---

export async function refreshGroups(): Promise<void> {
  if (!canTalk()) return;
  try {
    putGroups(await getApi().duplicateGroups('suggested'), true);
  } catch {
    // offline: the phone's copy is shown
  }
}

/** After an undo the group may be offered again; the records come back with /sync. */
function afterUndo(): void {
  kickSync();
  void refreshGroups();
}

function decide(id: string, on: boolean): void {
  const s = dedupState();
  s.set({ decided: on ? [...new Set([...s.decided, id])] : s.decided.filter((x) => x !== id) });
}

/**
 * [Объединить]: this tap is the «Да» for this one group (2-design 3.6). `keepItemId`: the person
 * chose which record stays; else the server's (the fullest, then the newest).
 */
export async function mergeGroup(group: DuplicateGroupOut, keepItemId?: string): Promise<boolean> {
  decide(group.id, true);
  try {
    const out = await getApi().mergeGroup(group.id, {
      client_id: newId(),
      ...(keepItemId && keepItemId !== group.keep_item_id ? { keep_item_id: keepItemId } : {}),
    });
    if (out.group) putGroups([out.group]);
    kickSync();
    const action = out.action;
    if (action) {
      rememberActions([action]);
      useUndo.getState().showCustom(summaryOf(action), () => void undoServerAction(action.id).then(afterUndo));
    }
    return true;
  } catch (e) {
    decide(group.id, false);
    if (offline(e)) toast('dup.offline');
    else if (e instanceof ApiError && (e.status === 404 || e.status === 409 || e.status === 410)) {
      // Already decided elsewhere, or the records changed: show what the server has now.
      toast('dup.changed');
      void refreshGroups();
    } else toast('errors.generic');
    return false;
  }
}

/** [Это разные]: not offered again. «Отменить» when the server gave an action for it. */
export async function dismissGroup(group: DuplicateGroupOut): Promise<boolean> {
  decide(group.id, true);
  try {
    const out = await getApi().dismissGroup(group.id, { client_id: newId() });
    if (out.group) putGroups([out.group]);
    const action = out.action;
    if (action) {
      rememberActions([action]);
      useUndo.getState().showCustom(summaryOf(action), () => void undoServerAction(action.id).then(afterUndo));
    } else {
      useToast.getState().show(t('dup.dismissed'), 3000);
    }
    return true;
  } catch (e) {
    decide(group.id, false);
    toast(offline(e) ? 'dup.offline' : 'errors.generic');
    return false;
  }
}

// --- «Убрать повторы: 37 → 1?» (one «Да» on the batch, S25) ---

/** Asks the server for the plan; nothing changes until «Да». */
export async function planCleanup(importId?: string): Promise<void> {
  if (!canTalk()) return;
  try {
    const out = await getApi().cleanupPlan({ client_id: newId(), ...(importId ? { import_id: importId } : {}) });
    dedupState().set({ cleanup: liveCleanup(out.pending_action) });
    if (out.groups.length > 0) putGroups(out.groups);
  } catch {
    // offline or nothing to clean: the card simply is not there
  }
}

/** [Да, убрать]: one action, one «Отменить» for the whole batch. */
export async function confirmCleanup(): Promise<boolean> {
  const p = liveCleanup(dedupState().cleanup);
  if (!p) return false;
  try {
    const out = await getApi().confirmPending(p.id, newId());
    dedupState().set({ cleanup: null });
    kickSync();
    notifyDataChanged();
    const action = out.action;
    if (action) {
      rememberActions([action]);
      useUndo.getState().showCustom(summaryOf(action), () => void undoServerAction(action.id).then(afterUndo));
    }
    return true;
  } catch (e) {
    if (e instanceof ApiError && e.status === 410) {
      dedupState().set({ cleanup: null });
      toast('dup.plan_gone');
      void planCleanup();
    } else toast(offline(e) ? 'dup.offline' : 'errors.generic');
    return false;
  }
}

/** [Нет]: the card goes; nothing was changed. */
export async function rejectCleanup(): Promise<void> {
  const p = dedupState().cleanup;
  dedupState().set({ cleanup: null });
  if (!p) return;
  try {
    await getApi().rejectPending(p.id);
  } catch {
    // it expires by itself in 24 h
  }
}

// --- stacks (S11) ---

export async function refreshCollections(): Promise<void> {
  if (!canTalk()) return;
  try {
    putCollections(await getApi().collections());
  } catch {
    // offline: the phone's copy
  }
}

function stackDone(out: { collection: CollectionOut | null; action: ActionOut | null }, fallback: string): void {
  if (out.collection) putCollections([out.collection]);
  kickSync();
  const action = out.action;
  const text = action ? summaryOf(action) : fallback;
  if (action) {
    rememberActions([action]);
    useUndo.getState().showCustom(text, () =>
      void undoServerAction(action.id).then(() => {
        kickSync();
        void refreshCollections();
      }),
    );
  } else useToast.getState().show(text, 3000);
}

/** «Убрать из стопки»: the assistant does not put it back there (R-54). */
export async function removeFromStack(c: CollectionOut, itemServerId: string): Promise<boolean> {
  try {
    stackDone(await getApi().removeFromCollection(c.id, itemServerId, newId()), t('stack.removed'));
    return true;
  } catch (e) {
    toast(offline(e) ? 'stack.offline' : 'errors.generic');
    return false;
  }
}

/** «Разобрать стопку»: the records stay on the page. */
export async function takeApartStack(c: CollectionOut): Promise<boolean> {
  const s = dedupState();
  s.set({ goneCollections: [...s.goneCollections, c.id] });
  try {
    stackDone(await getApi().deleteCollection(c.id, newId()), t('stack.taken_apart', { title: c.title }));
    return true;
  } catch (e) {
    dedupState().set({ goneCollections: dedupState().goneCollections.filter((x) => x !== c.id) });
    toast(offline(e) ? 'stack.offline' : 'errors.generic');
    return false;
  }
}

/** «Переименовать», with «Отменить». */
export async function renameStack(c: CollectionOut, title: string): Promise<boolean> {
  const name = title.trim();
  if (!name || name === c.title) return false;
  try {
    stackDone(await getApi().renameCollection(c.id, name, newId()), t('stack.renamed', { title: name }));
    return true;
  } catch (e) {
    toast(offline(e) ? 'stack.offline' : 'errors.generic');
    return false;
  }
}

// --- Telegram import (S21, 3-engineering 6.10) ---

/** The `telegram_import` text to show, or null when it was given already. Throws when it cannot be had. */
export async function importConsentText(): Promise<ConsentTextOut | null> {
  if (dedupState().telegramConsent) return null;
  const api = getApi();
  const state = await api.consents();
  if (state.active.some((c) => c.kind === 'telegram_import')) {
    dedupState().set({ telegramConsent: true });
    return null;
  }
  const locale = useOnboarding.getState().language;
  return api.getConsentText('telegram_import', locale);
}

/** Records exactly the text on screen (version + hash), like S05. */
export async function giveImportConsent(text: ConsentTextOut): Promise<void> {
  await getApi().grantConsents({
    consents: [{ kind: 'telegram_import', version: text.version, text_hash: text.text_hash, locale: text.locale }],
    screen: 'import',
    // Confirmed on S05 already; the server asks it only together with `terms`.
    age_confirmed_18: true,
  });
  dedupState().set({ telegramConsent: true });
}

const IMPORT_NAME = /(\.json|\.zip)$/i;

export function isExportFile(name: string): boolean {
  return IMPORT_NAME.test(name.trim());
}

/**
 * The chosen file: copied into the app (so a restart does not lose it), then the outbox uploads it
 * and starts the import. The notes go to the pages by their rules (the server's `auto_rule`).
 */
export async function startImport(f: { uri: string; name: string; mime: string | null }): Promise<ImportRow> {
  const clientId = newId();
  const files = getFiles();
  const safe = f.name.replace(/[^\w.\-]+/g, '_').slice(-80);
  const uri = await files.persist(f.uri, `import-${clientId}-${safe}`);
  const [bytes, sha256] = await Promise.all([files.size(uri), files.sha256(uri)]);
  const mime = f.mime && f.mime !== 'application/octet-stream' ? f.mime : /\.zip$/i.test(f.name) ? 'application/zip' : 'application/json';
  const payload: ImportPayload = { clientId, file: { uri, mime, bytes, sha256, name: f.name } };
  const row = await (await getOutbox()).enqueue('import.telegram', payload);
  const importRow: ImportRow = { clientId, outboxId: row.id, fileName: f.name, importId: null, error: null, at: new Date().toISOString() };
  dedupState().set({ importRow });
  kickSync();
  return importRow;
}

const RUNNING = new Set(['created', 'running', 'paused_budget', 'awaiting_code']);

export const importRunning = (imp: ImportOut | undefined | null) => !!imp && RUNNING.has(imp.status);

export async function pollImport(id: string): Promise<ImportOut | null> {
  try {
    const out = await getApi().getImport(id);
    if (out) {
      putImport(out);
      if (!importRunning(out)) {
        kickSync(); // the records it brought
        notifyDataChanged();
      }
    }
    return out;
  } catch {
    return null;
  }
}

/** [Остановить]: what came over stays, with «Отменить» on the import. */
export async function cancelImport(id: string): Promise<void> {
  try {
    const out = await getApi().cancelImport(id);
    if (out) putImport(out);
    kickSync();
  } catch (e) {
    toast(offline(e) ? 'import.offline' : 'errors.generic');
  }
}

/** «Отменить перенос»: the undo of the import's action hides what it brought (it can be brought back). */
export async function undoImport(imp: ImportOut): Promise<void> {
  if (!imp.action_id) return;
  const r = await undoServerAction(imp.action_id);
  if (r.result === 'expired') toast('changes.expired');
  else if (r.result === 'failed') toast('errors.generic');
  else {
    useToast.getState().show(t('import.undone'), 4000);
    kickSync();
  }
}
