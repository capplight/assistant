import type { ItemKind, ItemOut, ItemSource, ReviewFieldOut } from '@/api/types';

import type { SqlDb } from './outbox';

/**
 * Local mirror of `items` (3-engineering §3.3): what the person saved on this phone plus what
 * arrived via GET /sync. The local id is the item's `client_id`.
 * Status: `queued` = only on this phone («Ждёт связи»); otherwise the server status.
 *
 * Columns hold the server's state; `pending` is the overlay of changes still in the outbox
 * («Верно», «Исправить», «Отменить», «Удалить», «Вернуть»). A delta from /sync never undoes what the person just did, and a change
 * the server rejected disappears by clearing the overlay.
 */
export type RecordStatus = 'queued' | ItemOut['status'];

export type RecordFile = {
  /** Local copy in the app's document directory (share cache / recorder cache can be cleared). */
  uri: string;
  mime: string;
  bytes: number;
  sha256: string;
  name?: string;
  /** Voice fragment length. */
  durationMs?: number;
};

export type RecordPending = {
  /** Field key → the exact value the person confirmed with «Верно». */
  verify?: Record<string, string | null>;
  /** «Отменить» on an automatic merge is on its way. */
  unmerge?: boolean;
  /** Field key → the value the person typed with «Исправить». */
  corrected?: Record<string, string>;
  /** «Удалить» is on its way: when it was pressed (ms). */
  deleted?: number;
  /** «Вернуть» is on its way. */
  restored?: boolean;
};

export type LocalRecord = {
  id: string;
  serverId: string | null;
  kind: ItemKind;
  source: ItemSource | string;
  status: RecordStatus;
  title: string | null;
  text: string | null;
  summary: string | null;
  url: string | null;
  files: RecordFile[];
  pageId: string | null;
  reviewFields: Record<string, ReviewFieldOut>;
  aiGenerated: boolean;
  hiddenReason: string | null;
  canonicalId: string | null;
  error: string | null;
  pending: RecordPending;
  seq: number;
  occurredAt: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
  /** Server's end of the 30 days in «Удалённые записи». */
  purgeAfter: number | null;
};

export type NewRecord = Pick<LocalRecord, 'kind' | 'source'> &
  Partial<Pick<LocalRecord, 'id' | 'title' | 'text' | 'url' | 'files' | 'pageId' | 'occurredAt'>>;

export interface RecordsRepository {
  insertLocal(r: NewRecord & { id: string }): Promise<LocalRecord>;
  get(id: string): Promise<LocalRecord | null>;
  /** Newest first, without deleted and hidden repeats. */
  list(limit?: number): Promise<LocalRecord[]>;
  /** «Удалённые записи», last deleted first: what can still be brought back. */
  listTrash(limit?: number): Promise<LocalRecord[]>;
  findByServerId(serverId: string): Promise<LocalRecord | null>;
  /** POST /items or PATCH succeeded: link the local record to the server item. */
  markSynced(id: string, item: ItemOut): Promise<void>;
  /** From GET /sync: upsert by client_id (own records) or server id (other devices). */
  applyRemote(item: ItemOut): Promise<void>;
  /** Purged for good on the server after its 30 days: nothing to bring back any more. */
  applyTombstone(serverId: string): Promise<void>;
  setPending(id: string, pending: RecordPending): Promise<void>;
  /** A record the server does not have: its trash date lives only here. null = not deleted. */
  setLocalTrash(id: string, deletedAt: number | null): Promise<void>;
  /**
   * Week 10: the phone itself found an exact repeat on save (2-design 3.x «Уже было»): the new
   * record is hidden here at once, as the server will hide it. `canonicalId`: the server id of the
   * original, when it has one.
   */
  markLocalRepeat(id: string, canonicalId: string | null): Promise<void>;
  /**
   * Another account: server ids, review marks and changes on their way mean nothing there. Records
   * stay on the phone. `requeued` go back to «Ждёт связи»; the others (deleted, repeats, nothing
   * left to send) keep their status, with no server id. Local deletions stay deleted.
   */
  detachFromAccount(requeued: ReadonlySet<string>): Promise<void>;
  getCursor(): Promise<number>;
  setCursor(seq: number): Promise<void>;
}

