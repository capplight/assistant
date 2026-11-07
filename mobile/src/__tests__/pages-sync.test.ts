import { ApiClient } from '@/api/client';
import { Api } from '@/api/endpoints';
import { MemorySecretStore, TokenStorage } from '@/api/tokens';
import { InMemoryOutboxRepository } from '@/db/outbox';
import { InMemoryPagesRepository } from '@/db/pages';
import { InMemoryRecordsRepository } from '@/db/records';
import { pageEntries } from '@/pages/contents';
import { RecordActions } from '@/records/actions';
import { Capture } from '@/records/capture';
import { reviewRows, unverifiedCount } from '@/records/review';
import { migrateV0, seedPages, type Page } from '@/store/pages';
import { SyncEngine } from '@/sync/engine';
import { createOut, FakeServer, happyServer, itemOut, linkOut, pageOut } from '@/testing/fakeServer';
import { fakeFiles } from '@/testing/helpers';

function setup(server: FakeServer) {
  let clock = 1_000_000;
  const now = () => clock;
  const outbox = new InMemoryOutboxRepository(now);
  const records = new InMemoryRecordsRepository(now);
  const pages = new InMemoryPagesRepository(now);
  const api = new Api(
    new ApiClient({
      fetch: server.fetch,
      tokens: new TokenStorage(new MemorySecretStore()),
      baseUrl: () => 'http://api.test',
    }),
    async () => undefined,
  );
  const onChanged = jest.fn();
  const onAutoMerged = jest.fn();
  const engine = new SyncEngine({
    api,
    outbox,
    records,
    pages,
    installId: async () => 'install-1',
    deviceInfo: () => ({ platform: 'ios', capabilities: {} }),
    now,
    random: () => 0.5,
    onChanged,
    onAutoMerged,
  });
  const capture = new Capture({ outbox, records, files: fakeFiles });
  const actions = new RecordActions({ records, outbox });
  return { outbox, records, pages, engine, capture, actions, onChanged, onAutoMerged, advance: (ms: number) => (clock += ms) };
}

const page = (o: Partial<Page> = {}): Page => ({ ...seedPages()[0]!, createdBy: 'user', ...o });

const reviewed = (clientId: string, seq: number, state: 'unverified' | 'verified' = 'unverified', value = '389 990 ₸') =>
  itemOut(clientId, seq, {
    status: 'needs_review',
    review_fields: { amount_1: { kind: 'amount', value, state } },
  });

