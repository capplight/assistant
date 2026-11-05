import type { SQLiteDatabase } from 'expo-sqlite';

import { newId } from '@/utils/id';

/**
 * Outbox: every local change that must reach the backend is written here first
 * (offline-first, 3-engineering §2.1 / §6.7 offline). No sync yet — week 2 adds the sender.
 */
export type OutboxKind = 'consent.accept' | 'pages.create' | 'capture.text' | 'chat.message';

export type OutboxStatus = 'pending' | 'sent' | 'failed';

export type OutboxEntry = {
  /** client_id — also the idempotency key for the server. */
  id: string;
  kind: OutboxKind;
  payload: unknown;
  status: OutboxStatus;
  attempts: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
};

export interface OutboxRepository {
  enqueue(kind: OutboxKind, payload: unknown): Promise<OutboxEntry>;
  /** Oldest first. */
  listPending(limit?: number): Promise<OutboxEntry[]>;
  markSent(id: string): Promise<void>;
  markFailed(id: string, error: string): Promise<void>;
  countPending(): Promise<number>;
}

export const OUTBOX_SCHEMA_VERSION = 1;

/** Migrations by PRAGMA user_version. TODO: drizzle-orm + SQLCipher (3-engineering §2.1). */
export const OUTBOX_MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS outbox (
     id TEXT PRIMARY KEY NOT NULL,
     kind TEXT NOT NULL,
     payload TEXT NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
     attempts INTEGER NOT NULL DEFAULT 0,
     last_error TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE INDEX IF NOT EXISTS outbox_status_created ON outbox (status, created_at);`,
];

type Row = {
  id: string;
  kind: OutboxKind;
  payload: string;
  status: OutboxStatus;
  attempts: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
};

const fromRow = (r: Row): OutboxEntry => ({
  id: r.id,
  kind: r.kind,
  payload: JSON.parse(r.payload) as unknown,
  status: r.status,
  attempts: r.attempts,
  lastError: r.last_error,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export type SqlDb = Pick<SQLiteDatabase, 'execAsync' | 'runAsync' | 'getAllAsync' | 'getFirstAsync'>;

export async function migrate(db: SqlDb): Promise<void> {
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const current = row?.user_version ?? 0;
  for (let v = current; v < OUTBOX_MIGRATIONS.length; v++) {
    const sql = OUTBOX_MIGRATIONS[v];
    if (sql) await db.execAsync(sql);
    await db.execAsync(`PRAGMA user_version = ${v + 1}`);
  }
}

export class SqliteOutboxRepository implements OutboxRepository {
  constructor(
    private readonly db: SqlDb,
    private readonly now: () => number = Date.now,
  ) {}

  async enqueue(kind: OutboxKind, payload: unknown): Promise<OutboxEntry> {
    const ts = this.now();
    const entry: OutboxEntry = {
      id: newId(),
      kind,
      payload,
      status: 'pending',
      attempts: 0,
      lastError: null,
      createdAt: ts,
      updatedAt: ts,
    };
    await this.db.runAsync(
      'INSERT INTO outbox (id, kind, payload, status, attempts, last_error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      entry.id,
      kind,
      JSON.stringify(payload),
      entry.status,
      0,
      null,
      ts,
      ts,
    );
    return entry;
  }

  async listPending(limit = 50): Promise<OutboxEntry[]> {
    const rows = await this.db.getAllAsync<Row>(
      "SELECT * FROM outbox WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?",
      limit,
    );
    return rows.map(fromRow);
  }

  async markSent(id: string): Promise<void> {
    await this.db.runAsync("UPDATE outbox SET status = 'sent', updated_at = ? WHERE id = ?", this.now(), id);
  }

  async markFailed(id: string, error: string): Promise<void> {
    // Stays retryable: status back to pending is the sender's decision (backoff), here we only record.
    await this.db.runAsync(
      "UPDATE outbox SET status = 'failed', attempts = attempts + 1, last_error = ?, updated_at = ? WHERE id = ?",
      error,
      this.now(),
      id,
    );
  }

  async countPending(): Promise<number> {
    const row = await this.db.getFirstAsync<{ n: number }>("SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending'");
    return row?.n ?? 0;
  }
}

/** For tests and for platforms without SQLite. Same semantics as the SQLite implementation. */
export class InMemoryOutboxRepository implements OutboxRepository {
  private rows = new Map<string, OutboxEntry>();
  private seq = 0;

  constructor(private readonly now: () => number = Date.now) {}

  async enqueue(kind: OutboxKind, payload: unknown): Promise<OutboxEntry> {
    // seq keeps insertion order stable when timestamps collide
    const ts = this.now() + this.seq++ / 1000;
    const entry: OutboxEntry = {
      id: newId(),
      kind,
      payload: JSON.parse(JSON.stringify(payload)) as unknown,
      status: 'pending',
      attempts: 0,
      lastError: null,
      createdAt: ts,
      updatedAt: ts,
    };
    this.rows.set(entry.id, entry);
    return entry;
  }

  async listPending(limit = 50): Promise<OutboxEntry[]> {
    return [...this.rows.values()]
      .filter((r) => r.status === 'pending')
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(0, limit);
  }

  async markSent(id: string): Promise<void> {
    const r = this.rows.get(id);
    if (r) this.rows.set(id, { ...r, status: 'sent', updatedAt: this.now() });
  }

  async markFailed(id: string, error: string): Promise<void> {
    const r = this.rows.get(id);
    if (r)
      this.rows.set(id, { ...r, status: 'failed', attempts: r.attempts + 1, lastError: error, updatedAt: this.now() });
  }

  async countPending(): Promise<number> {
    return (await this.listPending(Number.MAX_SAFE_INTEGER)).length;
  }
}
