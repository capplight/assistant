import { groupTitles } from '@/api/endpoints';
import type { NoteColor, PageItemOut, PageOut } from '@/api/types';
import { TEMPLATE_DEFAULT_TITLE, type IconKey, type Layout, type TemplateKey } from '@/pages/templates';
import { parseView, viewFromServer, type PageView } from '@/pages/viewModel';
import type { Page, PageCreatedBy } from '@/store/pages';

import type { SqlDb } from './outbox';

/**
 * Local mirror of `screens` + `screen_items` (3-engineering §3.10, docs/api/pages.md).
 * A page is a view: `page_links` only says which server item shows on which server page.
 * The local page id is the page's `client_id` (the id the phone made), or the server id for a page
 * from another device; links are keyed by server ids.
 */
export type LocalPage = Page & {
  deletedAt: number | null;
  hiddenAt: number | null;
  titleDirty: boolean;
  /** Changes of the tab order still in the outbox: /sync keeps the local `position` meanwhile. */
  positionDirty?: number;
  /** «Убрать» / its undo still in the outbox: /sync keeps the local `deletedAt` meanwhile. */
  removedDirty?: number;
  /** Week 11: view changes still in the outbox: /sync keeps the local layout, icon and view meanwhile. */
  viewDirty?: number;
};

/** What a view change touches on the page (S38, `set_view`). */
export type PageLook = { layout: Layout; icon: IconKey; view: PageView };

export type PageLink = {
  id: string;
  pageServerId: string;
  itemServerId: string;
  position: string | null;
  /** Group after «Разложи»; null = not in a group. */
  groupKey?: string | null;
  manualOrder: boolean;
  pinned: boolean;
  /** Week 11а: the sticker's colour on this page («Заметки»); null/absent = none (white). */
  color?: NoteColor | null;
  removedAt: string | null;
  seq: number;
  /**
   * Changes by hand of this row still in the outbox (week 7). While > 0 the row shows the person's
   * change: /sync and `page_patch` only update the server's copy, which is shown once they settle.
   */
  pending?: number;
};

/**
 * `answer`: the server's row after the change (none: refused, cancelled by «Отменить», or the
 * answer did not carry it). `show`: what to show while other changes of the row still wait.
 * `keepShown`: accepted, but no row came back — keep showing the person's version (with the old
 * seq, so the next /sync row replaces it).
 */
export type SettleOptions = { answer?: PageItemOut | null; show?: PageLink | null; keepShown?: boolean };

/**
 * One pending change of a row is done. While others wait, the row shows `show` (or stays); when
 * none is left it is the newest server row, or — never on the server — it goes (null).
 */
export function settle(
  shown: PageLink | null,
  kept: PageLink | null,
  o: SettleOptions,
): { left: number; visible: PageLink | null; server: PageLink | null } {
  const answer = o.answer ?? null;
  const server = answer && (!kept || kept.seq <= answer.seq) ? linkFrom(answer) : kept;
  const left = Math.max(0, (shown?.pending ?? 0) - 1);
  if (left > 0) {
    const v = o.show === undefined ? shown : o.show;
    return { left, visible: v ? { ...v, pending: left } : shown ? { ...shown, pending: left } : null, server };
  }
  if (!answer && o.keepShown && shown)
    return { left, visible: { ...shown, pending: 0, seq: kept?.seq ?? 0 }, server: null };
  return { left, visible: server ? { ...server, pending: 0 } : null, server: null };
}

/** A row the phone made itself (not on the server yet). */
export const placeholderLinkId = (pageKey: string, itemKey: string) => `local:${pageKey}|${itemKey}`;

