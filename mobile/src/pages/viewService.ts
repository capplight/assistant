import { ApiError, isRetryable } from '@/api/errors';
import type { CollectionOut, ItemFacetOut, PagePatchOut, PageViewOut } from '@/api/types';
import { getOutbox, getPagesRepo, getRecords } from '@/db';
import type { OutboxEntry } from '@/db/outbox';
import type { PageLook } from '@/db/pages';
import i18n from '@/i18n';
import { getApi, getSyncEngine, kickSync, notifyDataChanged } from '@/services';
import { usePages, type Page } from '@/store/pages';
import { syncPagesStore } from '@/store/pagesSync';
import { useToast } from '@/store/toast';
import { useUndo } from '@/store/undo';
import type { ActionUndoPayload } from '@/sync/engine';
import { refreshCollections } from '@/dedup/service';
import { undoServerAction } from '@/tasks/actions';
import { settleBoardSlots } from './manual';
import { rememberActions } from '@/tasks/service';
import { newId } from '@/utils/id';

import { catalogTemplate, fieldTitle } from './catalog';
import { DONE_FIELD, facetKey, useFacets, type FieldValue } from './facets';
import { getTemplate, type IconKey, type Layout } from './templates';
import {
  applyChange,
  EMPTY_VIEW,
  fieldsOf,
  restoreBody,
  sortFromServer,
  viewBody,
  type ChangeError,
  type Look,
  type ViewChange,
} from './viewModel';

/**
 * Week 11: the view of a page changed by hand (S38 «Настроить страницу», the notebook switcher)
 * and by the assistant (`set_view`, template-screens 2.8). By hand: shown at once, offline too, one
 * outbox row per change (`page.view`), «Отменить» in the strip (still in the outbox → dropped;
 * sent → the undo of its action). The server checks again (★, ≤5 own fields, allowed views) and
 * its answer wins. Records are never touched by a view change.
 */

const t = (k: string, o?: Record<string, unknown>) => i18n.t(k, o);

export type PageViewPayload = {
  pageId: string;
  change: ViewChange;
  before: Look;
  after: Look;
  clientId: string;
  actionId?: string | null;
  /** «Отменить» of a change the server answered without an action: the old look goes as a change. */
  restore?: boolean;
};

export type ItemFieldsPayload = {
  pageId: string;
  recordId: string;
  fields: Record<string, FieldValue>;
  before: Record<string, FieldValue>;
  clientId: string;
  actionId?: string | null;
};

export const lookOf = (p: Page): Look => ({ layout: p.layout, icon: p.icon, view: p.view ?? EMPTY_VIEW });

/** «Скрыл поле «Способ»», «Вид: Таблица»… — what the strip says about one change. */
export function changeText(page: Page, change: ViewChange, lang = i18n.language): string {
  const tpl = catalogTemplate(page.templateKey);
  const field = (id: string) => {
    const f = fieldsOf(tpl, page.view).find((x) => x.id === id);
    return f ? fieldTitle(f, lang) : id;
  };
  switch (change.kind) {
    case 'layout':
      return t('view.changed_layout', { view: t(`view.layout.${layoutLabel(page.templateKey, change.layout)}`) });
    case 'sort':
      return t('view.changed_sort', { what: t(`view.sort_${change.sort ?? 'position'}`) });
    case 'group':
      return change.groupBy ? t('view.changed_group', { field: field(change.groupBy) }) : t('view.changed_ungroup');
    case 'group_order':
      return t('view.changed_group_order', { group: change.moved });
    case 'board':
      return t('view.changed_layout', { view: t(change.on ? 'notes.mode_board' : 'notes.mode_rows') });
    case 'icon':
      return t('view.changed_icon');
    case 'field_visible':
      return t(change.visible ? 'view.field_shown' : 'view.field_hidden', { field: field(change.fieldId) });
    case 'field_move':
      return t('view.field_moved', { field: field(change.fieldId) });
    case 'custom_add':
      return t('view.field_added', { field: change.field.title.trim() });
    case 'custom_remove':
      return t('view.field_removed', { field: field(change.fieldId) });
    case 'reset':
      return t('view.reset_done');
  }
}

/** The label key of a view in S38 and the notebook switcher. */
export function layoutLabel(templateKey: string, layout: string): string {
  if (layout === 'list') return templateKey === 'custom' ? 'list' : 'simple';
  const known = ['checklist', 'table', 'stacks', 'builtin:tasks', 'builtin:kp', 'builtin:expenses', 'builtin:notes_board', 'builtin:shopping', 'builtin:planner'];
  return known.includes(layout) ? layout.replace('builtin:', '') : 'tool';
}