const CURSOR_KEY = 'sync.since';

function metaString(meta: Record<string, unknown> | undefined, key: string): string | null {
  const v = meta?.[key];
  return typeof v === 'string' && v ? v : null;
}

function fromServer(item: ItemOut, now: number, base?: LocalRecord | null): LocalRecord {
  return {
    id: base?.id ?? item.client_id ?? item.id,
    serverId: item.id,
    kind: item.kind,
    source: item.source,
    status: item.status,
    title: item.title ?? base?.title ?? null,
    // Server text wins once it has one (recognized voice / OCR); keep the local text until then.
    text: item.text ?? base?.text ?? null,
    summary: item.summary ?? null,
    url: base?.url ?? metaString(item.source_meta, 'url'),
    files: base?.files ?? [],
    pageId: base?.pageId ?? null,
    reviewFields: item.review_fields ?? base?.reviewFields ?? {},
    // Created by the assistant, or it wrote the title or summary of the person's own record.
    aiGenerated: !!item.ai_generated || (item.ai_fields?.length ?? 0) > 0,
    hiddenReason: item.hidden_reason ?? null,
    canonicalId: item.canonical_id ?? null,
    error: item.error ?? null,
    pending: base?.pending ?? {},
    seq: item.seq,
    occurredAt: item.occurred_at ?? base?.occurredAt ?? item.created_at,
    createdAt: base?.createdAt ?? (Date.parse(item.created_at) || now),
    updatedAt: now,
    deletedAt: item.deleted_at ? Date.parse(item.deleted_at) || now : null,
    purgeAfter: item.purge_after ? Date.parse(item.purge_after) || null : null,
  };
}

function newLocal(r: NewRecord & { id: string }, ts: number): LocalRecord {
  return {
    id: r.id,
    serverId: null,
    kind: r.kind,
    source: r.source,
    status: 'queued',
    title: r.title ?? null,
    text: r.text ?? null,
    summary: null,
    url: r.url ?? null,
    files: r.files ?? [],
    pageId: r.pageId ?? null,
    reviewFields: {},
    aiGenerated: false,
    hiddenReason: null,
    canonicalId: null,
    error: null,
    pending: {},
    seq: 0,
    occurredAt: r.occurredAt ?? new Date(ts).toISOString(),
    createdAt: ts,
    updatedAt: ts,
    deletedAt: null,
    purgeAfter: null,
  };
}

/** How long a deleted record can be brought back (R-33). */
export const TRASH_DAYS = 30;
const DAY_MS = 86_400_000;

/** Deleted, counting what is still on its way. */
export const isTrashed = (r: LocalRecord): boolean =>
  !r.pending.restored && (r.pending.deleted !== undefined || r.deletedAt !== null);

const trashedAt = (r: LocalRecord): number => r.pending.deleted ?? r.deletedAt ?? 0;

/** When the record is gone for good: the server's date, or 30 days from the local deletion. */
export const purgeAt = (r: LocalRecord): number => r.purgeAfter ?? trashedAt(r) + TRASH_DAYS * DAY_MS;

const isVisible = (r: LocalRecord) => !isTrashed(r) && (r.hiddenReason === null || r.pending.unmerge === true);

/** A deleted repeat was never shown as a record of its own. */
const inTrash = (r: LocalRecord, now: number) => isTrashed(r) && r.hiddenReason === null && purgeAt(r) > now;

const byTrashedAt = (a: LocalRecord, b: LocalRecord) => trashedAt(b) - trashedAt(a);

const detached = (r: LocalRecord, requeued: ReadonlySet<string>): LocalRecord => ({
  ...r,
  serverId: null,
  status: requeued.has(r.id) ? 'queued' : r.status,
  reviewFields: {},
  pending: {},
  seq: 0,
  deletedAt: r.pending.restored ? null : (r.pending.deleted ?? r.deletedAt),
  purgeAfter: null,
});

export class InMemoryRecordsRepository implements RecordsRepository {
  private rows = new Map<string, LocalRecord>();
  private cursor = 0;

  constructor(private readonly now: () => number = Date.now) {}