describe('pages through the outbox', () => {
  it('creates queued pages with one POST /pages each, idempotent by client_id; also rows from weeks 1-2', async () => {
    const s = happyServer();
    const { outbox, pages, engine } = setup(s);
    // A row as week 1 wrote it: integer position, no server fields.
    const legacy = { id: 'p-old', templateKey: 'notes', title: null, icon: 'documents', layout: 'stacks', position: 0, createdBy: 'seed', createdAt: 'x' };
    await outbox.enqueue('pages.create', { pages: [legacy, { ...legacy, id: 'p-2', templateKey: 'custom', title: 'Дача', createdBy: 'onboarding_blank', position: 1 }] });
    await engine.push();

    const bodies = s.callsTo('POST /pages').map((c) => c.body);
    expect(bodies).toEqual([
      { client_id: 'p-old', template_key: 'notes' }, // `seed` is not a value the server takes
      { client_id: 'p-2', template_key: 'custom', title: 'Дача', created_by: 'onboarding_blank' },
    ]);
    expect(s.callsTo('POST /pages')[0]?.headers['Idempotency-Key']).toBe('p-old');
    expect(await outbox.countPending()).toBe(0);
    expect(await pages.get('p-2')).toMatchObject({ serverId: 'srv-p-2', syncState: 'synced', title: 'Дача' });
  });

  it('singleton_exists: the local page becomes the existing one, the screen keeps its id', async () => {
    const s = happyServer();
    s.on('POST /pages', () => ({
      status: 409,
      body: { code: 'singleton_exists', message_ru: '', message_kk: '', details: { page_id: 'srv-notes' } },
    })).on('GET /pages/*', () => ({
      status: 200,
      body: pageOut(null, 9, { id: 'srv-notes', template_key: 'notes', title: 'Заметки', position: 'k' }),
    }));
    const { outbox, pages, engine } = setup(s);
    const p = page({ id: 'local-notes', templateKey: 'notes' });
    await pages.insertLocal(p);
    await outbox.enqueue('pages.create', { pages: [p] });
    await engine.push();
    expect(outbox.all()[0]?.status).toBe('sent');
    const row = await pages.get('local-notes');
    expect(row).toMatchObject({ serverId: 'srv-notes', position: 'k', title: null });
    expect(await pages.listAll()).toHaveLength(1);
  });

  it('offline keeps it queued; a permanent refusal (pages_limit) stays on the phone, row kept as failed', async () => {
    const s = happyServer();
    const { outbox, pages, engine, advance } = setup(s);
    const p = page({ id: 'p1' });
    await pages.insertLocal(p);
    await outbox.enqueue('pages.create', { pages: [p] });
    s.offline = true;
    await engine.push();
    expect(await outbox.countPending()).toBe(1);

    s.offline = false;
    s.on('POST /pages', () => ({ status: 422, body: { code: 'pages_limit', message_ru: '', message_kk: '' } }));
    advance(60_000);
    await engine.push();
    expect(outbox.all()[0]).toMatchObject({ status: 'failed', lastError: 'pages_limit' });
    expect(await pages.get('p1')).toMatchObject({ syncState: 'failed', serverId: null });
  });

  it('saved from a page: waits for the page, then POST /items and POST /pages/{id}/items', async () => {
    const s = happyServer();
    const { outbox, pages, engine, capture, advance } = setup(s);
    const p = page({ id: 'p1', templateKey: 'custom' });
    await pages.insertLocal(p);
    const rec = await capture.saveText({ text: 'плитка 24 м²', source: 'typed', pageId: 'p1' });
    // The item row runs first here to prove it does not go ahead without its page.
    await outbox.enqueue('pages.create', { pages: [p] });
    await engine.push();
    expect(s.callsTo('POST /items')).toHaveLength(0);
    advance(60_000);
    await engine.push();
    expect(s.callsTo('POST /items')).toHaveLength(1);
    expect(s.callsTo('POST /pages/srv-p1/items')[0]?.body).toEqual({ item_id: `srv-${rec.id}` });
    expect(await pages.linksFor('srv-p1')).toHaveLength(1);
  });

  it('«Сегодня» and other non-pages get no link', async () => {
    const s = happyServer();
    const { engine, capture } = setup(s);
    await capture.saveText({ text: 'x', source: 'typed', pageId: 'today' });
    await engine.push();
    expect(s.calls.some((c) => /\/pages\/.*\/items/.test(c.path))).toBe(false);
  });

  it('rename: PATCH, a pull during the wait does not undo it; empty name returns to the default', async () => {
    const s = happyServer();
    const { outbox, pages, engine } = setup(s);
    await pages.insertLocal(page({ id: 'p1', templateKey: 'custom', serverId: 'srv-1', syncState: 'synced' }));
    await pages.setTitle('p1', 'Дача');
    await pages.applyRemote(pageOut('p1', 0, { id: 'srv-1', title: 'Старое' }));
    expect((await pages.get('p1'))?.title).toBe('Дача');

    await outbox.enqueue('pages.update', { pageId: 'p1', title: 'Дача' });
    await outbox.enqueue('pages.update', { pageId: 'p1', title: null });
    await engine.push();
    expect(s.callsTo('PATCH /pages/srv-1').map((c) => c.body)).toEqual([{ title: 'Дача' }, { title: 'Моя страница' }]);
    expect((await pages.get('p1'))?.title).toBeNull();
  });

  it('pull: screens, links, tombstones; «Сегодня» is skipped; lists are told to reload', async () => {
    const s = happyServer();
    s.on('GET /sync', () => ({
      status: 200,
      body: {
        items: [itemOut('c1', 3)],
        screens: [
          pageOut(null, 1, { id: 'srv-today', kind: 'system_today', template_key: 'today', title: 'Сегодня' }),
          pageOut(null, 2, { id: 'srv-a', title: 'Дача' }),
          pageOut(null, 4, { id: 'srv-gone', deleted_at: '2026-11-07T10:00:00Z' }),
        ],
        screen_items: [linkOut('srv-a', 'srv-c1', 5), linkOut('srv-a', 'srv-x', 6)],
        tombstones: [{ entity: 'screen_item', id: 'link-srv-a-srv-x', seq: 7, deleted_at: 'x' }],
        next_since: 7,
        has_more: false,
      },
    }));
    const { pages, records, engine, onChanged } = setup(s);
    await engine.run();
    const all = await pages.listAll();
    expect(all.map((p) => p.serverId).sort()).toEqual(['srv-a', 'srv-gone']);
    expect(all.find((p) => p.serverId === 'srv-gone')?.deletedAt).not.toBeNull();
    expect((await pages.linksFor('srv-a')).map((l) => l.itemServerId)).toEqual(['srv-c1']);
    expect(await records.getCursor()).toBe(7);
    expect(onChanged).toHaveBeenCalled();
  });

  it('a page nobody renamed keeps following the app language', async () => {
    const pages = new InMemoryPagesRepository();
    await pages.applyRemote(pageOut(null, 1, { id: 'a', template_key: 'notes', title: 'Заметки', title_kk: 'Жазбалар' }));
    await pages.applyRemote(pageOut(null, 2, { id: 'b', template_key: 'custom', title: 'Дача', title_kk: 'Саяжай' }));
    expect(await pages.get('a')).toMatchObject({ title: null, titleKk: null });
    expect(await pages.get('b')).toMatchObject({ title: 'Дача', titleKk: 'Саяжай' });
  });
});