export interface PagesRepository {
  insertLocal(page: Page): Promise<LocalPage>;
  get(id: string): Promise<LocalPage | null>;
  /** All rows, also removed ones (the store needs to know what is gone). */
  listAll(): Promise<LocalPage[]>;
  /** POST /pages answered. */
  markSynced(id: string, out: PageOut): Promise<void>;
  /** 409 singleton_exists: this local page IS that server page (keeps the local id: screens hold it). */
  adopt(id: string, serverId: string): Promise<void>;
  /** Permanent rejection: the page stays on this phone only. */
  markFailed(id: string): Promise<void>;
  applyRemote(out: PageOut): Promise<void>;
  applyTombstone(serverId: string): Promise<void>;
  setTitle(id: string, title: string | null): Promise<void>;
  clearTitleDirty(id: string): Promise<void>;
  applyLink(link: PageItemOut): Promise<void>;
  removeLink(linkId: string): Promise<void>;
  linksFor(pageServerId: string): Promise<PageLink[]>;
  /** «Отменить» on the phone: these rows exactly as they were (whatever their seq). */
  restoreLinks(links: PageLink[]): Promise<void>;
  /** Every row of one record, on any page (S39: «сейчас здесь», «уже там»). */
  linksForItem(itemKey: string): Promise<PageLink[]>;
  /** One row by (page key, item key). */
  getLink(pageKey: string, itemKey: string): Promise<PageLink | null>;
  /**
   * A change by hand, shown at once (week 7): the row as the person left it, one more change
   * pending. The first pending change keeps the server's row aside.
   */
  writeLocal(link: PageLink): Promise<void>;
  /** One pending change of this row is done (see `settle`). */
  settleLink(pageKey: string, itemKey: string, o?: SettleOptions): Promise<void>;
  /**
   * S34 ↑↓: the page's place in the tabs, kept over /sync until the change is sent.
   * `pending=false`: only what is shown changes (a change that waited was taken back).
   */
  setPosition(id: string, position: string, pending?: boolean): Promise<void>;
  /** S34 «Убрать» (ms) or its undo (null), kept over /sync until sent. */
  setRemoved(id: string, deletedAt: number | null, pending?: boolean): Promise<void>;
  /** One pending change of the page is done. */
  settlePage(id: string, what: 'position' | 'removed' | 'view'): Promise<void>;
  /** S38 / the switcher / «Отменить»: shown at once; `pending` keeps it over /sync until sent. */
  setLook(id: string, look: PageLook, pending?: boolean): Promise<void>;
  /** `page_patch` arrived: the page's version and group headings. */
  setView(pageServerId: string, viewVersion: number, groups: { key: string; title: string }[] | null): Promise<void>;
  /**
   * Another account: its pages are other pages. Pages wait to be created there (a topic the account
   * already has adopts its page), and links, which name server ids, are gone.
   */
  detachFromAccount(): Promise<void>;
}

const parseTs = (iso: string | null | undefined, now: number): number | null => (iso ? Date.parse(iso) || now : null);

/**
 * Default titles stay null, so the label follows the app language; a renamed page keeps its own.
 * In Kazakh a renamed page shows `title_kk` when set, otherwise `title` (docs/api/pages.md).
 */
function fromServer(out: PageOut, now: number, base: LocalPage | null): LocalPage {
  const key = out.template_key as TemplateKey;
  const isDefault = out.title === TEMPLATE_DEFAULT_TITLE[key];
  const dirty = base?.titleDirty ?? false;
  const posDirty = (base?.positionDirty ?? 0) > 0;
  const remDirty = (base?.removedDirty ?? 0) > 0;
  const lookDirty = (base?.viewDirty ?? 0) > 0 && !!base;
  return {
    id: base?.id ?? out.client_id ?? out.id,
    serverId: out.id,
    templateKey: key,
    title: dirty ? (base?.title ?? null) : isDefault ? null : out.title,
    titleKk: dirty || isDefault ? null : (out.title_kk ?? null),
    icon: lookDirty ? base.icon : (out.icon as IconKey),
    layout: lookDirty ? base.layout : (out.layout as Layout),
    position: posDirty && base ? base.position : out.position,
    createdBy: (base?.createdBy ?? out.created_by) as PageCreatedBy,
    createdAt: out.created_at,
    syncState: 'synced',
    seq: out.seq,
    deletedAt: remDirty && base ? base.deletedAt : parseTs(out.deleted_at, now),
    hiddenAt: parseTs(out.hidden_at, now),
    titleDirty: dirty,
    positionDirty: base?.positionDirty ?? 0,
    removedDirty: base?.removedDirty ?? 0,
    viewDirty: base?.viewDirty ?? 0,
    viewVersion: Math.max(out.view_version ?? 0, base?.viewVersion ?? 0),
    groups: titlesToGroups(groupTitles(out.view_state)) ?? base?.groups ?? [],
    view: lookDirty ? base.view : viewFromServer(out),
  };
}

