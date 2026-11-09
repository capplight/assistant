import {
  actionsOf,
  collectionsOf,
  duplicateGroupsOf,
  expenseCategoriesOf,
  expensesOf,
  firesOf,
  habitsOf,
  importsOf,
  itemFacetsOf,
  pendingActionsOf,
  remindersOf,
  suggestionsOf,
  tasksOf,
  type Api,
} from '@/api/endpoints';
import { ApiError, isOfflineError, isRetryable, SignInRequiredError } from '@/api/errors';
import type {
  ConsentsIn,
  DeviceIn,
  DeviceOut,
  FireOut,
  ReminderCreateIn,
  ReminderEventIn,
  ReminderOut,
  ReminderWithFiresOut,
  ActionOut,
  CollectionOut,
  DuplicateGroupOut,
  ImportOut,
  PendingActionOut,
  HabitOut,
  SuggestionOut,
  TaskOut,
  TaskWriteOut,
  FeedbackIn,
  ItemCreateIn,
  ItemKind,
  ItemOut,
  ItemSource,
  ManualOut,
  PageCreateIn,
  ItemFacetOut,
  ExpenseCategoryOut,
  ExpenseOut,
} from '@/api/types';
import type { OutboxEntry, OutboxRepository } from '@/db/outbox';
import type { PagesRepository } from '@/db/pages';
import type { RecordFile, RecordsRepository } from '@/db/records';
import type {
  ItemLookPayload,
  ItemMovePayload,
  ItemRemovePayload,
  LinkKey,
  LinkPayload,
  MoveToPagePayload,
  PageRemovePayload,
  PagesReorderPayload,
} from '@/pages/manual';
import type { RenamePayload } from '@/pages/service';
import type { CorrectPayload, TrashPayload, UnmergePayload, VerifyPayload } from '@/records/actions';
import type { TaskCreatePayload, TaskUpdatePayload } from '@/tasks/service';
import type { ClearDonePayload, TaskPatchPayload } from '@/tasks/edit';
import type { ReminderUpdatePayload } from '@/alarms/service';
import { TEMPLATE_DEFAULT_TITLE } from '@/pages/templates';
import { newId } from '@/utils/id';
import type { Page } from '@/store/pages';

/** Payload of `item.create`. `uploadIds` is filled in as files get uploaded (progress survives restarts). */
export type ItemPayload = {
  clientId: string;
  kind: ItemKind;
  source: ItemSource;
  text?: string;
  url?: string;
  file?: RecordFile;
  uploadId?: string;
  contentHash?: string;
  occurredAt: string;
  pageId?: string;
  sourceMeta?: Record<string, unknown>;
  /** Sent once more for another account: a repeat found there is not news for the person. */
  replay?: boolean;
};

/** `afterAccountSwitch`: without this consent nothing else may go to that account. */
export type ConsentPayload = { request: ConsentsIn; afterAccountSwitch?: boolean };

export type ProfilePayload = { displayName: string | null };

/** `pages.create`. Rows queued in weeks 1-2 have the same shape, with integer positions. */
export type PagesCreatePayload = { pages: (Omit<Page, 'position'> & { position: string | number })[] };

/**
 * An event the server refused (`invalid`). The phone keeps its own alarm either way. A snooze whose
 * `until` was refused goes once more without it (the server then uses `at + 10 min`); anything else,
 * or a resend refused again, is dropped — never the same bad value in a loop.
 */
export function fixInvalid(ev: QueuedReminderEvent | undefined): QueuedReminderEvent | null {
  if (!ev || ev.retry_of || ev.event !== 'snoozed' || !ev.meta || !('until' in ev.meta)) return null;
  const { until, ...meta } = ev.meta;
  return { ...ev, client_id: newId(), retry_of: ev.client_id, meta: { ...meta, until_refused: until } };
}

const SERVER_CREATED_BY = new Set(['user', 'onboarding_gallery', 'onboarding_blank', 'onboarding_phrase']);

/** Backoff: 2 s, 4 s, 8 s … capped at 10 min, ±20% jitter; server `retry_after` wins when larger. */
export function backoffMs(
  attempts: number,
  retryAfterSec: number | null = null,
  rnd: () => number = Math.random,
): number {
  const base = Math.min(2_000 * 2 ** Math.max(0, attempts), 600_000);
  const jittered = base * (0.8 + 0.4 * rnd());
  return Math.max(Math.round(jittered), (retryAfterSec ?? 0) * 1000);
}

/**
 * An undo of a change by hand also has what the phone shows meanwhile: `keys` (rows shown as they
 * were) or `pageId` (a tab back in its place). They settle when the server answers.
 */
export type ActionUndoPayload = {
  actionId: string;
  itemIds?: string[];
  clientId?: string;
  keys?: LinkKey[];
  pageId?: string;
  /** Week 9: «Отменить» of «Убрать страницу» — the page shown again here settles when it answers. */
  restoredPageId?: string;
  /** Week 11: «Отменить» of a view change — the old look shown here settles when it answers. */
  viewPageId?: string;
  /** Week 11: «Вернуть» one view setting (`keys` of views.md). */
  settingKeys?: string[];
};

const NOTHING: ManualOut = {
  moved: false,
  reason: null,
  rows: [],
  removed: [],
  pages: [],
  view_versions: [],
  action: null,
  learned_ru: null,
};

export type DeviceInfo = () => Omit<DeviceIn, 'client_id'>;

/** `reminder.create`: the S13 body, sent as it was saved. */
export type ReminderCreatePayload = { body: ReminderCreateIn };

/** One event of `reminder.events`; `fire_id` is looked up at send time when the fire was local. */
export type QueuedReminderEvent = Omit<ReminderEventIn, 'fire_id' | 'fire_key'> & {
  fire_id: string | null;
  fire_key: string;
  /** The `client_id` of the event the server called `invalid`: this is its one fixed resend. */
  retry_of?: string;
};
export type ReminderEventsPayload = {
  events: QueuedReminderEvent[];
  /** Filled in from the answer: event `client_id` → the action it made (a late «Сделано»). */
  actionIds?: Record<string, string>;
};

/** Where reminders from the server go (src/alarms/service.ts). */
export type ReminderSink = {
  applyServer(reminders: ReminderOut[], fires: FireOut[], deviceId?: string | null): void;
  created(clientId: string, out: ReminderWithFiresOut): void;
  /** POST /reminders refused it for good (e.g. `reminder_in_past`): the local rings go. */
  createFailed(clientId: string, code: string): void;
  /** The server id of a fire, or null while its reminder is not on the server yet. */
  fireId(key: string): string | null;
  /** The server's key for a fire (a local key saved offline maps to it once POST /reminders answered). */
  serverKey(key: string): string | null;
  /** The fire will never reach the server (offline test alarm, refused reminder): drop its events. */
  localOnly(key: string): boolean;
  deviceRegistered(device: DeviceOut): void;
  /** Week 9: PATCH /reminders/{id} answered / refused for good. */
  updated(id: string, out: ReminderWithFiresOut): void;
  updateFailed(id: string): void;
};

/** Week 10: `import.telegram` — the file is uploaded once (`uploadId` kept), then the import starts. */
export type ImportPayload = { clientId: string; file: RecordFile; uploadId?: string };

