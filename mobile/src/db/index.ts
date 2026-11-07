import { openDatabaseAsync } from 'expo-sqlite';

import { InMemoryOutboxRepository, migrate, SqliteOutboxRepository, type OutboxRepository } from './outbox';
import { InMemoryPagesRepository, SqlitePagesRepository, type PagesRepository } from './pages';
import { InMemoryRecordsRepository, SqliteRecordsRepository, type RecordsRepository } from './records';

export * from './outbox';
export * from './pages';
export * from './records';

export const DB_NAME = 'assistant.db';

type Repos = { outbox: OutboxRepository; records: RecordsRepository; pages: PagesRepository };

let repos: Promise<Repos> | null = null;

/** Lazily opens the local DB and runs migrations once. Falls back to memory if SQLite is unavailable. */
function getRepos(): Promise<Repos> {
  if (!repos) {
    repos = (async () => {
      try {
        const db = await openDatabaseAsync(DB_NAME);
        await db.execAsync('PRAGMA journal_mode = WAL;');
        await migrate(db);
        return {
          outbox: new SqliteOutboxRepository(db),
          records: new SqliteRecordsRepository(db),
          pages: new SqlitePagesRepository(db),
        };
      } catch (e) {
        console.warn('SQLite unavailable, using in-memory storage', e);
        return {
          outbox: new InMemoryOutboxRepository(),
          records: new InMemoryRecordsRepository(),
          pages: new InMemoryPagesRepository(),
        };
      }
    })();
  }
  return repos;
}

export async function getOutbox(): Promise<OutboxRepository> {
  return (await getRepos()).outbox;
}

export async function getRecords(): Promise<RecordsRepository> {
  return (await getRepos()).records;
}

export async function getPagesRepo(): Promise<PagesRepository> {
  return (await getRepos()).pages;
}

/** Test hook. */
export function setOutboxForTests(
  r: OutboxRepository | null,
  records?: RecordsRepository,
  pages?: PagesRepository,
): void {
  repos = r
    ? Promise.resolve({
        outbox: r,
        records: records ?? new InMemoryRecordsRepository(),
        pages: pages ?? new InMemoryPagesRepository(),
      })
    : null;
}