/** `group_key` is the group's title (docs/api/chat.md PagePatch). */
export function titlesToGroups(titles: string[] | null): { key: string; title: string }[] | null {
  return titles ? titles.map((t) => ({ key: t, title: t })) : null;
}

function toLocal(page: Page): LocalPage {
  return { ...page, deletedAt: null, hiddenAt: null, titleDirty: false };
}

export function linkFrom(out: PageItemOut): PageLink {
  return {
    id: out.id,
    pageServerId: out.page_id,
    itemServerId: out.item_id,
    position: out.position,
    groupKey: out.group_key ?? null,
    manualOrder: out.manual_order,
    pinned: out.pinned,
    color: out.appearance?.color ?? null,
    removedAt: out.removed_at,
    seq: out.seq,
  };
}

export class InMemoryPagesRepository implements PagesRepository {
  private rows = new Map<string, LocalPage>();
  private links = new Map<string, PageLink>();
  /** The server's copy of a pending row (null: the server has no such row). */
  private serverRows = new Map<string, PageLink | null>();

  constructor(private readonly now: () => number = Date.now) {}

  private byServerId(serverId: string) {
    return [...this.rows.values()].find((p) => p.serverId === serverId) ?? null;
  }

  async insertLocal(page: Page) {
    const existing = this.rows.get(page.id);
    if (existing) return existing;
    const row = toLocal(page);
    this.rows.set(row.id, row);
    return row;
  }

  async get(id: string) {
    return this.rows.get(id) ?? null;
  }

  async listAll() {
    return [...this.rows.values()];
  }

  async markSynced(id: string, out: PageOut) {
    for (const [k, p] of this.rows) if (p.serverId === out.id && k !== id) this.rows.delete(k);
    const row = fromServer(out, this.now(), this.rows.get(id) ?? null);
    this.rows.set(id, { ...row, id });
  }

  async adopt(id: string, serverId: string) {
    for (const [k, p] of this.rows) if (p.serverId === serverId && k !== id) this.rows.delete(k);
    const row = this.rows.get(id);
    if (row) this.rows.set(id, { ...row, serverId, syncState: 'synced' });
  }

  async markFailed(id: string) {
    const row = this.rows.get(id);
    if (row) this.rows.set(id, { ...row, syncState: 'failed' });
  }

  async applyRemote(out: PageOut) {
    const base = (out.client_id ? this.rows.get(out.client_id) : undefined) ?? this.byServerId(out.id);
    if (base && base.seq > out.seq) return;
    const row = fromServer(out, this.now(), base);
    this.rows.set(row.id, row);
  }

  async applyTombstone(serverId: string) {
    const row = this.byServerId(serverId);
    if (row) this.rows.set(row.id, { ...row, deletedAt: this.now() });
  }

  async setTitle(id: string, title: string | null) {
    const row = this.rows.get(id);
    if (row) this.rows.set(id, { ...row, title, titleKk: null, titleDirty: true });
  }

  async clearTitleDirty(id: string) {
    const row = this.rows.get(id);
    if (row) this.rows.set(id, { ...row, titleDirty: false });
  }