/** Where repeats, stacks and imports from the server go (src/dedup/service.ts). */
export type DedupSink = {
  apply(x: { groups: DuplicateGroupOut[]; collections: CollectionOut[]; imports: ImportOut[]; pending: PendingActionOut[] }): void;
  importStarted(clientId: string, out: ImportOut): void;
  importFailed(clientId: string, code: string): void;
};

/** Where tasks and actions from the server go (src/tasks/service.ts). */
export type TaskSink = {
  applyServer(tasks: TaskOut[]): void;
  created(clientId: string, out: TaskWriteOut): void;
  createFailed(clientId: string): void;
  serverId(key: string): string | null;
  updated(key: string, out: TaskWriteOut, clientId: string): void;
  updateFailed(key: string, clientId: string): void;
  /** Week 11а (`task.patch`): the version the server last gave, and the answer of a change. */
  version?(key: string): number | null;
  patched?(key: string, out: TaskWriteOut, clientId: string): void;
  patchFailed?(key: string, clientId: string): void;
};

export type SyncDeps = {
  api: Api;
  outbox: OutboxRepository;
  records: RecordsRepository;
  pages: PagesRepository;
  installId: () => Promise<string>;
  deviceInfo: DeviceInfo;
  now?: () => number;
  random?: () => number;
  /** Local records or pages changed: reload lists. */
  onChanged?: () => void;
  /** The server hid a new record as an exact repeat (the person can undo it). */
  onAutoMerged?: (recordId: string, canonicalCreatedAt: string) => void;
  /** Nothing moves while true: the account needs S05 or S04b first. */
  blocked?: () => boolean;
  /** The server refused the consent given for this account: ask again. */
  onAccountConsentRejected?: () => void;
  /** «Похожие положу туда же»: the move of this outbox row taught the server a placement rule. */
  onLearned?: (outboxId: string, text: string) => void;
  /** Week 11а: a move of a row with a time was refused (`reason: "timed"`). */
  onTimedRefused?: () => void;
  /** A line from the server for the person («Часть уже изменена вами — вернул остальное»). */
  onNotice?: (text: string) => void;
  /** Week 8: reminders and fires (sync arrays, POST /reminders, events). */
  reminders?: ReminderSink;
  /** Week 9: tasks («Дела», «Покупки») and actions («Что я сделал»). */
  tasks?: TaskSink;
  actions?: (list: ActionOut[]) => void;
  /** Week 9: suggestions (status changes) and learned rules of /sync. `pending_actions` is empty until a producer exists. */
  extras?: (x: { suggestions: SuggestionOut[]; habits: HabitOut[]; pendingActions: number }) => void;
  /** Week 10: «Объединить?» groups, stacks, imports, things waiting for «Да» (/sync arrays). */
  dedup?: DedupSink;
  /** Week 11: view changes by hand (`page.view`) and field values of «Своя страница» (`page.item_fields`). */
  views?: { send(e: OutboxEntry): Promise<void>; facets?: (list: ItemFacetOut[]) => Promise<void> };
  /** Week 12: «Расходы» — changes by hand (`expense.*`), /sync `expense_entries` / `expense_categories` (src/expenses/service.ts). */
  expenses?: {
    send(e: OutboxEntry): Promise<void>;
    apply(x: { entries: ExpenseOut[]; categories: ExpenseCategoryOut[] }): void;
    tombstone?(id: string): void;
  };
};

export type PushResult = { sent: number; retried: number; failed: number; offline: boolean };

/** Kinds that later entries depend on (devices/items need consent on the server): strict order. */
const BARRIERS = new Set(['consent.accept', 'device.register']);

/**
 * Changes by hand keep the order of the taps among themselves: each names its neighbours as they
 * were after the one before. A row waiting for its retry holds the later ones, the rest still go.
 */
const IN_TAP_ORDER = new Set<string>([
  'page.item_move',
  'item.move_to_page',
  'page.item_remove',
  'pages.reorder',
  'pages.remove',
  'pages.restore',
  'action.undo',
  'task.create',
  'task.update',
  'page.view',
  'page.item_fields',
  'page.item_look',
  'task.patch',
  'task.clear_done',
  'expense.create',
  'expense.patch',
  'expense.delete',
  'expense.categories',
]);

/**
 * Outbox → server, then server → local SQLite.
 * Guarantees: FIFO for barrier kinds; items are idempotent by `client_id` (a retry after a lost
 * response can't duplicate); nothing is deleted — permanent rejections are kept as `failed`.
 */
export class SyncEngine {
  private running: Promise<void> | null = null;
  private again = false;
  /** The outbox row being sent right now, and when its call is over. */
  private sending: { id: string; done: Promise<void> } | null = null;
  private readonly held = new Set<string>();
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(private readonly d: SyncDeps) {
    this.now = d.now ?? Date.now;
    this.random = d.random ?? Math.random;
  }