  async insertLocal(r: NewRecord & { id: string }): Promise<LocalRecord> {
    const existing = this.rows.get(r.id);
    if (existing) return existing; // idempotent: a retried save never duplicates
    const rec = newLocal(r, this.now());
    this.rows.set(rec.id, rec);
    return rec;
  }

  async get(id: string) {
    return this.rows.get(id) ?? null;
  }

  async list(limit = 200) {
    return [...this.rows.values()]
      .filter(isVisible)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  async listTrash(limit = 200) {
    const now = this.now();
    return [...this.rows.values()]
      .filter((r) => inTrash(r, now))
      .sort(byTrashedAt)
      .slice(0, limit);
  }

  async detachFromAccount(requeued: ReadonlySet<string>) {
    for (const r of this.rows.values()) {
      if (r.serverId !== null || Object.keys(r.pending).length > 0) this.rows.set(r.id, detached(r, requeued));
    }
  }

  async findByServerId(serverId: string) {
    return [...this.rows.values()].find((r) => r.serverId === serverId) ?? null;
  }

  async markSynced(id: string, item: ItemOut) {
    const base = this.rows.get(id);
    this.rows.set(id, { ...fromServer(item, this.now(), base), id });
  }

  async applyRemote(item: ItemOut) {
    const base =
      (item.client_id ? this.rows.get(item.client_id) : undefined) ?? (await this.findByServerId(item.id));
    if (base && base.seq > item.seq) return; // older delta
    const rec = fromServer(item, this.now(), base);
    this.rows.set(rec.id, rec);
  }

  async applyTombstone(serverId: string) {
    for (const r of this.rows.values()) if (r.serverId === serverId) this.rows.delete(r.id);
  }

  async setPending(id: string, pending: RecordPending) {
    const r = this.rows.get(id);
    if (r) this.rows.set(id, { ...r, pending });
  }

  async setLocalTrash(id: string, deletedAt: number | null) {
    const r = this.rows.get(id);
    if (r) this.rows.set(id, { ...r, deletedAt, purgeAfter: null });
  }

  async markLocalRepeat(id: string, canonicalId: string | null) {
    const r = this.rows.get(id);
    if (r) this.rows.set(id, { ...r, hiddenReason: 'duplicate_merged', canonicalId });
  }

  async getCursor() {
    return this.cursor;
  }

  async setCursor(seq: number) {
    this.cursor = seq;
  }
}

type Row = {
  id: string;
  server_id: string | null;
  kind: ItemKind;
  source: string;
  status: RecordStatus;
  title: string | null;
  text: string | null;
  summary: string | null;
  url: string | null;
  files: string;
  page_id: string | null;
  review_fields: string;
  ai_generated: number;
  hidden_reason: string | null;
  canonical_id: string | null;
  error: string | null;
  pending: string;
  seq: number;
  occurred_at: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  purge_after: number | null;
};

const rowTo = (r: Row): LocalRecord => ({
  id: r.id,
  serverId: r.server_id,
  kind: r.kind,
  source: r.source,
  status: r.status,
  title: r.title,
  text: r.text,
  summary: r.summary,
  url: r.url,
  files: JSON.parse(r.files || '[]') as RecordFile[],
  pageId: r.page_id,
  reviewFields: JSON.parse(r.review_fields || '{}') as Record<string, ReviewFieldOut>,
  aiGenerated: !!r.ai_generated,
  hiddenReason: r.hidden_reason,
  canonicalId: r.canonical_id,
  error: r.error,
  pending: JSON.parse(r.pending || '{}') as RecordPending,
  seq: r.seq,
  occurredAt: r.occurred_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  deletedAt: r.deleted_at,
  purgeAfter: r.purge_after,
});

const COLS =
  'id, server_id, kind, source, status, title, text, summary, url, files, page_id, review_fields, ai_generated, ' +
  'hidden_reason, canonical_id, error, pending, seq, occurred_at, created_at, updated_at, deleted_at, purge_after';

export class SqliteRecordsRepository implements RecordsRepository {
  constructor(
    private readonly db: SqlDb,
    private readonly now: () => number = Date.now,
  ) {}