  async applyLink(out: PageItemOut) {
    const key = `${out.page_id}|${out.item_id}`;
    const old = this.links.get(key);
    if (old && (old.pending ?? 0) > 0) {
      const kept = this.serverRows.get(key);
      if (!kept || kept.seq <= out.seq) this.serverRows.set(key, linkFrom(out));
      return;
    }
    if (old && old.seq > out.seq) return;
    this.links.set(key, linkFrom(out));
  }

  async removeLink(linkId: string) {
    for (const [k, l] of this.links) {
      if (l.id !== linkId) continue;
      if ((l.pending ?? 0) > 0) this.serverRows.set(k, null);
      else this.links.delete(k);
    }
  }

  async linksForItem(itemKey: string) {
    return [...this.links.values()].filter((l) => l.itemServerId === itemKey);
  }

  async getLink(pageKey: string, itemKey: string) {
    return this.links.get(`${pageKey}|${itemKey}`) ?? null;
  }

  async writeLocal(link: PageLink) {
    const key = `${link.pageServerId}|${link.itemServerId}`;
    const old = this.links.get(key) ?? null;
    const pending = old?.pending ?? 0;
    if (pending === 0) this.serverRows.set(key, old ? { ...old } : null);
    this.links.set(key, { ...link, pending: pending + 1 });
  }

  async settleLink(pageKey: string, itemKey: string, o: SettleOptions = {}) {
    const key = `${pageKey}|${itemKey}`;
    const r = settle(this.links.get(key) ?? null, this.serverRows.get(key) ?? null, o);
    if (r.left > 0) this.serverRows.set(key, r.server);
    else this.serverRows.delete(key);
    if (r.visible) this.links.set(key, r.visible);
    else this.links.delete(key);
  }

  async setPosition(id: string, position: string, pending = true) {
    const row = this.rows.get(id);
    if (row) this.rows.set(id, { ...row, position, positionDirty: (row.positionDirty ?? 0) + (pending ? 1 : 0) });
  }

  async setRemoved(id: string, deletedAt: number | null, pending = true) {
    const row = this.rows.get(id);
    if (row) this.rows.set(id, { ...row, deletedAt, removedDirty: (row.removedDirty ?? 0) + (pending ? 1 : 0) });
  }

  async settlePage(id: string, what: 'position' | 'removed' | 'view') {
    const row = this.rows.get(id);
    if (!row) return;
    if (what === 'position') this.rows.set(id, { ...row, positionDirty: Math.max(0, (row.positionDirty ?? 0) - 1) });
    else if (what === 'view') this.rows.set(id, { ...row, viewDirty: Math.max(0, (row.viewDirty ?? 0) - 1) });
    else this.rows.set(id, { ...row, removedDirty: Math.max(0, (row.removedDirty ?? 0) - 1) });
  }

  async setLook(id: string, look: PageLook, pending = true) {
    const row = this.rows.get(id);
    if (row) this.rows.set(id, { ...row, ...look, viewDirty: (row.viewDirty ?? 0) + (pending ? 1 : 0) });
  }

  async linksFor(pageServerId: string) {
    return [...this.links.values()].filter((l) => l.pageServerId === pageServerId);
  }

  async restoreLinks(links: PageLink[]) {
    for (const l of links) {
      const key = `${l.pageServerId}|${l.itemServerId}`;
      this.links.set(key, { ...l, pending: this.links.get(key)?.pending ?? 0 });
    }
  }

  async setView(pageServerId: string, viewVersion: number, groups: { key: string; title: string }[] | null) {
    const row = this.byServerId(pageServerId);
    if (!row) return;
    this.rows.set(row.id, {
      ...row,
      viewVersion: Math.max(row.viewVersion ?? 0, viewVersion),
      groups: groups ?? row.groups ?? [],
    });
  }

  async detachFromAccount() {
    for (const [k, p] of this.rows) {
      const clean = { ...p, positionDirty: 0, removedDirty: 0, viewDirty: 0 };
      this.rows.set(k, p.serverId ? { ...clean, serverId: null, syncState: 'pending', seq: 0 } : clean);
    }
    this.links.clear();
    this.serverRows.clear();
  }
}

