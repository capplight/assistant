import { act, fireEvent, renderRouter, screen } from 'expo-router/testing-library';

import { moveRecordsToThisAccount } from '@/account/switch';
import { manualOut } from '@/api/endpoints';
import type { PageItemOut } from '@/api/types';
import { InMemoryPagesRepository, type InMemoryOutboxRepository } from '@/db';
import { dropIndex, entryIndexAfterDrop, shiftFor } from '@/pages/drag';
import { between } from '@/pages/lexorank';
import { EMPTY_VIEW } from '@/pages/viewModel';
import {
  loadEntries,
  movePage,
  moveToPages,
  removeFromPage,
  removePage,
  stepPage,
  stepRecord,
  undoManual,
} from '@/pages/manual';
import { getSyncEngine } from '@/services';
import { usePages, selectSortedPages, type Page } from '@/store/pages';
import { useToast } from '@/store/toast';
import { useUndo } from '@/store/undo';
import { useView } from '@/store/view';
import type { Call } from '@/testing/fakeServer';
import { happyServer, itemOut, linkOut, pageOut } from '@/testing/fakeServer';
import { APP_DIR, finishOnboarding, resetApp, settle, testPages, testRecords } from '@/testing/helpers';

/**
 * Week 7 (F-41, US-27, US-28; docs/api/pages.md «Manual order», 2026-11-08): «Выше / Ниже /
 * перетащил», «⋯», «Порядок», S39, «Убрать с этой страницы», S34 «Мои страницы», «Отменить» —
 * offline, in «Без ИИ», two phones. Fake server only: not the real backend, not a device.
 * Dragging is checked as maths here; the gesture itself needs a real phone.
 */

const SRV = { notes: 'srv-notes', tasks: 'srv-tasks', expenses: 'srv-expenses' } as const;
const ids = ['n1', 'n2', 'n3', 'n4', 'n5'];
const pos = (i: number) => String.fromCharCode(66 + i * 2); // B, D, F, H, J

const page = (k: keyof typeof SRV) => usePages.getState().pages.find((p) => p.templateKey === k)!;
const order = async (k: keyof typeof SRV = 'notes') => (await loadEntries(page(k))).map((e) => e.record.id);
const tabOrder = () => selectSortedPages(usePages.getState()).map((p) => p.templateKey);

/**
 * A server that keeps rows and pages: moves keep the phone's key (as pages.md says), every change
 * returns an action, «Отменить» puts the rows back. `newerOn`: rows another phone moved later.
 */
