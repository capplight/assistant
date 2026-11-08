import { getOutbox, getPagesRepo, getRecords, placeholderLinkId, type LocalRecord, type PageLink } from '@/db';
import { getSyncEngine, kickSync, notifyDataChanged } from '@/services';
import { comparePages, usePages, type Page } from '@/store/pages';
import { useUndo, type ManualStripText } from '@/store/undo';
import { newId } from '@/utils/id';

import { itemKey, pageEntries, pageKey, placesLocally, type PageEntry } from './contents';
import { between, RankError } from './lexorank';

/**
 * Week 7, by hand (F-41, R-54, US-27; docs/api/pages.md «Manual order»): «Выше / Ниже /
 * перетащил», «Переместить на страницу…», «Показать ещё на…», «Убрать с этой страницы», and the
 * page order in S34. Not AI: all of it works offline and in «Без ИИ».
 *
 * Each change is shown at once and goes to the outbox as one row (idempotent by its `client_id`).
 * The rows it touches stay as the person left them until it is sent: /sync and the assistant's
 * `page_patch` only update the server's copy meanwhile (`PagesRepository.writeLocal` /
 * `settleLink`), so nothing moves under the person (US-28).
 *
 * «Отменить» (10 s): a change still in the outbox is dropped from it (nothing to undo on the
 * server). One that reached the server is undone by its action, `POST /actions/{id}/undo`: the
 * server restores the rows, `manual_order` included. The phone never writes rows that would look
 * like the person's own moves (actions.md). A call that came back without an action changed
 * nothing, so there is nothing to undo.
 */

export type LinkKey = { page: string; item: string };

/** Neighbours kept per side: the nearest one the server knows is sent. */
const NEIGHBOURS = 5;

type Base = {
  clientId: string;
  /** When the person did it (`client_ts`: the later one wins on two phones). */
  at: string;
  /** Set when the server answered: «Отменить» then goes through this action. */
  actionId?: string | null;
  /** The server's keys, when the change was made before the page or record had them. */
  realKeys?: LinkKey[];
};

export type ItemMovePayload = Base & {
  pageId: string;
  recordId: string;
  /** Local record ids right above / below its new place as the person saw them, nearest first. */
  above: string[];
  below: string[];
  /** The key the phone computed; null when the neighbours have the same key (the server re-keys). */
  position: string | null;
  /** `next_since` of the last /sync applied before the move. */
  baseSeq: number;
  /** Absent: keep the group. null: out of any group. */
  groupKey?: string | null;
  baseViewVersion: number;
  keys: [LinkKey];
  /** What the row was before: shown again by «Отменить». */
  before: [PageLink | null];
};

export type MoveToPagePayload = Base & {
  recordId: string;
  fromPageId: string | null;
  toPageIds: string[];
  mode: 'move' | 'also_show';
  /** The target pages' rows, then (mode `move`) the row of the page it left. */
  keys: LinkKey[];
  before: (PageLink | null)[];
};

export type ItemRemovePayload = Base & {
  pageId: string;
  recordId: string;
  keys: [LinkKey];
  before: [PageLink | null];
};

export type PagesReorderPayload = Base & {
  pageId: string;
  /** Local page ids above / below the new place, nearest first («Сегодня» is never one). */
  above: string[];
  below: string[];
  position: string;
  beforePosition: string;
};

export type PageRemovePayload = Base & { pageId: string };

export type LinkPayload = ItemMovePayload | MoveToPagePayload | ItemRemovePayload;

const nowIso = () => new Date().toISOString();

function blankLink(key: LinkKey): PageLink {
  return {
    id: placeholderLinkId(key.page, key.item),
    pageServerId: key.page,
    itemServerId: key.item,
    position: null,
    groupKey: null,
    manualOrder: false,
    pinned: false,
    removedAt: null,
    seq: 0,
  };
}

