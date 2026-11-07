/**
 * Wire shapes of the backend /v1 API (3-engineering §4).
 *
 * Auth, consents, devices, uploads: copied from `src/assistant/api/schemas.py` (exists).
 * Items, pages and sync: reconciled with `schemas.py`, `routes/items.py`, `routes/pages.py`,
 * `routes/sync.py` and `docs/api/pages.md` on 2026-11-07.
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

/** POST /auth/otp/request. Signed in: `link` is the server's default. */
export type OtpRequestIn = { phone: string; purpose?: 'link' | 'login' };
/** `dev_code` only with API_DEV_MODE=true and the fake SMS sender. */
export type OtpRequestOut = { challenge_id: string; expires_at: string; dev_code?: string | null };
export type OtpVerifyIn = { challenge_id: string; phone: string; code: string };
/**
 * `account_switched`: the phone already had an account; these tokens are for that account.
 * app_enabled, ai_enabled: consents of the account the tokens are for. They, not account_switched,
 * decide about S05 (docs/api/auth.md).
 */
export type OtpVerifyOut = TokenPair & { account_switched: boolean; app_enabled: boolean; ai_enabled: boolean };
/** PATCH /me, the name from S04b. Up to 100 chars; null or blank forgets it. */
export type ProfilePatchIn = { display_name: string | null };

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
   * Fragment 0 uses the recording id as its client_id; the server joins the rest into that record.
   */
  source_meta?: Record<string, unknown>;
};

/** One «Проверьте» field. Keys of `review_fields` are what PATCH `verify` takes. */
export type ReviewFieldOut = {
  /** phone | iin_bin | iban | amount | doc_number | transcript (open list). */
  kind: string;
  value: string | null;
  state: 'unverified' | 'verified';
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
  review_fields?: Record<string, ReviewFieldOut>;
  source_meta?: Record<string, unknown>;
  /** The record itself was created by the assistant. */
  ai_generated?: boolean;
  /** Fields the assistant wrote on the person's own record: title, summary. */
  ai_fields?: string[];
  /** Public id of the record this one was merged into (hidden repeat). */
  canonical_id?: string | null;
  hidden_reason?: string | null;
  /** Short code, e.g. pdf_encrypted, ingest_failed. */
  error?: string | null;
  occurred_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
  /** In «Удалённые записи» until this time. */
  purge_after?: string | null;
  seq: number;
};

