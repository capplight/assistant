import * as Crypto from 'expo-crypto';

import type { ItemKind, ItemSource } from '@/api/types';
import type { OutboxRepository } from '@/db/outbox';
import type { LocalRecord, RecordFile, RecordsRepository } from '@/db/records';
import type { ItemPayload } from '@/sync/engine';

/** File access, injected (expo-file-system in the app, fakes in tests). */
export interface FileOps {
  /** Copy into the app's own document storage; returns the new URI. */
  persist(srcUri: string, name: string): Promise<string>;
  size(uri: string): Promise<number>;
  sha256(uri: string): Promise<string>;
}

export type CaptureDeps = {
  outbox: OutboxRepository;
  records: RecordsRepository;
  files: FileOps;
  newId?: () => string;
  /** Called after every save: kicks the sync engine (non-blocking). */
  onSaved?: () => void;
};

/** Spec §3.3: sha256 of the normalized text, computed on the phone before sending. */
export function normalizeText(text: string): string {
  return text.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
}

export function contentHash(text: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, normalizeText(text));
}

const URL_ONLY = /^https?:\/\/\S+$/i;

/** Server item kind from a MIME type (spec §3.3 `items.kind`, §6.1). */
export function kindForMime(mime: string, fileName = ''): ItemKind {
  const m = mime.toLowerCase();
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('audio/')) return 'voice';
  if (m === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (m.includes('wordprocessingml') || m === 'application/msword' || ext === 'docx' || ext === 'doc') return 'docx';
  if (m.includes('spreadsheetml') || m === 'application/vnd.ms-excel' || ext === 'xlsx' || ext === 'xls') return 'xlsx';
  if (m === 'message/rfc822' || ext === 'eml') return 'email';
  if (m.startsWith('text/')) return 'note';
  return 'file_other';
}

/**
 * Saving anything = local record + outbox entry in one step, before any network.
 * The record is visible right away («Ждёт связи» until synced); the engine sends it later.
 */
export class Capture {
  private readonly newId: () => string;

  constructor(private readonly d: CaptureDeps) {
    this.newId = d.newId ?? (() => Crypto.randomUUID());
  }

  async saveText(o: { text: string; source: ItemSource; pageId?: string; url?: string }): Promise<LocalRecord> {
    const text = o.text.trim();
    const id = this.newId();
    const occurredAt = new Date().toISOString();
    const url = o.url ?? (URL_ONLY.test(text) ? text : undefined);
    const kind: ItemKind = url && text === url ? 'link' : 'note';
    const rec = await this.d.records.insertLocal({
      id,
      kind,
      source: o.source,
      text,
      url,
      pageId: o.pageId,
      occurredAt,
    });
    const payload: ItemPayload = {
      clientId: id,
      kind,
      source: o.source,
      occurredAt,
      ...(kind === 'link' ? { url } : { text }),
      ...(o.url && kind !== 'link' ? { url: o.url } : {}),
      contentHash: await contentHash(text),
      ...(o.pageId ? { pageId: o.pageId } : {}),
    };
    await this.d.outbox.enqueue('item.create', payload);
    this.d.onSaved?.();
    return rec;
  }

  async saveFile(o: {
    uri: string;
    mime: string;
    name?: string;
    source: ItemSource;
    kind?: ItemKind;
    note?: string;
    pageId?: string;
  }): Promise<LocalRecord> {
    const id = this.newId();
    const name = o.name || o.uri.split('/').pop() || 'file';
    const file = await this.persistFile(id, o.uri, o.mime, name);
    const kind = o.kind ?? kindForMime(o.mime, name);
    const occurredAt = new Date().toISOString();
    const text = o.note?.trim() || undefined;
    const rec = await this.d.records.insertLocal({
      id,
      kind,
      source: o.source,
      text,
      files: [file],
      pageId: o.pageId,
      occurredAt,
    });
    const payload: ItemPayload = {
      clientId: id,
      kind,
      source: o.source,
      occurredAt,
      file,
      ...(text ? { text } : {}),
      sourceMeta: { file_name: name, mime: o.mime },
      ...(o.pageId ? { pageId: o.pageId } : {}),
    };
    await this.d.outbox.enqueue('item.create', payload);
    this.d.onSaved?.();
    return rec;
  }

  /**
   * One recording = one local record; each ≤3-min fragment is its own upload + item, linked by
   * `source_meta.recording_id` (fragment 0 uses the recording id as its client_id).
   */
  async saveVoice(o: {
    fragments: { uri: string; durationMs: number }[];
    pageId?: string;
  }): Promise<LocalRecord | null> {
    if (o.fragments.length === 0) return null;
    const recordingId = this.newId();
    const occurredAt = new Date().toISOString();
    const mime = 'audio/mp4';
    const files: RecordFile[] = [];
    for (const [i, f] of o.fragments.entries()) {
      const persisted = await this.persistFile(`${recordingId}-${i}`, f.uri, mime, `voice-${i + 1}.m4a`);
      files.push({ ...persisted, durationMs: f.durationMs });
    }
    const rec = await this.d.records.insertLocal({
      id: recordingId,
      kind: 'voice',
      source: 'mic',
      files,
      pageId: o.pageId,
      occurredAt,
    });
    const totalMs = files.reduce((s, f) => s + (f.durationMs ?? 0), 0);
    for (const [i, file] of files.entries()) {
      const payload: ItemPayload = {
        clientId: i === 0 ? recordingId : this.newId(),
        kind: 'voice',
        source: 'mic',
        occurredAt,
        file,
        sourceMeta: {
          recording_id: recordingId,
          fragment: i,
          fragments: files.length,
          duration_ms: file.durationMs ?? 0,
          total_duration_ms: totalMs,
        },
        ...(o.pageId ? { pageId: o.pageId } : {}),
      };
      await this.d.outbox.enqueue('item.create', payload);
    }
    this.d.onSaved?.();
    return rec;
  }

  private async persistFile(id: string, uri: string, mime: string, name: string): Promise<RecordFile> {
    const safe = name.replace(/[^\w.\-]+/g, '_').slice(-80);
    const local = await this.d.files.persist(uri, `${id}-${safe}`);
    const [bytes, sha256] = await Promise.all([this.d.files.size(local), this.d.files.sha256(local)]);
    return { uri: local, mime: mime || 'application/octet-stream', bytes, sha256, name };
  }
}