describe('page contents', () => {
  const links = [
    { id: 'l1', pageServerId: 'P', itemServerId: 'srv-b', position: 'k', manualOrder: false, pinned: false, removedAt: null, seq: 1 },
    { id: 'l2', pageServerId: 'P', itemServerId: 'srv-a', position: 'B', manualOrder: true, pinned: false, removedAt: null, seq: 2 },
    { id: 'l3', pageServerId: 'P', itemServerId: 'srv-gone', position: 'C', manualOrder: false, pinned: false, removedAt: '2026-01-01', seq: 3 },
  ];

  async function repo() {
    let t = 1000;
    const records = new InMemoryRecordsRepository(() => t++);
    for (const [id, at] of [['a', '2026-01-01'], ['b', '2026-02-01'], ['gone', '2026-03-01'], ['other', '2026-04-01']] as const) {
      await records.applyRemote(itemOut(id, 1, { occurred_at: `${at}T10:00:00Z` }));
    }
    return records;
  }

  it('shows linked rows in key order; removed rows and rows of other pages do not show', async () => {
    const records = await repo();
    const out = pageEntries(page({ id: 'p', templateKey: 'custom', serverId: 'P' }), await records.list(), links);
    expect(out.map((e) => e.record.id)).toEqual(['a', 'b']);
  });

  it('«Заметки» (rule: always) shows everything at once, offline too, except what was removed', async () => {
    const records = await repo();
    const out = pageEntries(page({ id: 'p', templateKey: 'notes', serverId: 'P' }), await records.list(), links);
    expect(out.map((e) => e.record.id).sort()).toEqual(['a', 'b', 'other']);
  });

  it('a new record goes by its date: under rows placed by hand, above older rows', async () => {
    const records = await repo();
    await records.insertLocal({ id: 'new', kind: 'note', source: 'typed', text: 'x', pageId: 'p', occurredAt: '2026-05-01T10:00:00Z' });
    const out = pageEntries(page({ id: 'p', templateKey: 'custom', serverId: 'P' }), await records.list(), links);
    expect(out.map((e) => e.record.id)).toEqual(['a', 'new', 'b']);
  });

  it('a page not yet on the server shows what was saved on it', async () => {
    const records = new InMemoryRecordsRepository();
    await records.insertLocal({ id: 'r', kind: 'note', source: 'typed', text: 'x', pageId: 'p' });
    await records.insertLocal({ id: 'elsewhere', kind: 'note', source: 'typed', text: 'y', pageId: 'today' });
    const out = pageEntries(page({ id: 'p', templateKey: 'custom' }), await records.list(), []);
    expect(out.map((e) => e.record.id)).toEqual(['r']);
  });
});