type PageRow = {
  id: string;
  server_id: string | null;
  template_key: TemplateKey;
  title: string | null;
  title_kk: string | null;
  title_dirty: number;
  icon: IconKey;
  layout: Layout;
  position: string;
  created_by: PageCreatedBy;
  created_at: string;
  sync_state: Page['syncState'];
  seq: number;
  deleted_at: number | null;
  hidden_at: number | null;
  view_version?: number;
  view_groups?: string;
  position_dirty?: number;
  removed_dirty?: number;
  view_json?: string;
  view_dirty?: number;
};

function parseGroups(json: string | undefined): { key: string; title: string }[] {
  try {
    const v: unknown = json ? JSON.parse(json) : [];
    return Array.isArray(v)
      ? v.filter(
          (g): g is { key: string; title: string } => !!g && typeof g.key === 'string' && typeof g.title === 'string',
        )
      : [];
  } catch {
    return [];
  }
}

const pageFromRow = (r: PageRow): LocalPage => ({
  id: r.id,
  serverId: r.server_id,
  templateKey: r.template_key,
  title: r.title,
  titleKk: r.title_kk,
  titleDirty: !!r.title_dirty,
  icon: r.icon,
  layout: r.layout,
  position: r.position,
  createdBy: r.created_by,
  createdAt: r.created_at,
  syncState: r.sync_state,
  seq: r.seq,
  deletedAt: r.deleted_at,
  hiddenAt: r.hidden_at,
  viewVersion: r.view_version ?? 0,
  groups: parseGroups(r.view_groups),
  positionDirty: r.position_dirty ?? 0,
  removedDirty: r.removed_dirty ?? 0,
  viewDirty: r.view_dirty ?? 0,
  ...(r.view_json && r.view_json !== '{}' ? { view: parseView(r.view_json) } : {}),
});

type LinkRow = {
  id: string;
  page_server_id: string;
  item_server_id: string;
  position: string | null;
  group_key?: string | null;
  manual_order: number;
  pinned: number;
  color?: string | null;
  removed_at: string | null;
  seq: number;
  pending?: number;
  server_row?: string | null;
};

const linkFromRow = (r: LinkRow): PageLink => ({
  id: r.id,
  pageServerId: r.page_server_id,
  itemServerId: r.item_server_id,
  position: r.position,
  groupKey: r.group_key ?? null,
  manualOrder: !!r.manual_order,
  pinned: !!r.pinned,
  color: (r.color as NoteColor | null | undefined) ?? null,
  removedAt: r.removed_at,
  seq: r.seq,
  pending: r.pending ?? 0,
});

function parseLink(json: string | null | undefined): PageLink | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as PageLink | null;
    return v && typeof v.id === 'string' ? v : null;
  } catch {
    return null;
  }
}

const PAGE_COLS =
  'id, server_id, template_key, title, title_kk, title_dirty, icon, layout, position, created_by, created_at, sync_state, seq, deleted_at, hidden_at, view_version, view_groups, position_dirty, removed_dirty, view_json, view_dirty';

export class SqlitePagesRepository implements PagesRepository {
  constructor(
    private readonly db: SqlDb,
    private readonly now: () => number = Date.now,
  ) {}

