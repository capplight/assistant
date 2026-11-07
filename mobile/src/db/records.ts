import type { ItemKind, ItemOut, ItemSource } from '@/api/types';

import type { SqlDb } from './outbox';

/**
 * Local mirror of `items` (3-engineering §3.3): what the person saved on this phone plus what
 * arrived via GET /sync. The local id is the item's `client_id`.
 * Status: `queued` = only on this phone («Ждёт связи»); otherwise the server status.
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

export type LocalRecord = {
  id: string;
  serverId: string | null;
  kind: ItemKind;
  source: ItemSource | string;
  status: RecordStatus;
  title: string | null;
  text: string | null;
  url: string | null;
  files: RecordFile[];
  pageId: string | null;
  seq: number;
  occurredAt: string;
  createdAt: number;
  updatedAt: number;
  deletedAt: number | null;
};

export type NewRecord = Pick<LocalRecord, 'kind' | 'source'> &
  Partial<Pick<LocalRecord, 'id' | 'title' | 'text' | 'url' | 'files' | 'pageId' | 'occurredAt'>>;

export interface RecordsRepository {
  insertLocal(r: NewRecord & { id: string }): Promise<LocalRecord>;
  get(id: string): Promise<LocalRecord | null>;
  /** Newest first, without deleted. */
  list(limit?: number): Promise<LocalRecord[]>;
  /** POST /items succeeded: link the local record to the server item. */
  markSynced(id: string, item: ItemOut): Promise<void>;
  /** From GET /sync: upsert by client_id (own records) or server id (other devices). */
  applyRemote(item: ItemOut): Promise<void>;
  applyTombstone(serverId: string): Promise<void>;
  getCursor(): Promise<number>;
  setCursor(seq: number): Promise<void>;
}

const CURSOR_KEY = 'sync.since';

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
    url: base?.url ?? null,
    files: base?.files ?? [],
    pageId: base?.pageId ?? null,
    seq: item.seq,
    occurredAt: item.occurred_at ?? base?.occurredAt ?? item.created_at,
    createdAt: base?.createdAt ?? (Date.parse(item.created_at) || now),
    updatedAt: now,
    deletedAt: item.deleted_at ? Date.parse(item.deleted_at) || now : null,
  };
}

export class InMemoryRecordsRepository implements RecordsRepository {
  private rows = new Map<string, LocalRecord>();
  private cursor = 0;

  constructor(private readonly now: () => number = Date.now) {}

  async insertLocal(r: NewRecord & { id: string }): Promise<LocalRecord> {
    const existing = this.rows.get(r.id);
    if (existing) return existing; // idempotent: a retried save never duplicates
    const ts = this.now();
    const rec: LocalRecord = {
      id: r.id,
      serverId: null,
      kind: r.kind,
      source: r.source,
      status: 'queued',
      title: r.title ?? null,
      text: r.text ?? null,
      url: r.url ?? null,
      files: r.files ?? [],
      pageId: r.pageId ?? null,
      seq: 0,
      occurredAt: r.occurredAt ?? new Date(ts).toISOString(),
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
    };
    this.rows.set(rec.id, rec);
    return rec;
  }

  async get(id: string) {
    return this.rows.get(id) ?? null;
  }

  async list(limit = 200) {
    return [...this.rows.values()]
      .filter((r) => r.deletedAt === null)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  }

  async markSynced(id: string, item: ItemOut) {
    const base = this.rows.get(id);
    this.rows.set(id, { ...fromServer(item, this.now(), base), id });
  }

  async applyRemote(item: ItemOut) {
    const base =
      (item.client_id ? this.rows.get(item.client_id) : undefined) ??
      [...this.rows.values()].find((r) => r.serverId === item.id) ??
      null;
    if (base && base.seq > item.seq) return; // older delta
    const rec = fromServer(item, this.now(), base);
    this.rows.set(rec.id, rec);
  }

  async applyTombstone(serverId: string) {
    for (const r of this.rows.values()) {
      if (r.serverId === serverId) this.rows.set(r.id, { ...r, deletedAt: this.now() });
    }
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
  url: string | null;
  files: string;
  page_id: string | null;
  seq: number;
  occurred_at: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
};

const rowTo = (r: Row): LocalRecord => ({
  id: r.id,
  serverId: r.server_id,
  kind: r.kind,
  source: r.source,
  status: r.status,
  title: r.title,
  text: r.text,
  url: r.url,
  files: JSON.parse(r.files || '[]') as RecordFile[],
  pageId: r.page_id,
  seq: r.seq,
  occurredAt: r.occurred_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  deletedAt: r.deleted_at,
});

const COLS =
  'id, server_id, kind, source, status, title, text, url, files, page_id, seq, occurred_at, created_at, updated_at, deleted_at';

export class SqliteRecordsRepository implements RecordsRepository {
  constructor(
    private readonly db: SqlDb,
    private readonly now: () => number = Date.now,
  ) {}

  private async write(r: LocalRecord, mode: 'INSERT OR IGNORE' | 'INSERT OR REPLACE') {
    await this.db.runAsync(
      `${mode} INTO records (${COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      r.id,
      r.serverId,
      r.kind,
      r.source,
      r.status,
      r.title,
      r.text,
      r.url,
      JSON.stringify(r.files),
      r.pageId,
      r.seq,
      r.occurredAt,
      r.createdAt,
      r.updatedAt,
      r.deletedAt,
    );
  }

  async insertLocal(r: NewRecord & { id: string }): Promise<LocalRecord> {
    const ts = this.now();
    const rec: LocalRecord = {
      id: r.id,
      serverId: null,
      kind: r.kind,
      source: r.source,
      status: 'queued',
      title: r.title ?? null,
      text: r.text ?? null,
      url: r.url ?? null,
      files: r.files ?? [],
      pageId: r.pageId ?? null,
      seq: 0,
      occurredAt: r.occurredAt ?? new Date(ts).toISOString(),
      createdAt: ts,
      updatedAt: ts,
      deletedAt: null,
    };
    await this.write(rec, 'INSERT OR IGNORE');
    return (await this.get(r.id)) ?? rec;
  }

  async get(id: string) {
    const row = await this.db.getFirstAsync<Row>('SELECT * FROM records WHERE id = ?', id);
    return row ? rowTo(row) : null;
  }

  async list(limit = 200) {
    const rows = await this.db.getAllAsync<Row>(
      'SELECT * FROM records WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT ?',
      limit,
    );
    return rows.map(rowTo);
  }

  async markSynced(id: string, item: ItemOut) {
    const base = await this.get(id);
    await this.write({ ...fromServer(item, this.now(), base), id }, 'INSERT OR REPLACE');
  }

  async applyRemote(item: ItemOut) {
    let base: LocalRecord | null = null;
    if (item.client_id) base = await this.get(item.client_id);
    if (!base) {
      const row = await this.db.getFirstAsync<Row>('SELECT * FROM records WHERE server_id = ?', item.id);
      base = row ? rowTo(row) : null;
    }
    if (base && base.seq > item.seq) return;
    await this.write(fromServer(item, this.now(), base), 'INSERT OR REPLACE');
  }

  async applyTombstone(serverId: string) {
    await this.db.runAsync(
      'UPDATE records SET deleted_at = ?, updated_at = ? WHERE server_id = ?',
      this.now(),
      this.now(),
      serverId,
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