/** The row of this record on this page under whichever key it has now. */
async function currentLink(page: Pick<Page, 'id' | 'serverId'>, record: LocalRecord): Promise<PageLink | null> {
  const repo = await getPagesRepo();
  const keys: LinkKey[] = [];
  for (const p of new Set([pageKey(page), `local:${page.id}`])) {
    for (const i of new Set([itemKey(record), `local:${record.id}`])) keys.push({ page: p, item: i });
  }
  let found: PageLink | null = null;
  for (const k of keys) {
    const l = await repo.getLink(k.page, k.item);
    if (l && (!found || ((l.pending ?? 0) > 0 && !(found.pending ?? 0)))) found = l;
  }
  return found;
}

const keyOf = (l: PageLink): LinkKey => ({ page: l.pageServerId, item: l.itemServerId });

/**
 * A key strictly between the nearest keys around `at`. `exact` = false when the neighbours have
 * the same key: the phone cannot fit one between them, the server re-keys (pages.md).
 */
function rankAround(list: PageEntry[], at: number): { position: string; exact: boolean } {
  // A neighbour with no key yet (not placed by the server): the nearest keys do not bound the gap.
  const keyed = (e: PageEntry | undefined) => !e || !!e.link?.position;
  const known = keyed(list[at - 1]) && keyed(list[at]);
  let lo: string | null = null;
  for (let i = at - 1; i >= 0 && lo === null; i--) lo = list[i]?.link?.position ?? null;
  let hi: string | null = null;
  for (let i = at; i < list.length && hi === null; i++) hi = list[i]?.link?.position ?? null;
  try {
    return { position: between(lo, hi), exact: known };
  } catch (e) {
    if (e instanceof RankError) return { position: between(lo, null), exact: false };
    throw e;
  }
}

function showStrip(text: ManualStripText, outboxIds: string[], openPageId: string | null = null): void {
  useUndo.getState().showManual(text, outboxIds, openPageId);
}

async function cursor(): Promise<number> {
  try {
    return await (await getRecords()).getCursor();
  } catch {
    return 0;
  }
}

/** One change at a time, each on the order as it is by then («Выше» pressed three times = three steps). */
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(job: () => Promise<T>): Promise<T> {
  const next = chain.then(job, job);
  chain = next.catch(() => undefined);
  return next;
}

/** What the page shows now, from local data (the same list as the screen). */
export async function loadEntries(page: Page): Promise<PageEntry[]> {
  const records = await getRecords();
  const repo = await getPagesRepo();
  const links = [
    ...(page.serverId ? await repo.linksFor(page.serverId) : []),
    ...(await repo.linksFor(`local:${page.id}`)),
  ];
  return pageEntries(page, await records.list(2000), links);
}

// --- on a page: «Выше», «Ниже», dragged ---

/**
 * Puts `entries[from]` at index `to` of the page as shown (`entries` = what is on screen, in
 * order). With groups, it joins the group of the row it now stands next to, on the side it came from.
 */
async function moveInPage(page: Page, entries: PageEntry[], from: number, to: number): Promise<string | null> {
  const entry = entries[from];
  if (!entry || to === from || to < 0 || to >= entries.length) return null;
  const rest = entries.filter((_, i) => i !== from);
  const { position, exact } = rankAround(rest, to);
  const near = to < from ? (rest[to] ?? rest[to - 1]) : (rest[to - 1] ?? rest[to]);
  const grouped = (page.groups?.length ?? 0) > 0;
  const groupKey = grouped ? (near?.link?.groupKey ?? null) : (entry.link?.groupKey ?? null);
  const old = (await currentLink(page, entry.record)) ?? entry.link;
  const key = old ? keyOf(old) : { page: pageKey(page), item: itemKey(entry.record) };
  await (await getPagesRepo()).writeLocal({ ...(old ?? blankLink(key)), position, groupKey, manualOrder: true });
  const ids = (list: PageEntry[]) => list.map((e) => e.record.id);
  const payload: ItemMovePayload = {
    clientId: newId(),
    at: nowIso(),
    pageId: page.id,
    recordId: entry.record.id,
    above: ids(rest.slice(Math.max(0, to - NEIGHBOURS), to)).reverse(),
    below: ids(rest.slice(to, to + NEIGHBOURS)),
    position: exact ? position : null,
    baseSeq: await cursor(),
    ...(grouped ? { groupKey } : {}),
    baseViewVersion: page.viewVersion ?? 0,
    keys: [key],
    before: [old],
  };
  const row = await (await getOutbox()).enqueue('page.item_move', payload);
  notifyDataChanged();
  showStrip({ key: 'move.reordered' }, [row.id]);
  kickSync();
  return row.id;
}

