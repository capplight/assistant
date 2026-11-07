import type { Api } from '@/api/endpoints';
import { ApiError, isOfflineError, isRetryable, SignInRequiredError } from '@/api/errors';
import type { ConsentsIn, DeviceIn, FeedbackIn, ItemCreateIn, ItemKind, ItemOut, ItemSource, PageCreateIn } from '@/api/types';
import type { OutboxEntry, OutboxRepository } from '@/db/outbox';
import type { PagesRepository } from '@/db/pages';
import type { RecordFile, RecordsRepository } from '@/db/records';
import type { RenamePayload } from '@/pages/service';
import type { CorrectPayload, TrashPayload, UnmergePayload, VerifyPayload } from '@/records/actions';
import { TEMPLATE_DEFAULT_TITLE } from '@/pages/templates';
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

export type DeviceInfo = () => Omit<DeviceIn, 'client_id'>;

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
};

export type PushResult = { sent: number; retried: number; failed: number; offline: boolean };

/** Kinds that later entries depend on (devices/items need consent on the server): strict order. */
const BARRIERS = new Set(['consent.accept', 'device.register']);

/**
 * Outbox → server, then server → local SQLite.
 * Guarantees: FIFO for barrier kinds; items are idempotent by `client_id` (a retry after a lost
 * response can't duplicate); nothing is deleted — permanent rejections are kept as `failed`.
 */
export class SyncEngine {
  private running: Promise<void> | null = null;
  private again = false;
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

  /** Resolves when no run is in flight: nothing is writing the old account's answers any more. */
  async whenIdle(): Promise<void> {
    while (this.running) await this.running.catch(() => undefined);
  }

  async push(): Promise<PushResult> {
    const res: PushResult = { sent: 0, retried: 0, failed: 0, offline: false };
    const pending = await this.d.outbox.listPending(500);
    // Consent and device come first, whenever they were queued: everything else depends on them.
    const ordered = [...pending.filter((e) => BARRIERS.has(e.kind)), ...pending.filter((e) => !BARRIERS.has(e.kind))];
    for (const entry of ordered) {
      if (this.d.blocked?.()) break;
      const sender = this.senderFor(entry);
      if (!sender) continue; // no endpoint yet (chat: week 5) — stays queued
      const barrier = BARRIERS.has(entry.kind);
      if (entry.nextAttemptAt > this.now()) {
        if (barrier) break;
        continue;
      }
      try {
        await sender(entry);
        await this.d.outbox.markSent(entry.id);
        res.sent++;
      } catch (e) {
        if (e instanceof SignInRequiredError) {
          res.offline = true; // not this row's fault: everything waits for S04b
          break;
        }
        const msg = e instanceof ApiError ? e.code : e instanceof Error ? e.message : String(e);
        if (isRetryable(e)) {
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
      for (const t of out.tombstones ?? []) {
        if (t.entity === 'item' || t.entity === 'items') await this.d.records.applyTombstone(t.id);
        else if (t.entity === 'screen') await this.d.pages.applyTombstone(t.id);
        else if (t.entity === 'screen_item') await this.d.pages.removeLink(t.id);
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
      default:
        return null;
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
    await this.d.api.upsertDevice({ client_id: await this.d.installId(), ...this.d.deviceInfo() });
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
    await this.d.records.markSynced(p.clientId, item);
    if (duplicate && !p.replay) this.d.onAutoMerged?.(p.clientId, duplicate.canonical_created_at);
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
    try {
      const item = await this.d.api.unmergeItem(p.serverId);
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
      const out = await this.d.api.patchPage(page.serverId, { title: p.title ?? TEMPLATE_DEFAULT_TITLE[page.templateKey] });
      await this.d.pages.clearTitleDirty(p.pageId);
      await this.d.pages.applyRemote(out);
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
}