function manualServer() {
  const s = happyServer();
  let seq = 1000;
  const links = new Map<string, PageItemOut>();
  const pages = new Map<string, { id: string; position: string; key: string }>();
  const undo = new Map<string, PageItemOut[]>();
  const newerOn = new Map<string, PageItemOut>();
  let learned: string | null = null;
  const k = (p: string, i: string) => `${p}|${i}`;
  const put = (l: PageItemOut) => {
    links.set(k(l.page_id, l.item_id), l);
    return l;
  };
  const action = (id: string, before: PageItemOut[], kind = 'screen_reorder_items') => {
    undo.set(id, before);
    return {
      id,
      kind,
      initiated_by: 'user',
      summary: { ru: 'Переставил', kk: null },
      page: null,
      changes: [],
      changed_item_ids: [],
      undoable: true,
      seq: ++seq,
      created_at: new Date().toISOString(),
    };
  };
  const patch = (pageId: string, rows: PageItemOut[]) => ({
    page_id: pageId,
    view_version: 9,
    view_state: null,
    rows,
    removed_item_ids: [],
  });

  s.on('POST /pages/*/items/move', (c) => {
    const pageId = c.path.split('/')[2]!;
    const b = c.body as {
      item_id: string;
      after_item_id: string | null;
      before_item_id: string | null;
      position?: string;
    };
    const old = links.get(k(pageId, b.item_id))!;
    const newer = newerOn.get(k(pageId, b.item_id));
    if (newer) {
      return {
        status: 200,
        body: {
          moved: false,
          reason: 'newer_move',
          repeated: false,
          rebased: false,
          link: put(newer),
          action: null,
          page_patch: patch(pageId, [newer]),
        },
      };
    }
    const lo = b.after_item_id ? (links.get(k(pageId, b.after_item_id))?.position ?? null) : null;
    const hi = b.before_item_id ? (links.get(k(pageId, b.before_item_id))?.position ?? null) : null;
    const position = b.position ?? between(lo, hi);
    const link = put({ ...old, position, manual_order: true, updated_by: 'user', seq: ++seq });
    return {
      status: 200,
      body: {
        moved: true,
        reason: null,
        repeated: false,
        rebased: false,
        link,
        action: action(`a-${seq}`, [old]),
        page_patch: patch(pageId, [link]),
      },
    };
  })
    .on('POST /items/*/move-to-page', (c) => {
      const item = c.path.split('/')[2]!;
      const b = c.body as { mode: string; from_page_id?: string; to_page_ids: string[] };
      const before: PageItemOut[] = [];
      const out: PageItemOut[] = [];
      for (const to of b.to_page_ids) {
        const old = links.get(k(to, item));
        if (old) before.push(old);
        out.push(put({ ...(old ?? linkOut(to, item, 0, { added_by: 'user' })), removed_at: null, seq: ++seq }));
      }
      if (b.mode === 'move' && b.from_page_id) {
        const old = links.get(k(b.from_page_id, item)) ?? linkOut(b.from_page_id, item, 0);
        before.push(old);
        out.push(put({ ...old, removed_at: new Date().toISOString(), seq: ++seq }));
      }
      return {
        status: 200,
        body: {
          moved: true,
          reason: null,
          repeated: false,
          links: out,
          action: action(`a-${seq}`, before, 'screen_move_items'),
          page_patches: out.map((l) => patch(l.page_id, [l])),
          learned_ru: learned,
        },
      };
    })
    .on('DELETE /pages/*/items/*', (c) => {
      const [, , pageId, , item] = c.path.split('/');
      const old = links.get(k(pageId!, item!)) ?? linkOut(pageId!, item!, 0);
      const link = put({ ...old, removed_at: new Date().toISOString(), seq: ++seq });
      return {
        status: 200,
        body: {
          removed: true,
          repeated: false,
          link,
          action: action(`a-${seq}`, [old], 'screen_remove_item'),
          page_patch: patch(pageId!, [link]),
          still_on: [],
        },
      };
    })
    .on('POST /pages/reorder', (c) => {
      const b = c.body as { page_id: string; position?: string };
      const p = { id: b.page_id, position: b.position ?? 'V', key: b.page_id.replace('srv-', '') };
      pages.set(b.page_id, p);
      ++seq;
      return {
        status: 200,
        body: {
          moved: true,
          reason: null,
          repeated: false,
          page: pageOut(null, seq, { id: p.id, template_key: p.key, title: 'x', position: p.position }),
          action: action(`a-${seq}`, [], 'reorder_screens'),
        },
      };
    })
    .on('POST /actions/*/undo', (c) => {
      const id = c.path.split('/')[2]!;
      const back = (undo.get(id) ?? []).map((l) => put({ ...l, seq: ++seq }));
      return {
        status: 200,
        body: {
          action: { ...action(id, []), undoable: false },
          undo: action(`u-${id}`, []),
          partial: false,
          repeated: false,
          message_ru: null,
          page_patches: back.map((l) => patch(l.page_id, [l])),
        },
      };
    })
    .on('DELETE /pages/*', (c) => ({
      status: 200,
      body: pageOut(null, ++seq, {
        id: c.path.split('/')[2],
        template_key: 'tasks',
        deleted_at: new Date().toISOString(),
      }),
    }))
    .on('POST /pages/*/restore', (c) => ({
      status: 200,
      body: pageOut(null, ++seq, { id: c.path.split('/')[2], template_key: 'tasks' }),
    }))
    .on('GET /sync', (c) => {
      const since = Number(c.query.since ?? 0);
      const rows = [...links.values()].filter((l) => l.seq > since);
      return {
        status: 200,
        body: {
          items: [],
          screen_items: rows,
          tombstones: [],
          next_since: Math.max(since, ...rows.map((l) => l.seq)),
          has_more: false,
        },
      };
    });
  return {
    s,
    links,
    put,
    /** Another phone moved this row later: our move of it loses. */
    newer: (l: PageItemOut) => newerOn.set(k(l.page_id, l.item_id), l),
    learn: (text: string | null) => (learned = text),
    nextSeq: () => ++seq,
  };
}

let srv: ReturnType<typeof manualServer>;
let outbox: InMemoryOutboxRepository;

/** «Заметки» (5 records by hand-free keys B…J), «Дела», «Расходы»: all on the server. */
async function setup(o: { mode?: 'full' | 'no_ai'; offline?: boolean } = {}) {
  srv = manualServer();
  outbox = resetApp({ fetch: srv.s.fetch });
  srv.s.offline = !!o.offline;
  finishOnboarding(o.mode ?? 'full');
  usePages.setState({
    pages: usePages.getState().pages.map((p) => {
      const key = p.templateKey as keyof typeof SRV;
      return { ...p, serverId: SRV[key], syncState: 'synced' as const, createdBy: 'user' as const, viewVersion: 3 };
    }),
  });
  for (const p of usePages.getState().pages) await testPages.insertLocal(p);
  for (const [i, id] of ids.entries()) {
    await testRecords.applyRemote(itemOut(id, i + 1, { text: `Заметка ${i + 1}`, status: 'ready' }));
    const l = srv.put(linkOut(SRV.notes, `srv-${id}`, 100 + i, { position: pos(i) }));
    await testPages.applyLink(l);
  }
  await testRecords.setCursor(200);
}