  /** Single-flight: a call during a run schedules exactly one more run. */
  run(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    if (this.d.blocked?.()) return Promise.resolve();
    this.running = (async () => {
      do {
        this.again = false;
        if (this.d.blocked?.()) break;
        const res = await this.push();
        let applied = 0;
        if (!res.offline) {
          try {
            applied = await this.pull();
          } catch {
            // pull is best-effort; cursor only moves on success
          }
        }
        if (res.sent > 0 || res.failed > 0 || applied > 0) this.d.onChanged?.();
      } while (this.again);
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /**
   * «Отменить»: the engine keeps its hands off this row until `release`. When a call of it is in
   * flight, waits for the end of that call first, so the row is then either waiting or answered.
   */
  async hold(outboxId: string): Promise<void> {
    while (this.sending?.id === outboxId) await this.sending.done.catch(() => undefined);
    this.held.add(outboxId);
  }

  release(outboxId: string): void {
    this.held.delete(outboxId);
  }

  /** Resolves when no run is in flight: nothing is writing the old account's answers any more. */
  async whenIdle(): Promise<void> {
    while (this.running) await this.running.catch(() => undefined);
  }

  async push(): Promise<PushResult> {
    const res: PushResult = { sent: 0, retried: 0, failed: 0, offline: false };
    const pending = await this.d.outbox.listPending(500);
    // Consent and device come first, whenever they were queued: everything else depends on them.
    const ordered = [...pending.filter((e) => BARRIERS.has(e.kind)), ...pending.filter((e) => !BARRIERS.has(e.kind))];
    let tapsWait = false;
    for (const entry of ordered) {
      if (this.d.blocked?.()) break;
      const sender = this.senderFor(entry);
      if (!sender) continue; // no endpoint yet (chat: week 5) — stays queued
      const barrier = BARRIERS.has(entry.kind);
      const inOrder = IN_TAP_ORDER.has(entry.kind);
      if (inOrder && (tapsWait || this.held.has(entry.id))) {
        tapsWait = true;
        continue;
      }
      if (entry.nextAttemptAt > this.now()) {
        if (barrier) break;
        if (inOrder) tapsWait = true;
        continue;
      }
      let release: () => void = () => undefined;
      this.sending = { id: entry.id, done: new Promise<void>((r) => (release = r)) };
      try {
        if (this.held.has(entry.id)) continue;
        // `pending` above is a snapshot: the row may have been taken back or updated since.
        const fresh = (await this.d.outbox.get(entry.id)) ?? entry;
        if (fresh.status !== 'pending') continue;
        await sender(fresh);
        await this.d.outbox.markSent(entry.id);
        res.sent++;
      } catch (e) {
        if (e instanceof SignInRequiredError) {
          res.offline = true; // not this row's fault: everything waits for S04b
          break;
        }
        const msg = e instanceof ApiError ? e.code : e instanceof Error ? e.message : String(e);
        if (isRetryable(e)) {
          if (inOrder) tapsWait = true;
          const retryAfter = e instanceof ApiError ? e.retryAfter : null;
          await this.d.outbox.markRetry(entry.id, msg, this.now() + backoffMs(entry.attempts, retryAfter, this.random));
          res.retried++;
          if (isOfflineError(e)) {
            res.offline = true;
            break; // no point trying the rest now
          }
          if (barrier) break;
        } else {
          await this.d.outbox.markFailed(entry.id, msg);
          res.failed++;
          if (entry.kind === 'consent.accept' && (entry.payload as ConsentPayload).afterAccountSwitch) {
            this.d.onAccountConsentRejected?.();
            break;
          }
        }
      } finally {
        this.sending = null;
        release();
      }
    }
    return res;
  }

  /** GET /sync?since= until has_more=false; applies items + tombstones, then moves the cursor. */
  async pull(): Promise<number> {
    let since = await this.d.records.getCursor();
    let applied = 0;
    for (let page = 0; page < 50; page++) {
      const out = await this.d.api.sync(since);
      for (const item of out.items ?? []) {
        const before = await this.d.records.findByServerId(item.id);
        await this.d.records.applyRemote(item);
        applied++;
        // Files and voice are compared once their text is ready, long after POST /items: the
        // record the person sees disappears here, so this is where «Отменить» has to be offered.
        if (before && !before.hiddenReason && item.hidden_reason === 'duplicate_merged') {
          const original = item.canonical_id ? await this.d.records.findByServerId(item.canonical_id) : null;
          this.d.onAutoMerged?.(before.id, original?.occurredAt ?? item.updated_at);
        }
      }
      for (const screen of out.screens ?? []) {
        // «Сегодня» is a built-in screen on the phone, it has no links (docs/api/pages.md).
        if (screen.kind === 'system_today') continue;
        await this.d.pages.applyRemote(screen);
        applied++;
      }
      for (const link of out.screen_items ?? []) {
        await this.d.pages.applyLink(link);
        applied++;
      }
      // Week 8 (docs/api/reminders.md «Sync»): no tombstones — `deleted_at` / fire state `cancelled`.
      const rems = Array.isArray(out.reminders) ? remindersOf(out.reminders) : [];
      const fs = Array.isArray(out.reminder_fires) ? firesOf(out.reminder_fires) : [];
      if (rems.length > 0 || fs.length > 0) {
        this.d.reminders?.applyServer(rems, fs);
        applied += rems.length + fs.length;
      }
      // Week 9: tasks (no tombstones: `deleted_at`) and actions («Что я сделал», actions.md «Sync»).
      const ts = Array.isArray(out.tasks) ? tasksOf(out.tasks) : [];
      if (ts.length > 0) {
        this.d.tasks?.applyServer(ts);
        applied += ts.length;
      }
      const extra = {
        suggestions: Array.isArray(out.suggestions) ? suggestionsOf(out.suggestions) : [],
        habits: Array.isArray(out.habits) ? habitsOf(out.habits) : [],
        pendingActions: Array.isArray(out.pending_actions) ? out.pending_actions.length : 0,
      };
      if (extra.suggestions.length > 0 || extra.habits.length > 0) {
        this.d.extras?.(extra);
        applied += extra.suggestions.length + extra.habits.length;
      }
      // Week 10 (3-engineering §4.4: every entity with `seq` comes in /sync; absent arrays are fine).
      const dedup = {
        groups: duplicateGroupsOf(out.duplicate_groups),
        collections: collectionsOf(out.collections),
        imports: importsOf(out.imports),
        pending: pendingActionsOf(out.pending_actions),
      };
      if (dedup.groups.length + dedup.collections.length + dedup.imports.length + dedup.pending.length > 0) {
        this.d.dedup?.apply(dedup);
        applied += dedup.groups.length + dedup.collections.length + dedup.imports.length;
      }
      // Week 11 (views.md «Sync»): own field values and checklist ticks (`screen_items.done_at`).
      const ticks = (out.screen_items ?? [])
        .filter((l) => l.done_at !== undefined)
        .map((l) => ({ id: l.id, page_id: l.page_id, item_id: l.item_id, data: { done: !!l.done_at }, seq: l.seq }));
      const facets = [...itemFacetsOf(out.item_facets), ...ticks];
      if (facets.length > 0 && this.d.views?.facets) {
        await this.d.views.facets(facets);
        applied += facets.length;
      }
      // Week 12 (docs/api/expenses.md «Sync»): `expenses` (`deleted_at` while in the trash) and `expense_categories`.
      const spent = { entries: expensesOf(out.expenses), categories: expenseCategoriesOf(out.expense_categories) };
      if (spent.entries.length + spent.categories.length > 0) {
        this.d.expenses?.apply(spent);
        applied += spent.entries.length + spent.categories.length;
      }
      const acts = Array.isArray(out.actions) ? actionsOf(out.actions) : [];
      if (acts.length > 0) {
        this.d.actions?.(acts);
        applied += acts.length;
      }
      for (const t of out.tombstones ?? []) {
        if (t.entity === 'item' || t.entity === 'items') await this.d.records.applyTombstone(t.id);
        else if (t.entity === 'screen') await this.d.pages.applyTombstone(t.id);
        else if (t.entity === 'screen_item') await this.d.pages.removeLink(t.id);
        else if (t.entity === 'expense_entry' || t.entity === 'expense') this.d.expenses?.tombstone?.(t.id);
        applied++;
      }
      if (typeof out.next_since === 'number' && out.next_since >= since) {
        since = out.next_since;
        await this.d.records.setCursor(since);
      }
      if (!out.has_more) break;
    }
    return applied;
  }

  private senderFor(entry: OutboxEntry): ((e: OutboxEntry) => Promise<void>) | null {
    switch (entry.kind) {
      case 'consent.accept':
        return (e) => this.sendConsent(e);
      case 'device.register':
        return () => this.sendDevice();
      case 'item.create':
        return (e) => this.sendItem(e);
      case 'item.verify':
        return (e) => this.sendVerify(e);
      case 'item.unmerge':
        return (e) => this.sendUnmerge(e);
      case 'item.correct':
        return (e) => this.sendCorrect(e);
      case 'item.delete':
        return (e) => this.sendTrash(e, 'deleted');
      case 'item.restore':
        return (e) => this.sendTrash(e, 'restored');
      case 'profile.update':
        return (e) => this.sendProfile(e);
      case 'pages.create':
        return (e) => this.sendPages(e);
      case 'pages.update':
        return (e) => this.sendRename(e);
      case 'capture.text':
        return (e) => this.sendLegacyText(e);
      case 'feedback.send':
        return (e) => this.sendFeedback(e);
      case 'action.undo':
        return (e) => this.sendUndo(e);
      case 'page.item_move':
        return (e) => this.sendItemMove(e);
      case 'item.move_to_page':
        return (e) => this.sendMoveToPage(e);
      case 'page.item_remove':
        return (e) => this.sendItemRemove(e);
      case 'pages.reorder':
        return (e) => this.sendPagesReorder(e);
      case 'pages.remove':
        return (e) => this.sendPageRemove(e, 'remove');
      case 'pages.restore':
        return (e) => this.sendPageRemove(e, 'restore');
      case 'reminder.create':
        return (e) => this.sendReminder(e);
      case 'reminder.events':
        return (e) => this.sendReminderEvents(e);
      case 'reminder.update':
        return (e) => this.sendReminderUpdate(e);
      case 'reminder.delete':
        return (e) => this.sendReminderDelete(e);
      case 'task.create':
        return (e) => this.sendTaskCreate(e);
      case 'task.update':
        return (e) => this.sendTaskUpdate(e);
      case 'task.patch':
        return (e) => this.sendTaskPatch(e);
      case 'task.clear_done':
        return (e) => this.sendClearDone(e);
      case 'page.item_look':
        return (e) => this.sendItemLook(e);
      case 'import.telegram':
        return (e) => this.sendImport(e);
      case 'expense.create':
      case 'expense.patch':
      case 'expense.delete':
      case 'expense.categories': {
        const expenses = this.d.expenses;
        return expenses ? (e) => expenses.send(e) : null;
      }
      case 'page.view':
      case 'page.item_fields': {
        const views = this.d.views;
        return views ? (e) => views.send(e) : null;
      }
      default:
        return null;
    }
  }

  /** The page already shows the old order; the server brings it back too, then sync confirms. */
  private async sendUndo(e: OutboxEntry): Promise<void> {
    const p = e.payload as ActionUndoPayload;
    try {
      // client_id = the outbox row: a repeat returns the first result (actions.md).
      const out = await this.d.api.undoAction(p.actionId, {
        client_id: p.clientId ?? e.id,
        ...(p.itemIds ? { item_ids: p.itemIds } : {}),
        ...(p.settingKeys ? { keys: p.settingKeys } : {}),
      });
      // The tab's place comes back in /sync (`page_patches` carry rows only, pages.md).
      if (p.pageId) await this.d.pages.settlePage(p.pageId, 'position');
      if (p.restoredPageId) await this.d.pages.settlePage(p.restoredPageId, 'removed');
      if (p.viewPageId) await this.d.pages.settlePage(p.viewPageId, 'view');
      if (out.action || out.undo) this.d.actions?.([...(out.action ? [out.action] : []), ...(out.undo ? [out.undo] : [])]);
      if (out.partial && out.message_ru) this.d.onNotice?.(out.message_ru);
      if (!p.keys) return;
      const rows = out.page_patches.flatMap((x) => x.rows);
      const removed = out.page_patches.flatMap((x) => x.removed_item_ids.map((item_id) => ({ page_id: x.page_id, item_id })));
      const versions = out.page_patches.map((x) => ({ page_id: x.page_id, view_version: x.view_version }));
      await this.settleKeys(p.keys, p.keys, { ...NOTHING, moved: true, rows, removed, view_versions: versions });
    } catch (err) {
      if (!isRetryable(err)) {
        // Too late or refused: the server's rows (and the page's place) are shown again.
        for (const k of p.keys ?? []) await this.d.pages.settleLink(k.page, k.item);
        if (p.pageId) await this.d.pages.settlePage(p.pageId, 'position');
        if (p.restoredPageId) await this.d.pages.settlePage(p.restoredPageId, 'removed');
        if (p.viewPageId) await this.d.pages.settlePage(p.viewPageId, 'view');
      }
      throw err;
    }
  }

  // --- week 7: by hand (pages/manual.ts, docs/api/pages.md «Manual order») ---

  /** The server id of a local page; null = it lives on this phone only. Throws while it is on its way. */
  private async pageServerId(localId: string | null, wait = true): Promise<string | null> {
    if (!localId) return null;
    const page = await this.d.pages.get(localId);
    if (!page) return null;
    if (page.serverId) return page.serverId;
    if (wait && page.syncState === 'pending') throw new Error('page_not_synced');
    return null;
  }

  /** The server id of a local record; null = on this phone only. Throws while its `item.create` waits. */
  private async itemServerId(recordId: string | null, wait = true): Promise<string | null> {
    if (!recordId) return null;
    const rec = await this.d.records.get(recordId);
    if (!rec) return null;
    if (rec.serverId) return rec.serverId;
    if (!wait) return null;
    if (await this.creating(recordId)) throw new Error('record_not_synced');
    return null;
  }

  private async creating(recordId: string): Promise<boolean> {
    return (await this.d.outbox.listPending(500)).some((row) => {
      if (row.kind !== 'item.create') return false;
      const p = row.payload as ItemPayload;
      return p.clientId === recordId || p.sourceMeta?.recording_id === recordId;
    });
  }

  /**
   * The nearest neighbour the server knows (the server needs at least one).
   */
  private async neighbour(ids: string[], resolve: (id: string) => Promise<string | null>) {
    for (const id of ids) {
      const server = await resolve(id);
      if (server) return server;
    }
    return null;
  }

  /**
   * The rows of the change take the server's answer. A row made under a local key (page or record
   * not on the server then) goes, and the server's row under the real keys takes its place. When
   * the call did nothing (`moved: false`: a later move on another phone, gone neighbours), the
   * rows show where they really are.
   */
  private async settleKeys(keys: LinkKey[], real: LinkKey[], out: ManualOut): Promise<void> {
    const find = (k: LinkKey) => out.rows.find((r) => r.page_id === k.page && r.item_id === k.item) ?? null;
    for (const [i, k] of keys.entries()) {
      const r = real[i] ?? k;
      const answer = find(r);
      if (r.page !== k.page || r.item !== k.item) {
        await this.d.pages.settleLink(k.page, k.item, { answer: null, keepShown: out.moved && !answer });
        if (answer) await this.d.pages.applyLink(answer);
        continue;
      }
      await this.d.pages.settleLink(k.page, k.item, { answer, keepShown: out.moved });
    }
    // Gone from the page for good (the undo took back a row that did not exist before).
    for (const gone of out.removed) {
      const left = await this.d.pages.getLink(gone.page_id, gone.item_id);
      if (left) await this.d.pages.removeLink(left.id);
    }
    for (const v of out.view_versions) await this.d.pages.setView(v.page_id, v.view_version, null);
    const mine = new Set(real.map((k) => `${k.page}|${k.item}`));
    for (const row of out.rows) if (!mine.has(`${row.page_id}|${row.item_id}`)) await this.d.pages.applyLink(row);
    for (const page of out.pages) if (page.kind !== 'system_today') await this.d.pages.applyRemote(page);
  }

  /**
   * One change by hand of rows: resolve the server ids, call, take the rows it returns, keep the
   * action for «Отменить». Refused for good: the server's rows come back on screen.
   */
  private async sendLink(e: OutboxEntry, call: () => Promise<{ out: ManualOut; real: LinkKey[] } | null>): Promise<void> {
    const p = e.payload as LinkPayload;
    let res: { out: ManualOut; real: LinkKey[] } | null;
    try {
      res = await call();
    } catch (err) {
      if (!isRetryable(err)) for (const k of p.keys) await this.d.pages.settleLink(k.page, k.item);
      throw err;
    }
    if (!res) return; // lives on this phone only: the rows stay as the person left them
    await this.settleKeys(p.keys, res.real, res.out);
    await this.d.outbox.updatePayload(e.id, { ...p, actionId: res.out.action?.id ?? null, realKeys: res.real });
    if (res.out.learned_ru) this.d.onLearned?.(e.id, res.out.learned_ru);
    // Week 11а: a row with a time on «Дела» keeps its place (pages.md `timed`); the row is already back.
    if (!res.out.moved && res.out.reason === 'timed') this.d.onTimedRefused?.();
  }

  private sendItemMove(e: OutboxEntry): Promise<void> {
    return this.sendLink(e, async () => {
      const p = e.payload as ItemMovePayload;
      const page = await this.pageServerId(p.pageId);
      const item = await this.itemServerId(p.recordId);
      if (!page || !item) return null;
      const known = (id: string) => this.itemServerId(id, false);
      const after = await this.neighbour(p.above, known);
      const before = await this.neighbour(p.below, known);
      if (!after && !before) {
        // No neighbour on the server yet: wait for one that is on its way, else it stays here only.
        for (const id of [...p.above, ...p.below]) if (await this.creating(id)) throw new Error('record_not_synced');
        return null;
      }
      // The phone's key is only good among the same neighbours as on screen.
      const exact = after === (await known(p.above[0] ?? '')) && before === (await known(p.below[0] ?? ''));
      const out = await this.d.api.moveItem(page, {
        client_id: p.clientId,
        client_ts: p.at,
        item_id: item,
        after_item_id: after,
        before_item_id: before,
        ...(p.position && exact ? { position: p.position, base_seq: p.baseSeq } : {}),
        ...('groupKey' in p ? { group_key: p.groupKey ?? null } : {}),
        base_view_version: p.baseViewVersion,
      });
      return { out, real: [{ page, item }] };
    });
  }

  private sendMoveToPage(e: OutboxEntry): Promise<void> {
    return this.sendLink(e, async () => {
      const p = e.payload as MoveToPagePayload;
      const item = await this.itemServerId(p.recordId);
      if (!item) return null;
      const to: (string | null)[] = [];
      for (const id of p.toPageIds) to.push(await this.pageServerId(id));
      const targets = to.filter((x): x is string => !!x);
      if (targets.length === 0) return null; // pages only on this phone
      const from = await this.pageServerId(p.fromPageId);
      // From a page the server does not have, it can only show it there too.
      const mode = p.mode === 'move' && from ? 'move' : 'also_show';
      const out = await this.d.api.moveToPage(item, {
        client_id: p.clientId,
        client_ts: p.at,
        mode,
        ...(mode === 'move' ? { from_page_id: from } : {}),
        to_page_ids: targets,
      });
      const real: LinkKey[] = to.map((page, i) => (page ? { page, item } : (p.keys[i] as LinkKey)));
      if (p.mode === 'move') real.push(from ? { page: from, item } : (p.keys[p.toPageIds.length] as LinkKey));
      return { out, real };
    });
  }

  private sendItemRemove(e: OutboxEntry): Promise<void> {
    return this.sendLink(e, async () => {
      const p = e.payload as ItemRemovePayload;
      const page = await this.pageServerId(p.pageId);
      const item = await this.itemServerId(p.recordId);
      if (!page || !item) return null;
      const out = await this.d.api.removeFromPage(page, item, p.clientId);
      return { out, real: [{ page, item }] };
    });
  }

  /** Week 11а: colour / «Приколоть» of a sticker — the row call of views.md; its row comes back. */
  private sendItemLook(e: OutboxEntry): Promise<void> {
    return this.sendLink(e, async () => {
      const p = e.payload as ItemLookPayload;
      const page = await this.pageServerId(p.pageId);
      const item = await this.itemServerId(p.recordId);
      if (!page || !item) return null;
      const out = await this.d.api.setItemFields(page, item, {
        client_id: p.clientId,
        ...('color' in p ? { color: p.color ?? null } : {}),
        ...(typeof p.pinned === 'boolean' ? { pinned: p.pinned } : {}),
      });
      return { out: { ...NOTHING, moved: true, rows: out.link ? [out.link] : [], action: out.action }, real: [{ page, item }] };
    });
  }

  private async sendPagesReorder(e: OutboxEntry): Promise<void> {
    const p = e.payload as PagesReorderPayload;
    if (!(await this.d.pages.get(p.pageId))) return; // a placeholder page of the first launch
    const id = await this.pageServerId(p.pageId);
    if (!id) {
      await this.d.pages.settlePage(p.pageId, 'position'); // lives on this phone only
      return;
    }
    try {
      const known = (x: string) => this.pageServerId(x, false);
      const after = await this.neighbour(p.above, known);
      const before = await this.neighbour(p.below, known);
      if (!after && !before) {
        for (const x of [...p.above, ...p.below]) await this.pageServerId(x); // throws while one is on its way
        await this.d.pages.settlePage(p.pageId, 'position');
        return;
      }
      const out = await this.d.api.reorderPages({
        client_id: p.clientId,
        client_ts: p.at,
        page_id: id,
        after_page_id: after,
        before_page_id: before,
        ...(after === (await known(p.above[0] ?? '')) && before === (await known(p.below[0] ?? ''))
          ? { position: p.position }
          : {}),
      });
      await this.d.pages.settlePage(p.pageId, 'position');
      for (const pg of out.pages) if (pg.kind !== 'system_today') await this.d.pages.applyRemote(pg);
      await this.d.outbox.updatePayload(e.id, { ...p, actionId: out.action?.id ?? null });
    } catch (err) {
      if (!isRetryable(err)) await this.d.pages.settlePage(p.pageId, 'position');
      throw err;
    }
  }

  private async sendPageRemove(e: OutboxEntry, what: 'remove' | 'restore'): Promise<void> {
    const p = e.payload as PageRemovePayload;
    if (!(await this.d.pages.get(p.pageId))) return;
    const id = await this.pageServerId(p.pageId);
    if (!id) {
      await this.d.pages.settlePage(p.pageId, 'removed'); // lives on this phone only
      return;
    }
    try {
      if (what === 'remove') {
        // Week 9: the removal is an action (pages.md): its «Отменить» is POST /actions/{id}/undo.
        const out = await this.d.api.removePage(id);
        await this.d.outbox.updatePayload(e.id, { ...p, actionId: out.action?.id ?? null });
        if (out.action) this.d.actions?.([out.action]);
        await this.d.pages.settlePage(p.pageId, 'removed');
        if (out.page) await this.d.pages.applyRemote(out.page);
      } else {
        const out = await this.d.api.restorePage(id);
        await this.d.pages.settlePage(p.pageId, 'removed');
        await this.d.pages.applyRemote(out);
      }
    } catch (err) {
      if (!isRetryable(err)) await this.d.pages.settlePage(p.pageId, 'removed');
      throw err;
    }
  }

  /** «Сообщить о проблеме»: the body was built when the person pressed «Отправить». */
  private async sendFeedback(e: OutboxEntry): Promise<void> {
    await this.d.api.sendFeedback(e.payload as FeedbackIn);
  }

  private async sendConsent(e: OutboxEntry): Promise<void> {
    const p = e.payload as Partial<ConsentPayload>;
    if (!p.request) throw new ApiError(400, { code: 'consent_payload_legacy' }); // week-1 rows: kept as failed
    await this.d.api.grantConsents(p.request);
  }

  private async sendDevice(): Promise<void> {
    const out = await this.d.api.upsertDevice({ client_id: await this.d.installId(), ...this.d.deviceInfo() });
    if (out && typeof out.id === 'string') this.d.reminders?.deviceRegistered(out);
  }

  private async sendReminder(e: OutboxEntry): Promise<void> {
    const { body } = e.payload as ReminderCreatePayload;
    try {
      const out = await this.d.api.createReminder(body);
      this.d.reminders?.created(body.client_id, out);
      if (out.action) this.d.actions?.([out.action]);
    } catch (err) {
      if (!isRetryable(err)) this.d.reminders?.createFailed(body.client_id, err instanceof ApiError ? err.code : 'failed');
      throw err;
    }
  }

  /**
   * One batch of rings / buttons, in the order they happened. An event of a fire whose reminder is
   * still in the outbox waits (its `reminder.create` row goes first); one that can never be sent
   * (offline test alarm) is dropped. `not_found` / `invalid` from the server are not retried.
   */
  private async sendReminderEvents(e: OutboxEntry): Promise<void> {
    const p = e.payload as ReminderEventsPayload;
    const sink = this.d.reminders;
    const events: ReminderEventIn[] = [];
    const byClient = new Map(p.events.map((ev) => [ev.client_id, ev]));
    for (const ev of p.events) {
      if (sink?.localOnly(ev.fire_key)) continue;
      const fireId = ev.fire_id ?? sink?.fireId(ev.fire_key) ?? null;
      const key = sink ? sink.serverKey(ev.fire_key) : ev.fire_key;
      // A fire saved offline is unknown to the server until its reminder.create row went through.
      if (!fireId && !key) throw new Error('fire_pending');
      events.push({
        client_id: ev.client_id,
        ...(fireId ? { fire_id: fireId } : { fire_key: key! }),
        event: ev.event,
        at: ev.at,
        ...(ev.meta ? { meta: ev.meta } : {}),
      });
    }
    events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    for (let i = 0; i < events.length; i += 200) {
      const out = await this.d.api.reminderEvents(events.slice(i, i + 200));
      if (out.fires.length > 0) sink?.applyServer([], out.fires);
      // Week 9: a late «Сделано» on a missed one is an action («Отменить» in S20 / on the strip).
      // Each names its event (`event_client_id`): kept on this row, so «Отменить» finds its own one.
      if (out.actions.length > 0) {
        this.d.actions?.(out.actions);
        const linked = out.actions.filter((a) => a.event_client_id && byClient.has(a.event_client_id));
        if (linked.length > 0) {
          const row = await this.d.outbox.get(e.id);
          const prev = (row?.payload as ReminderEventsPayload | undefined) ?? p;
          const actionIds = { ...(prev.actionIds ?? {}) };
          for (const a of linked) actionIds[a.event_client_id!] = a.id;
          await this.d.outbox.updatePayload(e.id, { ...prev, actionIds } satisfies ReminderEventsPayload);
        }
      }
      const fixed = out.results
        .filter((r) => r.status === 'invalid')
        .map((r) => fixInvalid(byClient.get(r.client_id)))
        .filter((x): x is QueuedReminderEvent => x !== null);
      // Not the same row again: a new outbox row with new client_ids (reminders.md «fix and resend»).
      if (fixed.length > 0) await this.d.outbox.enqueue('reminder.events', { events: fixed } satisfies ReminderEventsPayload);
    }
  }

  private async sendItem(e: OutboxEntry): Promise<void> {
    const p = e.payload as ItemPayload;
    let uploadId = p.uploadId;
    if (p.file && !uploadId) {
      uploadId = await this.d.api.uploadFile({
        clientId: p.clientId, // upload client_id = item client_id → same upload on retry
        uri: p.file.uri,
        mime: p.file.mime,
        bytes: p.file.bytes,
        sha256: p.file.sha256,
      });
      await this.d.outbox.updatePayload(e.id, { ...p, uploadId });
    }
    const body: ItemCreateIn = {
      client_id: p.clientId,
      // Files: the server derives kind from the upload's MIME (it rejects e.g. `email` for files).
      ...(uploadId ? {} : { kind: p.kind === 'link' ? 'link' : 'note' }),
      source: p.source,
      occurred_at: p.occurredAt,
      ...(p.text ? { text: p.text } : {}),
      ...(p.url ? { url: p.url } : {}),
      ...(uploadId ? { upload_id: uploadId } : {}),
      ...(p.contentHash ? { content_hash: p.contentHash } : {}),
      ...(p.sourceMeta ? { source_meta: p.sourceMeta } : {}),
    };
    // A page not on the server yet: wait for it (its pages.create row is ahead in the outbox).
    const page = p.pageId ? await this.d.pages.get(p.pageId) : null;
    if (page && !page.serverId && page.syncState === 'pending') throw new Error('page_not_synced');
    const { item, duplicate } = await this.d.api.createItem(body);
    // Voice: the first fragment is the record, the server joins the others into it (records/voice.py).
    const recordingId = typeof p.sourceMeta?.recording_id === 'string' ? p.sourceMeta.recording_id : p.clientId;
    if (recordingId !== p.clientId) return;
    const before = await this.d.records.get(p.clientId);
    await this.d.records.markSynced(p.clientId, item);
    // The phone found the repeat itself and the strip was shown at save: not news a second time.
    if (duplicate && !p.replay && !before?.hiddenReason) this.d.onAutoMerged?.(p.clientId, duplicate.canonical_created_at);
    // Saved from a page: the record shows there, whatever its rule says. A repeat is hidden, so
    // the page shows the record it was merged into.
    if (page?.serverId) await this.linkToPage(page.serverId, duplicate?.canonical_id ?? item.id);
  }

  /** The record is saved already: a refused link is not worth failing the save for. */
  private async linkToPage(pageServerId: string, itemServerId: string): Promise<void> {
    try {
      const { link } = await this.d.api.addItemToPage(pageServerId, itemServerId);
      await this.d.pages.applyLink(link);
    } catch (e) {
      if (isRetryable(e)) throw e;
    }
  }

  /** «Верно». If the record changed meanwhile, confirm only values that are still what was seen. */
  private async sendVerify(e: OutboxEntry): Promise<void> {
    const p = e.payload as VerifyPayload;
    const keys = Object.keys(p.fields);
    try {
      let item: ItemOut;
      try {
        item = await this.d.api.patchItem(p.serverId, { verify: keys, base_seq: p.baseSeq });
      } catch (err) {
        if (!(err instanceof ApiError) || err.code !== 'conflict') throw err;
        const fresh = await this.d.api.getItem(p.serverId);
        const same = keys.filter((k) => fresh.review_fields?.[k] && fresh.review_fields[k].value === p.fields[k]);
        if (same.length === 0) {
          await this.d.records.applyRemote(fresh);
          await this.clearVerify(p.recordId, keys); // the card asks again about the new value
          return;
        }
        try {
          item = await this.d.api.patchItem(p.serverId, { verify: same, base_seq: fresh.seq });
        } catch (again) {
          // Changed once more in that instant: an ordinary retry, not a rejection.
          if (again instanceof ApiError && again.code === 'conflict') throw new Error('conflict');
          throw again;
        }
      }
      await this.d.records.markSynced(p.recordId, item);
      await this.clearVerify(p.recordId, keys);
    } catch (err) {
      if (!isRetryable(err)) await this.clearVerify(p.recordId, keys);
      throw err;
    }
  }

  private async clearVerify(recordId: string, keys: string[]): Promise<void> {
    const rec = await this.d.records.get(recordId);
    if (!rec) return;
    const verify = { ...rec.pending.verify };
    for (const k of keys) delete verify[k];
    await this.d.records.setPending(recordId, { ...rec.pending, verify });
  }

  private async sendUnmerge(e: OutboxEntry): Promise<void> {
    const p = e.payload as UnmergePayload;
    const rec = await this.d.records.get(p.recordId);
    if (!rec) return;
    if (!rec.serverId && (await this.creating(p.recordId))) throw new Error('record_not_synced');
    const serverId = p.serverId ?? rec.serverId;
    // Lives on this phone only: `unmerge` stays set, so it stays shown.
    if (!serverId) return;
    // The phone hid it as a repeat but the server kept it apart: nothing to undo there.
    if (rec.hiddenReason === null) {
      await this.clearUnmerge(p.recordId);
      return;
    }
    try {
      const item = await this.d.api.unmergeItem(serverId);
      await this.d.records.markSynced(p.recordId, item);
      await this.clearUnmerge(p.recordId);
    } catch (err) {
      if (!isRetryable(err)) await this.clearUnmerge(p.recordId); // stays hidden, as on the server
      throw err;
    }
  }

  private async clearUnmerge(recordId: string): Promise<void> {
    const rec = await this.d.records.get(recordId);
    if (!rec) return;
    const { unmerge: _done, ...pending } = rec.pending;
    await this.d.records.setPending(recordId, pending);
  }

  /**
   * «Исправить». On a conflict: if this field still holds what the person saw, only something else in
   * the record changed, so the correction goes again on the newer version. If the field itself changed,
   * the card shows the current value and asks again (docs/api/items.md). A refusal brings back the
   * server's value.
   */
  private async sendCorrect(e: OutboxEntry): Promise<void> {
    const p = e.payload as CorrectPayload;
    const corrections = { [p.key]: p.value };
    try {
      let item: ItemOut;
      try {
        item = await this.d.api.patchItem(p.serverId, { corrections, base_seq: p.baseSeq });
      } catch (err) {
        if (!(err instanceof ApiError) || err.code !== 'conflict') throw err;
        const fresh = await this.d.api.getItem(p.serverId);
        if (fresh.review_fields?.[p.key]?.value !== p.seen) {
          await this.d.records.applyRemote(fresh);
          await this.clearCorrected(p.recordId, p.key, p.value);
          return;
        }
        try {
          item = await this.d.api.patchItem(p.serverId, { corrections, base_seq: fresh.seq });
        } catch (again) {
          if (again instanceof ApiError && again.code === 'conflict') throw new Error('conflict');
          throw again;
        }
      }
      await this.d.records.markSynced(p.recordId, item);
      await this.clearCorrected(p.recordId, p.key, p.value);
    } catch (err) {
      if (!isRetryable(err)) await this.clearCorrected(p.recordId, p.key, p.value);
      throw err;
    }
  }

  /** A newer «Исправить» of the same field keeps its own value on screen. */
  private async clearCorrected(recordId: string, key: string, value: string): Promise<void> {
    const rec = await this.d.records.get(recordId);
    if (rec?.pending.corrected?.[key] !== value) return;
    const corrected = { ...rec.pending.corrected };
    delete corrected[key];
    await this.d.records.setPending(recordId, { ...rec.pending, corrected });
  }

  /** «Удалить» / «Вернуть». A record still on its way waits for its `item.create`, ahead in the outbox. */
  private async sendTrash(e: OutboxEntry, overlay: 'deleted' | 'restored'): Promise<void> {
    const { recordId } = e.payload as TrashPayload;
    const rec = await this.d.records.get(recordId);
    if (!rec) return;
    const clear = async () => {
      const now = await this.d.records.get(recordId);
      if (!now) return;
      const pending = { ...now.pending };
      delete pending[overlay];
      await this.d.records.setPending(recordId, pending);
    };
    if (!rec.serverId) {
      const waiting = (await this.d.outbox.listPending(500)).some((row) => {
        if (row.kind !== 'item.create') return false;
        const p = row.payload as ItemPayload;
        return p.clientId === recordId || p.sourceMeta?.recording_id === recordId;
      });
      if (waiting) throw new Error('record_not_synced');
      // Lives on this phone only: the deletion or return is just local.
      await this.d.records.setLocalTrash(recordId, overlay === 'deleted' ? (rec.pending.deleted ?? this.now()) : null);
      await clear();
      return;
    }
    try {
      const item =
        overlay === 'deleted' ? await this.d.api.deleteItem(rec.serverId) : await this.d.api.restoreItem(rec.serverId);
      await this.d.records.markSynced(recordId, item);
      await clear();
    } catch (err) {
      if (!isRetryable(err)) await clear();
      throw err;
    }
  }

  private async sendProfile(e: OutboxEntry): Promise<void> {
    await this.d.api.patchProfile({ display_name: (e.payload as ProfilePayload).displayName });
  }

  /** One POST /pages per page; idempotent by client_id, so a retry of the row is safe. */
  private async sendPages(e: OutboxEntry): Promise<void> {
    const { pages } = e.payload as PagesCreatePayload;
    let rejected: unknown = null;
    for (const raw of pages) {
      const p: Page = { ...raw, position: typeof raw.position === 'string' ? raw.position : 'V' };
      const local = await this.d.pages.insertLocal({
        ...p,
        titleKk: p.titleKk ?? null,
        serverId: p.serverId ?? null,
        syncState: p.syncState ?? 'pending',
        seq: p.seq ?? 0,
      });
      if (local.serverId) continue;
      const body: PageCreateIn = {
        client_id: p.id,
        template_key: p.templateKey,
        ...(local.title ? { title: local.title } : {}),
        ...(SERVER_CREATED_BY.has(p.createdBy) ? { created_by: p.createdBy as PageCreateIn['created_by'] } : {}),
      };
      try {
        const { page } = await this.d.api.createPage(body);
        await this.d.pages.markSynced(p.id, page);
      } catch (err) {
        const existing = err instanceof ApiError && err.code === 'singleton_exists' ? err.details?.page_id : null;
        if (typeof existing === 'string') {
          // One topic, one page: this local page simply is the one the account already has.
          await this.d.pages.adopt(p.id, existing);
          await this.d.pages.applyRemote(await this.d.api.getPage(existing));
        } else if (isRetryable(err)) {
          throw err;
        } else {
          await this.d.pages.markFailed(p.id);
          rejected = err;
        }
      }
    }
    if (rejected) throw rejected; // the row is kept as `failed`, the other pages are on the server
  }

  private async sendRename(e: OutboxEntry): Promise<void> {
    const p = e.payload as RenamePayload;
    const page = await this.d.pages.get(p.pageId);
    if (!page) return;
    if (page.syncState === 'failed') return; // lives on this phone only
    if (!page.serverId) throw new Error('page_not_synced');
    try {
      // The API has no "no name": an emptied name goes back to the template's default.
      const res = await this.d.api.renamePage(page.serverId, p.title ?? TEMPLATE_DEFAULT_TITLE[page.templateKey], p.clientId ?? e.id);
      await this.d.pages.clearTitleDirty(p.pageId);
      if (res.page) await this.d.pages.applyRemote(res.page);
      if (res.action) this.d.actions?.([res.action]);
      // Week 11: «Отменить» of a rename already sent = the undo of its action.
      await this.d.outbox.updatePayload(e.id, { ...p, actionId: res.action?.id ?? null } satisfies RenamePayload);
    } catch (err) {
      if (!isRetryable(err)) await this.d.pages.clearTitleDirty(p.pageId);
      throw err;
    }
  }

  /** Week-1 rows (`capture.text` without a local record). */
  private async sendLegacyText(e: OutboxEntry): Promise<void> {
    const p = e.payload as { text?: string; clientId?: string };
    if (!p.text) return;
    await this.d.api.createItem({
      client_id: p.clientId ?? e.id,
      kind: 'note',
      source: 'typed',
      text: p.text,
      occurred_at: new Date(e.createdAt).toISOString(),
    });
  }

  /** «Перенести»: PATCH with the version the person saw; a stale one is refused (`409`), sync then shows the server's. */
  private async sendReminderUpdate(e: OutboxEntry): Promise<void> {
    const p = e.payload as ReminderUpdatePayload;
    try {
      const out = await this.d.api.patchReminder(p.id, p.body);
      this.d.reminders?.updated(p.id, out);
      if (out.action) this.d.actions?.([out.action]);
    } catch (err) {
      if (!isRetryable(err)) this.d.reminders?.updateFailed(p.id);
      throw err;
    }
  }

  /** «Удалить» a reminder: 200 with its action since week 9 («Отменить» = its undo); 204 from an older server is fine too. */
  private async sendReminderDelete(e: OutboxEntry): Promise<void> {
    const p = e.payload as { id: string };
    try {
      const out = await this.d.api.deleteReminder(p.id);
      await this.d.outbox.updatePayload(e.id, { ...p, actionId: out.action?.id ?? null });
      if (out.reminder || out.fires.length > 0) this.d.reminders?.applyServer(out.reminder ? [out.reminder] : [], out.fires);
      if (out.action) this.d.actions?.([out.action]);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) return; // gone already
      throw err;
    }
  }

  // --- week 10: Telegram import (src/dedup) ---

  /**
   * The same upload path as any file (POST /uploads → PUT → complete; the upload id is kept, so a
   * retry never uploads twice), then POST /imports/telegram/file with the same `client_id`.
   */
  private async sendImport(e: OutboxEntry): Promise<void> {
    const p = e.payload as ImportPayload;
    try {
      let uploadId = p.uploadId;
      if (!uploadId) {
        uploadId = await this.d.api.uploadFile({
          clientId: p.clientId,
          uri: p.file.uri,
          mime: p.file.mime,
          bytes: p.file.bytes,
          sha256: p.file.sha256,
        });
        await this.d.outbox.updatePayload(e.id, { ...p, uploadId } satisfies ImportPayload);
      }
      const out = await this.d.api.importTelegramFile({ client_id: p.clientId, upload_id: uploadId });
      this.d.dedup?.importStarted(p.clientId, out);
    } catch (err) {
      if (!isRetryable(err)) this.d.dedup?.importFailed(p.clientId, err instanceof ApiError ? err.code : 'failed');
      throw err;
    }
  }

  // --- week 9: «Дела», «Покупки» (src/tasks) ---

  private async sendTaskCreate(e: OutboxEntry): Promise<void> {
    const { body } = e.payload as TaskCreatePayload;
    try {
      this.d.tasks?.created(body.client_id, await this.d.api.createTask(body));
    } catch (err) {
      if (!isRetryable(err)) this.d.tasks?.createFailed(body.client_id);
      throw err;
    }
  }

  /** A tick, or «Отменить» of an added row. Waits for its `task.create` ahead in the outbox. */
  private async sendTaskUpdate(e: OutboxEntry): Promise<void> {
    const p = e.payload as TaskUpdatePayload;
    const id = this.d.tasks?.serverId(p.key) ?? null;
    if (!id) {
      const clientId = p.key.replace(/^local:/, '');
      const waiting = (await this.d.outbox.listPending(500)).some(
        (row) => row.kind === 'task.create' && (row.payload as TaskCreatePayload).body.client_id === clientId,
      );
      if (waiting) throw new Error('task_not_synced');
      return; // lives on this phone only
    }
    try {
      const out = p.deleted
        ? await this.d.api.deleteTask(id, p.clientId)
        : await this.d.api.taskDone(id, { client_id: p.clientId, done: !!p.done });
      // The tick's action: «Отменить» on the strip after it went (today.md, actions.md).
      await this.d.outbox.updatePayload(e.id, { ...p, actionId: out.action?.id ?? null });
      this.d.tasks?.updated(p.key, out, p.clientId);
    } catch (err) {
      if (!isRetryable(err)) this.d.tasks?.updateFailed(p.key, p.clientId);
      throw err;
    }
  }

  /** Week 11а: «Убрать все купленные»; the ids are the server's (rows the phone made wait for theirs). */
  private async sendClearDone(e: OutboxEntry): Promise<void> {
    const p = e.payload as ClearDonePayload;
    const sink = this.d.tasks;
    const ids: string[] = [];
    for (const k of p.keys) {
      const id = sink?.serverId(k) ?? null;
      if (id) ids.push(id);
      else if (
        (await this.d.outbox.listPending(500)).some(
          (row) => row.kind === 'task.create' && (row.payload as TaskCreatePayload).body.client_id === k.replace(/^local:/, ''),
        )
      )
        throw new Error('task_not_synced');
    }
    if (ids.length === 0) return;
    const out = await this.d.api.clearDoneTasks({ client_id: p.clientId, list_key: p.listKey, task_ids: ids });
    if (out.tasks.length > 0) sink?.applyServer(out.tasks);
    if (out.action) this.d.actions?.([out.action]);
    await this.d.outbox.updatePayload(e.id, { ...p, actionId: out.action?.id ?? null } satisfies ClearDonePayload);
  }

  /**
   * Week 11а: «− 2 +» / «На завтра» (PATCH /tasks/{id}). The version is the one the phone has now;
   * `409 conflict` (another phone, or a retry after a lost answer) goes once more with the server's
   * version: the person's change wins, as with every change by hand.
   */
  private async sendTaskPatch(e: OutboxEntry): Promise<void> {
    const p = e.payload as TaskPatchPayload;
    const sink = this.d.tasks;
    const id = sink?.serverId(p.key) ?? null;
    if (!id) {
      const clientId = p.key.replace(/^local:/, '');
      const waiting = (await this.d.outbox.listPending(500)).some(
        (row) => row.kind === 'task.create' && (row.payload as TaskCreatePayload).body.client_id === clientId,
      );
      if (waiting) throw new Error('task_not_synced');
      sink?.patchFailed?.(p.key, p.clientId);
      return; // lives on this phone only
    }
    const call = (version: number) => this.d.api.patchTask(id, { version, client_id: p.clientId, ...p.body });
    try {
      let out: TaskWriteOut;
      try {
        out = await call(sink?.version?.(p.key) ?? 0);
      } catch (err) {
        const v = err instanceof ApiError && err.status === 409 ? Number(err.details?.version) : NaN;
        if (!Number.isFinite(v)) throw err;
        out = await call(v);
      }
      await this.d.outbox.updatePayload(e.id, { ...p, actionId: out.action?.id ?? null } satisfies TaskPatchPayload);
      sink?.patched?.(p.key, out, p.clientId);
    } catch (err) {
      if (!isRetryable(err)) sink?.patchFailed?.(p.key, p.clientId);
      throw err;
    }
  }
}
