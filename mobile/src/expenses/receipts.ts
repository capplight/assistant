import { ApiError, isRetryable, NetworkError, SignInRequiredError } from '@/api/errors';
import type { ExpenseDuplicateOut, ExpenseOut, PendingActionOut, ReceiptOut, StatementOut, StatementRowOut } from '@/api/types';
import { getOutbox, getRecords, type OutboxEntry } from '@/db';
import i18n from '@/i18n';
import { getApi, getCapture, getRecordActions, getSyncEngine, kickSync, notifyDataChanged, syncBlocked } from '@/services';
import { useOnboarding } from '@/store/onboarding';
import { useToast } from '@/store/toast';
import { useUndo } from '@/store/undo';
import { undoServerAction } from '@/tasks/actions';
import { rememberActions } from '@/tasks/service';
import { newId } from '@/utils/id';

import { formatAmount, minorToDecimal, toMinor, TRANSFERS_KEY } from './calc';
import type { PickedMedia } from './media';
import { applyServer, resolveKey } from './service';
import { expensesState, type ReceiptJob } from './store';

/**
 * Week 13 «Расходы 2» (docs/api/expenses.md «Week 13»; 3-engineering 6.13, 11.2; 2-design S40
 * paths 2–3; product US-32): a receipt photo, a fiscal QR, a receipt shared from a bank app, a
 * bank statement PDF, and «Объединить?» for two spendings that are one payment.
 *
 * - The phone reads nothing in a picture or a PDF: the file is a record at once (offline too, «Ждёт
 *   связи»), and the server reads it when it can; code checks every number there. The fiscal QR is
 *   decoded on the phone (no network, no model); the phone never opens the link, the server opens
 *   only official OFD domains. An amount not typed by the person is «Проверьте» until «Верно» (R-36).
 * - A statement gives a plan («Нашёл 86 операций за октябрь, 4 уже есть»); nothing is saved before
 *   its one «Да»; after it, one «Отменить» (the undo of `bulk_create_expenses`).
 * - Joining two spendings is the server's (one goes to the trash with its record, the kept one takes
 *   what it lacks), so it needs the internet; the person is told so and nothing changes offline.
 */

const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o);
const nowIso = () => new Date().toISOString();
const canSend = () => useOnboarding.getState().consent !== null;
const kick = () => {
  if (!syncBlocked()) kickSync();
};
const offline = (e: unknown) => e instanceof NetworkError || e instanceof SignInRequiredError;
const serverWords = (err: unknown): string | null =>
  err instanceof ApiError ? (i18n.language === 'kk' ? err.messageKk || err.messageRu : err.messageRu || err.messageKk) || null : null;

/** Outbox `expense.receipt` / `expense.statement`: the job id is the `client_id` of the call. */
export type ReceiptPayload = { jobId: string };

/** Shown on the page this long; then only the spending (or the record) stays. */
export const JOB_SHOWN_DAYS = 7;

function putJob(job: ReceiptJob): void {
  expensesState().set({ jobs: { ...expensesState().jobs, [job.id]: job } });
  notifyDataChanged();
}

function patchJob(id: string, p: Partial<ReceiptJob>): ReceiptJob | null {
  const job = expensesState().jobs[id];
  if (!job) return null;
  const next = { ...job, ...p };
  putJob(next);
  return next;
}

function dropJob(id: string): void {
  const jobs = { ...expensesState().jobs };
  delete jobs[id];
  expensesState().set({ jobs });
  notifyDataChanged();
}

function newJob(kind: ReceiptJob['kind'], recordId: string | null, qr: string | null): ReceiptJob {
  return { id: newId(), kind, recordId, itemId: null, qr, state: 'waiting', draft: null, expenseIds: [], statementId: null, message: null, createdAt: nowIso() };
}