/** «Выше» (-1) / «Ниже» (+1): one step; may be pressed again and again. */
export function stepRecord(page: Page, recordId: string, step: -1 | 1): Promise<string | null> {
  return serial(async () => {
    const entries = await loadEntries(page);
    const i = entries.findIndex((e) => e.record.id === recordId);
    return i < 0 ? null : moveInPage(page, entries, i, i + step);
  });
}

/** Dragged and let go at index `to` of the page's records. */
export function dropRecord(page: Page, recordId: string, to: number): Promise<string | null> {
  return serial(async () => {
    const entries = await loadEntries(page);
    const i = entries.findIndex((e) => e.record.id === recordId);
    return i < 0 ? null : moveInPage(page, entries, i, Math.max(0, Math.min(entries.length - 1, to)));
  });
}

/** Local ids of the pages that show this record now (S39: «сейчас здесь», «уже там»). */
export async function pagesShowing(record: LocalRecord, pages: Page[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const page of pages) {
    const link = await currentLink(page, record);
    const shown = link ? !link.removedAt : placesLocally(page, record);
    if (shown) out.add(page.id);
  }
  return out;
}

// --- between pages (S39) and «Убрать с этой страницы» ---

/** Where a record shown anew on `target` goes for now: by its date, as the server does. */
async function placeOn(target: Page, record: LocalRecord): Promise<string> {
  const list = (await loadEntries(target)).filter((e) => e.record.id !== record.id);
  const date = Date.parse(record.occurredAt) || record.createdAt;
  const at = list.findIndex(
    (e) => !e.link?.manualOrder && (Date.parse(e.record.occurredAt) || e.record.createdAt) < date,
  );
  return rankAround(list, at < 0 ? list.length : at).position;
}

/**
 * «Переместить на страницу…» (`move`: shown on one page, gone from `from`) or «Показать ещё на…»
 * (`also_show`: shown on each of `targets` too). One outbox row, one action.
 */
export function moveToPages(
  record: LocalRecord,
  from: Page,
  targets: Page[],
  mode: 'move' | 'also_show',
): Promise<string | null> {
  return serial(async () => {
    const list = (mode === 'move' ? targets.slice(0, 1) : targets).filter((p) => p.id !== from.id);
    if (list.length === 0) return null;
    const repo = await getPagesRepo();
    const keys: LinkKey[] = [];
    const before: (PageLink | null)[] = [];
    for (const target of list) {
      const old = await currentLink(target, record);
      const key = old ? keyOf(old) : { page: pageKey(target), item: itemKey(record) };
      // Already shown there: it stays where it is. Otherwise where its date puts it.
      const position = old && !old.removedAt ? old.position : await placeOn(target, record);
      await repo.writeLocal({ ...(old ?? blankLink(key)), position, removedAt: null });
      keys.push(key);
      before.push(old);
    }
    if (mode === 'move') {
      const old = await currentLink(from, record);
      const key = old ? keyOf(old) : { page: pageKey(from), item: itemKey(record) };
      await repo.writeLocal({ ...(old ?? blankLink(key)), removedAt: nowIso() });
      keys.push(key);
      before.push(old);
    }
    const payload: MoveToPagePayload = {
      clientId: newId(),
      at: nowIso(),
      recordId: record.id,
      fromPageId: from.id,
      toPageIds: list.map((p) => p.id),
      mode,
      keys,
      before,
    };
    const row = await (await getOutbox()).enqueue('item.move_to_page', payload);
    notifyDataChanged();
    showStrip(
      { key: mode === 'move' ? 'move.done' : 'move.also_done', pages: list },
      [row.id],
      mode === 'move' ? (list[0]?.id ?? null) : null,
    );
    kickSync();
    return row.id;
  });
}