describe('«Верно»', () => {
  async function withReviewed(server: FakeServer, ctx: ReturnType<typeof setup>) {
    await ctx.records.applyRemote(reviewed('c1', 5));
    return server;
  }

  it('works at once, offline; sent later with base_seq; only then is it cleared', async () => {
    const s = happyServer();
    const ctx = setup(s);
    await withReviewed(s, ctx);
    s.on('PATCH /items/*', () => ({ status: 200, body: reviewed('c1', 6, 'verified') }));

    s.offline = true;
    await ctx.actions.verify('c1', 'amount_1');
    await ctx.actions.verify('c1', 'amount_1'); // double tap: one row
    expect(ctx.outbox.all().filter((e) => e.kind === 'item.verify')).toHaveLength(1);
    expect(unverifiedCount((await ctx.records.get('c1'))!)).toBe(0);
    await ctx.engine.run();
    expect(unverifiedCount((await ctx.records.get('c1'))!)).toBe(0);

    s.offline = false;
    ctx.advance(60_000);
    await ctx.engine.push();
    expect(s.callsTo('PATCH /items/srv-c1').at(-1)?.body).toEqual({ verify: ['amount_1'], base_seq: 5 });
    const rec = (await ctx.records.get('c1'))!;
    expect(rec.seq).toBe(6);
    expect(rec.reviewFields.amount_1?.state).toBe('verified');
    expect(rec.pending.verify).toEqual({});
  });

  it('a delta from /sync while the verify waits does not bring the mark back', async () => {
    const s = happyServer();
    const ctx = setup(s);
    await withReviewed(s, ctx);
    await ctx.actions.verify('c1', 'amount_1');
    await ctx.records.applyRemote(reviewed('c1', 6));
    expect(unverifiedCount((await ctx.records.get('c1'))!)).toBe(0);
  });

  it('409 and the same value: confirmed against the new seq', async () => {
    const s = happyServer();
    const ctx = setup(s);
    await withReviewed(s, ctx);
    s.on('PATCH /items/*', (c) =>
      (c.body as { base_seq: number }).base_seq === 5
        ? { status: 409, body: { code: 'conflict', message_ru: '', message_kk: '', details: { seq: 8 } } }
        : { status: 200, body: reviewed('c1', 9, 'verified') },
    ).on('GET /items/*', () => ({ status: 200, body: reviewed('c1', 8) }));
    await ctx.actions.verify('c1', 'amount_1');
    await ctx.engine.push();
    expect(s.callsTo('PATCH /items/srv-c1').map((c) => c.body)).toEqual([
      { verify: ['amount_1'], base_seq: 5 },
      { verify: ['amount_1'], base_seq: 8 },
    ]);
    expect(ctx.outbox.all().at(-1)?.status).toBe('sent');
    expect((await ctx.records.get('c1'))?.reviewFields.amount_1?.state).toBe('verified');
  });

  it('409 and the value changed: not confirmed, the card asks about the new value', async () => {
    const s = happyServer();
    const ctx = setup(s);
    await withReviewed(s, ctx);
    s.on('PATCH /items/*', () => ({ status: 409, body: { code: 'conflict', message_ru: '', message_kk: '', details: { seq: 8 } } }))
      .on('GET /items/*', () => ({ status: 200, body: reviewed('c1', 8, 'unverified', '398 990 ₸') }));
    await ctx.actions.verify('c1', 'amount_1');
    await ctx.engine.push();
    expect(s.callsTo('PATCH /items/srv-c1')).toHaveLength(1);
    const rec = (await ctx.records.get('c1'))!;
    expect(reviewRows(rec)).toEqual([{ key: 'amount_1', kind: 'amount', value: '398 990 ₸', verified: false }]);
  });

  it('a value that changed under a waiting «Верно» has to be confirmed again', async () => {
    const s = happyServer();
    const ctx = setup(s);
    await withReviewed(s, ctx);
    await ctx.actions.verify('c1', 'amount_1');
    await ctx.records.applyRemote(reviewed('c1', 6, 'unverified', '1 ₸'));
    expect(unverifiedCount((await ctx.records.get('c1'))!)).toBe(1);
  });

  it('a permanent refusal clears the local mark, the field asks again', async () => {
    const s = happyServer();
    const ctx = setup(s);
    await withReviewed(s, ctx);
    s.on('PATCH /items/*', () => ({ status: 409, body: { code: 'item_deleted', message_ru: '', message_kk: '' } }));
    await ctx.actions.verify('c1', 'amount_1');
    await ctx.engine.push();
    expect(ctx.outbox.all().at(-1)).toMatchObject({ status: 'failed' });
    expect(unverifiedCount((await ctx.records.get('c1'))!)).toBe(1);
  });
});

