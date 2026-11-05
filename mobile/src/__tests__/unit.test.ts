import { InMemoryOutboxRepository, migrate, OUTBOX_MIGRATIONS, SqliteOutboxRepository, type SqlDb } from '@/db/outbox';
import kk from '@/i18n/locales/kk.json';
import ru from '@/i18n/locales/ru.json';
import { premarksFromPhrase } from '@/pages/premarks';
import { GALLERY_ORDER, TEMPLATES } from '@/pages/templates';
import { premarksFor } from '@/store/onboarding';
import { darkColors, lightColors, type } from '@/theme';

type Tree = { [k: string]: string | Tree };

function flatten(obj: Tree, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out[key] = v;
    else Object.assign(out, flatten(v, key));
  }
  return out;
}

describe('i18n', () => {
  const ruFlat = flatten(ru as Tree);
  const kkFlat = flatten(kk as Tree);

  it('kk has every ru key (KK is a draft but complete)', () => {
    const missing = Object.keys(ruFlat).filter((k) => !(k in kkFlat));
    expect(missing).toEqual([]);
  });

  it('kk is marked as draft', () => {
    expect(kkFlat['_meta.status']).toMatch(/DRAFT/);
  });

  it('the word «ИИ» appears only in consent/disclosure strings (R-06)', () => {
    const allowed = /^(consent|ai)\./;
    const offenders = Object.entries(ruFlat)
      .filter(([k, v]) => /(^|[^А-Яа-яЁё])ИИ([^А-Яа-яЁё]|$)/.test(v) && !allowed.test(k))
      .map(([k]) => k);
    expect(offenders).toEqual([]);
  });

  it('no «чат», «шаблон», «контекст» in buttons/tabs/line (R-47)', () => {
    const uiKeys = Object.entries(ruFlat).filter(([k]) => /^(tabs|line|answer|chat|more|gallery\.ok|start\.)/.test(k));
    const offenders = uiKeys.filter(([, v]) => /\b(чат|контекст)/i.test(v)).map(([k]) => k);
    expect(offenders).toEqual([]);
  });
});

describe('templates and premarks', () => {
  it('has the 6 catalog templates; gallery starts with «Своя страница»', () => {
    expect(TEMPLATES.map((t) => t.key)).toEqual(['notes', 'tasks', 'shopping', 'documents', 'expenses', 'custom']);
    expect(GALLERY_ORDER[0]).toBe('custom');
  });

  it('premarks from the first phrase by words, no AI', () => {
    expect(premarksFromPhrase('Сделай КП для клиента')).toEqual(['documents']);
    expect(premarksFromPhrase('потратил 5000 на бензин')).toEqual(['expenses']);
    expect(premarksFromPhrase('Напомни в пятницу оплатить свет')).toEqual([]);
  });

  it('welcome picks add premarks', () => {
    expect(premarksFor(['kp'], ['notes', 'tasks'])).toEqual(['notes', 'tasks', 'documents']);
  });
});

describe('theme tokens', () => {
  it('match 2-design §2.1 key values', () => {
    expect(lightColors.bg).toBe('#F6F3EC');
    expect(lightColors.accent).toBe('#2F4BD8');
    expect(darkColors.bg).toBe('#16151A');
    expect(darkColors.accent).toBe('#8FA2FF');
  });

  it('body text is ≥18 and nothing is below 15', () => {
    expect(type.body.fontSize).toBeGreaterThanOrEqual(18);
    for (const t of Object.values(type)) expect(t.fontSize).toBeGreaterThanOrEqual(15);
  });
});

/** Minimal fake of the expo-sqlite async API, enough to exercise SQL paths of the repository. */
function fakeDb() {
  const calls: { sql: string; params: unknown[] }[] = [];
  let userVersion = 0;
  const db: SqlDb = {
    execAsync: jest.fn(async (sql: string) => {
      calls.push({ sql, params: [] });
      const m = /PRAGMA user_version = (\d+)/.exec(sql);
      if (m) userVersion = Number(m[1]);
    }),
    runAsync: jest.fn(async (sql: string, ...params: unknown[]) => {
      calls.push({ sql, params });
      return { lastInsertRowId: 1, changes: 1 };
    }) as unknown as SqlDb['runAsync'],
    getAllAsync: jest.fn(async () => []) as unknown as SqlDb['getAllAsync'],
    getFirstAsync: jest.fn(async (sql: string) =>
      sql.includes('user_version') ? { user_version: userVersion } : { n: 0 },
    ) as unknown as SqlDb['getFirstAsync'],
  };
  return { db, calls };
}

describe('outbox', () => {
  it('in-memory: enqueue → pending in order → sent/failed', async () => {
    const repo = new InMemoryOutboxRepository(() => 1000);
    const a = await repo.enqueue('capture.text', { text: 'a' });
    const b = await repo.enqueue('chat.message', { text: 'b' });
    expect((await repo.listPending()).map((e) => e.id)).toEqual([a.id, b.id]);
    await repo.markSent(a.id);
    await repo.markFailed(b.id, 'offline');
    expect(await repo.countPending()).toBe(0);
  });

  it('sqlite: migrates once and inserts with JSON payload', async () => {
    const { db, calls } = fakeDb();
    await migrate(db);
    await migrate(db); // idempotent
    const creates = calls.filter((c) => c.sql.includes('CREATE TABLE IF NOT EXISTS outbox'));
    expect(creates).toHaveLength(OUTBOX_MIGRATIONS.length);

    const repo = new SqliteOutboxRepository(db, () => 42);
    const e = await repo.enqueue('pages.create', { pages: [1] });
    const insert = calls.find((c) => c.sql.startsWith('INSERT INTO outbox'));
    expect(insert?.params).toEqual([e.id, 'pages.create', '{"pages":[1]}', 'pending', 0, null, 42, 42]);
  });
});