/** The connection is back and the retry delays are over: send, then /sync. */
async function sync() {
  const e = await getSyncEngine();
  await e.whenIdle();
  for (const r of outbox.all()) if (r.status === 'pending') await outbox.markRetry(r.id, 'test', 0);
  await e.run();
}

const sent = (route: string): Call[] => srv.s.callsTo(route);
const moveCalls = () => srv.s.calls.filter((c) => c.method === 'POST' && /\/items\/move$/.test(c.path));
const undoCalls = () => srv.s.calls.filter((c) => /\/actions\/.+\/undo$/.test(c.path));

describe('dragging, as maths (the gesture needs a phone)', () => {
  it('a row passes a neighbour once it covers half of it, both ways', () => {
    const h = [60, 60, 100, 60];
    expect(dropIndex(h, 0, 29)).toBe(0);
    expect(dropIndex(h, 0, 31)).toBe(1);
    expect(dropIndex(h, 0, 60 + 49)).toBe(1);
    expect(dropIndex(h, 0, 60 + 51)).toBe(2);
    expect(dropIndex(h, 0, 5000)).toBe(3);
    expect(dropIndex(h, 3, -49)).toBe(3);
    expect(dropIndex(h, 3, -51)).toBe(2);
    expect(dropIndex(h, 3, -5000)).toBe(0);
  });

  it('the others move aside by the dragged row; headings do not count as records', () => {
    expect([0, 1, 2, 3].map((i) => shiftFor(i, 0, 2, 60))).toEqual([0, -60, -60, 0]);
    expect([0, 1, 2, 3].map((i) => shiftFor(i, 3, 1, 60))).toEqual([0, 60, 60, 0]);
    // rows: [heading, r0, r1, heading, r2]; r0 dropped after the second heading = record index 1
    expect(entryIndexAfterDrop([false, true, true, false, true], 1, 3)).toBe(1);
    expect(entryIndexAfterDrop([false, true, true, false, true], 4, 1)).toBe(0);
  });
});

describe('rows changed by hand stay over /sync (US-28)', () => {
  it('in memory: the same answers as SQLite', async () => {
    const repo = new InMemoryPagesRepository(() => 1000);
    await repo.applyLink(linkOut('S', 'i1', 5, { position: 'B' }));
    const server = (await repo.getLink('S', 'i1'))!;
    await repo.writeLocal({ ...server, position: 'M', manualOrder: true });
    await repo.applyLink(linkOut('S', 'i1', 9, { position: 'Z' }));
    expect(await repo.getLink('S', 'i1')).toMatchObject({ position: 'M', pending: 1 });
    await repo.settleLink('S', 'i1', {});
    expect(await repo.getLink('S', 'i1')).toMatchObject({ position: 'Z', pending: 0, seq: 9 });
    await repo.writeLocal({ ...server, id: 'local:x', pageServerId: 'local:p', itemServerId: 'i2' });
    await repo.settleLink('local:p', 'i2', {});
    expect(await repo.getLink('local:p', 'i2')).toBeNull();
  });

  it('answers of every call are read into one shape', () => {
    const link = linkOut('P', 'I', 7, { manual_order: true });
    const move = manualOut({
      moved: true,
      link,
      action: { id: 'a', summary: { ru: 'Переставил' } },
      page_patch: { page_id: 'P', view_version: 4, rows: [link] },
    });
    expect(move).toMatchObject({
      moved: true,
      rows: [link],
      view_versions: [{ page_id: 'P', view_version: 4 }],
      action: { id: 'a' },
    });
    expect(move.rows).toHaveLength(1); // the patch repeats the row: kept once
    const to = manualOut({
      moved: false,
      reason: 'page_removed',
      links: [link],
      page_patches: [],
      learned_ru: 'Похожие положу туда же',
      action: null,
    });
    expect(to).toMatchObject({
      moved: false,
      reason: 'page_removed',
      learned_ru: 'Похожие положу туда же',
      action: null,
    });
    expect(manualOut({ removed: true, link, still_on: [] }).moved).toBe(true);
    expect(manualOut({ moved: true, page: pageOut('c', 3, { position: 'W' }) }).pages[0]?.position).toBe('W');
  });
});