  private async write(p: LocalPage, mode: 'INSERT OR IGNORE' | 'INSERT OR REPLACE') {
    await this.db.runAsync(
      `${mode} INTO pages (${PAGE_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      p.id,
      p.serverId,
      p.templateKey,
      p.title,
      p.titleKk,
      p.titleDirty ? 1 : 0,
      p.icon,
      p.layout,
      p.position,
      p.createdBy,
      p.createdAt,
      p.syncState,
      p.seq,
      p.deletedAt,
      p.hiddenAt,
      p.viewVersion ?? 0,
      JSON.stringify(p.groups ?? []),
      p.positionDirty ?? 0,
      p.removedDirty ?? 0,
      p.view ? JSON.stringify(p.view) : '{}',
      p.viewDirty ?? 0,
    );
  }

  private async byServerId(serverId: string) {
    const row = await this.db.getFirstAsync<PageRow>('SELECT * FROM pages WHERE server_id = ?', serverId);
    return row ? pageFromRow(row) : null;
  }

  async insertLocal(page: Page) {
    const row = toLocal(page);
    await this.write(row, 'INSERT OR IGNORE');
    return (await this.get(page.id)) ?? row;
  }

  async get(id: string) {
    const row = await this.db.getFirstAsync<PageRow>('SELECT * FROM pages WHERE id = ?', id);
    return row ? pageFromRow(row) : null;
  }

  async listAll() {
    const rows = await this.db.getAllAsync<PageRow>('SELECT * FROM pages');
    return rows.map(pageFromRow);
  }

  async markSynced(id: string, out: PageOut) {
    const row = fromServer(out, this.now(), await this.get(id));
    await this.db.runAsync('DELETE FROM pages WHERE server_id = ? AND id != ?', out.id, id);
    await this.write({ ...row, id }, 'INSERT OR REPLACE');
  }

  async adopt(id: string, serverId: string) {
    await this.db.runAsync('DELETE FROM pages WHERE server_id = ? AND id != ?', serverId, id);
    await this.db.runAsync("UPDATE pages SET server_id = ?, sync_state = 'synced' WHERE id = ?", serverId, id);
  }

  async markFailed(id: string) {
    await this.db.runAsync("UPDATE pages SET sync_state = 'failed' WHERE id = ?", id);
  }

  async applyRemote(out: PageOut) {
    const base = (out.client_id ? await this.get(out.client_id) : null) ?? (await this.byServerId(out.id));
    if (base && base.seq > out.seq) return;
    await this.write(fromServer(out, this.now(), base), 'INSERT OR REPLACE');
  }

  async applyTombstone(serverId: string) {
    await this.db.runAsync('UPDATE pages SET deleted_at = ? WHERE server_id = ?', this.now(), serverId);
  }

  async setTitle(id: string, title: string | null) {
    await this.db.runAsync('UPDATE pages SET title = ?, title_kk = NULL, title_dirty = 1 WHERE id = ?', title, id);
  }

  async clearTitleDirty(id: string) {
    await this.db.runAsync('UPDATE pages SET title_dirty = 0 WHERE id = ?', id);
  }

  private async linkRow(pageKey: string, itemKey: string) {
    return this.db.getFirstAsync<LinkRow>(
      'SELECT * FROM page_links WHERE page_server_id = ? AND item_server_id = ?',
      pageKey,
      itemKey,
    );
  }

  async applyLink(out: PageItemOut) {
    const old = await this.linkRow(out.page_id, out.item_id);
    if (old && (old.pending ?? 0) > 0) {
      const kept = parseLink(old.server_row);
      if (!kept || kept.seq <= out.seq) {
        await this.db.runAsync(
          'UPDATE page_links SET server_row = ? WHERE id = ?',
          JSON.stringify(linkFrom(out)),
          old.id,
        );
      }
      return;
    }
    if (old && old.seq > out.seq) return;
    await this.writeLink(linkFrom(out));
  }

  private async writeLink(l: PageLink, pending = 0, serverRow: PageLink | null = null) {
    // The UNIQUE (page, item) index makes this an upsert by either key.
    await this.db.runAsync(
      `INSERT OR REPLACE INTO page_links
         (id, page_server_id, item_server_id, position, group_key, manual_order, pinned, color, removed_at, seq, pending, server_row)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      l.id,
      l.pageServerId,
      l.itemServerId,
      l.position,
      l.groupKey ?? null,
      l.manualOrder ? 1 : 0,
      l.pinned ? 1 : 0,
      l.color ?? null,
      l.removedAt,
      l.seq,
      pending,
      serverRow ? JSON.stringify(serverRow) : null,
    );
  }

