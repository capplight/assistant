import { ApiError, isRetryable } from '@/api/errors';
import type { ExpenseCategoryOut, ExpenseCreateIn, ExpenseOut, ExpensePatchIn, ExpenseWriteOut } from '@/api/types';
import { getOutbox, type OutboxEntry } from '@/db';
import i18n from '@/i18n';
import { getApi, getSyncEngine, kickSync, notifyDataChanged, syncBlocked } from '@/services';
import { useOnboarding } from '@/store/onboarding';
import { useToast } from '@/store/toast';
import { useUndo } from '@/store/undo';
import { undoServerAction } from '@/tasks/actions';
import { rememberActions } from '@/tasks/service';
import { newId } from '@/utils/id';

import { minorToDecimal } from './calc';
import type { Category } from './categories';
import { expensesState, LOCAL_EXPENSE, shownExpense, type ExpenseEdit } from './store';

/**
 * Week 12 (template-screens 2.2, docs/api/expenses.md): every change of a spending by hand — the
 * keypad's «Записать», a category, the amount, the date, «Верно», «Удалить», the order of the
 * chips. Shown at once, offline and in «Без ИИ» too (written to the store first), sent through the
 * outbox in tap order, each with «Отменить»: still waiting → the row is dropped and nothing goes;
 * sent → the undo of its action on the server (actions.md), the old state shown at once.
 */

const nowIso = () => new Date().toISOString();
const canSend = () => useOnboarding.getState().consent !== null;
const kick = () => {
  if (!syncBlocked()) kickSync();
};

/** `categoryKey`: the chip; its server id is looked up when it goes (the person's categories may not be on the phone yet). */
export type CreatePayload = { key: string; body: ExpenseCreateIn; categoryKey: string | null; actionId?: string | null };
/** `fields`: the entry fields as shown; `before`: the same keys as they were. */
export type PatchPayload = { key: string; clientId: string; fields: Partial<ExpenseOut>; before: Partial<ExpenseOut>; actionId?: string | null };
export type DeletePayload = { key: string; clientId: string; actionId?: string | null };
export type OrderPayload = { clientId: string; keys: string[]; before: string[] | null; actionId?: string | null };

/** A local key or a server id → the entry's key in the store now. */
export const resolveKey = (key: string): string => expensesState().aliases[key] ?? key;

function setEdit(key: string, edit: ExpenseEdit | null): void {
  const edits = { ...expensesState().edits };
  if (edit) edits[key] = edit;
  else delete edits[key];
  expensesState().set({ edits });
}

/** The edit of `clientId` is answered: it goes, unless a newer tap is on top of it. */
function settleEdit(key: string, clientId: string): void {
  const k = resolveKey(key);
  if (expensesState().edits[k]?.clientId === clientId) setEdit(k, null);
}

/** Put fields back on top of what is shown (an «Отменить» of the person's own change). */
function overlay(key: string, fields: Partial<ExpenseOut>, clientId: string): void {
  const k = resolveKey(key);
  const prev = expensesState().edits[k];
  setEdit(k, { fields: { ...prev?.fields, ...fields }, clientId });
}

export type NewExpense = {
  minor: bigint;
  /** The keypad text of a compound sum («1200+350»), else null. */
  expression: string | null;
  category: Pick<Category, 'key' | 'id'> | null;
  spentOn: string;
  note?: string | null;
  currency?: string;
};

