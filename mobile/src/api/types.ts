/**
 * Wire shapes of the backend /v1 API (3-engineering §4).
 *
 * Auth, consents, devices, uploads: copied from `src/assistant/api/schemas.py` (exists).
 * Items and sync: from spec §4.3/§4.4, cross-checked with the in-progress server code
 * (`routes/items.py`, `routes/sync.py`) on 2026-11-07 — the backend is being built in parallel.
 * Everything about items/sync lives here and in `endpoints.ts`, so adjusting to the real
 * server is a change in these two files only.
 */

export type Locale = 'ru' | 'kk';

/** Error body: {code, message_ru, message_kk, retry_after?, details?} (spec §4, api/errors.py). */
export type ApiErrorBody = {
  code: string;
  message_ru: string;
  message_kk: string;
  retry_after?: number;
  details?: Record<string, unknown>;
};

// --- auth ---

export type AnonymousIn = { device_key: string; locale: Locale; tz: string };
export type RefreshIn = { refresh_token: string };

export type UserOut = {
  id: string;
  display_name: string | null;
  locale: string;
  tz: string;
  country: string | null;
  is_anonymous: boolean;
  age_confirmed: boolean;
};

export type TokenPair = {
  token_type: 'Bearer';
  access_token: string;
  access_expires_at: string;
  refresh_token: string;
  refresh_expires_at: string;
  user: UserOut;
};

export type AnonymousOut = TokenPair & { created: boolean };

// --- consents ---

/** Server consent kinds (db/models_v2.ConsentKind). `age_confirmed_18` is a flag, not a kind. */
export type ServerConsentKind =
  'pd_processing' | 'ai_cross_border' | 'terms' | 'push_content' | 'analytics' | 'telegram_import' | 'human_review';

export type ConsentTextOut = {
  kind: ServerConsentKind;
  version: string;
  locale: Locale;
  text: string;
  text_hash: string;
  providers: string[];
};

export type ConsentGrantIn = { kind: ServerConsentKind; version: string; text_hash: string; locale: Locale };

export type ConsentsIn = {
  consents: ConsentGrantIn[];
  screen: 'S05' | 'settings' | 'import';
  age_confirmed_18: boolean;
};

export type ConsentOut = {
  id: string;
  kind: string;
  version: string;
  providers: string[];
  text_hash: string | null;
  locale: string | null;
  screen: string | null;
  granted_at: string;
  revoked_at: string | null;
};

export type ConsentsOut = {
  active: ConsentOut[];
  history: ConsentOut[];
  ai_enabled: boolean;
  app_enabled: boolean;
};

// --- devices ---

export type DeviceIn = {
  client_id: string;
  platform: 'ios' | 'android' | 'web';
  os_version?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  app_version?: string | null;
  push_provider?: 'fcm' | 'apns' | null;
  push_token?: string | null;
  capabilities?: Record<string, unknown>;
};

export type DeviceOut = {
  id: string;
  client_id: string | null;
  platform: string;
  app_version: string | null;
  push_provider: string | null;
  has_push_token: boolean;
  capabilities: Record<string, unknown>;
  last_active_at: string | null;
};

// --- uploads ---

export type UploadIn = {
  client_id?: string;
  mime: string;
  bytes: number;
  sha256: string;
  role?: 'original';
};

export type PresignedPutOut = { url: string; method: string; headers: Record<string, string>; expires_at: string };

export type UploadOut = {
  id: string;
  state: 'pending' | 'completed' | 'failed' | 'expired' | string;
  put: PresignedPutOut | null;
  file_id: string | null;
};

// --- items (spec §3.3 / §4.3; aligned with the server's schemas.py as of 2026-11-07, still in progress) ---

export type ItemKind =
  'note' | 'voice' | 'image' | 'screenshot' | 'pdf' | 'docx' | 'xlsx' | 'link' | 'email' | 'file_other';

export type ItemSource = 'typed' | 'mic' | 'share' | 'camera' | 'files';

export type ItemStatus = 'pending' | 'processing' | 'ready' | 'needs_review' | 'needs_consent' | 'failed';

/**
 * POST /v1/items. Idempotent by `client_id` (repeat → same item, 200).
 * Exactly one of text / url / upload_id carries the content (text may accompany upload as a note).
 */
export type ItemCreateIn = {
  client_id: string;
  /** Omitted for uploads: the server derives it from the file's MIME. Text: note | link. */
  kind?: ItemKind;
  source: ItemSource;
  title?: string;
  text?: string;
  url?: string;
  upload_id?: string;
  /** sha256 of the normalized text, computed on the phone (spec §3.3, §6.1). */
  content_hash?: string;
  occurred_at: string;
  /**
   * Voice fragments: {recording_id, fragment, fragments, duration_ms}; share: {file_name, mime}.
   * NOT in the server's ItemCreateIn yet (ignored as an extra field) — needed to join voice fragments.
   */
  source_meta?: Record<string, unknown>;
};

export type ItemOut = {
  id: string;
  client_id: string | null;
  kind: ItemKind;
  source: ItemSource | string;
  status: ItemStatus;
  title: string | null;
  text: string | null;
  summary?: string | null;
  occurred_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
  seq: number;
};

/** POST /v1/items response: the item + exact-duplicate check result (spec §4.3). */
export type ItemCreateOut = {
  item: ItemOut;
  /** false = this client_id was already stored (retry). */
  created: boolean;
  /** Exact repeat: hidden and attached to `duplicate.canonical_id` («Уже было — добавил к записи от …»). */
  auto_merged: boolean;
  duplicate: { canonical_id: string; canonical_created_at: string; undo_path: string } | null;
};

// --- sync (spec §4.4; aligned with routes/sync.py as of 2026-11-07) ---

export type Tombstone = { entity: string; id: string; seq: number; deleted_at?: string };

/**
 * GET /v1/sync?since=<seq>&limit=<n>. `since` is the last `next_since` (0 on first sync).
 * Other entity arrays (reminders, tasks, screens, …) may be present; the client ignores what it
 * doesn't know yet.
 */
export type SyncOut = {
  items?: ItemOut[];
  tombstones?: Tombstone[];
  next_since: number;
  has_more: boolean;
  [entity: string]: unknown;
};
