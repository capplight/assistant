import type { PageItemOut, PageOut } from '@/api/types';
import { TEMPLATE_DEFAULT_TITLE, type IconKey, type Layout, type TemplateKey } from '@/pages/templates';
import type { Page, PageCreatedBy } from '@/store/pages';

import type { SqlDb } from './outbox';

/**
 * Local mirror of `screens` + `screen_items` (3-engineering §3.10, docs/api/pages.md).
 * A page is a view: `page_links` only says which server item shows on which server page.
 * The local page id is the page's `client_id` (the id the phone made), or the server id for a page
 * from another device; links are keyed by server ids.
 */
export type LocalPage = Page & { deletedAt: number | null; hiddenAt: number | null; titleDirty: boolean };

export type PageLink = {
  id: string;
  pageServerId: string;
  itemServerId: string;
  position: string | null;
  manualOrder: boolean;
  pinned: boolean;
  removedAt: string | null;
  seq: number;
};

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
  return {
    id: base?.id ?? out.client_id ?? out.id,
    serverId: out.id,
    templateKey: key,
    title: dirty ? (base?.title ?? null) : isDefault ? null : out.title,
    titleKk: dirty || isDefault ? null : (out.title_kk ?? null),
    icon: out.icon as IconKey,
    layout: out.layout as Layout,
    position: out.position,
    createdBy: (base?.createdBy ?? out.created_by) as PageCreatedBy,
    createdAt: out.created_at,
    syncState: 'synced',
    seq: out.seq,
    deletedAt: parseTs(out.deleted_at, now),
    hiddenAt: parseTs(out.hidden_at, now),
    titleDirty: dirty,
  };
}

function toLocal(page: Page): LocalPage {
  return { ...page, deletedAt: null, hiddenAt: null, titleDirty: false };
}

function linkFrom(out: PageItemOut): PageLink {
  return {
    id: out.id,
    pageServerId: out.page_id,
    itemServerId: out.item_id,
    position: out.position,
    manualOrder: out.manual_order,
    pinned: out.pinned,
    removedAt: out.removed_at,
    seq: out.seq,
  };
}

export class InMemoryPagesRepository implements PagesRepository {
  private rows = new Map<string, LocalPage>();
  private links = new Map<string, PageLink>();

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
    if (old && old.seq > out.seq) return;
    this.links.set(key, linkFrom(out));
  }

  async removeLink(linkId: string) {
    for (const [k, l] of this.links) if (l.id === linkId) this.links.delete(k);
  }

  async linksFor(pageServerId: string) {
    return [...this.links.values()].filter((l) => l.pageServerId === pageServerId);
  }

  async detachFromAccount() {
    for (const [k, p] of this.rows) {
      if (p.serverId) this.rows.set(k, { ...p, serverId: null, syncState: 'pending', seq: 0 });
    }
    this.links.clear();
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
};

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
});

type LinkRow = {
  id: string;
  page_server_id: string;
  item_server_id: string;
  position: string | null;
  manual_order: number;
  pinned: number;
  removed_at: string | null;
  seq: number;
};

const linkFromRow = (r: LinkRow): PageLink => ({
  id: r.id,
  pageServerId: r.page_server_id,
  itemServerId: r.item_server_id,
  position: r.position,
  manualOrder: !!r.manual_order,
  pinned: !!r.pinned,
  removedAt: r.removed_at,
  seq: r.seq,
});

const PAGE_COLS =
  'id, server_id, template_key, title, title_kk, title_dirty, icon, layout, position, created_by, created_at, sync_state, seq, deleted_at, hidden_at';

export class SqlitePagesRepository implements PagesRepository {
  constructor(
    private readonly db: SqlDb,
    private readonly now: () => number = Date.now,
  ) {}

  private async write(p: LocalPage, mode: 'INSERT OR IGNORE' | 'INSERT OR REPLACE') {
    await this.db.runAsync(
      `${mode} INTO pages (${PAGE_COLS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

  async applyLink(out: PageItemOut) {
    const old = await this.db.getFirstAsync<{ seq: number }>(
      'SELECT seq FROM page_links WHERE page_server_id = ? AND item_server_id = ?',
      out.page_id,
      out.item_id,
    );
    if (old && old.seq > out.seq) return;
    const l = linkFrom(out);
    // The UNIQUE (page, item) index makes this an upsert by either key.
    await this.db.runAsync(
      `INSERT OR REPLACE INTO page_links
         (id, page_server_id, item_server_id, position, manual_order, pinned, removed_at, seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      l.id,
      l.pageServerId,
      l.itemServerId,
      l.position,
      l.manualOrder ? 1 : 0,
      l.pinned ? 1 : 0,
      l.removedAt,
      l.seq,
    );
  }

  async removeLink(linkId: string) {
    await this.db.runAsync('DELETE FROM page_links WHERE id = ?', linkId);
  }

  async linksFor(pageServerId: string) {
    const rows = await this.db.getAllAsync<LinkRow>('SELECT * FROM page_links WHERE page_server_id = ?', pageServerId);
    return rows.map(linkFromRow);
  }

  async detachFromAccount() {
    await this.db.runAsync(
      "UPDATE pages SET server_id = NULL, sync_state = 'pending', seq = 0 WHERE server_id IS NOT NULL",
    );
    await this.db.runAsync('DELETE FROM page_links');
  }
}