/** Jobs still worth a line on «Расходы», newest first (a statement's plan has its own card). */
export function visibleJobs(jobs: Record<string, ReceiptJob>, now = Date.now()): ReceiptJob[] {
  return Object.values(jobs)
    .filter((j) => j.state !== 'done' && now - Date.parse(j.createdAt) < JOB_SHOWN_DAYS * 86_400_000)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** «Отменить» right after bringing it: nothing goes (or its spending goes back); the record goes to «Удалённые записи». */
async function takeBackJob(jobId: string, rowId: string | null): Promise<void> {
  const job = expensesState().jobs[jobId];
  if (!job) return;
  if (rowId) {
    const engine = await getSyncEngine();
    await engine.hold(rowId);
    try {
      const outbox = await getOutbox();
      const row = await outbox.get(rowId);
      if (row?.status === 'pending') await outbox.markFailed(row.id, 'undone');
    } finally {
      engine.release(rowId);
    }
  }
  for (const id of expensesState().jobs[jobId]?.expenseIds ?? []) {
    const actionId = expensesState().createdBy[resolveKey(id)];
    if (actionId) await undoServerAction(actionId);
  }
  if (job.recordId) await (await getRecordActions()).remove(job.recordId);
  dropJob(jobId);
  kick();
}

async function queue(job: ReceiptJob, stripKey: string): Promise<ReceiptJob> {
  putJob(job);
  if (!canSend()) {
    useUndo.getState().showCustom(t(stripKey), () => void takeBackJob(job.id, null));
    return job;
  }
  const row = await (await getOutbox()).enqueue(job.kind === 'statement' ? 'expense.statement' : 'expense.receipt', { jobId: job.id } satisfies ReceiptPayload);
  useUndo.getState().showCustom(t(stripKey), () => void takeBackJob(job.id, row.id));
  kick();
  return job;
}

/** A record already on the phone is a receipt (the camera, the gallery, «Поделиться»): the server reads it. */
export function readAsReceipt(recordId: string, kind: 'photo' | 'shared'): Promise<ReceiptJob> {
  return queue(newJob(kind, recordId, null), 'exp.receipt_saved');
}

/** A record already on the phone (a shared PDF) is a bank statement: the plan comes, nothing is added before «Да». */
export function readAsStatement(recordId: string): Promise<ReceiptJob> {
  return queue(newJob('statement', recordId, null), 'exp.statement_saved');
}

/** A receipt photo (camera or gallery): a record at once on «Расходы» (and by its rules on «Документы»), then it is read. */
export async function saveReceipt(m: PickedMedia, pageId: string | null): Promise<ReceiptJob> {
  const capture = await getCapture();
  const rec = await capture.saveFile({ uri: m.uri, mime: m.mime, name: m.name, source: 'camera', pageId: pageId ?? undefined });
  return readAsReceipt(rec.id, 'photo');
}

/** A statement PDF from the files: a record (a document, not a spending), then the plan. */
export async function saveStatement(m: PickedMedia): Promise<ReceiptJob> {
  const capture = await getCapture();
  const rec = await capture.saveFile({ uri: m.uri, mime: m.mime || 'application/pdf', name: m.name, source: 'files' });
  return readAsStatement(rec.id);
}

/** A web link, http(s) only, nothing private in it: the only QR text sent (the server checks the OFD allowlist). */
export function qrLink(text: string): string | null {
  const s = text.trim();
  if (s.length > 2000 || !/^https?:\/\//i.test(s)) return null;
  try {
    const u = new URL(s);
    if (u.username || u.password || !u.hostname.includes('.')) return null;
    return s;
  } catch {
    return null;
  }
}

/**
 * What the link itself says (expenses.md «Fiscal QR»: the sum `s` and the time `t` are in it, read
 * by code): shown on the waiting line offline. Not a spending until the server makes it.
 */
export function qrPreview(link: string): { amount: string; day: string | null } | null {
  const q = link.split('?')[1] ?? '';
  const params: Record<string, string> = {};
  for (const part of q.split('&')) {
    const [k = '', v = ''] = part.split('=');
    try {
      params[decodeURIComponent(k)] = decodeURIComponent(v);
    } catch {
      return null;
    }
  }
  const minor = toMinor(params.s ?? '');
  if (minor === null || minor <= 0n) return null;
  const m = /^(\d{4})(\d{2})(\d{2})/.exec(params.t ?? '');
  return { amount: minorToDecimal(minor), day: m ? `${m[1]}-${m[2]}-${m[3]}` : null };
}

/** A fiscal receipt's QR, decoded on the phone (offline too): the server makes the spending when it can. */
export async function saveReceiptQr(text: string): Promise<ReceiptJob | null> {
  const url = qrLink(text);
  if (!url) return null;
  const same = Object.values(expensesState().jobs).find((j) => j.kind === 'qr' && j.qr === url && j.state !== 'failed');
  if (same) {
    useToast.getState().show(t('exp.qr_again'), 4000);
    return same;
  }
  return queue(newJob('qr', null, url), 'exp.qr_saved');
}

/** «Убрать» on a line that could not be read: the record stays where it is. */
export function dismissJob(id: string): void {
  dropJob(id);
}

// --- the server's side ---

/** The server id of the job's record; null = the record is gone. Throws while it waits to be sent. */
async function itemIdOf(job: ReceiptJob): Promise<string | null> {
  if (job.itemId) return job.itemId;
  if (!job.recordId) return null;
  const rec = await (await getRecords()).get(job.recordId);
  if (!rec || rec.deletedAt || rec.pending.deleted !== undefined) return null;
  if (!rec.serverId) throw new Error('record_not_synced');
  patchJob(job.id, { itemId: rec.serverId });
  return rec.serverId;
}

function receiptAnswered(jobId: string, out: ReceiptOut): void {
  if (out.expense) applyServer([out.expense]);
  if (out.action) {
    rememberActions([out.action]);
    if (out.expense) expensesState().set({ createdBy: { ...expensesState().createdBy, [out.expense.id]: out.action.id } });
  }
  if (out.duplicate) putDuplicates([out.duplicate]);
  if (out.status === 'ok' || out.status === 'exists') {
    patchJob(jobId, { state: 'done', expenseIds: out.expense ? [out.expense.id] : [], itemId: out.expense?.item_id ?? expensesState().jobs[jobId]?.itemId ?? null, message: null });
    if (out.status === 'exists') useToast.getState().show(t('exp.receipt_exists'), 4000);
    return;
  }
  if (out.status === 'form') {
    patchJob(jobId, { state: 'form', draft: out.draft, message: out.message ?? t('exp.receipt_form') });
    return;
  }
  // `waiting`: the text is not read yet; the outbox asks again after `retry_after` (2 s).
  patchJob(jobId, { state: 'reading' });
  throw new ApiError(503, { code: 'receipt_waiting', retry_after: out.retry_after ?? 2 });
}

function jobRefused(jobId: string, err: unknown, kind: ReceiptJob['kind']): void {
  const fallback = kind === 'statement' ? 'exp.statement_failed' : kind === 'qr' ? 'exp.qr_failed' : 'exp.receipt_failed';
  patchJob(jobId, { state: 'failed', message: serverWords(err) ?? t(fallback) });
}

async function sendReceipt(e: OutboxEntry): Promise<void> {
  const { jobId } = e.payload as ReceiptPayload;
  const job = expensesState().jobs[jobId];
  if (!job || (job.state !== 'waiting' && job.state !== 'reading')) return;
  let out: ReceiptOut;
  try {
    if (job.kind === 'qr') out = await getApi().expenseFromQr({ client_id: job.id, url: job.qr ?? '', item_id: null });
    else {
      const itemId = await itemIdOf(job);
      if (!itemId) return dropJob(jobId);
      out = await getApi().expenseFromItem({ client_id: job.id, item_id: itemId, kind: job.kind === 'photo' ? 'receipt' : 'shared_receipt', save: true });
    }
  } catch (err) {
    if (!isRetryable(err)) jobRefused(jobId, err, job.kind);
    throw err;
  }
  receiptAnswered(jobId, out);
}

async function sendStatement(e: OutboxEntry): Promise<void> {
  const { jobId } = e.payload as ReceiptPayload;
  const job = expensesState().jobs[jobId];
  if (!job || job.state !== 'waiting') return;
  try {
    const itemId = await itemIdOf(job);
    if (!itemId) return dropJob(jobId);
    const out = await getApi().createStatement({ client_id: job.id, item_id: itemId });
    if (!out.statement) throw new ApiError(502, { code: 'bad_answer' });
    putStatements([out.statement]);
    patchJob(jobId, { state: 'done', statementId: out.statement.id });
  } catch (err) {
    if (!isRetryable(err)) jobRefused(jobId, err, 'statement');
    throw err;
  }
}

/** Spendings from /sync: a job they answer (by its record, or by the call's `client_id`) is done. */
export function settleJobs(entries: readonly ExpenseOut[]): void {
  const open = Object.values(expensesState().jobs).filter((j) => j.kind !== 'statement' && (j.state === 'reading' || j.state === 'waiting'));
  if (open.length === 0 || entries.length === 0) return;
  for (const j of open) {
    const mine = entries.filter((e) => (j.itemId && e.item_id === j.itemId) || e.client_id === j.id);
    if (mine.length > 0) patchJob(j.id, { state: 'done', expenseIds: mine.map((e) => e.id) });
  }
}

// --- statements: the plan, «Да», «Не сейчас», «Отменить» ---

export function putStatements(list: readonly StatementOut[]): void {
  if (list.length === 0) return;
  const statements = { ...expensesState().statements };
  for (const st of list) {
    const prev = statements[st.id];
    // A decision taken here wins over an older copy that still says `proposed`.
    if (prev && prev.status !== 'proposed' && st.status === 'proposed') continue;
    statements[st.id] = st;
  }
  expensesState().set({ statements });
  notifyDataChanged();
}

/**
 * A plan made on another phone (or before this phone kept its copy) comes in /sync as a pending action
 * `import_statement` (expenses.md): its preview has the statement id and the counts; the plan screen
 * loads the rest (GET /expenses/statements/{id}). A closed one closes the phone's copy.
 */
export function putPendingPlans(list: readonly PendingActionOut[]): void {
  const s = expensesState();
  const add: StatementOut[] = [];
  for (const p of list) {
    if (p.kind !== 'import_statement') continue;
    const v = p.preview;
    const id = typeof v.statement_id === 'string' ? v.statement_id : null;
    if (!id) continue;
    const known = s.statements[id];
    const n = (x: unknown) => (typeof x === 'number' ? x : 0);
    if (p.status !== 'proposed') {
      if (known?.status === 'proposed') markStatement(id, { status: p.status === 'executed' ? 'confirmed' : p.status === 'rejected' ? 'rejected' : 'expired' });
      continue;
    }
    if (known) continue;
    add.push({
      id,
      client_id: null,
      item_id: null,
      status: 'proposed',
      bank: null,
      parser: null,
      currency: 'KZT',
      period_from: null,
      period_to: null,
      rows_found: n(v.rows_found),
      rows_new: n(v.rows_new),
      rows_existing: n(v.rows_existing),
      rows_similar: 0,
      check: null,
      adds: null,
      summary_ru: typeof v.text_ru === 'string' ? v.text_ru : null,
      error: null,
      pending_action_id: p.id,
      action_id: null,
      created_at: p.created_at,
      decided_at: null,
    });
  }
  putStatements(add);
}

/** «Расходы» opens (online): the latest plans (another phone may have brought one). */
export async function refreshStatements(): Promise<void> {
  if (!canSend() || syncBlocked()) return;
  try {
    putStatements(await getApi().statements());
  } catch {
    // offline: the phone's copies stay
  }
}

/** Plans waiting for «Да», newest first. */
export function proposedStatements(statements: Record<string, StatementOut>): StatementOut[] {
  return Object.values(statements)
    .filter((s) => s.status === 'proposed')
    .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
}

export type Adds = { expense: bigint; refund: bigint; income: bigint; transfers: bigint; transfer_own: bigint };

export type PlanNumbers = {
  found: number;
  already: number;
  add: number;
  /** What «Да» adds (the server's `adds`, counted by `calc.py`; the phone's count of the rows when there are none). */
  adds: Adds | null;
  /** «Потрачено» of the plan: expense − refund. */
  spent: bigint | null;
  /** The phone counted the rows with `calc.ts`: null = no rows here; else equal to the server's to the tiyn. */
  matches: boolean | null;
};

const ZERO: Adds = { expense: 0n, refund: 0n, income: 0n, transfers: 0n, transfer_own: 0n };

/**
 * The rows «Да» adds (new and similar), in tiyn, by the server's buckets (`imports._adds`): a row of
 * «Переводы» is `transfers` whatever its sign; the rest by direction. Exact integers, never floats.
 */
export function countRows(rows: readonly StatementRowOut[]): Adds {
  const out = { ...ZERO };
  for (const r of rows) {
    if (r.state === 'existing') continue;
    const m = toMinor(r.amount) ?? 0n;
    if (r.category_key === TRANSFERS_KEY) out.transfers += m;
    else if (r.direction === 'transfer_own') out.transfer_own += m;
    else out[r.direction] += m;
  }
  return out;
}

export function planNumbers(st: StatementOut, rows: readonly StatementRowOut[] | null = null): PlanNumbers {
  const found = st.rows_found || rows?.length || 0;
  const already = st.rows_existing || rows?.filter((r) => r.state === 'existing').length || 0;
  const add = st.rows_new || Math.max(0, found - already);
  const adds: Adds | null = st.adds
    ? {
        expense: toMinor(st.adds.expense) ?? 0n,
        refund: toMinor(st.adds.refund) ?? 0n,
        income: toMinor(st.adds.income) ?? 0n,
        transfers: toMinor(st.adds.transfers) ?? 0n,
        transfer_own: toMinor(st.adds.transfer_own) ?? 0n,
      }
    : null;
  let matches: boolean | null = null;
  if (rows && rows.length > 0 && adds) {
    const mine = countRows(rows);
    matches = (Object.keys(ZERO) as (keyof Adds)[]).every((k) => mine[k] === adds[k]);
  }
  const base = adds ?? (rows && rows.length > 0 ? countRows(rows) : null);
  return { found, already, add, adds: base, spent: base ? base.expense - base.refund : null, matches };
}

/** GET /expenses/statements/{id}: the plan now and its rows (only while it waits for «Да»). */
export async function loadStatement(id: string): Promise<{ statement: StatementOut | null; rows: StatementRowOut[] | null }> {
  try {
    const out = await getApi().getStatement(id);
    if (out.statement) putStatements([out.statement]);
    return { statement: expensesState().statements[id] ?? out.statement, rows: out.rows };
  } catch {
    return { statement: expensesState().statements[id] ?? null, rows: null };
  }
}

function markStatement(id: string, p: Partial<StatementOut>): void {
  const st = expensesState().statements[id];
  if (!st) return;
  expensesState().set({ statements: { ...expensesState().statements, [id]: { ...st, ...p } } });
  notifyDataChanged();
}

export type PlanResult = 'done' | 'offline' | 'expired' | 'failed';

/** The one «Да»: the server writes the new operations in one batch; the strip has its one «Отменить». */
export async function confirmStatement(id: string): Promise<PlanResult> {
  const st = expensesState().statements[id];
  if (!st || st.status !== 'proposed') return 'failed';
  try {
    const out = await getApi().confirmStatement(id, newId());
    if (out.statement) putStatements([out.statement]);
    const action = out.action;
    if (action) rememberActions([action]);
    markStatement(id, { status: 'confirmed', action_id: action?.id ?? out.statement?.action_id ?? st.action_id });
    if (out.duplicates.length > 0) putDuplicates(out.duplicates);
    const n = out.created || planNumbers(st).add;
    const strip = t('exp.statement_added', { count: n });
    if (action) useUndo.getState().showCustom(strip, () => void undoStatement(id));
    else useToast.getState().show(strip, 4000);
    kick();
    return 'done';
  } catch (e) {
    if (offline(e)) return 'offline';
    if (e instanceof ApiError && (e.status === 410 || e.code === 'pending_closed' || e.code === 'pending_expired')) {
      markStatement(id, { status: 'expired' });
      return 'expired';
    }
    return 'failed';
  }
}

/** «Не сейчас»: nothing was written and nothing is. The PDF stays a record, like any file brought in. */
export async function rejectStatement(id: string): Promise<PlanResult> {
  const st = expensesState().statements[id];
  if (!st) return 'failed';
  try {
    const out = await getApi().rejectStatement(id);
    markStatement(id, { ...(out ?? {}), status: 'rejected' });
    return 'done';
  } catch (e) {
    return offline(e) ? 'offline' : 'failed';
  }
}

/** «Отменить» after «Да»: the whole batch at once (one action). Its spendings leave the totals now; the server follows. */
export async function undoStatement(id: string): Promise<void> {
  const st = expensesState().statements[id];
  if (!st?.action_id) return;
  const s = expensesState();
  const edits = { ...s.edits };
  for (const e of Object.values(s.entries)) {
    if (e.statement_id !== id) continue;
    edits[e.id] = { fields: { ...edits[e.id]?.fields, deleted_at: nowIso() }, clientId: newId() };
  }
  s.set({ edits });
  markStatement(id, { status: 'undone' });
  const r = await undoServerAction(st.action_id);
  if (r.result === 'expired' || r.result === 'failed') useToast.getState().show(t('exp.undo_failed'), 4000);
  kick();
}

// --- «Объединить?» ---

/** Pairs from the server (from-item, «Да» of a plan, GET /expenses/duplicates, /sync). */
export function putDuplicates(list: readonly ExpenseDuplicateOut[], replace = false): void {
  if (list.length === 0 && !replace) return;
  const s = expensesState();
  const duplicates = replace ? {} : { ...s.duplicates };
  for (const d of list) {
    if (d.status === 'suggested') duplicates[d.id] = d;
    else delete duplicates[d.id];
  }
  s.set({ duplicates, decided: s.decided.filter((id) => duplicates[id]) });
  notifyDataChanged();
}

/** «Расходы» opens (online): the pairs the server suggests now. */
export async function refreshDuplicates(): Promise<void> {
  if (!canSend() || syncBlocked()) return;
  try {
    putDuplicates(await getApi().expenseDuplicates(), true);
  } catch {
    // offline: the pairs the phone has stay
  }
}

/** Pairs to show: suggested, both still live and shown, not decided here. */
export function visibleDuplicates(duplicates: Record<string, ExpenseDuplicateOut>, decided: readonly string[], live: readonly ExpenseOut[]): ExpenseDuplicateOut[] {
  const shown = new Map(live.map((e) => [e.id, e]));
  return Object.values(duplicates)
    .filter((d) => d.status === 'suggested' && !decided.includes(d.id) && shown.has(d.keep.id) && shown.has(d.other.id))
    .map((d) => ({ ...d, keep: shown.get(d.keep.id)!, other: shown.get(d.other.id)! }))
    .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
}

function decide(id: string, on: boolean): void {
  const s = expensesState();
  s.set({ decided: on ? [...s.decided.filter((x) => x !== id), id] : s.decided.filter((x) => x !== id) });
  notifyDataChanged();
}

/** [Объединить]: needs the internet; then «Объединил траты: 2 500 ₸ [Отменить]». */
export async function mergeDuplicate(d: ExpenseDuplicateOut): Promise<PlanResult> {
  decide(d.id, true);
  try {
    const out = await getApi().mergeExpenseDuplicate(d.id, { client_id: newId() });
    if (out.expense) applyServer([out.expense]);
    // The other one went to the trash with its record: gone from the totals now; /sync brings the rest.
    const s = expensesState();
    const otherKey = resolveKey(d.other.id);
    if (s.entries[otherKey]) s.set({ edits: { ...s.edits, [otherKey]: { fields: { ...s.edits[otherKey]?.fields, deleted_at: nowIso() }, clientId: newId() } } });
    putDuplicates(out.duplicate ? [out.duplicate] : [{ ...d, status: 'merged' }]);
    const strip = t('exp.merged', { amount: formatAmount(d.keep.amount, d.keep.currency) });
    if (out.action) {
      rememberActions([out.action]);
      const actionId = out.action.id;
      useUndo.getState().showCustom(strip, () => void undoMerge(actionId, otherKey));
    } else useToast.getState().show(strip, 4000);
    notifyDataChanged();
    kick();
    return 'done';
  } catch (e) {
    decide(d.id, false);
    if (offline(e)) return 'offline';
    if (e instanceof ApiError && (e.code === 'duplicate_closed' || e.code === 'duplicate_stale' || e.status === 404)) {
      putDuplicates([{ ...d, status: 'dismissed' }]);
      return 'expired';
    }
    return 'failed';
  }
}

async function undoMerge(actionId: string, otherKey: string): Promise<void> {
  const s = expensesState();
  const edit = s.edits[otherKey];
  if (edit) {
    const fields = { ...edit.fields };
    delete fields.deleted_at;
    const edits = { ...s.edits };
    if (Object.keys(fields).length > 0) edits[otherKey] = { ...edit, fields };
    else delete edits[otherKey];
    s.set({ edits });
    notifyDataChanged();
  }
  const r = await undoServerAction(actionId);
  if (r.result === 'expired' || r.result === 'failed') useToast.getState().show(t('exp.undo_failed'), 4000);
  kick();
}

/**
 * [Это разные]: hidden at once and not suggested again. Nothing changes in the spendings, so the
 * server keeps no action for it: «Отменить» shows the pair again here (the server's dismissal stays).
 */
export async function dismissDuplicate(d: ExpenseDuplicateOut): Promise<PlanResult> {
  decide(d.id, true);
  try {
    await getApi().dismissExpenseDuplicate(d.id, newId());
    useUndo.getState().showCustom(t('exp.not_same'), () => decide(d.id, false));
    return 'done';
  } catch (e) {
    decide(d.id, false);
    return offline(e) ? 'offline' : 'failed';
  }
}

export const receiptSink = {
  send: (e: OutboxEntry): Promise<void> => (e.kind === 'expense.statement' ? sendStatement(e) : sendReceipt(e)),
};
