import type { SQLiteDatabase } from 'expo-sqlite';

import { newId } from '@/utils/id';

/**
 * Outbox: every local change that must reach the backend is written here first
 * (offline-first, 3-engineering §2.1 / §6.7 offline). The sender is `src/sync/engine.ts`.
 * Rows are never deleted: `sent` stays as history, `failed` = permanent server rejection (kept for support).
 */
export type OutboxKind =
  | 'consent.accept'
  | 'device.register'
  | 'item.create'
  | 'item.verify'
  | 'item.unmerge'
  | 'item.correct'
  | 'item.delete'
  | 'item.restore'
  | 'profile.update'
  | 'pages.create'
  /** Week 16: the S35 choice in one request (POST /pages/batch, one action, one «Отменить»). */
  | 'pages.batch'
  /** Week 16: product events (POST /events), only with the `analytics` consent. */
  | 'events.send'
  /** Week 16: `PATCH /onboarding {welcome_seen}` after S05 (metrics). */
  | 'onboarding.welcome_seen'
  /** Week 16: a tile on «Сегодня» pinned / hidden by hand (PUT /pages/{id}/today-tile). */
  | 'page.today_tile'
  | 'pages.update'
  | 'capture.text'
  /** Unused: questions stream live (src/chat), they are not queued here. Old rows stay pending. */
  | 'chat.message'
  | 'feedback.send'
  /** «Отменить» / «Вернуть» an assistant action: done on the phone at once, the server follows. */
  | 'action.undo'
  /** Week 7, by hand (F-41): «Выше / Ниже / перетащил» on a page. */
  | 'page.item_move'
  /** «Переместить на страницу…» / «Показать ещё на…» (S39). */
  | 'item.move_to_page'
  /** «Убрать с этой страницы». */
  | 'page.item_remove'
  /** S34 ↑↓ / drag: the tab order. */
  | 'pages.reorder'
  /** S34 «Убрать» and its «Отменить». */
  | 'pages.remove'
  | 'pages.restore'
  /** Week 8: a reminder from S13 (also offline): POST /reminders, idempotent by `client_id`. */
  | 'reminder.create'
  /** Rings and buttons on this phone → POST /reminders/events (docs/api/reminders.md). */
  | 'reminder.events'
  /** Week 9: «Перенести» a missed reminder (PATCH /reminders/{id}). */
  | 'reminder.update'
  /** «Удалить» a reminder (DELETE /reminders/{id}, 200 + action since week 9). */
  | 'reminder.delete'
  /** Week 9: a row added on «Дела» / «Покупки» by hand or offline (POST /tasks). */
  | 'task.create'
  /** A box ticked / unticked, or a row taken back (PATCH / DELETE /tasks/{id}). */
  | 'task.update'
  /** Week 11: a view change by hand (S38, the notebook switcher): PATCH / PUT fields / reset. */
  | 'page.view'
  /** Week 11: a value of a field of one record on «Своя страница» (a tick, a table cell). */
  | 'page.item_fields'
  /** Week 11а: a sticker's colour or «Приколоть» by hand (PATCH /pages/{id}/items/{item_id}). */
  | 'page.item_look'
  | 'page.item_place'
  /** Week 11а: «− 2 +» on «Покупки», «На завтра» on «Дела» (PATCH /tasks/{id} with `version`). */
  | 'task.patch'
  /** Week 11а: «Убрать все купленные» (POST /tasks/clear-done, one action). */
  | 'task.clear_done'
  /** Week 10: a Telegram Desktop export (result.json / zip): upload, then POST /imports/telegram/file. */
  | 'import.telegram'
  /** Week 12: «Записать» on «Расходы» (POST /expenses, idempotent by `client_id`). */
  | 'expense.create'
  /** A category, the amount, the date, «Верно» of a spending (PATCH /expenses/{id}). */
  | 'expense.patch'
  /** «Удалить» a spending (DELETE /expenses/{id}). */
  | 'expense.delete'
  /** The person's order of the category chips (PATCH /expense-categories/reorder). */
  | 'expense.categories'
  /** Week 13: a receipt photo / shared receipt (POST /expenses/from-item) or a fiscal QR (POST /expenses/from-qr). */
  | 'expense.receipt'
  /** Week 13: a statement PDF → its plan (POST /expenses/statements); nothing is added before «Да». */
  | 'expense.statement'
  // week 14: КП (src/kp/service.ts)
  | 'kp.profile'
  | 'kp.image'
  | 'kp.prices'
  | 'kp.price'
  | 'kp.price_delete'
  | 'kp.patch'
  | 'kp.status'
  /** Week 15: «Вернуть эту» (POST /documents/{id}/revert) and «Отправили?» [Да] (…/versions/{n}/sent). */
  | 'kp.revert'
  | 'kp.sent'
  /** F-15 drafts: «Изменить» (PATCH), «Не надо» (DELETE), «Отправили?» (pending result). */
  | 'kp.draft';

