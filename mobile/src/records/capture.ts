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
  /**
   * Week 16, account deletion: every file of the person on this phone goes — the records' copies
   * (shares, photos, voice fragments, documents) and everything the app left in its cache (КП
   * files, receipt photos, recordings not saved yet).
   */
  wipeAll?(): Promise<void>;
}

export type CaptureDeps = {
  outbox: OutboxRepository;
  records: RecordsRepository;
  files: FileOps;
  newId?: () => string;
  /** Called after every save: kicks the sync engine (non-blocking). */
  onSaved?: () => void;
  /** Week 10: the text was already here (exact repeat): «Уже было — добавил к записи от …». */
  onRepeat?: (recordId: string, originalDate: string) => void;
};

/**
 * The basis of `content_hash`, byte for byte as the server's `records/textnorm.hash_basis`:
 * NFKC, lowercase, every char that is not a letter or digit → space, spaces collapsed.
 */
export function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** sha256 of the basis; null when nothing is left to compare (only signs or emoji). */
export async function contentHash(text: string): Promise<string | null> {
  const basis = normalizeText(text);
  return basis ? Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, basis) : null;
}

/** How many of the newest records the phone compares a new note with (the server checks them all). */
const REPEAT_WINDOW = 2000;

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
    // Exact repeat (3-engineering 6.3 п. 1, no model): checked here first, so it works offline and
    // in «Без ИИ». Only notes and links typed or shared as text; files are compared by the server.
    const basis = normalizeText(text);
    const original = basis
      ? (await this.d.records.list(REPEAT_WINDOW)).find((r) => r.text !== null && normalizeText(r.text) === basis)
      : undefined;
    let rec = await this.d.records.insertLocal({
      id,
      kind,
      source: o.source,
      text,
      url,
      pageId: o.pageId,
      occurredAt,
    });
    if (original) {
      await this.d.records.markLocalRepeat(id, original.serverId);
      rec = { ...rec, hiddenReason: 'duplicate_merged', canonicalId: original.serverId };
    }
    const hash = await contentHash(text);
    const payload: ItemPayload = {
      clientId: id,
      kind,
      source: o.source,
      occurredAt,
      ...(kind === 'link' ? { url } : { text }),
      ...(o.url && kind !== 'link' ? { url: o.url } : {}),
      ...(hash ? { contentHash: hash } : {}),
      ...(o.pageId ? { pageId: o.pageId } : {}),
    };
    await this.d.outbox.enqueue('item.create', payload);
    this.d.onSaved?.();
    if (original) this.d.onRepeat?.(id, original.occurredAt);
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