  private async write(r: LocalRecord, mode: 'INSERT OR IGNORE' | 'INSERT OR REPLACE') {
    await this.db.runAsync(
      `${mode} INTO records (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      r.id,
      r.serverId,
      r.kind,
      r.source,
      r.status,
      r.title,
      r.text,
      r.summary,
      r.url,
      JSON.stringify(r.files),
      r.pageId,
      JSON.stringify(r.reviewFields),
      r.aiGenerated ? 1 : 0,
      r.hiddenReason,
      r.canonicalId,
      r.error,
      JSON.stringify(r.pending),
      r.seq,
      r.occurredAt,
      r.createdAt,
      r.updatedAt,
      r.deletedAt,
      r.purgeAfter,
    );
  }

  async insertLocal(r: NewRecord & { id: string }): Promise<LocalRecord> {
    const rec = newLocal(r, this.now());
    await this.write(rec, 'INSERT OR IGNORE');
    return (await this.get(r.id)) ?? rec;
  }

  async get(id: string) {
    const row = await this.db.getFirstAsync<Row>('SELECT * FROM records WHERE id = ?', id);
    return row ? rowTo(row) : null;
  }

  async list(limit = 200) {
    const rows = await this.db.getAllAsync<Row>(
      `SELECT * FROM records
       WHERE (deleted_at IS NULL OR pending LIKE '%"restored":true%')
         AND pending NOT LIKE '%"deleted":%'
         AND (hidden_reason IS NULL OR pending LIKE '%"unmerge":true%')
       ORDER BY created_at DESC LIMIT ?`,
      limit,
    );
    return rows.map(rowTo);
  }

  async listTrash(limit = 200) {
    const rows = await this.db.getAllAsync<Row>(
      `SELECT * FROM records
       WHERE (deleted_at IS NOT NULL OR pending LIKE '%"deleted":%')
         AND pending NOT LIKE '%"restored":true%'
         AND hidden_reason IS NULL`,
    );
    const now = this.now();
    return rows
      .map(rowTo)
      .filter((r) => inTrash(r, now))
      .sort(byTrashedAt)
      .slice(0, limit);
  }

  async detachFromAccount(requeued: ReadonlySet<string>) {
    const rows = await this.db.getAllAsync<Row>("SELECT * FROM records WHERE server_id IS NOT NULL OR pending != '{}'");
    for (const row of rows) await this.write(detached(rowTo(row), requeued), 'INSERT OR REPLACE');
  }

  async findByServerId(serverId: string) {
    const row = await this.db.getFirstAsync<Row>('SELECT * FROM records WHERE server_id = ?', serverId);
    return row ? rowTo(row) : null;
  }

  async markSynced(id: string, item: ItemOut) {
    const base = await this.get(id);
    await this.write({ ...fromServer(item, this.now(), base), id }, 'INSERT OR REPLACE');
  }

  async applyRemote(item: ItemOut) {
    const base = (item.client_id ? await this.get(item.client_id) : null) ?? (await this.findByServerId(item.id));
    if (base && base.seq > item.seq) return;
    await this.write(fromServer(item, this.now(), base), 'INSERT OR REPLACE');
  }

  async applyTombstone(serverId: string) {
    await this.db.runAsync('DELETE FROM records WHERE server_id = ?', serverId);
  }

  async setPending(id: string, pending: RecordPending) {
    await this.db.runAsync('UPDATE records SET pending = ? WHERE id = ?', JSON.stringify(pending), id);
  }

  async setLocalTrash(id: string, deletedAt: number | null) {
    await this.db.runAsync('UPDATE records SET deleted_at = ?, purge_after = NULL WHERE id = ?', deletedAt, id);
  }

  async markLocalRepeat(id: string, canonicalId: string | null) {
    await this.db.runAsync(
      "UPDATE records SET hidden_reason = 'duplicate_merged', canonical_id = ? WHERE id = ?",
      canonicalId,
      id,
    );
  }

  async getCursor() {
    const row = await this.db.getFirstAsync<{ value: string }>(
      'SELECT value FROM sync_state WHERE key = ?',
      CURSOR_KEY,
    );
    return Number(row?.value ?? 0) || 0;
  }

  async setCursor(seq: number) {
    await this.db.runAsync('INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)', CURSOR_KEY, String(seq));
  }
}