export type OutboxStatus = 'pending' | 'sent' | 'failed';

export type OutboxEntry = {
  /** client_id — also the idempotency key for the server. */
  id: string;
  kind: OutboxKind;
  payload: unknown;
  status: OutboxStatus;
  attempts: number;
  lastError: string | null;
  /** Earliest time (ms) of the next attempt — retry backoff. 0 = now. */
  nextAttemptAt: number;
  createdAt: number;
  updatedAt: number;
};

export interface OutboxRepository {
  enqueue(kind: OutboxKind, payload: unknown): Promise<OutboxEntry>;
  /** Oldest first. */
  listPending(limit?: number): Promise<OutboxEntry[]>;
  markSent(id: string): Promise<void>;
  /** Permanent failure (server rejected it): kept, not retried automatically. */
  markFailed(id: string, error: string): Promise<void>;
  /** Transient failure: stays pending, attempts + 1, next try not before `nextAttemptAt`. */
  markRetry(id: string, error: string, nextAttemptAt: number): Promise<void>;
  /** Store progress (e.g. the upload id after the file is uploaded) so a retry doesn't redo it. */
  updatePayload(id: string, payload: unknown): Promise<void>;
  get(id: string): Promise<OutboxEntry | null>;
  countPending(): Promise<number>;
  /** Oldest first: captures already sent, to replay them on another account. */
  listSent(kind: OutboxKind): Promise<OutboxEntry[]>;
  /** Week 16: the account is being deleted — nothing of it stays on this phone. */
  wipe(): Promise<void>;
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
  // v2 (week 2): retry backoff + local records (items mirror) + sync cursor
  `ALTER TABLE outbox ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0;
   CREATE TABLE IF NOT EXISTS records (
     id TEXT PRIMARY KEY NOT NULL,
     server_id TEXT,
     kind TEXT NOT NULL,
     source TEXT NOT NULL,
     status TEXT NOT NULL,
     title TEXT,
     text TEXT,
     url TEXT,
     files TEXT NOT NULL DEFAULT '[]',
     page_id TEXT,
     seq INTEGER NOT NULL DEFAULT 0,
     occurred_at TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     deleted_at INTEGER
   );
   CREATE UNIQUE INDEX IF NOT EXISTS records_server_id ON records (server_id);
   CREATE INDEX IF NOT EXISTS records_created ON records (created_at);
   CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);`,
  // v3 (week 3): what the record card needs + local overlay for changes not yet on the server
  `ALTER TABLE records ADD COLUMN summary TEXT;
   ALTER TABLE records ADD COLUMN review_fields TEXT NOT NULL DEFAULT '{}';
   ALTER TABLE records ADD COLUMN ai_generated INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE records ADD COLUMN hidden_reason TEXT;
   ALTER TABLE records ADD COLUMN canonical_id TEXT;
   ALTER TABLE records ADD COLUMN error TEXT;
   ALTER TABLE records ADD COLUMN pending TEXT NOT NULL DEFAULT '{}';
   CREATE TABLE IF NOT EXISTS pages (
     id TEXT PRIMARY KEY NOT NULL,
     server_id TEXT,
     template_key TEXT NOT NULL,
     title TEXT,
     title_kk TEXT,
     title_dirty INTEGER NOT NULL DEFAULT 0,
     icon TEXT NOT NULL,
     layout TEXT NOT NULL,
     position TEXT NOT NULL,
     created_by TEXT NOT NULL,
     created_at TEXT NOT NULL,
     sync_state TEXT NOT NULL DEFAULT 'pending',
     seq INTEGER NOT NULL DEFAULT 0,
     deleted_at INTEGER,
     hidden_at INTEGER
   );
   CREATE UNIQUE INDEX IF NOT EXISTS pages_server_id ON pages (server_id);
   CREATE TABLE IF NOT EXISTS page_links (
     id TEXT PRIMARY KEY NOT NULL,
     page_server_id TEXT NOT NULL,
     item_server_id TEXT NOT NULL,
     position TEXT,
     manual_order INTEGER NOT NULL DEFAULT 0,
     pinned INTEGER NOT NULL DEFAULT 0,
     removed_at TEXT,
     seq INTEGER NOT NULL DEFAULT 0
   );
   CREATE UNIQUE INDEX IF NOT EXISTS page_links_page_item ON page_links (page_server_id, item_server_id);`,
  // v4 (week 4): how long a deleted record can still be brought back
  `ALTER TABLE records ADD COLUMN purge_after INTEGER;`,
  // v5 (week 6): the page version the line sends with a request, group headings after «Разложи»
  `ALTER TABLE pages ADD COLUMN view_version INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE pages ADD COLUMN view_groups TEXT NOT NULL DEFAULT '[]';
   ALTER TABLE page_links ADD COLUMN group_key TEXT;`,
  // v6 (week 7): changes by hand still in the outbox keep the person's version over /sync
  `ALTER TABLE page_links ADD COLUMN pending INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE page_links ADD COLUMN server_row TEXT;
   ALTER TABLE pages ADD COLUMN position_dirty INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE pages ADD COLUMN removed_dirty INTEGER NOT NULL DEFAULT 0;
   CREATE INDEX IF NOT EXISTS page_links_item ON page_links (item_server_id);`,
  // v7 (week 11): the page's view (S38, `set_view`) and its changes still in the outbox
  `ALTER TABLE pages ADD COLUMN view_json TEXT NOT NULL DEFAULT '{}';
   ALTER TABLE pages ADD COLUMN view_dirty INTEGER NOT NULL DEFAULT 0;`,
  // v8 (week 11а): the sticker's colour on this page (`link.appearance.color`)
  `ALTER TABLE page_links ADD COLUMN color TEXT;`,
  // v9 (weeks 16а–16б): the sticker's place on the free board (`board_x/y/z`, `board_manual`)
  `ALTER TABLE page_links ADD COLUMN board_x REAL;
   ALTER TABLE page_links ADD COLUMN board_y REAL;
   ALTER TABLE page_links ADD COLUMN board_z INTEGER;
   ALTER TABLE page_links ADD COLUMN board_manual INTEGER NOT NULL DEFAULT 0;`,
];