const ERROR_TEXT: Record<Exclude<ChangeError, 'nothing'>, string> = {
  field_required: 'view.err_required',
  custom_limit: 'view.err_custom_limit',
  layout_not_allowed: 'view.err_layout',
};

async function show(page: Page, look: Look, pending: boolean): Promise<void> {
  usePages.getState().setLook(page.id, look);
  const repo = await getPagesRepo();
  await repo.setLook(page.id, look as PageLook, pending);
  notifyDataChanged();
}

/**
 * One change by hand. Shown at once, sent when it can be; the strip «Скрыл поле «Способ»
 * [Отменить]». Returns why it cannot be done (★, the 5 own fields), or null.
 */
export async function changeView(page: Page, change: ViewChange): Promise<ChangeError | null> {
  const tpl = catalogTemplate(page.templateKey);
  const before = lookOf(page);
  const r = applyChange(tpl, before, change, getTemplate(page.templateKey).icon);
  if ('error' in r) {
    if (r.error !== 'nothing') useToast.getState().show(t(ERROR_TEXT[r.error]), 4000);
    return r.error;
  }
  const text = changeText(page, change);
  await show(page, r.look, true);
  // Weeks 16а–16б: the board on — stickers with no place take the server's slots here at once.
  if (change.kind === 'board' && change.on) await settleBoardSlots(page);
  const payload: PageViewPayload = { pageId: page.id, change, before, after: r.look, clientId: newId() };
  const row = await (await getOutbox()).enqueue('page.view', payload);
  useUndo.getState().showCustom(text, () => void undoView(row.id));
  kickSync();
  return null;
}

/** «Отменить» of a change by hand: never sent → dropped; sent → the undo of its action. */
export async function undoView(outboxId: string): Promise<void> {
  const engine = await getSyncEngine();
  await engine.hold(outboxId);
  try {
    const outbox = await getOutbox();
    const row = await outbox.get(outboxId);
    if (!row || row.status === 'failed') return;
    const p = row.payload as PageViewPayload;
    const page = usePages.getState().pages.find((x) => x.id === p.pageId);
    if (!page) return;
    const repo = await getPagesRepo();
    if (row.status === 'pending') {
      await outbox.markFailed(row.id, 'undone'); // it never goes
      await repo.settlePage(p.pageId, 'view');
      await show(page, p.before, false);
      return;
    }
    await show(page, p.before, true);
    if (p.actionId) {
      const undo: ActionUndoPayload = { actionId: p.actionId, clientId: newId(), viewPageId: p.pageId };
      await outbox.enqueue('action.undo', undo);
    } else {
      const back: PageViewPayload = { ...p, change: p.change, before: p.after, after: p.before, clientId: newId(), actionId: null, restore: true };
      await outbox.enqueue('page.view', back);
    }
  } finally {
    engine.release(outboxId);
    kickSync();
  }
}

// --- the sender (the sync engine calls it for `page.view` and `page.item_fields`) ---

async function serverPage(localId: string): Promise<string | null> {
  const page = await (await getPagesRepo()).get(localId);
  if (!page || page.syncState === 'failed') return null; // lives on this phone only
  if (!page.serverId) throw new Error('page_not_synced');
  return page.serverId;
}

async function callView(serverId: string, p: PageViewPayload, base: number | undefined): Promise<PageViewOut> {
  // One call for every part (views.md `POST /pages/{id}/view`); only the keys this change touched.
  // A board switch taken back goes as the switch itself (`board` is a «Заметки» key only).
  const body = p.restore && p.change.kind !== 'board' ? restoreBody(p.after) : viewBody(p.change, p.after);
  return getApi().setView(serverId, { client_id: p.clientId, ...(base ? { base_view_version: base } : {}), ...body });
}

async function sendView(e: OutboxEntry): Promise<void> {
  const p = e.payload as PageViewPayload;
  const repo = await getPagesRepo();
  const serverId = await serverPage(p.pageId); // throws while the page is on its way
  if (!serverId) {
    await repo.settlePage(p.pageId, 'view'); // this phone only: the look stays as the person left it
    return;
  }
  const local = await repo.get(p.pageId);
  let out: PageViewOut;
  try {
    // `base_view_version` never blocks here: the person's change wins (views.md).
    out = await callView(serverId, p, local?.viewVersion);
  } catch (err) {
    if (!isRetryable(err)) {
      await repo.settlePage(p.pageId, 'view');
      await refetch(serverId);
      const code = err instanceof ApiError ? err.code : '';
      useToast.getState().show(
        code === 'field_required' ? t('view.err_required') : code === 'fields_limit' ? t('view.err_custom_limit') : t('view.refused'),
        4000,
      );
    }
    throw err;
  }
  await repo.settlePage(p.pageId, 'view');
  if (out.page) await repo.applyRemote(out.page);
  // The board turned on: the slots the server gave come as rows (views.md «Доска»).
  for (const row of out.page_patch?.rows ?? []) await repo.applyLink(row);
  if (out.action) rememberActions([out.action]);
  await (await getOutbox()).updatePayload(e.id, { ...p, actionId: out.action?.id ?? null } satisfies PageViewPayload);
  notifyDataChanged();
}

