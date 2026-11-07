import type { ApiClient } from './client';
import { ApiError } from './errors';
import type {
  ConsentsIn,
  ConsentsOut,
  ConsentTextOut,
  DeviceIn,
  DeviceOut,
  ItemCreateIn,
  ItemCreateOut,
  Locale,
  ServerConsentKind,
  SyncOut,
  UploadIn,
  UploadOut,
} from './types';

/** Reads a local file and PUTs it to a presigned URL. Injected so tests don't touch the filesystem. */
export type PutFile = (fileUri: string, put: NonNullable<UploadOut['put']>) => Promise<void>;

/** Typed /v1 endpoints. The ONLY place that knows paths and request bodies. */
export class Api {
  constructor(
    readonly client: ApiClient,
    private readonly putFile?: PutFile,
  ) {}

  // consents — the text endpoint is public (shown before any account data matters)
  getConsentText(kind: ServerConsentKind, locale: Locale): Promise<ConsentTextOut> {
    return this.client.request('GET', '/consents/text', { auth: false, query: { kind, locale } });
  }

  grantConsents(body: ConsentsIn): Promise<ConsentsOut> {
    return this.client.request('POST', '/consents', { body });
  }

  // devices — only after pd_processing + terms (server: 403 consent_required otherwise)
  upsertDevice(body: DeviceIn): Promise<DeviceOut> {
    return this.client.request('POST', '/devices', { body });
  }

  // uploads: create (idempotent by client_id) → PUT bytes → complete
  createUpload(body: UploadIn): Promise<UploadOut> {
    return this.client.request('POST', '/uploads', { body });
  }

  completeUpload(id: string): Promise<UploadOut> {
    return this.client.request('POST', `/uploads/${encodeURIComponent(id)}/complete`);
  }

  /**
   * Full upload of one local file. Safe to repeat after any failure: the same `clientId` returns
   * the same upload (fresh URL while pending; `put: null` once completed).
   */
  async uploadFile(f: { clientId: string; uri: string; mime: string; bytes: number; sha256: string }): Promise<string> {
    const up = await this.createUpload({ client_id: f.clientId, mime: f.mime, bytes: f.bytes, sha256: f.sha256 });
    if (up.state === 'completed' || !up.put) return up.id;
    if (!this.putFile) throw new Error('putFile not configured');
    await this.putFile(f.uri, up.put);
    const done = await this.completeUpload(up.id);
    if (done.state !== 'completed') throw new ApiError(409, { code: 'upload_mismatch' });
    return done.id;
  }

  // items / sync — spec §4.3/§4.4 (server still in progress), see types.ts
  createItem(body: ItemCreateIn): Promise<ItemCreateOut> {
    return this.client.request('POST', '/items', { body, idempotencyKey: body.client_id });
  }

  sync(since: number, limit = 200): Promise<SyncOut> {
    return this.client.request('GET', '/sync', { query: { since, limit } });
  }
}