describe('automatic merge and «Отменить»', () => {
  const merged = (clientId: string, seq: number) =>
    itemOut(clientId, seq, { hidden_reason: 'duplicate_merged', canonical_id: 'srv-orig', status: 'ready' });
  const duplicate = { canonical_id: 'srv-orig', canonical_created_at: '2026-03-12T10:00:00Z', undo_path: '/v1/items/x/unmerge' };

  function mergingServer() {
    const s = happyServer();
    s.on('POST /items', (c) => {
      const id = (c.body as { client_id: string }).client_id;
      return { status: 201, body: { item: merged(id, 3), created: true, auto_merged: true, duplicate } };
    });
    return s;
  }

  it('hides the repeat, tells the UI; on a page the original shows instead', async () => {
    const s = mergingServer();
    const ctx = setup(s);
    await ctx.pages.insertLocal(page({ id: 'p1', templateKey: 'custom', serverId: 'srv-p1', syncState: 'synced' }));
    const rec = await ctx.capture.saveText({ text: 'x', source: 'typed', pageId: 'p1' });
    await ctx.engine.push();
    expect(ctx.onAutoMerged).toHaveBeenCalledWith(rec.id, duplicate.canonical_created_at);
    expect(await ctx.records.list()).toEqual([]);
    expect(s.callsTo('POST /pages/srv-p1/items')[0]?.body).toEqual({ item_id: 'srv-orig' });
  });

  it('«Отменить» shows it again at once, offline too; POST unmerge when online', async () => {
    const s = mergingServer();
    s.on('POST /items/*/unmerge', () => ({ status: 200, body: itemOut('c-x', 9) }));
    const ctx = setup(s);
    const rec = await ctx.capture.saveText({ text: 'x', source: 'typed' });
    await ctx.engine.push();

    s.offline = true;
    await ctx.actions.unmerge(rec.id);
    expect((await ctx.records.list()).map((r) => r.id)).toEqual([rec.id]);
    await ctx.engine.push();

    s.offline = false;
    ctx.advance(60_000);
    await ctx.engine.push();
    expect(s.callsTo(`POST /items/srv-${rec.id}/unmerge`)).toHaveLength(1);
    expect(await ctx.outbox.countPending()).toBe(0);
    const after = (await ctx.records.get(rec.id))!;
    expect(after.pending.unmerge).toBeUndefined();
    expect(after.hiddenReason).toBeNull();
  });

  it('if the server refuses, the record is hidden again, as it is there', async () => {
    const s = mergingServer();
    s.on('POST /items/*/unmerge', () => ({ status: 409, body: { code: 'conflict', message_ru: '', message_kk: '' } }));
    const ctx = setup(s);
    const rec = await ctx.capture.saveText({ text: 'x', source: 'typed' });
    await ctx.engine.push();
    await ctx.actions.unmerge(rec.id);
    await ctx.engine.push();
    expect(await ctx.records.list()).toEqual([]);
  });
});

