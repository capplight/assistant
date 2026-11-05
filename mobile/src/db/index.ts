import { openDatabaseAsync } from 'expo-sqlite';

import { InMemoryOutboxRepository, migrate, SqliteOutboxRepository, type OutboxRepository } from './outbox';

export * from './outbox';

export const DB_NAME = 'assistant.db';

let repo: Promise<OutboxRepository> | null = null;

/** Lazily opens the local DB and runs migrations once. Falls back to memory if SQLite is unavailable. */
export function getOutbox(): Promise<OutboxRepository> {
  if (!repo) {
    repo = (async () => {
      try {
        const db = await openDatabaseAsync(DB_NAME);
        await db.execAsync('PRAGMA journal_mode = WAL;');
        await migrate(db);
        return new SqliteOutboxRepository(db);
      } catch (e) {
        console.warn('SQLite unavailable, using in-memory outbox', e);
        return new InMemoryOutboxRepository();
      }
    })();
  }
  return repo;
}

/** Test hook. */
export function setOutboxForTests(r: OutboxRepository | null): void {
  repo = r ? Promise.resolve(r) : null;
}
