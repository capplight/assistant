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
  ItemOut,
  ItemPatchIn,
  Locale,
  OtpRequestIn,
  OtpRequestOut,
  OtpVerifyIn,
  OtpVerifyOut,
  PageCreateIn,
  PageCreateOut,
  PageLinkCreateOut,
  PageOut,
  PagePatchIn,
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

  // phone (S04b): link to this account, or sign into the account that already has this phone
  requestOtp(body: OtpRequestIn): Promise<OtpRequestOut> {
    return this.client.request('POST', '/auth/otp/request', { body });
  }

  /** Saves the new tokens: from here on the app works as this account. */
  async verifyOtp(body: OtpVerifyIn): Promise<OtpVerifyOut> {
    const out = await this.client.request<OtpVerifyOut>('POST', '/auth/otp/verify', { body });
    await this.client.tokens.saveTokens(out);
    return out;
  }

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

  getItem(id: string): Promise<ItemOut> {
    return this.client.request('GET', `/items/${encodeURIComponent(id)}`);
  }

  patchItem(id: string, body: ItemPatchIn): Promise<ItemOut> {
    return this.client.request('PATCH', `/items/${encodeURIComponent(id)}`, { body });
  }

  /** «Отменить» for an automatically merged exact repeat: the record is visible again. */
  unmergeItem(id: string): Promise<ItemOut> {
    return this.client.request('POST', `/items/${encodeURIComponent(id)}/unmerge`);
  }

  // pages — docs/api/pages.md
  createPage(body: PageCreateIn): Promise<PageCreateOut> {
    return this.client.request('POST', '/pages', { body, idempotencyKey: body.client_id });
  }

  getPage(id: string): Promise<PageOut> {
    return this.client.request('GET', `/pages/${encodeURIComponent(id)}`);
  }

  patchPage(id: string, body: PagePatchIn): Promise<PageOut> {
    return this.client.request('PATCH', `/pages/${encodeURIComponent(id)}`, { body });
  }

  /** Show an existing item on this page too. Idempotent by page + item. */
  addItemToPage(pageId: string, itemId: string): Promise<PageLinkCreateOut> {
    return this.client.request('POST', `/pages/${encodeURIComponent(pageId)}/items`, { body: { item_id: itemId } });
  }

  sync(since: number, limit = 200): Promise<SyncOut> {
    return this.client.request('GET', '/sync', { query: { since, limit } });
  }
}
