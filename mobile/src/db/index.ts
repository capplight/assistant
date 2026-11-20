import { openDatabaseAsync } from 'expo-sqlite';

import { InMemoryCalendarRepository, SqliteCalendarRepository, type CalendarRepository } from './calendar';
import { InMemoryOutboxRepository, migrate, SqliteOutboxRepository, type OutboxRepository } from './outbox';
import { InMemoryPagesRepository, SqlitePagesRepository, type PagesRepository } from './pages';
import { InMemoryRecordsRepository, SqliteRecordsRepository, type RecordsRepository } from './records';

export * from './outbox';
export * from './pages';
export * from './records';
export * from './calendar';

export const DB_NAME = 'assistant.db';

type Repos = { outbox: OutboxRepository; records: RecordsRepository; pages: PagesRepository; calendar: CalendarRepository };

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
          calendar: new SqliteCalendarRepository(db),
        };
      } catch (e) {
        console.warn('SQLite unavailable, using in-memory storage', e);
        return {
          outbox: new InMemoryOutboxRepository(),
          records: new InMemoryRecordsRepository(),
          pages: new InMemoryPagesRepository(),
          calendar: new InMemoryCalendarRepository(),
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

/** Ф-89: occurrences of repeating to-dos and the kept GET /v1/calendar ranges. */
export async function getCalendarRepo(): Promise<CalendarRepository> {
  return (await getRepos()).calendar;
}

/** Test hook. */
export function setOutboxForTests(
  r: OutboxRepository | null,
  records?: RecordsRepository,
  pages?: PagesRepository,
  calendar?: CalendarRepository,
): void {
  repos = r
    ? Promise.resolve({
        outbox: r,
        records: records ?? new InMemoryRecordsRepository(),
        pages: pages ?? new InMemoryPagesRepository(),
        calendar: calendar ?? new InMemoryCalendarRepository(),
      })
    : null;
}