describe('«Выше / Ниже» on a page: offline first, the server follows', () => {
  it('moves at once offline, sends the neighbours as seen, the phone key, base_seq and client_ts', async () => {
    await setup({ offline: true });
    await stepRecord(page('notes'), 'n3', -1);
    expect(await order()).toEqual(['n1', 'n3', 'n2', 'n4', 'n5']);
    expect(useUndo.getState().strip).toMatchObject({ kind: 'manual', text: { key: 'move.reordered' } });
    const row = outbox.all().find((r) => r.kind === 'page.item_move')!;
    expect(row.status).toBe('pending');

    srv.s.offline = false;
    await sync();
    const [call] = moveCalls();
    expect(call?.path).toBe(`/pages/${SRV.notes}/items/move`);
    expect(call?.body).toMatchObject({
      client_id: (row.payload as { clientId: string }).clientId,
      item_id: 'srv-n3',
      after_item_id: 'srv-n1',
      before_item_id: 'srv-n2',
      position: between(pos(0), pos(1)),
      base_seq: 200,
      base_view_version: 3,
    });
    expect(typeof (call?.body as { client_ts: string }).client_ts).toBe('string');
    expect(call?.body as object).not.toHaveProperty('group_key'); // no groups: kept as is
    expect(await order()).toEqual(['n1', 'n3', 'n2', 'n4', 'n5']);
    const moved = await testPages.getLink(SRV.notes, 'srv-n3');
    expect(moved?.manualOrder).toBe(true);
    expect(moved?.pending ?? 0).toBe(0);
  });

  it('pressed three times in a row: three steps, each on the order as it is by then', async () => {
    await setup({ offline: true });
    await Promise.all([1, 2, 3].map(() => stepRecord(page('notes'), 'n5', -1)));
    expect(await order()).toEqual(['n1', 'n5', 'n2', 'n3', 'n4']);
    srv.s.offline = false;
    await sync();
    expect(moveCalls().map((c) => (c.body as { after_item_id: string }).after_item_id)).toEqual([
      'srv-n3',
      'srv-n2',
      'srv-n1',
    ]);
    expect(await order()).toEqual(['n1', 'n5', 'n2', 'n3', 'n4']);
  });

  it('«Отменить» before it was sent: dropped from the outbox, nothing goes, the order is back', async () => {
    await setup({ offline: true });
    await stepRecord(page('notes'), 'n2', 1);
    const strip = useUndo.getState().strip;
    if (strip?.kind !== 'manual') throw new Error('no strip');
    await undoManual(strip.outboxIds);
    expect(await order()).toEqual(ids);
    srv.s.offline = false;
    await sync();
    expect(moveCalls()).toHaveLength(0);
    expect(outbox.all().find((r) => r.kind === 'page.item_move')).toMatchObject({
      status: 'failed',
      lastError: 'undone',
    });
  });

  it('«Отменить» after it was sent: the server action undoes it, the phone sends no move of its own', async () => {
    await setup();
    await stepRecord(page('notes'), 'n4', -1);
    await sync();
    expect(moveCalls()).toHaveLength(1);
    const strip = useUndo.getState().strip;
    if (strip?.kind !== 'manual') throw new Error('no strip');
    srv.s.offline = true;
    await undoManual(strip.outboxIds);
    expect(await order()).toEqual(ids); // at once, offline too
    srv.s.offline = false;
    await sync();
    expect(undoCalls()).toHaveLength(1);
    expect(moveCalls()).toHaveLength(1); // no row written as if the person moved it back
    const back = await testPages.getLink(SRV.notes, 'srv-n4');
    expect(back).toMatchObject({ position: pos(3), manualOrder: false });
    expect(back?.pending ?? 0).toBe(0);
  });

  it('«Отменить» while the engine already holds the row in its list: it is still not sent', async () => {
    await setup();
    await stepRecord(page('notes'), 'n2', 1);
    const strip = useUndo.getState().strip;
    if (strip?.kind !== 'manual') throw new Error('no strip');
    await undoManual(strip.outboxIds); // kickSync of the move is on its way at this moment
    await sync();
    // Either the call never went, or it went first and its action undid it: never a move left standing.
    expect(moveCalls().length).toBe(undoCalls().length);
    expect(await order()).toEqual(ids);
  });

  it('the undo says part was changed by the person: the server’s line is shown', async () => {
    await setup();
    await stepRecord(page('notes'), 'n2', 1);
    await sync();
    const strip = useUndo.getState().strip;
    if (strip?.kind !== 'manual') throw new Error('no strip');
    srv.s.on('POST /actions/*/undo', () => ({
      status: 200,
      body: {
        action: null,
        undo: null,
        partial: true,
        repeated: false,
        message_ru: 'Часть уже изменена вами — вернул остальное.',
        page_patches: [],
      },
    }));
    await undoManual(strip.outboxIds);
    await sync();
    expect(useToast.getState().toast?.text).toBe('Часть уже изменена вами — вернул остальное.');
  });

  it('the page version from the answer goes with the next move', async () => {
    await setup();
    await stepRecord(page('notes'), 'n2', 1);
    await sync();
    expect((await testPages.get(page('notes').id))?.viewVersion).toBe(9);
  });

  it('a neighbour with no key yet: no phone key, the server places it', async () => {
    await setup({ offline: true });
    await testRecords.insertLocal({
      id: 'loc2',
      kind: 'note',
      source: 'typed',
      text: 'Новая',
      occurredAt: '2020-01-01T00:00:00Z',
    } as never);
    await stepRecord(page('notes'), 'n5', 1); // below a row the server has not placed
    srv.s.offline = false;
    await sync();
    expect(moveCalls()[0]?.body).toMatchObject({ item_id: 'srv-n5', after_item_id: 'srv-n4' });
    expect(moveCalls()[0]?.body).not.toHaveProperty('position');
  });

  it('another account: moves on the way name old ids, they do not go', async () => {
    await setup({ offline: true });
    await stepRecord(page('notes'), 'n2', 1);
    await moveRecordsToThisAccount();
    expect(outbox.all().find((r) => r.kind === 'page.item_move')).toMatchObject({
      status: 'failed',
      lastError: 'account_switched',
    });
  });

  it('the assistant rearranged meanwhile: until the move is sent, the person’s place stays (US-28)', async () => {
    await setup({ offline: true });
    await stepRecord(page('notes'), 'n5', -1);
    // /sync brings the assistant's row for n5 (another device asked «разложи»)
    await testPages.applyLink(linkOut(SRV.notes, 'srv-n5', 500, { position: 'A', group_key: 'Ремонт' }));
    expect(await order()).toEqual(['n1', 'n2', 'n3', 'n5', 'n4']);
    useView.getState().reset();
  });

  it('two phones moved the same row: the later one wins, shown there with no question', async () => {
    await setup();
    srv.newer(linkOut(SRV.notes, 'srv-n1', 900, { position: 'Z', manual_order: true }));
    await stepRecord(page('notes'), 'n1', 1);
    await sync();
    expect(await order()).toEqual(['n2', 'n3', 'n4', 'n5', 'n1']);
    expect(useUndo.getState().strip).toMatchObject({ kind: 'manual' }); // no dialog
  });

  it('two phones moved different rows: both stay (each row its own key)', async () => {
    await setup();
    // phone B moved n5 to the top before; it arrives by /sync
    const b = srv.put(linkOut(SRV.notes, 'srv-n5', srv.nextSeq(), { position: '9', manual_order: true }));
    await stepRecord(page('notes'), 'n1', 1); // phone A: n1 below n2
    await sync();
    expect((await testPages.getLink(SRV.notes, 'srv-n5'))?.position).toBe(b.position);
    expect(await order()).toEqual(['n5', 'n2', 'n1', 'n3', 'n4']);
  });

  it('works in «Без ИИ»: the same calls, no /chat', async () => {
    await setup({ mode: 'no_ai' });
    await stepRecord(page('notes'), 'n2', -1);
    await sync();
    expect(moveCalls()).toHaveLength(1);
    expect(srv.s.calls.some((c) => c.path.startsWith('/chat'))).toBe(false);
  });

  it('a record saved offline is moved under a local key and sent once it is on the server', async () => {
    await setup({ offline: true });
    await testRecords.insertLocal({
      id: 'loc1',
      kind: 'note',
      source: 'typed',
      text: 'Новая',
      occurredAt: '2020-01-01T00:00:00Z',
    } as never);
    await outbox.enqueue('item.create', {
      clientId: 'loc1',
      kind: 'note',
      source: 'typed',
      text: 'Новая',
      occurredAt: '2020-01-01T00:00:00Z',
    });
    expect((await order()).at(-1)).toBe('loc1');
    await stepRecord(page('notes'), 'loc1', -1);
    expect((await order()).slice(-2)).toEqual(['loc1', 'n5']);
    expect(await testPages.getLink(SRV.notes, 'local:loc1')).toMatchObject({ pending: 1 });
    srv.s.offline = false;
    srv.put(linkOut(SRV.notes, 'srv-loc1', srv.nextSeq(), { position: 'Y' })); // the rule placed it
    await sync();
    expect(moveCalls()[0]?.body).toMatchObject({
      item_id: 'srv-loc1',
      after_item_id: 'srv-n4',
      before_item_id: 'srv-n5',
    });
    expect(await testPages.getLink(SRV.notes, 'local:loc1')).toBeNull();
    expect((await order()).slice(-2)).toEqual(['loc1', 'n5']);
  });
});