async function refetch(serverId: string): Promise<void> {
  try {
    await (await getPagesRepo()).applyRemote(await getApi().getPage(serverId));
  } catch {
    // the next /sync brings it
  }
  notifyDataChanged();
}

async function sendItemFields(e: OutboxEntry): Promise<void> {
  const p = e.payload as ItemFieldsPayload;
  const pageServer = await serverPage(p.pageId);
  if (!pageServer) return;
  const rec = await (await getRecords()).get(p.recordId);
  if (!rec) return;
  if (!rec.serverId) throw new Error('item_not_synced');
  // One row call (views.md): own field values and the checklist tick (`done` → `link.done_at`).
  const values = Object.fromEntries(Object.entries(p.fields).filter(([k]) => k !== DONE_FIELD));
  const done = p.fields[DONE_FIELD];
  const out = await getApi().setItemFields(pageServer, rec.serverId, {
    client_id: p.clientId,
    ...(Object.keys(values).length > 0 ? { values } : {}),
    ...(typeof done === 'boolean' ? { done } : done === null ? { done: false } : {}),
  });
  if (out.action) rememberActions([out.action]);
  await (await getOutbox()).updatePayload(e.id, { ...p, actionId: out.action?.id ?? null } satisfies ItemFieldsPayload);
}

/**
 * `/v1/sync` `item_facets` → the phone's values, keyed by local ids. A value the person changed
 * that is still in the outbox is kept (it goes after this and wins).
 */
async function applyFacets(list: ItemFacetOut[]): Promise<void> {
  const pages = await (await getPagesRepo()).listAll();
  const records = await getRecords();
  const outbox = await getOutbox();
  const waiting = (await outbox.listPending(500)).filter((r) => r.kind === 'page.item_fields').map((r) => r.payload as ItemFacetsPending);
  for (const f of list) {
    const page = pages.find((p) => p.serverId === f.page_id);
    const rec = await records.findByServerId(f.item_id);
    if (!page || !rec) continue;
    const mine = new Set(waiting.filter((w) => w.pageId === page.id && w.recordId === rec.id).flatMap((w) => Object.keys(w.fields)));
    const data: Record<string, FieldValue> = {};
    for (const [k, v] of Object.entries(f.data)) {
      if (mine.has(k)) continue;
      data[k] = typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : null;
    }
    useFacets.getState().set(facetKey(page.id, rec.id), data);
  }
}

type ItemFacetsPending = Pick<ItemFieldsPayload, 'pageId' | 'recordId' | 'fields'>;

export const viewSink = {
  send: (e: OutboxEntry): Promise<void> => (e.kind === 'page.item_fields' ? sendItemFields(e) : sendView(e)),
  facets: applyFacets,
};

// --- a value of a field on «Своя страница» (a tick of the checklist, a table cell) ---

/** Shown at once, sent when it can be, with «Отменить». */
export async function setFieldValues(page: Page, recordId: string, fields: Record<string, FieldValue>, text: string): Promise<void> {
  const key = facetKey(page.id, recordId);
  const before = Object.fromEntries(Object.keys(fields).map((k) => [k, useFacets.getState().values[key]?.[k] ?? null]));
  useFacets.getState().set(key, fields);
  const payload: ItemFieldsPayload = { pageId: page.id, recordId, fields, before, clientId: newId() };
  const row = await (await getOutbox()).enqueue('page.item_fields', payload);
  useUndo.getState().showCustom(text, () => void undoFieldValues(row.id));
  kickSync();
}

async function undoFieldValues(outboxId: string): Promise<void> {
  const engine = await getSyncEngine();
  await engine.hold(outboxId);
  try {
    const outbox = await getOutbox();
    const row = await outbox.get(outboxId);
    if (!row || row.status === 'failed') return;
    const p = row.payload as ItemFieldsPayload;
    useFacets.getState().set(facetKey(p.pageId, p.recordId), p.before);
    if (row.status === 'pending') {
      await outbox.markFailed(row.id, 'undone');
      return;
    }
    if (p.actionId) void undoServerAction(p.actionId);
    else await outbox.enqueue('page.item_fields', { ...p, fields: p.before, before: p.fields, clientId: newId(), actionId: null });
  } finally {
    engine.release(outboxId);
    kickSync();
  }
}