/** «Убрать с этой страницы»: the record stays everywhere else and in search; not put back here. */
export function removeFromPage(record: LocalRecord, page: Page): Promise<string> {
  return serial(async () => {
    const old = await currentLink(page, record);
    const key = old ? keyOf(old) : { page: pageKey(page), item: itemKey(record) };
    await (await getPagesRepo()).writeLocal({ ...(old ?? blankLink(key)), removedAt: nowIso() });
    const payload: ItemRemovePayload = {
      clientId: newId(),
      at: nowIso(),
      pageId: page.id,
      recordId: record.id,
      keys: [key],
      before: [old],
    };
    const row = await (await getOutbox()).enqueue('page.item_remove', payload);
    notifyDataChanged();
    showStrip({ key: 'move.removed' }, [row.id]);
    kickSync();
    return row.id;
  });
}

// --- S34: the page order and «Убрать страницу» ---

const sorted = () => [...usePages.getState().pages].sort(comparePages);

function setStorePosition(pageId: string, position: string): void {
  usePages.setState((s) => ({ pages: s.pages.map((p) => (p.id === pageId ? { ...p, position } : p)) }));
}

/** S34 ↑↓ / drag: the page goes to index `to` of the page list («Сегодня» is not in it). */
export function movePage(pageId: string, to: number): Promise<string | null> {
  return serial(() => writePageMove(pageId, to));
}

/** S34 ↑ (-1) / ↓ (+1). */
export function stepPage(pageId: string, step: -1 | 1): Promise<string | null> {
  return serial(async () => {
    const i = sorted().findIndex((p) => p.id === pageId);
    return i < 0 ? null : writePageMove(pageId, i + step);
  });
}

async function writePageMove(pageId: string, to: number): Promise<string | null> {
  const pages = sorted();
  const from = pages.findIndex((p) => p.id === pageId);
  const page = pages[from];
  if (!page || to === from || to < 0 || to >= pages.length) return null;
  const rest = pages.filter((p) => p.id !== pageId);
  let position: string;
  try {
    position = between(rest[to - 1]?.position ?? null, rest[to]?.position ?? null);
  } catch {
    position = between(rest[to - 1]?.position ?? null, null);
  }
  const repo = await getPagesRepo();
  if (await repo.get(page.id)) await repo.setPosition(page.id, position);
  setStorePosition(page.id, position);
  const payload: PagesReorderPayload = {
    clientId: newId(),
    at: nowIso(),
    pageId: page.id,
    above: rest
      .slice(0, to)
      .map((p) => p.id)
      .reverse(),
    below: rest.slice(to).map((p) => p.id),
    position,
    beforePosition: page.position,
  };
  const row = await (await getOutbox()).enqueue('pages.reorder', payload);
  notifyDataChanged();
  showStrip({ key: 'pages.moved', pages: [page] }, [row.id]);
  kickSync();
  return row.id;
}

/** Pages taken away by «Убрать», kept for «Отменить» (also those only in the store). */
const removedPages = new Map<string, Page>();

/** S34 «Убрать»: the page goes, its records stay (R-46). «Сегодня» is not in this list. */
export function removePage(pageId: string): Promise<string | null> {
  return serial(async () => {
    const page = usePages.getState().pages.find((p) => p.id === pageId);
    if (!page) return null;
    removedPages.set(page.id, page);
    const repo = await getPagesRepo();
    if (await repo.get(pageId)) await repo.setRemoved(pageId, Date.now());
    usePages.setState((s) => ({ pages: s.pages.filter((p) => p.id !== pageId) }));
    const payload: PageRemovePayload = { clientId: newId(), at: nowIso(), pageId };
    const row = await (await getOutbox()).enqueue('pages.remove', payload);
    notifyDataChanged();
    showStrip({ key: 'pages.removed', pages: [page] }, [row.id]);
    kickSync();
    return row.id;
  });
}

function bringBack(pageId: string): void {
  const page = removedPages.get(pageId);
  if (!page) return;
  usePages.setState((s) => (s.pages.some((p) => p.id === pageId) ? s : { pages: [...s.pages, page] }));
}

// --- «Отменить» ---