describe('S39 and «Убрать с этой страницы» (US-27)', () => {
  it('«Переместить» offline: gone from here, on the other page at once; one call; the server’s learning shown', async () => {
    await setup({ offline: true });
    const rec = (await testRecords.get('n2'))!;
    await moveToPages(rec, page('notes'), [page('expenses')], 'move');
    expect(await order()).toEqual(['n1', 'n3', 'n4', 'n5']);
    expect(await order('expenses')).toEqual(['n2']);
    expect(useUndo.getState().strip).toMatchObject({
      kind: 'manual',
      text: { key: 'move.done' },
      openPageId: page('expenses').id,
    });
    srv.learn('Похожие положу туда же');
    srv.s.offline = false;
    await sync();
    expect(sent('POST /items/srv-n2/move-to-page')[0]?.body).toMatchObject({
      mode: 'move',
      from_page_id: SRV.notes,
      to_page_ids: [SRV.expenses],
    });
    const strip = useUndo.getState().strip;
    expect(strip?.kind === 'manual' && strip.text.extra).toBe('Похожие положу туда же');
    expect(await order()).toEqual(['n1', 'n3', 'n4', 'n5']);
    expect(await order('expenses')).toEqual(['n2']);
  });

  it('«Показать ещё на» two pages: one call, stays here too; «Отменить» goes through the action', async () => {
    await setup();
    const rec = (await testRecords.get('n1'))!;
    await moveToPages(rec, page('notes'), [page('tasks'), page('expenses')], 'also_show');
    await sync();
    expect(sent('POST /items/srv-n1/move-to-page')[0]?.body).toMatchObject({
      mode: 'also_show',
      to_page_ids: [SRV.tasks, SRV.expenses],
    });
    expect(sent('POST /items/srv-n1/move-to-page')[0]?.body).not.toHaveProperty('from_page_id');
    expect(await order('tasks')).toEqual(['n1']);
    expect(await order()).toEqual(ids);
    const strip = useUndo.getState().strip;
    if (strip?.kind !== 'manual') throw new Error('no strip');
    await undoManual(strip.outboxIds);
    expect(await order('tasks')).toEqual([]);
    await sync();
    expect(undoCalls()).toHaveLength(1);
  });

  it('«Убрать с этой страницы»: DELETE with client_id, hidden here, offline at once', async () => {
    await setup({ offline: true });
    await removeFromPage((await testRecords.get('n3'))!, page('notes'));
    expect(await order()).toEqual(['n1', 'n2', 'n4', 'n5']);
    srv.s.offline = false;
    await sync();
    const [call] = srv.s.calls.filter((c) => c.method === 'DELETE' && c.path === `/pages/${SRV.notes}/items/srv-n3`);
    expect(call?.query.client_id).toBeTruthy();
    expect(await order()).toEqual(['n1', 'n2', 'n4', 'n5']);
  });
});

