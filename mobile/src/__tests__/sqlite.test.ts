/**
 * Runs the real migrations and SQL of the repositories on a real SQLite engine (Node's built-in),
 * because no device has run them yet. Skipped where node:sqlite does not exist.
 */
import { migrate, OUTBOX_MIGRATIONS, SqliteOutboxRepository, type SqlDb } from '@/db/outbox';
import { SqlitePagesRepository } from '@/db/pages';
import { SqliteRecordsRepository } from '@/db/records';
import { pageEntries } from '@/pages/contents';
import { seedPages } from '@/store/pages';
import { itemOut, linkOut, pageOut } from '@/testing/fakeServer';

type NodeDb = {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...p: unknown[]): unknown;
    all(...p: unknown[]): unknown[];
    get(...p: unknown[]): unknown;
  };
};

let sqlite: { DatabaseSync: new (path: string) => NodeDb } | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  sqlite = require('node:sqlite');
} catch {
  sqlite = null;
}

function open(): SqlDb {
  const db = new sqlite!.DatabaseSync(':memory:');
  return {
    execAsync: async (sql: string) => db.exec(sql),
    runAsync: async (sql: string, ...p: unknown[]) => db.prepare(sql).run(...p),
    getAllAsync: async (sql: string, ...p: unknown[]) => db.prepare(sql).all(...p),
    getFirstAsync: async (sql: string, ...p: unknown[]) => db.prepare(sql).get(...p) ?? null,
  } as unknown as SqlDb;
}

const d = sqlite ? describe : describe.skip;