/** «Записать»: the entry is on the page and in the totals at once; returns its key. */
export async function addExpense(x: NewExpense, stripText: string): Promise<string> {
  const clientId = newId();
  const key = `${LOCAL_EXPENSE}${clientId}`;
  const at = nowIso();
  const amount = minorToDecimal(x.minor);
  // Keys: the expression goes and the server computes the amount from it (both would have to agree).
  const body: ExpenseCreateIn = {
    client_id: clientId,
    ...(x.expression ? { expression: x.expression } : { amount }),
    currency: x.currency ?? 'KZT',
    spent_on: x.spentOn,
    category_id: x.category?.id ?? null,
    note: x.note ?? null,
    direction: 'expense',
    source: 'form',
  };
  const entry: ExpenseOut = {
    id: key,
    client_id: clientId,
    item_id: null,
    amount,
    currency: body.currency,
    expression: x.expression,
    spent_on: body.spent_on,
    category_id: body.category_id,
    category_key: x.category?.key ?? null,
    payee: null,
    method: null,
    direction: 'expense',
    note: body.note ?? null,
    source: 'form',
    parse_source: null,
    review_fields: [],
    line_items: null,
    statement_id: null,
    ai_generated: false,
    version: 0,
    seq: 0,
    created_at: at,
    updated_at: at,
    deleted_at: null,
  };
  expensesState().set({ entries: { ...expensesState().entries, [key]: entry } });
  notifyDataChanged();
  if (!canSend()) {
    useUndo.getState().showCustom(stripText, () => dropLocal(key));
    return key;
  }
  const row = await (await getOutbox()).enqueue('expense.create', { key, body, categoryKey: x.category?.key ?? null } satisfies CreatePayload);
  useUndo.getState().showCustom(stripText, () => void undoCreate(row.id));
  kick();
  return key;
}

function dropLocal(key: string): void {
  const entries = { ...expensesState().entries };
  delete entries[resolveKey(key)];
  expensesState().set({ entries });
  setEdit(resolveKey(key), null);
  notifyDataChanged();
}

async function withRow<T>(rowId: string, f: (row: OutboxEntry) => Promise<T>): Promise<T | undefined> {
  const engine = await getSyncEngine();
  await engine.hold(rowId);
  try {
    const row = await (await getOutbox()).get(rowId);
    if (!row || row.status === 'failed') return undefined;
    return await f(row);
  } finally {
    engine.release(rowId);
    kick();
  }
}

async function undoCreate(rowId: string): Promise<void> {
  await withRow(rowId, async (row) => {
    const p = row.payload as CreatePayload;
    if (row.status === 'pending') {
      await (await getOutbox()).markFailed(row.id, 'undone'); // never sent: it does not go
      dropLocal(p.key);
      return;
    }
    await takeBack(p.key, p.actionId ?? expensesState().createdBy[resolveKey(p.key)] ?? null);
  });
}

/** A sent entry goes away: the undo of its action, or (an older server, no action) a deletion. */
async function takeBack(key: string, actionId: string | null): Promise<void> {
  const clientId = newId();
  overlay(key, { deleted_at: nowIso() }, clientId);
  notifyDataChanged();
  if (actionId) {
    const r = await undoServerAction(actionId);
    if (r.result === 'expired' || r.result === 'failed') {
      settleEdit(key, clientId);
      useToast.getState().show(i18n.t('exp.undo_failed'), 4000);
    }
    return;
  }
  await (await getOutbox()).enqueue('expense.delete', { key, clientId } satisfies DeletePayload);
}

export type ExpenseChange = Partial<Pick<ExpenseOut, 'amount' | 'spent_on' | 'category_id' | 'category_key' | 'expression' | 'review_fields' | 'payee'>>;

function currentOf(key: string): ExpenseOut | null {
  const s = expensesState();
  const e = s.entries[resolveKey(key)];
  return e ? shownExpense(e, s.edits) : null;
}

/** One change by hand (category, amount, date, «Верно»); null when nothing changed. */
export async function changeExpense(key: string, change: ExpenseChange, stripText: string): Promise<string | null> {
  const now = currentOf(key);
  if (!now) return null;
  const before: Partial<ExpenseOut> = {};
  for (const k of Object.keys(change) as (keyof ExpenseChange)[]) (before as Record<string, unknown>)[k] = now[k];
  if (JSON.stringify(before) === JSON.stringify(change)) return null;
  const clientId = newId();
  overlay(key, change, clientId);
  notifyDataChanged();
  if (!canSend()) {
    // Nothing to send to: the change lives on the phone, «Отменить» puts it back.
    useUndo.getState().showCustom(stripText, () => {
      overlay(key, before, newId());
      notifyDataChanged();
    });
    return null;
  }
  const payload: PatchPayload = { key, clientId, fields: change, before };
  const row = await (await getOutbox()).enqueue('expense.patch', payload);
  useUndo.getState().showCustom(stripText, () => void undoChange(row.id));
  kick();
  return row.id;
}