describe('S34: the page order = the tab order', () => {
  it('↑ offline: tabs follow at once; sent with neighbours and the key; «Отменить» after sending: the action', async () => {
    await setup({ offline: true });
    expect(tabOrder()).toEqual(['notes', 'tasks', 'expenses']);
    await stepPage(page('expenses').id, -1);
    expect(tabOrder()).toEqual(['notes', 'expenses', 'tasks']);
    srv.s.offline = false;
    await sync();
    expect(sent('POST /pages/reorder')[0]?.body).toMatchObject({
      page_id: SRV.expenses,
      after_page_id: SRV.notes,
      before_page_id: SRV.tasks,
      position: between(page('notes').position, page('tasks').position),
    });
    expect(tabOrder()).toEqual(['notes', 'expenses', 'tasks']);
    const strip = useUndo.getState().strip;
    if (strip?.kind !== 'manual') throw new Error('no strip');
    await undoManual(strip.outboxIds);
    expect(tabOrder()).toEqual(['notes', 'tasks', 'expenses']);
    await sync();
    expect(undoCalls()).toHaveLength(1);
    expect(sent('POST /pages/reorder')).toHaveLength(1);
  });

  it('dragged to the top; «Убрать» and its «Отменить» before sending: nothing goes', async () => {
    await setup({ offline: true });
    await movePage(page('expenses').id, 0);
    expect(tabOrder()).toEqual(['expenses', 'notes', 'tasks']);
    await removePage(page('tasks').id);
    expect(tabOrder()).toEqual(['expenses', 'notes']);
    const strip = useUndo.getState().strip;
    if (strip?.kind !== 'manual') throw new Error('no strip');
    await undoManual(strip.outboxIds);
    expect(tabOrder()).toEqual(['expenses', 'notes', 'tasks']);
    srv.s.offline = false;
    await sync();
    expect(srv.s.calls.filter((c) => c.method === 'DELETE' && c.path === `/pages/${SRV.tasks}`)).toHaveLength(0);
    expect(sent('POST /pages/reorder')[0]?.body).toMatchObject({ page_id: SRV.expenses, before_page_id: SRV.notes });
  });
});

