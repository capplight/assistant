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
  it('match the «Мята / Глубина» system (design-system §2, Ф-46)', () => {
    expect(lightColors.bg).toBe('#E2F2E9');
    expect(lightColors.brand).toBe('#0A7553');
    expect(lightColors.highlight).toBe('#FFC845');
    expect(darkColors.bg).toBe('#0F2C33');
    expect(darkColors.brand).toBe('#4CCB9D');
    expect(darkColors.highlight).toBe('#FFB547');
  });

  it('platform sizes (Ф-45): body 16–17, buttons never larger than body, nothing below 11, no uppercase', () => {
    expect(type.body.fontSize).toBeGreaterThanOrEqual(16);
    expect(type.body.fontSize).toBeLessThanOrEqual(17);
    expect(type.button.fontSize).toBeLessThanOrEqual(type.body.fontSize!);
    for (const t of Object.values(type)) {
      expect(t.fontSize).toBeGreaterThanOrEqual(11);
      expect(t.textTransform).toBeUndefined();
      // Room for the tails of қ ң ғ ұ.
      expect(t.lineHeight! / t.fontSize!).toBeGreaterThanOrEqual(1.1);
    }
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
    await repo.markRetry(b.id, 'offline', 5000);
    expect((await repo.get(b.id))?.attempts).toBe(1);
    expect(await repo.countPending()).toBe(1);
    await repo.markFailed(b.id, 'validation_error');
    expect(await repo.countPending()).toBe(0);
    expect(repo.all()).toHaveLength(2); // never deleted
  });

  it('sqlite: migrates once and inserts with JSON payload', async () => {
    const { db, calls } = fakeDb();
    await migrate(db);
    await migrate(db); // idempotent
    const creates = calls.filter((c) => c.sql.includes('CREATE TABLE IF NOT EXISTS outbox'));
    expect(creates).toHaveLength(1);
    expect(calls.filter((c) => c.sql.startsWith('PRAGMA user_version ='))).toHaveLength(OUTBOX_MIGRATIONS.length);

    const repo = new SqliteOutboxRepository(db, () => 42);
    const e = await repo.enqueue('pages.create', { pages: [1] });
    const insert = calls.find((c) => c.sql.startsWith('INSERT INTO outbox'));
    expect(insert?.params).toEqual([e.id, 'pages.create', '{"pages":[1]}', 'pending', 0, null, 42, 42]);
  });
});