async function undoChange(rowId: string): Promise<void> {
  await withRow(rowId, async (row) => {
    const p = row.payload as PatchPayload;
    const outbox = await getOutbox();
    if (row.status === 'pending') {
      await outbox.markFailed(row.id, 'undone');
      const k = resolveKey(p.key);
      const edit = expensesState().edits[k];
      if (edit?.clientId === p.clientId) setEdit(k, null);
      else overlay(p.key, p.before, edit?.clientId ?? newId());
      notifyDataChanged();
      return;
    }
    const clientId = newId();
    overlay(p.key, p.before, clientId);
    notifyDataChanged();
    if (p.actionId) {
      const r = await undoServerAction(p.actionId);
      if (r.result === 'expired' || r.result === 'failed') settleEdit(p.key, clientId);
      return;
    }
    await outbox.enqueue('expense.patch', { key: p.key, clientId, fields: p.before, before: p.fields } satisfies PatchPayload);
  });
}

/** «Удалить»: gone from the page and the totals at once; the record goes to «Удалённые записи» on the server. */
export async function deleteExpense(key: string, stripText: string): Promise<void> {
  const now = currentOf(key);
  if (!now || now.deleted_at) return;
  const clientId = newId();
  overlay(key, { deleted_at: nowIso() }, clientId);
  notifyDataChanged();
  const back = () => {
    overlay(key, { deleted_at: null }, newId());
    notifyDataChanged();
  };
  if (!canSend()) {
    useUndo.getState().showCustom(stripText, back);
    return;
  }
  const row = await (await getOutbox()).enqueue('expense.delete', { key, clientId } satisfies DeletePayload);
  useUndo.getState().showCustom(stripText, () => void undoDelete(row.id, back));
  kick();
}

async function undoDelete(rowId: string, back: () => void): Promise<void> {
  await withRow(rowId, async (row) => {
    const p = row.payload as DeletePayload;
    if (row.status === 'pending') {
      await (await getOutbox()).markFailed(row.id, 'undone');
      settleEdit(p.key, p.clientId);
      notifyDataChanged();
      return;
    }
    back();
    if (p.actionId) await undoServerAction(p.actionId);
  });
}

/** «Порядок»: the chips in the person's order (template-screens 2.2: the order is theirs). */
export async function reorderCategories(keys: string[], before: string[] | null, stripText: string): Promise<void> {
  const clientId = newId();
  expensesState().set({ orderEdit: { keys, clientId } });
  if (!canSend()) {
    useUndo.getState().showCustom(stripText, () => expensesState().set({ orderEdit: before ? { keys: before, clientId: newId() } : null }));
    return;
  }
  const row = await (await getOutbox()).enqueue('expense.categories', { clientId, keys, before } satisfies OrderPayload);
  useUndo.getState().showCustom(stripText, () => void undoOrder(row.id));
  kick();
}

async function undoOrder(rowId: string): Promise<void> {
  await withRow(rowId, async (row) => {
    const p = row.payload as OrderPayload;
    const outbox = await getOutbox();
    if (row.status === 'pending') {
      await outbox.markFailed(row.id, 'undone');
      if (expensesState().orderEdit?.clientId === p.clientId) expensesState().set({ orderEdit: p.before ? { keys: p.before, clientId: newId() } : null });
      return;
    }
    if (!p.before) {
      // The first order the person set: the undo of its action brings «by use» back.
      expensesState().set({ orderEdit: null });
      if (p.actionId) await undoServerAction(p.actionId);
      return;
    }
    const clientId = newId();
    expensesState().set({ orderEdit: { keys: p.before, clientId } });
    if (p.actionId) {
      await undoServerAction(p.actionId);
      return;
    }
    await outbox.enqueue('expense.categories', { clientId, keys: p.before, before: p.keys } satisfies OrderPayload);
  });
}

// --- the server's side: /sync and the answers of the outbox (src/sync/engine.ts) ---