d('SQLite repositories', () => {
  it('upgrades a week-2 database, keeping its rows', async () => {
    const db = open();
    await db.execAsync(OUTBOX_MIGRATIONS[0]!);
    await db.execAsync(OUTBOX_MIGRATIONS[1]!);
    await db.execAsync('PRAGMA user_version = 2');
    await db.runAsync(
      `INSERT INTO records (id, kind, source, status, occurred_at, created_at, updated_at)
       VALUES ('old', 'note', 'typed', 'queued', '2026-01-01', 1, 1)`,
    );
    await migrate(db);
    await migrate(db);
    const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    expect(row?.user_version).toBe(OUTBOX_MIGRATIONS.length);
    const rec = await new SqliteRecordsRepository(db).get('old');
    expect(rec).toMatchObject({ id: 'old', reviewFields: {}, aiGenerated: false, pending: {} });
  });

  it('a failed migration leaves nothing behind', async () => {
    const db = open();
    const failing = { ...db, execAsync: async (sql: string) => {
      if (sql.includes('CREATE TABLE IF NOT EXISTS pages')) {
        await db.execAsync('ALTER TABLE records ADD COLUMN broken TEXT');
        throw new Error('disk full');
      }
      await db.execAsync(sql);
    } } as SqlDb;
    await expect(migrate(failing)).rejects.toThrow('disk full');
    const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    expect(row?.user_version).toBe(2);
    await migrate(db); // the next launch succeeds
    expect((await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version'))?.user_version).toBe(OUTBOX_MIGRATIONS.length);
  });

  it('records: card fields, overlay, hidden repeats', async () => {
    const db = open();
    await migrate(db);
    const records = new SqliteRecordsRepository(db, () => 1000);
    await records.insertLocal({ id: 'a', kind: 'note', source: 'typed', text: 'x' });
    await records.markSynced(
      'a',
      itemOut('a', 2, {
        ai_fields: ['summary'],
        summary: 'кратко',
        review_fields: { amount: { kind: 'amount', value: '5 ₸', state: 'unverified' } },
      }),
    );
    expect(await records.get('a')).toMatchObject({
      serverId: 'srv-a',
      aiGenerated: true,
      summary: 'кратко',
      reviewFields: { amount: { value: '5 ₸' } },
    });
    await records.setPending('a', { verify: { amount: '5 ₸' } });
    await records.applyRemote(itemOut('a', 3, { review_fields: {} }));
    expect((await records.get('a'))?.pending.verify).toEqual({ amount: '5 ₸' });

    await records.applyRemote(itemOut('dup', 4, { hidden_reason: 'duplicate_merged' }));
    expect((await records.list()).map((r) => r.id)).toEqual(['a']);
    await records.setPending('dup', { unmerge: true });
    expect((await records.list()).map((r) => r.id).sort()).toEqual(['a', 'dup']);

    await records.applyTombstone('srv-a');
    expect((await records.list()).some((r) => r.id === 'a')).toBe(false);
    await records.setCursor(42);
    expect(await records.getCursor()).toBe(42);
  });

  it('pages and links: create, sync, adopt, rename, order on the page', async () => {
    const db = open();
    await migrate(db);
    const pages = new SqlitePagesRepository(db, () => 1000);
    const records = new SqliteRecordsRepository(db, () => 1000);
    const [seed] = seedPages();
    const local = { ...seed!, id: 'p1', templateKey: 'custom' as const, createdBy: 'user' as const };
    await pages.insertLocal(local);
    await pages.insertLocal(local); // idempotent
    expect(await pages.listAll()).toHaveLength(1);

    await pages.markSynced('p1', pageOut('p1', 2, { id: 'S1', title: 'Дача', position: 'k' }));
    expect(await pages.get('p1')).toMatchObject({ serverId: 'S1', title: 'Дача', position: 'k', syncState: 'synced' });

    // A pull saw the singleton before the phone's POST answered: one row stays, under the local id.
    await pages.applyRemote(pageOut(null, 3, { id: 'S2', template_key: 'notes', title: 'Заметки' }));
    await pages.insertLocal({ ...local, id: 'p2', templateKey: 'notes' });
    await pages.adopt('p2', 'S2');
    await pages.applyRemote(pageOut(null, 4, { id: 'S2', template_key: 'notes', title: 'Заметки' }));
    expect((await pages.listAll()).filter((p) => p.serverId === 'S2').map((p) => p.id)).toEqual(['p2']);

    await pages.setTitle('p1', 'Ремонт');
    await pages.applyRemote(pageOut('p1', 5, { id: 'S1', title: 'Дача' }));
    expect((await pages.get('p1'))?.title).toBe('Ремонт');
    await pages.clearTitleDirty('p1');
    await pages.applyRemote(pageOut('p1', 6, { id: 'S1', title: 'Дача' }));
    expect((await pages.get('p1'))?.title).toBe('Дача');

    await pages.applyLink(linkOut('S1', 'srv-a', 7, { position: 'z' }));
    await pages.applyLink(linkOut('S1', 'srv-a', 8, { position: 'k' })); // upsert by (page, item)
    await pages.applyLink(linkOut('S1', 'srv-a', 3, { position: 'old' })); // older: ignored
    await pages.applyLink(linkOut('S1', 'srv-b', 9, { position: 'B' }));
    const links = await pages.linksFor('S1');
    expect(links).toHaveLength(2);
    await records.applyRemote(itemOut('a', 1));
    await records.applyRemote(itemOut('b', 2));
    const entries = pageEntries((await pages.get('p1'))!, await records.list(), links);
    expect(entries.map((e) => e.record.id)).toEqual(['b', 'a']);

    await pages.removeLink('link-S1-srv-b');
    expect(await pages.linksFor('S1')).toHaveLength(1);
    await pages.applyTombstone('S1');
    expect((await pages.get('p1'))?.deletedAt).toBe(1000);
  });

  it('outbox: new kinds round-trip', async () => {
    const db = open();
    await migrate(db);
    const outbox = new SqliteOutboxRepository(db, () => 7);
    const e = await outbox.enqueue('item.verify', { fields: { a: null } });
    expect((await outbox.get(e.id))?.payload).toEqual({ fields: { a: null } });
    expect(await outbox.listPending()).toHaveLength(1);
  });
});
