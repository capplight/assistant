import type { Api } from '@/api/endpoints';
import { ApiError, isOfflineError, isRetryable } from '@/api/errors';
import type { ConsentsIn, DeviceIn, ItemCreateIn, ItemKind, ItemSource } from '@/api/types';
import type { OutboxEntry, OutboxRepository } from '@/db/outbox';
import type { RecordFile, RecordsRepository } from '@/db/records';

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
};

export type ConsentPayload = { request: ConsentsIn };

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
  installId: () => Promise<string>;
  deviceInfo: DeviceInfo;
  now?: () => number;
  random?: () => number;
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
    this.running = (async () => {
      do {
        this.again = false;
        const res = await this.push();
        if (!res.offline) {
          try {
            await this.pull();
          } catch {
            // pull is best-effort; cursor only moves on success
          }
        }
      } while (this.again);
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async push(): Promise<PushResult> {
    const res: PushResult = { sent: 0, retried: 0, failed: 0, offline: false };
    const pending = await this.d.outbox.listPending(500);
    for (const entry of pending) {
      const sender = this.senderFor(entry);
      if (!sender) continue; // no endpoint yet (pages: week 3, chat: week 5) — stays queued
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
        await this.d.records.applyRemote(item);
        applied++;
      }
      for (const t of out.tombstones ?? []) {
        if (t.entity === 'item' || t.entity === 'items') await this.d.records.applyTombstone(t.id);
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
      case 'capture.text':
        return (e) => this.sendLegacyText(e);
      default:
        return null;
    }
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
    const { item } = await this.d.api.createItem(body);
    // Voice: several fragments share one local record (sourceMeta.recording_id).
    const localId = typeof p.sourceMeta?.recording_id === 'string' ? p.sourceMeta.recording_id : p.clientId;
    if (localId === p.clientId) await this.d.records.markSynced(localId, item);
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