type Row = {
  id: string;
  kind: OutboxKind;
  payload: string;
  status: OutboxStatus;
  attempts: number;
  last_error: string | null;
  next_attempt_at?: number;
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
  nextAttemptAt: r.next_attempt_at ?? 0,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export type SqlDb = Pick<SQLiteDatabase, 'execAsync' | 'runAsync' | 'getAllAsync' | 'getFirstAsync'>;

export async function migrate(db: SqlDb): Promise<void> {
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const current = row?.user_version ?? 0;
  for (let v = current; v < OUTBOX_MIGRATIONS.length; v++) {
    const sql = OUTBOX_MIGRATIONS[v];
    // All or nothing: a half-applied ALTER list would fail forever on the next launch.
    await db.execAsync('BEGIN');
    try {
      if (sql) await db.execAsync(sql);
      await db.execAsync(`PRAGMA user_version = ${v + 1}`);
      await db.execAsync('COMMIT');
    } catch (e) {
      await db.execAsync('ROLLBACK');
      throw e;
    }
  }
}

export class SqliteOutboxRepository implements OutboxRepository {
  constructor(
    private readonly db: SqlDb,
    private readonly now: () => number = Date.now,
  ) {}

  async wipe() {
    await this.db.runAsync('DELETE FROM outbox');
  }

  async enqueue(kind: OutboxKind, payload: unknown): Promise<OutboxEntry> {
    const ts = this.now();
    const entry: OutboxEntry = {
      id: newId(),
      kind,
      payload,
      status: 'pending',
      attempts: 0,
      lastError: null,
      nextAttemptAt: 0,
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
    await this.db.runAsync(
      "UPDATE outbox SET status = 'failed', attempts = attempts + 1, last_error = ?, updated_at = ? WHERE id = ?",
      error,
      this.now(),
      id,
    );
  }

  async markRetry(id: string, error: string, nextAttemptAt: number): Promise<void> {
    await this.db.runAsync(
      'UPDATE outbox SET attempts = attempts + 1, last_error = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?',
      error,
      nextAttemptAt,
      this.now(),
      id,
    );
  }

  async updatePayload(id: string, payload: unknown): Promise<void> {
    await this.db.runAsync(
      'UPDATE outbox SET payload = ?, updated_at = ? WHERE id = ?',
      JSON.stringify(payload),
      this.now(),
      id,
    );
  }

  async get(id: string): Promise<OutboxEntry | null> {
    const row = await this.db.getFirstAsync<Row>('SELECT * FROM outbox WHERE id = ?', id);
    return row ? fromRow(row) : null;
  }

  async countPending(): Promise<number> {
    const row = await this.db.getFirstAsync<{ n: number }>("SELECT COUNT(*) AS n FROM outbox WHERE status = 'pending'");
    return row?.n ?? 0;
  }

  async listSent(kind: OutboxKind): Promise<OutboxEntry[]> {
    const rows = await this.db.getAllAsync<Row>(
      "SELECT * FROM outbox WHERE status = 'sent' AND kind = ? ORDER BY created_at ASC",
      kind,
    );
    return rows.map(fromRow);
  }
}

/** For tests and for platforms without SQLite. Same semantics as the SQLite implementation. */
export class InMemoryOutboxRepository implements OutboxRepository {
  private rows = new Map<string, OutboxEntry>();
  private seq = 0;

  constructor(private readonly now: () => number = Date.now) {}

  async wipe() {
    this.rows.clear();
  }

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
      nextAttemptAt: 0,
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

  async markRetry(id: string, error: string, nextAttemptAt: number): Promise<void> {
    const r = this.rows.get(id);
    if (r)
      this.rows.set(id, { ...r, attempts: r.attempts + 1, lastError: error, nextAttemptAt, updatedAt: this.now() });
  }

  async updatePayload(id: string, payload: unknown): Promise<void> {
    const r = this.rows.get(id);
    if (r) this.rows.set(id, { ...r, payload: JSON.parse(JSON.stringify(payload)) as unknown, updatedAt: this.now() });
  }

  async get(id: string): Promise<OutboxEntry | null> {
    return this.rows.get(id) ?? null;
  }

  /** Test helper: every row, any status. */
  all(): OutboxEntry[] {
    return [...this.rows.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  async countPending(): Promise<number> {
    return (await this.listPending(Number.MAX_SAFE_INTEGER)).length;
  }

  async listSent(kind: OutboxKind): Promise<OutboxEntry[]> {
    return this.all().filter((r) => r.status === 'sent' && r.kind === kind);
  }
}