describe('voice recording', () => {
  it('sends fragments with the keys the server takes; the first one is the record, the rest stay out of lists', async () => {
    const s = happyServer();
    s.on('POST /items', (c) => {
      const id = (c.body as { client_id: string }).client_id;
      return { status: 201, body: createOut(itemOut(id, 1, { kind: 'voice' })) };
    });
    const ctx = setup(s);
    const rec = (await ctx.capture.saveVoice({
      fragments: [
        { uri: 'file:///a.m4a', durationMs: 180000 },
        { uri: 'file:///b.m4a', durationMs: 20000 },
      ],
    }))!;
    await ctx.engine.push();
    const bodies = s.callsTo('POST /items').map((c) => c.body as { client_id: string; source_meta: object });
    expect(bodies[0]?.client_id).toBe(rec.id);
    expect(bodies[1]?.source_meta).toMatchObject({ recording_id: rec.id, fragment: 1, fragments: 2 });
    expect((await ctx.records.list()).map((r) => r.serverId)).toEqual([`srv-${rec.id}`]);
  });
});

describe('a repeat found after saving (files and voice)', () => {
  it('the record leaves the list, and «Отменить» is offered with the date of the original', async () => {
    const s = happyServer();
    s.on('GET /sync', () => ({
      status: 200,
      body: {
        items: [itemOut('c1', 5, { hidden_reason: 'duplicate_merged', canonical_id: 'srv-orig' })],
        tombstones: [],
        next_since: 5,
        has_more: false,
      },
    }));
    const ctx = setup(s);
    await ctx.records.applyRemote(itemOut('c1', 1));
    await ctx.records.applyRemote(itemOut('orig', 2, { occurred_at: '2026-03-12T10:00:00Z' }));
    await ctx.engine.pull();
    expect(ctx.onAutoMerged).toHaveBeenCalledTimes(1);
    expect(ctx.onAutoMerged).toHaveBeenCalledWith('c1', '2026-03-12T10:00:00Z');
    expect((await ctx.records.list()).map((r) => r.id)).toEqual(['orig']);

    await ctx.engine.pull(); // the same delta again: no second strip
    expect(ctx.onAutoMerged).toHaveBeenCalledTimes(1);
  });

  it('a hidden repeat from another phone is not news', async () => {
    const s = happyServer();
    s.on('GET /sync', () => ({
      status: 200,
      body: { items: [itemOut('c9', 5, { hidden_reason: 'duplicate_merged' })], tombstones: [], next_since: 5, has_more: false },
    }));
    const ctx = setup(s);
    await ctx.engine.pull();
    expect(ctx.onAutoMerged).not.toHaveBeenCalled();
  });
});

describe('AI label', () => {
  it('shows for a generated record and for a generated title or summary on the person\'s own record', async () => {
    const records = new InMemoryRecordsRepository();
    await records.applyRemote(itemOut('a', 1, { ai_generated: true }));
    await records.applyRemote(itemOut('b', 2, { ai_generated: false, ai_fields: ['summary'] }));
    await records.applyRemote(itemOut('c', 3, { ai_generated: false, ai_fields: [] }));
    expect((await records.get('a'))?.aiGenerated).toBe(true);
    expect((await records.get('b'))?.aiGenerated).toBe(true);
    expect((await records.get('c'))?.aiGenerated).toBe(false);
    // The person edited the summary away: the label goes too.
    await records.applyRemote(itemOut('b', 4, { ai_fields: [] }));
    expect((await records.get('b'))?.aiGenerated).toBe(false);
  });
});

describe('page store', () => {
  it('moves positions from weeks 1-2 to LexoRank, keeping the order', () => {
    const { pages } = migrateV0({
      pages: [
        { id: 'b', position: 1 },
        { id: 'a', position: 0 },
      ],
    });
    expect(pages.map((p) => p.id)).toEqual(['a', 'b']);
    expect(pages[0]!.position < pages[1]!.position).toBe(true);
    expect(pages[0]).toMatchObject({ serverId: null, syncState: 'pending' });
  });
});