/** «Отменить» of the strip: every outbox row of that change, newest first. */
export function undoManual(outboxIds: string[]): Promise<void> {
  return serial(async () => {
    for (const id of [...outboxIds].reverse()) await undoOne(id);
    notifyDataChanged();
    kickSync();
  });
}

async function undoOne(outboxId: string): Promise<void> {
  // Decided after a call in flight is over, with the engine kept off the row meanwhile: it is then
  // either still waiting (it will never go) or answered (the undo goes through its action).
  const engine = await getSyncEngine();
  await engine.hold(outboxId);
  try {
    await takeBack(outboxId);
  } finally {
    engine.release(outboxId);
  }
}

async function takeBack(outboxId: string): Promise<void> {
  const outbox = await getOutbox();
  const row = await outbox.get(outboxId);
  if (!row || row.status === 'failed') return; // refused: the server's rows are shown already
  const repo = await getPagesRepo();
  const pending = row.status === 'pending';
  if (pending) await outbox.markFailed(row.id, 'undone'); // never sent: it does not go
  switch (row.kind) {
    case 'page.item_move':
    case 'item.move_to_page':
    case 'page.item_remove': {
      const p = row.payload as LinkPayload;
      // Still waiting, or it stays on this phone only (no answer ever came): only local rows to put back.
      if (pending || !p.realKeys) {
        for (const [i, k] of p.keys.entries()) await repo.settleLink(k.page, k.item, { show: p.before[i] ?? null });
        return;
      }
      if (!p.actionId) return; // the call changed nothing
      // The old rows at once; they wait as pending rows until the undo answers.
      const keys = p.realKeys ?? p.keys;
      for (const [i, k] of keys.entries()) {
        const was = p.before[i] ?? null;
        // No row before: on a page it was shown anew it goes away again; on the page it left it
        // was shown by the page's rule, so it shows again.
        const anew = row.kind === 'item.move_to_page' && i < (p as MoveToPagePayload).toPageIds.length;
        await repo.writeLocal(
          was
            ? { ...was, pageServerId: k.page, itemServerId: k.item }
            : { ...blankLink(k), removedAt: anew ? nowIso() : null },
        );
      }
      await outbox.enqueue('action.undo', { actionId: p.actionId, clientId: newId(), keys });
      return;
    }
    case 'pages.reorder': {
      const p = row.payload as PagesReorderPayload;
      const inDb = !!(await repo.get(p.pageId));
      if (pending) {
        if (inDb) {
          await repo.setPosition(p.pageId, p.beforePosition, false);
          await repo.settlePage(p.pageId, 'position');
        }
        setStorePosition(p.pageId, p.beforePosition);
        return;
      }
      if (p.actionId === null) return; // answered: the call changed nothing
      // Not answered at all (a page only on this phone): only the local place to put back.
      if (inDb) await repo.setPosition(p.pageId, p.beforePosition, !!p.actionId);
      setStorePosition(p.pageId, p.beforePosition);
      if (!p.actionId) return;
      await outbox.enqueue('action.undo', { actionId: p.actionId, clientId: newId(), pageId: p.pageId });
      return;
    }
    case 'pages.remove': {
      const p = row.payload as PageRemovePayload;
      const inDb = !!(await repo.get(p.pageId));
      if (pending) {
        if (inDb) {
          await repo.setRemoved(p.pageId, null, false);
          await repo.settlePage(p.pageId, 'removed');
        }
        bringBack(p.pageId);
        return;
      }
      if (inDb) await repo.setRemoved(p.pageId, null);
      bringBack(p.pageId);
      // Week 9 (pages.md): the removal is an action; «Отменить» = its undo, which brings the page
      // back as `/restore` did. No action known (an older server, or no answer kept): `/restore`.
      if (p.actionId) {
        await outbox.enqueue('action.undo', { actionId: p.actionId, clientId: newId(), restoredPageId: p.pageId });
        return;
      }
      const back: PageRemovePayload = { clientId: newId(), at: nowIso(), pageId: p.pageId };
      await outbox.enqueue('pages.restore', back);
      return;
    }
    default:
      return;
  }
}