/** Fields of an edit the server's copy already has: the edit is no longer needed. */
function editDone(e: ExpenseOut, edit: ExpenseEdit): boolean {
  return Object.entries(edit.fields).every(([k, v]) => JSON.stringify((e as Record<string, unknown>)[k] ?? null) === JSON.stringify(v ?? null));
}

/** Entries and categories from /sync or an answer: newer `seq` wins; a local entry becomes its server one. */
export function applyServer(entries: ExpenseOut[], categories: ExpenseCategoryOut[] = []): void {
  if (entries.length === 0 && categories.length === 0) return;
  const s = expensesState();
  const next = { ...s.entries };
  const aliases = { ...s.aliases };
  const edits = { ...s.edits };
  const createdBy = { ...s.createdBy };
  for (const e of entries) {
    const local = e.client_id ? `${LOCAL_EXPENSE}${e.client_id}` : null;
    if (local && next[local]) {
      delete next[local];
      aliases[local] = e.id;
      if (edits[local]) {
        edits[e.id] = edits[local]!;
        delete edits[local];
      }
      if (createdBy[local]) {
        createdBy[e.id] = createdBy[local]!;
        delete createdBy[local];
      }
    } else if (local) aliases[local] = e.id;
    const prev = next[e.id];
    if (prev && prev.seq > e.seq && e.seq > 0) continue;
    next[e.id] = e;
    const edit = edits[e.id];
    if (edit && editDone(e, edit)) delete edits[e.id];
  }
  const cats = { ...s.categories };
  for (const c of categories) {
    const prev = cats[c.key];
    if (!prev || prev.seq <= c.seq) cats[c.key] = c;
  }
  s.set({ entries: next, aliases, edits, createdBy, categories: cats });
}

/** /sync tombstone of an entry (purged after the trash). */
export function applyTombstone(id: string): void {
  const entries = { ...expensesState().entries };
  if (!entries[id]) return;
  delete entries[id];
  expensesState().set({ entries });
}

function answered(out: ExpenseWriteOut): void {
  if (out.expense) applyServer([out.expense]);
  if (out.action) rememberActions([out.action]);
}

/**
 * The server id of the person's category: from the store, else asked once (the server makes the
 * person's copy of the 8 on first use). null = no such category there: the expense goes without one.
 */
async function categoryIdOf(key: string | null): Promise<string | null> {
  if (!key) return null;
  const known = expensesState().categories[key]?.id;
  if (known) return known;
  const list = await getApi().expenseCategories();
  applyServer([], list.categories);
  return expensesState().categories[key]?.id ?? null;
}

async function sendCreate(e: OutboxEntry): Promise<void> {
  const p = e.payload as CreatePayload;
  if (!expensesState().entries[resolveKey(p.key)]) return; // taken back meanwhile
  let out: ExpenseWriteOut;
  try {
    const categoryId = p.body.category_id ?? (await categoryIdOf(p.categoryKey));
    out = await getApi().createExpense({ ...p.body, category_id: categoryId });
  } catch (err) {
    if (!isRetryable(err)) refused(p.key, err, true);
    throw err;
  }
  answered(out);
  if (out.action && out.expense) expensesState().set({ createdBy: { ...expensesState().createdBy, [out.expense.id]: out.action.id } });
  await (await getOutbox()).updatePayload(e.id, { ...p, actionId: out.action?.id ?? null } satisfies CreatePayload);
}

/** The server id of an entry; null = it never reached the server (nothing to send). Throws while its create is waiting. */
function serverIdOf(key: string): string | null {
  const k = resolveKey(key);
  if (!k.startsWith(LOCAL_EXPENSE)) return k;
  if (expensesState().entries[k]) throw new Error('expense_not_synced');
  return null;
}