/** PATCH /v1/items/{id}. `base_seq`: 409 `conflict` (details.seq) if the record changed since. */
export type ItemPatchIn = {
  title?: string | null;
  text?: string;
  /** Keys of `review_fields` the person confirmed with «Верно». */
  verify?: string[];
  /** «Исправить»: key of `review_fields` → the value the person typed. */
  corrections?: Record<string, string>;
  base_seq?: number;
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

// --- search (docs/api/search.md) ---

export type SearchHitOut = {
  item_id: string;
  kind: ItemKind;
  status: ItemStatus;
  title: string | null;
  /** Plain text, about 200 characters. */
  snippet: string;
  /** [start, end) offsets inside the snippet, UTF-16. */
  highlights: [number, number][];
  occurred_at: string | null;
  created_at: string;
  /** Show it as is next to the title (R-06). */
  ai_label: string | null;
  pages: { id: string; title: string; icon: string }[];
  matched_by: ('words' | 'typo' | 'meaning')[];
};

export type SearchIn = { q: string; page_id?: string; limit?: number };

/** : words and typos only this time. Not an error, nothing to tell the person. */
export type SearchOut = { results: SearchHitOut[]; semantic: boolean };

// --- pages (docs/api/pages.md) ---

export type PageOut = {
  id: string;
  client_id: string | null;
  kind: 'system_today' | 'page';
  template_key: string;
  template_version: number;
  title: string;
  title_kk: string | null;
  icon: string;
  position: string;
  layout: string;
  view_version: number;
  created_by: string;
  hidden_at: string | null;
  seq: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type PageCreateIn = {
  client_id: string;
  template_key: string;
  /** 1-60 chars; default is the template title. */
  title?: string;
  icon?: string;
  layout?: string;
  created_by?: 'user' | 'onboarding_gallery' | 'onboarding_blank' | 'onboarding_phrase';
};

/** `revived`: a removed topic page came back, with its id, order and rows; `created` is false. */
export type PageCreateOut = { page: PageOut; created: boolean; revived?: boolean };

export type PagePatchIn = { title?: string; icon?: string; layout?: string; base_view_version?: number };

export type PageItemOut = {
  id: string;
  page_id: string;
  item_id: string;
  position: string | null;
  group_key: string | null;
  manual_order: boolean;
  manual_at: string | null;
  pinned: boolean;
  added_by: string;
  removed_at: string | null;
  seq: number;
  updated_at: string;
  updated_by: string;
};

export type PageLinkCreateOut = { link: PageItemOut; created: boolean };

// --- sync (spec §4.4; aligned with routes/sync.py as of 2026-11-07) ---

/** Counted by the server for each page. The phone counts its own lists, so it does not keep these. */
export type PageSummaryOut = {
  page_id: string;
  item_count: number;
  last_titles: string[];
  aggregates: Record<string, unknown>;
  seq: number;
  updated_at: string;
};

/** `entity`: item | screen | screen_item (docs/api/pages.md). */
export type Tombstone = { entity: string; id: string; seq: number; deleted_at?: string };

/**
 * GET /v1/sync?since=<seq>&limit=<n>. `since` is the last `next_since` (0 on first sync).
 * Other entity arrays (reminders, tasks, screens, …) may be present; the client ignores what it
 * doesn't know yet.
 */
export type SyncOut = {
  items?: ItemOut[];
  screens?: PageOut[];
  screen_items?: PageItemOut[];
  screen_summaries?: PageSummaryOut[];
  tombstones?: Tombstone[];
  next_since: number;
  has_more: boolean;
  [entity: string]: unknown;
};

// --- chat (week 5): one conversation for every page — docs/api/chat.md (2026-11-07) ---
// Every chat shape is here and the decoding in endpoints.ts, so a contract change is two files.

export type ChatInputKind = 'typed' | 'voice' | 'share';

/** POST /v1/chat/messages (SSE). Idempotent by `client_id`: the same one again resumes the first reply. */
export type ChatMessageIn = {
  client_id: string;
  text: string;
  /** Server id of the page the line is on; null on «Сегодня» and screens that are not pages. */
  page_id: string | null;
  visible_item_ids?: string[];
  view_version?: number | null;
  selected_item_id?: string | null;
  lang: Locale;
  input_kind: ChatInputKind;
};

export type ChatPageRef = { id: string; title: string; icon: string | null };

/** `sources` event entry: «Нашёл…» while the answer is written. `ref` is its id inside the reply. */
export type ChatSourceOut = {
  ref: string;
  item_id: string;
  title: string | null;
  snippet: string | null;
  kind: string | null;
  occurred_at: string | null;
  created_at?: string | null;
  /** Where the chip opens the record; null → the record card alone. */
  page: ChatPageRef | null;
  pages?: ChatPageRef[];
};

/** A chip under the answer: only records the answer is based on. `label` is ready to show. */
export type ChatCitationOut = {
  ref: string;
  item_id: string;
  chunk_id: string | null;
  page: ChatPageRef | null;
  title: string | null;
  label: string | null;
  occurred_at: string | null;
};

export type ChatAnswerKind = 'action' | 'text' | 'choice' | 'deferred';
export type ChatMessageState = 'pending' | 'done' | 'deferred' | 'failed';
export type ChatDelivery = 'streamed' | 'banner_pending' | 'banner_shown' | 'opened' | 'dismissed';

/** One message of the conversation (history, `snapshot`, delivery answer). */
export type ChatMessageOut = {
  id: string;
  client_id: string | null;
  role: 'user' | 'assistant';
  /** On an answer: the id of the person's message. */
  reply_to: string | null;
  page: ChatPageRef | null;
  input_kind: ChatInputKind | null;
  text: string;
  answer_kind: ChatAnswerKind | null;
  state: ChatMessageState;
  citations: ChatCitationOut[];
  checked: { ok: boolean; removed: number } | null;
  delivery: ChatDelivery | null;
  ai_label: string | null;
  created_at: string;
};

/** GET /v1/chat/messages?before=&around=&limit= — oldest first. */
export type ChatHistoryOut = { messages: ChatMessageOut[]; has_more_before: boolean; has_more_after: boolean };

export type ChatDeliveryState = 'banner_shown' | 'opened' | 'dismissed';

/** SSE events of one reply, decoded (unknown events are dropped by the decoder). `eventId` = SSE `id:`. */
export type ChatEvent = (
  | { type: 'accepted'; messageId: string | null; replyId: string | null }
  | { type: 'status'; text: string }
  | { type: 'sources'; sources: ChatSourceOut[] }
  | { type: 'token'; text: string }
  | { type: 'citations'; citations: ChatCitationOut[] }
  | { type: 'checked'; ok: boolean; removed: number }
  /** The full checked answer; `aiLabel` set when the assistant wrote it (R-06). */
  | { type: 'banner'; replyId: string | null; text: string; preview: string; short: boolean; aiLabel: string | null; citations: ChatCitationOut[] }
  /** `limited`: monthly limit reached, the answer is search results without a written answer. */
  | { type: 'done'; replyId: string | null; limited: boolean }
  | { type: 'deferred'; replyId: string | null; text: string | null }
  /** `retry`: «Попробуйте ещё раз» with a NEW client_id. */
  | { type: 'error'; replyId: string | null; code: string; messageRu: string; messageKk: string; retry: boolean }
  /** Resume of a finished reply: replace what was shown. */
  | { type: 'snapshot'; message: ChatMessageOut }
) & { eventId?: string | null };

// --- feedback («Сообщить о проблеме», R-41) — docs/api/chat.md ---

export type FeedbackReason = 'wrong' | 'offensive' | 'other';

export type FeedbackIn = {
  client_id: string;
  target: 'answer' | 'kp' | 'item' | 'reminder';
  /** `answer`: the server id of an assistant message of this person. */
  target_ref: string;
  reason: FeedbackReason;
  comment: string | null;
  allow_anonymized_example: boolean;
};

export type FeedbackOut = { id: string; created_at: string };
