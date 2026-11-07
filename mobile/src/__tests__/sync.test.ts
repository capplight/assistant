import { ApiClient, type FetchLike } from '@/api/client';
import { Api, type PutFile } from '@/api/endpoints';
import { MemorySecretStore, TokenStorage } from '@/api/tokens';
import { InMemoryOutboxRepository } from '@/db/outbox';
import { InMemoryRecordsRepository } from '@/db/records';
import { Capture } from '@/records/capture';
import { backoffMs, SyncEngine } from '@/sync/engine';
import { createOut, FakeServer, happyServer, itemOut, tokenPair } from '@/testing/fakeServer';
import { fakeFiles } from '@/testing/helpers';

function setup(server: FakeServer, o: { put?: PutFile; fetch?: FetchLike } = {}) {
  let clock = 1_000_000;
  const now = () => clock;
  const outbox = new InMemoryOutboxRepository(now);
  const records = new InMemoryRecordsRepository(now);
  const client = new ApiClient({
    fetch: o.fetch ?? server.fetch,
    tokens: new TokenStorage(new MemorySecretStore()),
    baseUrl: () => 'http://api.test',
  });
  const puts: string[] = [];
  const put: PutFile =
    o.put ??
    (async (uri) => {
      puts.push(uri);
    });
  const api = new Api(client, put);
  const engine = new SyncEngine({
    api,
    outbox,
    records,
    installId: async () => 'install-1',
    deviceInfo: () => ({ platform: 'ios', os_version: '18', app_version: '0.1.0', capabilities: {} }),
    now,
    random: () => 0.5,
  });
  const capture = new Capture({ outbox, records, files: fakeFiles });
  return { outbox, records, engine, capture, puts, advance: (ms: number) => (clock += ms) };
}

const consentPayload = {
  request: {
    screen: 'S05',
    age_confirmed_18: true,
    consents: [{ kind: 'pd_processing', version: 'pd-2026-11-v1', text_hash: 'h'.repeat(64), locale: 'ru' }],
  },
};