describe('«Отменить» of what stays on this phone only', () => {
  it('a page the server refused: the row goes back, nothing is sent', async () => {
    await setup();
    await testPages.detachFromAccount(); // no server ids: every page is on this phone only
    for (const p of usePages.getState().pages) await testPages.markFailed(p.id);
    const local: Page = { ...page('tasks'), serverId: null, syncState: 'failed' };
    usePages.setState((st) => ({
      pages: st.pages.map((p) => ({ ...p, serverId: null, syncState: 'failed' as const })),
    }));
    await testRecords.applyRemote(itemOut('z1', 300, { text: 'Своя', status: 'ready', page_id: null }));
    await moveToPages((await testRecords.get('z1'))!, page('notes'), [local], 'also_show');
    await sync();
    expect(await order('tasks')).toContain('z1');
    const strip = useUndo.getState().strip;
    if (strip?.kind !== 'manual') throw new Error('no strip');
    await undoManual(strip.outboxIds);
    expect(await order('tasks')).not.toContain('z1');
    expect(sent('POST /items/srv-z1/move-to-page')).toHaveLength(0);
  });

  it('a placeholder page of the first launch: the tab goes back after «Отменить»', async () => {
    srv = manualServer();
    outbox = resetApp({ fetch: srv.s.fetch });
    finishOnboarding('full'); // seed pages: only in the store
    await stepPage(page('expenses').id, -1);
    expect(tabOrder()).toEqual(['notes', 'expenses', 'tasks']);
    await sync();
    const strip = useUndo.getState().strip;
    if (strip?.kind !== 'manual') throw new Error('no strip');
    await undoManual(strip.outboxIds);
    expect(tabOrder()).toEqual(['notes', 'tasks', 'expenses']);
    expect(sent('POST /pages/reorder')).toHaveLength(0);
  });
});