async function patchBody(clientId: string, f: Partial<ExpenseOut>, entry: ExpenseOut | undefined, before: Partial<ExpenseOut> = {}): Promise<ExpensePatchIn> {
  const body: ExpensePatchIn = { client_id: clientId };
  if (entry && entry.version > 0) body.version = entry.version;
  if ('amount' in f && f.amount) body.amount = f.amount;
  if ('spent_on' in f && f.spent_on) body.spent_on = f.spent_on;
  if ('category_key' in f) body.category_id = f.category_id ?? (await categoryIdOf(f.category_key ?? null));
  if ('expression' in f) body.expression = f.expression ?? null;
  if ('payee' in f) body.payee = f.payee ?? null;
  // «Верно» (expenses.md): `confirm: [...]` = the fields no longer «Проверьте» (week 13: also `spent_on`,
  // `payee`, `line_items`); a field changed by hand clears its «Проверьте» by itself, so it is not sent.
  if ('review_fields' in f) {
    const now = f.review_fields ?? [];
    const was = before.review_fields ?? entry?.review_fields ?? ['amount'];
    const confirm = was.filter((k) => !now.includes(k) && !(k in f));
    if (confirm.length > 0) body.confirm = confirm;
  }
  return body;
}

async function sendPatch(e: OutboxEntry): Promise<void> {
  const p = e.payload as PatchPayload;
  const id = serverIdOf(p.key);
  if (!id) return settleEdit(p.key, p.clientId);
  let out: ExpenseWriteOut;
  try {
    out = await getApi().patchExpense(id, await patchBody(p.clientId, p.fields, expensesState().entries[id], p.before));
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      // Changed on another phone meanwhile: the person's tap still wins, once, on the server's version.
      const version = (err.details as { version?: unknown } | undefined)?.version;
      const base = expensesState().entries[id];
      const fresh = base && typeof version === 'number' ? { ...base, version } : undefined;
      out = await getApi().patchExpense(id, await patchBody(p.clientId, p.fields, fresh, p.before));
    } else {
      if (!isRetryable(err)) refused(p.key, err, false, p.clientId);
      throw err;
    }
  }
  answered(out);
  settleEdit(p.key, p.clientId);
  await (await getOutbox()).updatePayload(e.id, { ...p, actionId: out.action?.id ?? null } satisfies PatchPayload);
}

async function sendDelete(e: OutboxEntry): Promise<void> {
  const p = e.payload as DeletePayload;
  const id = serverIdOf(p.key);
  if (!id) return;
  let out: ExpenseWriteOut;
  try {
    out = await getApi().deleteExpense(id, p.clientId);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      settleEdit(p.key, p.clientId);
      return; // already gone there
    }
    if (!isRetryable(err)) refused(p.key, err, false, p.clientId);
    throw err;
  }
  answered(out);
  settleEdit(p.key, p.clientId);
  await (await getOutbox()).updatePayload(e.id, { ...p, actionId: out.action?.id ?? null } satisfies DeletePayload);
}

async function sendOrder(e: OutboxEntry): Promise<void> {
  const p = e.payload as OrderPayload;
  const ids: string[] = [];
  for (const k of p.keys) {
    const id = await categoryIdOf(k);
    if (id) ids.push(id);
  }
  const out = await getApi().reorderExpenseCategories({ client_id: p.clientId, ids });
  applyServer([], out.categories);
  if (out.action) rememberActions([out.action]);
  if (expensesState().orderEdit?.clientId === p.clientId && out.categories.length > 0) expensesState().set({ orderEdit: null });
  await (await getOutbox()).updatePayload(e.id, { ...p, actionId: out.action?.id ?? null } satisfies OrderPayload);
}

/** Refused for good: the server's copy shows again (a new entry that was refused goes) and the person is told. */
function refused(key: string, err: unknown, created: boolean, clientId?: string): void {
  if (created) dropLocal(key);
  else if (clientId) settleEdit(key, clientId);
  const code = err instanceof ApiError ? err.code : '';
  useToast.getState().show(i18n.t(code === 'validation_error' ? 'exp.refused_amount' : 'exp.refused'), 4000);
  notifyDataChanged();
}

export const expenseSink = {
  send: (e: OutboxEntry): Promise<void> => {
    switch (e.kind) {
      case 'expense.create':
        return sendCreate(e);
      case 'expense.patch':
        return sendPatch(e);
      case 'expense.delete':
        return sendDelete(e);
      default:
        return sendOrder(e);
    }
  },
  apply: (x: { entries: ExpenseOut[]; categories: ExpenseCategoryOut[] }) => applyServer(x.entries, x.categories),
  tombstone: applyTombstone,
};