describe('outbox sync', () => {
  it('sends consent → device → items in order, with client_id as the idempotency key', async () => {
    const s = happyServer();
    const { outbox, records, engine, capture } = setup(s);
    await outbox.enqueue('consent.accept', consentPayload);
    await outbox.enqueue('device.register', {});
    const rec = await capture.saveText({ text: 'Купить хлеб', source: 'typed', pageId: 'today' });
    expect((await records.get(rec.id))?.status).toBe('queued');

    await engine.run();

    const order = s.calls.map((c) => `${c.method} ${c.path}`).filter((r) => !r.includes('/auth/'));
    expect(order).toEqual(['POST /consents', 'POST /devices', 'POST /items', 'GET /sync']);
    expect(s.callsTo('POST /devices')[0]?.body).toMatchObject({ client_id: 'install-1', platform: 'ios' });
    const item = s.callsTo('POST /items')[0];
    expect(item?.body).toMatchObject({ client_id: rec.id, kind: 'note', source: 'typed', text: 'Купить хлеб' });
    expect((item?.body as { content_hash: string }).content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(item?.headers['Idempotency-Key']).toBe(rec.id);
    expect(await outbox.countPending()).toBe(0);
    const synced = await records.get(rec.id);
    expect(synced?.serverId).toBe(`srv-${rec.id}`);
    expect(synced?.status).toBe('pending'); // server status
  });

  it('offline: nothing lost, retried with backoff; lost response → resent with the same client_id, no duplicate', async () => {
    const s = happyServer();
    let lose = false;
    const fetch: FetchLike = async (url, init) => {
      const r = await s.fetch(url, init);
      if (lose && url.includes('/items')) {
        lose = false; // the server stored it, the phone never saw the answer
        throw new TypeError('Network request failed');
      }
      return r;
    };
    const { outbox, records, engine, capture, advance } = setup(s, { fetch });
    const rec = await capture.saveText({ text: 'Позвонить Ерлану', source: 'typed' });

    s.offline = true;
    await engine.run();
    let [entry] = await outbox.listPending();
    expect(entry?.attempts).toBe(1);
    expect(entry?.nextAttemptAt).toBe(1_000_000 + backoffMs(0, null, () => 0.5));

    s.offline = false;
    await engine.push(); // not due yet
    expect(s.callsTo('POST /items')).toHaveLength(0);

    advance(60_000);
    lose = true;
    await engine.push();
    [entry] = await outbox.listPending();
    expect(entry?.attempts).toBe(2);
    expect(s.callsTo('POST /items')).toHaveLength(1);

    advance(10 * 60_000);
    await engine.run();
    const posts = s.callsTo('POST /items');
    expect(posts.map((p) => (p.body as { client_id: string }).client_id)).toEqual([rec.id, rec.id]);
    expect(await outbox.countPending()).toBe(0);
    // one item on the server, one local record
    const sync = s.callsTo('GET /sync');
    expect(sync.length).toBeGreaterThan(0);
    expect(await records.list()).toHaveLength(1);
    expect((await records.get(rec.id))?.serverId).toBe(`srv-${rec.id}`);
  });

  it('a server rejection is kept as failed (never deleted) and does not block other items', async () => {
    const s = happyServer();
    let n = 0;
    s.on('POST /items', (c) => {
      n++;
      if (n === 1)
        return { status: 422, body: { code: 'validation_error', message_ru: 'Проверьте данные.', message_kk: '' } };
      return { status: 201, body: createOut(itemOut((c.body as { client_id: string }).client_id, n)) };
    });
    const { outbox, engine, capture } = setup(s);
    await capture.saveText({ text: 'a', source: 'typed' });
    await capture.saveText({ text: 'b', source: 'typed' });
    await engine.push();
    const all = outbox.all();
    expect(all.map((e) => e.status)).toEqual(['failed', 'sent']);
    expect(all[0]?.lastError).toBe('validation_error');
  });

  it('consent failing (5xx) blocks devices and items until it goes through', async () => {
    const s = happyServer();
    let fail = true;
    s.on('POST /consents', () => (fail ? { status: 503, body: { code: 'internal' } } : { status: 200, body: {} }));
    const { outbox, engine, capture, advance } = setup(s);
    await outbox.enqueue('consent.accept', consentPayload);
    await outbox.enqueue('device.register', {});
    await capture.saveText({ text: 'x', source: 'typed' });
    await engine.push();
    expect(s.callsTo('POST /devices')).toHaveLength(0);
    expect(s.callsTo('POST /items')).toHaveLength(0);
    fail = false;
    advance(10 * 60_000);
    await engine.push();
    expect(s.callsTo('POST /devices')).toHaveLength(1);
    expect(s.callsTo('POST /items')).toHaveLength(1);
  });

  it('kinds without an endpoint yet (pages, chat) stay queued and do not block', async () => {
    const s = happyServer();
    const { outbox, engine, capture } = setup(s);
    await outbox.enqueue('pages.create', { pages: [] });
    await capture.saveText({ text: 'x', source: 'typed' });
    await engine.push();
    expect(outbox.all().map((e) => [e.kind, e.status])).toEqual([
      ['pages.create', 'pending'],
      ['item.create', 'sent'],
    ]);
  });

  it('file: create upload → PUT → complete → item with upload_id; upload progress survives a retry', async () => {
    const s = happyServer();
    let itemsFail = true;
    s.on('POST /items', (c) =>
      itemsFail
        ? { status: 500, body: { code: 'internal' } }
        : { status: 201, body: createOut(itemOut((c.body as { client_id: string }).client_id, 1, { kind: 'pdf' })) },
    );
    const { outbox, engine, capture, puts, advance } = setup(s);
    const rec = await capture.saveFile({
      uri: 'file:///share/tz.pdf',
      mime: 'application/pdf',
      name: 'ТЗ.pdf',
      source: 'share',
    });
    await engine.push();
    expect(s.callsTo('POST /uploads')[0]?.body).toMatchObject({
      client_id: rec.id,
      mime: 'application/pdf',
      sha256: 'a'.repeat(64),
    });
    expect(puts).toHaveLength(1);
    expect(s.callsTo(`POST /uploads/up-${rec.id}/complete`)).toHaveLength(1);
    expect(((await outbox.listPending())[0]?.payload as { uploadId: string }).uploadId).toBe(`up-${rec.id}`);

    itemsFail = false;
    advance(10 * 60_000);
    await engine.push();
    expect(puts).toHaveLength(1); // not uploaded twice
    const body = s.callsTo('POST /items')[1]?.body;
    expect(body).toMatchObject({ client_id: rec.id, source: 'share', upload_id: `up-${rec.id}` });
    expect(body).not.toHaveProperty('kind'); // server derives it from the upload MIME
    expect(await outbox.countPending()).toBe(0);
  });

  it('pull: GET /sync?since= pages through deltas, applies items + tombstones, moves the cursor', async () => {
    const s = new FakeServer()
      .on('POST /auth/anonymous', () => ({ status: 200, body: { ...tokenPair(), created: true } }))
      .on('GET /sync', (c) =>
        c.query.since === '0'
          ? { status: 200, body: { items: [itemOut('c1', 1, { text: 'one' })], next_since: 1, has_more: true } }
          : {
              status: 200,
              body: {
                items: [itemOut('c2', 2, { text: 'two', status: 'ready' })],
                tombstones: [{ entity: 'item', id: 'srv-c1', seq: 3 }],
                next_since: 3,
                has_more: false,
                reminders: [],
              },
            },
      );
    const { records, engine } = setup(s);
    expect(await engine.pull()).toBe(2);
    expect(s.callsTo('GET /sync').map((c) => c.query.since)).toEqual(['0', '1']);
    expect(await records.getCursor()).toBe(3);
    expect((await records.list()).map((r) => r.text)).toEqual(['two']); // c1 deleted
  });
});

it('backoff grows exponentially, is capped, and honours Retry-After', () => {
  const r = () => 0.5;
  expect([0, 1, 2, 3].map((a) => backoffMs(a, null, r))).toEqual([2000, 4000, 8000, 16000]);
  expect(backoffMs(30, null, r)).toBe(600_000);
  expect(backoffMs(0, 120, r)).toBe(120_000);
});