describe('on screen', () => {
  async function open(url = `/page/${page('notes').id}`) {
    const r = await renderRouter(APP_DIR, { initialUrl: url });
    await settle(() => screen.queryByTestId(url === '/more' ? 'page-more' : 'record-n1') !== null);
    return r;
  }
  const rowsOnScreen = () =>
    screen.getAllByTestId(/^record-n\d$/).map((n) => String(n.props.testID).replace('record-', ''));

  it('«⋯»: «Выше» twice keeps the sheet open, the strip offers «Отменить»; every control is labelled', async () => {
    await setup({ offline: true });
    await open();
    expect(screen.getByTestId('record-menu-n3').props.accessibilityLabel).toBe('Ещё: Заметка 3');
    const actions = (screen.getByTestId('record-n3').props.accessibilityActions as { name: string }[]).map(
      (a) => a.name,
    );
    expect(actions).toEqual(['up', 'down', 'moveTo', 'menu']);
    await fireEvent.press(screen.getByTestId('record-menu-n3'));
    await fireEvent.press(screen.getByTestId('record-menu-up'));
    await settle(() => rowsOnScreen().join() === 'n1,n3,n2,n4,n5');
    await fireEvent.press(screen.getByTestId('record-menu-up'));
    await settle(() => rowsOnScreen().join() === 'n3,n1,n2,n4,n5');
    expect(screen.getByTestId('record-menu')).toBeTruthy();
    expect(screen.getByTestId('record-menu-up').props.accessibilityState).toMatchObject({ disabled: true });
    expect(screen.getByTestId('record-menu-mine')).toBeTruthy(); // «Вы поставили эту запись сюда сами»
    await fireEvent.press(screen.getByTestId('record-menu-close'));
    expect(screen.getByTestId('undo-strip-text').props.children).toBe('Переставил');
    await fireEvent.press(screen.getByTestId('undo-strip-undo'));
    await settle(() => rowsOnScreen().join() === 'n1,n3,n2,n4,n5');
  });

  it('«Порядок»: ↑ ↓ on every card; «Ниже» moves; «Готово» hides them', async () => {
    await setup({ offline: true });
    await open();
    expect(screen.queryByTestId('record-down-n1')).toBeNull();
    await fireEvent.press(screen.getByTestId('page-order'));
    expect(screen.getByTestId('record-up-n1').props.accessibilityState).toMatchObject({ disabled: true });
    expect(screen.getByTestId('record-down-n1').props.accessibilityLabel).toBe('Ниже: Заметка 1');
    await fireEvent.press(screen.getByTestId('record-down-n1'));
    await settle(() => rowsOnScreen().join() === 'n2,n1,n3,n4,n5');
    await fireEvent.press(screen.getByTestId('page-order'));
    expect(screen.queryByTestId('record-down-n1')).toBeNull();
  });

  it('long press lifts the card; let go without moving: nothing moves', async () => {
    await setup({ offline: true });
    // Week 11а: the sticker grid has no drag (template-screens 2.1); the list engine's drag is checked on the list view.
    const look = { layout: 'stacks' as const, icon: page('notes').icon, view: EMPTY_VIEW };
    await testPages.setLook(page('notes').id, look, false);
    await act(async () => usePages.getState().setLook(page('notes').id, look));
    await open();
    await fireEvent(screen.getByTestId('record-n2'), 'longPress');
    expect(useView.getState().touching).toBe(true); // the assistant's changes wait meanwhile
    await act(async () => {
      screen.getByTestId('page-records').parent?.props.onTouchEnd?.();
    });
    await settle(() => !useView.getState().touching);
    expect(rowsOnScreen().join()).toBe(ids.join());
  });

  it('S39: «Переместить на страницу…» → «Расходы»: gone here, on «Расходы», [Открыть] there', async () => {
    await setup({ offline: true });
    await open();
    await fireEvent.press(screen.getByTestId('record-menu-n2'));
    await fireEvent.press(screen.getByTestId('record-menu-move'));
    await settle(() => screen.queryByTestId('move-sheet') !== null);
    expect(screen.getByTestId(`move-target-${page('notes').id}`).props.accessibilityState).toMatchObject({
      disabled: true,
    });
    expect(screen.getByTestId('move-go').props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.press(screen.getByTestId(`move-target-${page('expenses').id}`));
    expect(screen.getByTestId('move-go').props.accessibilityLabel).toBe('Переместить в Расходы');
    await fireEvent.press(screen.getByTestId('move-go'));
    await settle(() => screen.queryByTestId('record-n2') === null);
    expect(screen.getByTestId('undo-strip-text').props.children).toBe('Перенёс в Расходы.');
    await fireEvent.press(screen.getByTestId('undo-strip-open'));
    await settle(() => screen.queryByTestId('page-expenses') !== null && screen.queryByTestId('record-n2') !== null);
  });

  it('S39 «Показать ещё на»: pages that show it already are ticked and locked', async () => {
    await setup({ offline: true });
    await testPages.applyLink(srv.put(linkOut(SRV.tasks, 'srv-n1', 300)));
    await open();
    await fireEvent.press(screen.getByTestId('record-menu-n1'));
    await fireEvent.press(screen.getByTestId('record-menu-also'));
    await settle(() => screen.queryByTestId('move-sheet') !== null);
    await settle(
      () => screen.getByTestId(`move-target-${page('tasks').id}`).props.accessibilityState?.disabled === true,
    );
    expect(screen.getByTestId(`move-target-${page('tasks').id}`).props.accessibilityLabel).toBe(
      'Дела и напоминания, уже там',
    );
    await fireEvent.press(screen.getByTestId(`move-target-${page('expenses').id}`));
    expect(screen.getByTestId('move-go').props.accessibilityLabel).toBe('Показать (1)');
    await fireEvent.press(screen.getByTestId('move-go'));
    await settle(() => useUndo.getState().strip?.kind === 'manual');
    expect(screen.getByTestId('record-n1')).toBeTruthy(); // stays here too
    expect(await order('expenses')).toEqual(['n1']);
  });

  it('S34 from «Ещё»: «Сегодня» first without buttons, ↑ reorders the tabs, «Убрать» and «Отменить»', async () => {
    await setup({ offline: true });
    await open('/more');
    await settle(() => screen.queryByTestId('more-my_pages') !== null);
    await fireEvent.press(screen.getByTestId('more-my_pages'));
    await settle(() => screen.queryByTestId('my-pages-screen') !== null);
    expect(screen.getByTestId('my-pages-count').props.children).toBe('Страниц: 4 из 20');
    expect(screen.queryByTestId('my-pages-up-today')).toBeNull();
    const tabs = () => screen.getAllByTestId(/^tab-/).map((n) => String(n.props.testID));
    const exp = page('expenses').id;
    expect(screen.getByTestId(`my-pages-up-${exp}`).props.accessibilityLabel).toBe('Выше: Расходы');
    await fireEvent.press(screen.getByTestId(`my-pages-up-${exp}`));
    await settle(() => tabs()[2] === `tab-${exp}`);
    const tasks = page('tasks').id;
    await fireEvent.press(screen.getByTestId(`my-pages-menu-${tasks}`));
    await fireEvent.press(screen.getByTestId('my-pages-sheet-remove'));
    await settle(() => !tabOrder().includes('tasks'));
    expect(screen.getByTestId('undo-strip-text').props.children).toBe(
      'Страница «Дела и напоминания» убрана. Записи остались.',
    );
    await fireEvent.press(screen.getByTestId('undo-strip-undo'));
    // Back as the third page: past the two tabs (design-system TabBar: ≤4 tabs), so it lives in «Ещё».
    await settle(() => tabOrder().includes('tasks'));
    expect(tabOrder()).toEqual(['notes', 'expenses', 'tasks']);
    expect(tabs()).not.toContain(`tab-${tasks}`);
  });
});