// --- the assistant changed a view (`page_patch` with the view, template-screens 2.8) ---

/**
 * A view change from the line: applied to the local page (the strip already says «Сделал …
 * [Что изменилось] [Отменить]»). A page with changes by hand still on their way keeps the person's
 * look; /sync settles it.
 */
export async function applyAssistantView(patch: PagePatchOut): Promise<boolean> {
  if (patch.layout === undefined && patch.field_prefs === undefined && patch.custom_fields === undefined && !hasViewKeys(patch)) return false;
  const repo = await getPagesRepo();
  const all = await repo.listAll();
  const local = all.find((p) => p.serverId === patch.page_id);
  if (!local || (local.viewDirty ?? 0) > 0) return false;
  const view = local.view ?? EMPTY_VIEW;
  const vs = patch.view_state ?? {};
  const next: Look = {
    layout: (patch.layout as Layout | undefined) ?? local.layout,
    icon: local.icon as IconKey,
    view: {
      ...view,
      ...('sort' in vs ? { sort: sortFromServer(vs.sort, vs.sort_dir) } : {}),
      ...('group_by' in vs ? { groupBy: typeof vs.group_by === 'string' ? vs.group_by : null } : {}),
      ...('group_order' in vs ? { groupOrder: Array.isArray(vs.group_order) ? vs.group_order.filter((x): x is string => typeof x === 'string') : [] } : {}),
      ...('board' in vs ? { mode: vs.board === true ? 'board' : null } : {}),
      ...(patch.field_prefs ? { fieldPrefs: patch.field_prefs } : {}),
      ...(patch.custom_fields ? { customFields: patch.custom_fields } : {}),
    },
  };
  await repo.setLook(local.id, next as PageLook, false);
  usePages.getState().setLook(local.id, next);
  notifyDataChanged();
  return true;
}

/** The look of a page (by server id) as it is now: kept to take an assistant's view change back offline. */
export type SavedLook = { pageServerId: string; look: Look };

export async function lookBefore(pageServerId: string): Promise<SavedLook | null> {
  const local = (await (await getPagesRepo()).listAll()).find((p) => p.serverId === pageServerId);
  return local ? { pageServerId, look: { layout: local.layout, icon: local.icon, view: local.view ?? EMPTY_VIEW } } : null;
}

/** «Отменить» offline: the old look at once; the undo waits in the outbox, /sync confirms it. */
export async function restoreLook(saved: SavedLook): Promise<void> {
  const repo = await getPagesRepo();
  const local = (await repo.listAll()).find((p) => p.serverId === saved.pageServerId);
  if (!local || (local.viewDirty ?? 0) > 0) return;
  await repo.setLook(local.id, saved.look as PageLook, false);
  usePages.getState().setLook(local.id, saved.look);
  notifyDataChanged();
}

const hasViewKeys = (patch: PagePatchOut) => {
  const vs = patch.view_state;
  return !!vs && ('group_by' in vs || 'group_order' in vs || 'board' in vs || ('sort' in vs && !Array.isArray(vs.groups)));
};

// --- «Сделать стопку страницей» (founder addition) ---

/**
 * The stack becomes a «Своя страница» with its records (they stay where they are too: a page is a
 * view). One action, «Отменить» takes the page away again; needs the internet, like every stack
 * change. Returns the local id of the new page.
 */
export async function stackToPage(c: CollectionOut): Promise<string | null> {
  const toast = (k: string) => useToast.getState().show(t(k), 4000);
  try {
    const out = await getApi().collectionToPage(c.id, newId());
    const page = out.page;
    const repo = await getPagesRepo();
    if (page) await repo.applyRemote(page);
    notifyDataChanged();
    kickSync();
    void refreshCollections(); // the stack left its page (stacks.md); «Отменить» brings it back
    const local = page ? (await repo.listAll()).find((p) => p.serverId === page.id) : undefined;
    if (local) await syncPagesStore(repo);
    const action = out.action;
    const text = action ? (i18n.language === 'kk' && action.summary.kk) || action.summary.ru : t('stack.to_page_done', { title: c.title });
    if (action) {
      rememberActions([action]);
      useUndo.getState().showCustom(
        text,
        () =>
          void undoServerAction(action.id).then(() => {
            kickSync();
            void refreshCollections();
          }),
        local?.id ?? null,
      );
    } else useToast.getState().show(text, 4000);
    return local?.id ?? null;
  } catch (e) {
    if (e instanceof ApiError && e.code === 'pages_limit') toast('stack.to_page_limit');
    else toast(e instanceof ApiError ? 'errors.generic' : 'stack.offline');
    return null;
  }
}