  async restoreLinks(links: PageLink[]) {
    for (const l of links) {
      const old = await this.linkRow(l.pageServerId, l.itemServerId);
      await this.writeLink(l, old?.pending ?? 0, parseLink(old?.server_row));
    }
  }

  async linksForItem(itemKey: string) {
    const rows = await this.db.getAllAsync<LinkRow>('SELECT * FROM page_links WHERE item_server_id = ?', itemKey);
    return rows.map(linkFromRow);
  }

  async getLink(pageKey: string, itemKey: string) {
    const row = await this.linkRow(pageKey, itemKey);
    return row ? linkFromRow(row) : null;
  }

  async writeLocal(link: PageLink) {
    const old = await this.linkRow(link.pageServerId, link.itemServerId);
    const pending = old?.pending ?? 0;
    const server = pending === 0 ? (old ? linkFromRow(old) : null) : parseLink(old?.server_row);
    await this.writeLink(link, pending + 1, server);
  }

  async settleLink(pageKey: string, itemKey: string, o: SettleOptions = {}) {
    const old = await this.linkRow(pageKey, itemKey);
    const r = settle(old ? linkFromRow(old) : null, parseLink(old?.server_row), o);
    await this.db.runAsync('DELETE FROM page_links WHERE page_server_id = ? AND item_server_id = ?', pageKey, itemKey);
    if (r.visible) await this.writeLink(r.visible, r.left, r.server);
  }

  async setPosition(id: string, position: string, pending = true) {
    await this.db.runAsync(
      'UPDATE pages SET position = ?, position_dirty = position_dirty + ? WHERE id = ?',
      position,
      pending ? 1 : 0,
      id,
    );
  }

  async setRemoved(id: string, deletedAt: number | null, pending = true) {
    await this.db.runAsync(
      'UPDATE pages SET deleted_at = ?, removed_dirty = removed_dirty + ? WHERE id = ?',
      deletedAt,
      pending ? 1 : 0,
      id,
    );
  }

  async settlePage(id: string, what: 'position' | 'removed' | 'view') {
    const col = what === 'position' ? 'position_dirty' : what === 'view' ? 'view_dirty' : 'removed_dirty';
    await this.db.runAsync(`UPDATE pages SET ${col} = MAX(0, ${col} - 1) WHERE id = ?`, id);
  }

  async setLook(id: string, look: PageLook, pending = true) {
    await this.db.runAsync(
      'UPDATE pages SET layout = ?, icon = ?, view_json = ?, view_dirty = view_dirty + ? WHERE id = ?',
      look.layout,
      look.icon,
      JSON.stringify(look.view),
      pending ? 1 : 0,
      id,
    );
  }

  async setView(pageServerId: string, viewVersion: number, groups: { key: string; title: string }[] | null) {
    await this.db.runAsync(
      'UPDATE pages SET view_version = MAX(view_version, ?) WHERE server_id = ?',
      viewVersion,
      pageServerId,
    );
    if (groups) {
      await this.db.runAsync(
        'UPDATE pages SET view_groups = ? WHERE server_id = ?',
        JSON.stringify(groups),
        pageServerId,
      );
    }
  }

  async removeLink(linkId: string) {
    await this.db.runAsync('UPDATE page_links SET server_row = NULL WHERE id = ? AND pending > 0', linkId);
    await this.db.runAsync('DELETE FROM page_links WHERE id = ? AND pending = 0', linkId);
  }

  async linksFor(pageServerId: string) {
    const rows = await this.db.getAllAsync<LinkRow>('SELECT * FROM page_links WHERE page_server_id = ?', pageServerId);
    return rows.map(linkFromRow);
  }

  async detachFromAccount() {
    await this.db.runAsync(
      "UPDATE pages SET server_id = NULL, sync_state = 'pending', seq = 0 WHERE server_id IS NOT NULL",
    );
    await this.db.runAsync('UPDATE pages SET position_dirty = 0, removed_dirty = 0, view_dirty = 0');
    await this.db.runAsync('DELETE FROM page_links');
  }
}
