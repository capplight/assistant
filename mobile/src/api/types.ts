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
  role?: UploadRole;
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
  /**
   * `groups`: group titles after «Разложи», in order (docs/api/chat.md PagePatch). Week 11
   * (template-screens 2.8, 4): `sort`, `group_by`, `mode`, and `set_by` = who set each setting.
   */
  view_state?: ViewStateOut | null;
  /** Week 11 (R-51, S38): empty = as in the template. */
  field_prefs?: FieldPrefOut[];
  custom_fields?: CustomFieldOut[];
  customized?: boolean;
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

/** `client_id` (week 11): from the outbox, a repeat returns the first action. */
export type PagePatchIn = { title?: string; icon?: string; layout?: string; base_view_version?: number; client_id?: string };

// --- week 11: «Настроить страницу» S38 and `set_view` (template-screens 2.8, 4; docs/api/views.md) ---

/** Who set a setting: the person by hand, the assistant, or the template (template-screens 2.8). */
export type SetBy = 'user' | 'agent' | 'template';

export type ViewStateOut = {
  sort?: string;
  /** Group rows by a field (`field id`); null = no grouping. */
  group_by?: string | null;
  groups?: string[];
  /** Template modes: «Доска» (week 16а), «В магазине» stays on the phone. */
  mode?: string | null;
  set_by?: Record<string, SetBy>;
  [k: string]: unknown;
};

export type FieldType =
  | 'text'
  | 'long_text'
  | 'number'
  | 'money'
  | 'date'
  | 'datetime'
  | 'enum'
  | 'tags'
  | 'bool'
  | 'person'
  | 'link';

/** A field of the template catalogue (`GET /page-templates`). `required` = ★, never hidden. */
export type TemplateFieldOut = {
  id: string;
  title: { ru: string; kk: string | null };
  type: FieldType;
  required: boolean;
  default_visible: boolean;
  source: string;
  options?: string[];
};

export type PageTemplateOut = {
  key: string;
  version: number;
  title: { ru: string; kk: string | null };
  icon: string;
  singleton: boolean;
  fields: TemplateFieldOut[];
  layouts: string[];
  default_layout: string;
  default_view: Record<string, unknown> | null;
  min_app_version: string | null;
};

/** The person's choice for a template field: shown or not, its place. */
export type FieldPrefOut = { field_id: string; visible: boolean; order: number; set_by?: SetBy };

/** S38 «+ Своё поле»: 5 types, at most 5 per page. */
export type CustomFieldType = 'text' | 'number' | 'money' | 'date' | 'bool';
export type CustomFieldOut = {
  id: string;
  title: string;
  type: CustomFieldType;
  order: number;
  visible: boolean;
  set_by?: SetBy;
};

/**
 * One view change (S38 by hand, the same `set_view` the assistant calls). Everything optional
 * except `client_id`; `confirm_manual` only after the person's «Да».
 */
/**
 * `POST /v1/pages/{id}/view` (views.md): every key optional, a key left out stays, `null` on a view
 * key = the template's value. The person by hand is never asked «Да» by the server.
 */
export type PageViewIn = {
  client_id: string;
  base_view_version?: number;
  layout?: string;
  board?: boolean | null;
  sort?: string | null;
  sort_dir?: 'asc' | 'desc' | null;
  group_by?: string | null;
  /** Week 11а: the whole order of the groups («Покупки»: the shop walk), ≤30 names; null = none. */
  group_order?: string[] | null;
  title?: string;
  icon?: string;
  /** The whole order the person sees, with the switches. */
  fields?: { field_id: string; visible: boolean }[];
  /** `id`: made on the phone (`c_` + 32 hex), so values typed offline map to it (views.md). */
  add_fields?: { id?: string; title: string; type: CustomFieldType }[];
  rename_fields?: { field_id: string; title: string }[];
  remove_fields?: string[];
  reset?: boolean;
};

/** A view change answered: the page as it is now and the action for «Отменить». */
export type PageViewOut = { page: PageOut | null; action: ActionOut | null; repeated: boolean; changed: boolean; page_patch: PagePatchOut | null };

/** `PATCH /pages/{id}/items/{item_id}` `values`: own field id → value (`null` clears). */
export type PageItemFieldsIn = {
  client_id: string;
  values?: Record<string, string | number | boolean | null>;
  /** The checklist tick (`link.done_at`). */
  done?: boolean;
  /** «Заметки» only (views.md): the sticker's colour; `null` = no colour. */
  color?: NoteColor | null;
  /** «Приколоть наверх / Открепить». */
  pinned?: boolean;
};
/** `link`: the row as it is now (colour, pin, tick); null from an older server. */
export type PageItemFieldsOut = { values: Record<string, unknown>; action: ActionOut | null; link: PageItemOut | null };

/** Week 11а: the six sticker colours (`color.note.*`, template-screens 3; views.md `link.appearance.color`). */
export type NoteColor = 'yellow' | 'pink' | 'green' | 'blue' | 'peach' | 'white';

/** `link.appearance` (views.md «Rows and contents»): who set it decides when the assistant asks «Да». */
export type AppearanceOut = { color: NoteColor | null; color_set_by?: SetBy | null; pinned_set_by?: SetBy | null };

/** `/v1/sync` `item_facets`: own field values of one record on one page. */
export type ItemFacetOut = { id: string; page_id: string; item_id: string; data: Record<string, unknown>; seq: number };

/** «Сделать стопку страницей» (founder addition): a «Своя страница» with the stack's records. */
export type CollectionToPageOut = {
  page: PageOut | null;
  collection: CollectionOut | null;
  action: ActionOut | null;
  repeated: boolean;
};

/** «Объединить все отмеченные (N)»: one `merge_group` action for all of them (duplicates.md). */
export type DuplicatesMergeIn = { client_id: string; groups: { id: string; keep_item_id?: string }[] };
export type DuplicatesMergeOut = {
  groups: DuplicateGroupOut[];
  action: ActionOut | null;
  skipped_group_ids: string[];
  repeated: boolean;
};

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
  /** Week 11 (views.md): the checklist tick of a `checklist` page; undefined = an older server. */
  done_at?: string | null;
  /** Week 11а: the sticker's colour on this page; undefined = an older server. */
  appearance?: AppearanceOut;
};

export type PageLinkCreateOut = { link: PageItemOut; created: boolean };

// --- week 7: by hand (F-41) — docs/api/pages.md «Manual order», schemas.py (2026-11-08) ---

/**
 * «Выше / Ниже / перетащил». At least one neighbour (as the person saw them). `position`: the key
 * the phone computed (with `base_seq`, the last applied `next_since`): the server keeps it when it
 * can, so two phones agree. Leave `group_key` out to keep the group; null = out of any group.
 */
export type ItemMoveIn = {
  client_id: string;
  client_ts?: string;
  item_id: string;
  after_item_id?: string | null;
  before_item_id?: string | null;
  position?: string;
  base_seq?: number;
  group_key?: string | null;
  base_view_version?: number;
};

/** S39. `move`: `from_page_id` and exactly one page; `also_show`: 1-19 pages. */
export type MoveToPageIn = {
  client_id: string;
  client_ts?: string;
  mode: 'move' | 'also_show';
  from_page_id?: string | null;
  to_page_ids: string[];
};

/** S34 ↑↓ / drag. At least one neighbour; `after_page_id` may be «Сегодня» (= first). */
export type PagesReorderIn = {
  client_id: string;
  client_ts?: string;
  page_id: string;
  after_page_id?: string | null;
  before_page_id?: string | null;
  position?: string;
};

/** Why a call did nothing: a later move on another phone won, the neighbours or pages are gone. */
/** `timed` (week 11а): on «Дела» the row's record has a live reminder, its time sets its place. */
export type MoveReason = 'newer_move' | 'anchor_gone' | 'nothing_to_do' | 'page_removed' | 'timed';

/**
 * The answer of every call above, in one shape: `moved` (`removed` for DELETE), the rows as they
 * are now (`link`, `links`, `page_patch(es)` rows), the page (reorder), the action for «Отменить»
 * (null: nothing changed), `learned_ru` («Похожие положу туда же») after the move that taught it.
 */
export type ManualOut = {
  moved: boolean;
  reason: MoveReason | null;
  rows: PageItemOut[];
  removed: { page_id: string; item_id: string }[];
  pages: PageOut[];
  view_versions: { page_id: string; view_version: number }[];
  action: ActionOut | null;
  learned_ru: string | null;
};

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
  /** A tap on an option of an earlier Proposal; `text` is then the option's label. */
  choice?: ChatChoiceIn | null;
};

export type ChatChoiceIn = { reply_id: string; option: string };

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
  /** The change of an `action` answer. */
  action: ActionOut | null;
  /** The question back of a `choice` answer, with its current `state`. */
  proposal: ProposalOut | null;
  /** On the person's message that was a tap. */
  choice: ChatChoiceIn | null;
  /** On a `failed` answer: `stream_interrupted`, `stale`, `not_done`, … */
  error_code: string | null;
  created_at: string;
};

/** GET /v1/chat/messages?before=&around=&limit= — oldest first. */
export type ChatHistoryOut = { messages: ChatMessageOut[]; has_more_before: boolean; has_more_after: boolean };

export type ChatDeliveryState = 'banner_shown' | 'opened' | 'dismissed';

// --- week 6: changes, questions back, undo — docs/api/chat.md + docs/api/actions.md (2026-11-07).
// The backend schemas.py did not have these models yet when this was written; the decoder in
// endpoints.ts is lenient, so a renamed field is a change there only.

/** «Что изменилось»: one row per record, `text` ready (««Плитка, замер» → Ремонт»). */
export type ActionChangeOut = {
  /** Null for a row about a page (`create_page`) or a reminder (`reminder`): no «Вернуть» of its own. */
  item_id: string | null;
  /** Week 9: the task / reminder the row is about. */
  task_id?: string | null;
  reminder_id?: string | null;
  title: string | null;
  kind: string | null;
  text: string;
  page_id: string | null;
  reverted: boolean;
  /** Week 11 (views.md): a view setting's row («Вид: Список → Таблица»): «Вернуть» = undo `keys`. */
  key?: string | null;
};

/** One change of the assistant with one «Отменить» (actions.md «Action»). */
export type ActionOut = {
  id: string;
  kind: string;
  summary: { ru: string; kk: string | null };
  page: ChatPageRef | null;
  changes: ActionChangeOut[];
  changed_item_ids: string[];
  created_page_id: string | null;
  undoable: boolean;
  undoable_until: string | null;
  undone_at: string | null;
  undo_of: string | null;
  message_id: string | null;
  /** Week 9 (S20): who did it (`user` = the person's own change, R-33), and when. */
  initiated_by?: 'agent' | 'user' | null;
  scope?: 'internal' | 'external' | null;
  created_at?: string | null;
  seq?: number;
  /** Week 9 follow-up (reminders.md events): the `client_id` of the `acked` event that made it. */
  event_client_id?: string | null;
};

/** `page_patch`, and `page_patches` of an undo. `group_key` = the group's title. */
export type PagePatchOut = {
  page_id: string;
  view_version: number;
  /** `groups`: titles in order, «Остальное» last; absent after a sort. */
  view_state: { sort?: string; groups?: string[]; [k: string]: unknown } | null;
  rows: PageItemOut[];
  removed_item_ids: string[];
  /** Week 11: the assistant changed the view (`set_view`); absent = unchanged. */
  layout?: string;
  field_prefs?: FieldPrefOut[];
  custom_fields?: CustomFieldOut[];
};

export type ProposalOptionKind = 'item' | 'pick' | 'yes' | 'no' | 'keep_mine' | 'cancel';

/**
 * A question back (`needs_choice` kind `choice`, `confirm` kind `count`, `confirm_manual` kind
 * `manual`). Nothing was changed. A tap: POST /chat/messages with `choice` (except `pick`).
 */
export type ProposalOut = {
  reply_id: string | null;
  /** `delete`: a deletion / trash asked from the line — always a question first (founder, 2026-11-09). */
  kind: 'choice' | 'count' | 'manual' | 'delete';
  question: string;
  count: number | null;
  item_ids: string[];
  options: { id: string; label: string; kind: ProposalOptionKind; item_id: string | null }[];
  /** The option in focus first («Оставить мои»). */
  default: string | null;
  expires_at: string | null;
  state: 'open' | 'answered' | 'expired';
};

/** POST /actions/{id}/undo. `item_ids`: «Вернуть» one row of «Что изменилось». */
/** `keys` (week 11, views.md): «Вернуть» one view setting of «Что изменилось». */
export type ActionUndoIn = { client_id?: string; item_ids?: string[]; keys?: string[] };

export type ActionUndoOut = {
  action: ActionOut | null;
  undo: ActionOut | null;
  partial: boolean;
  repeated: boolean;
  message_ru: string | null;
  page_patches: PagePatchOut[];
};

/** Data of the push «Ответ готов» (R-14: never any text). Not live: no push credentials on the server yet. */
export type AnswerReadyPushData = { type: 'chat_reply'; reply_id: string | null };

/** GET /v1/chat/pending-banner: the newest finished answer waiting for «Сегодня» (text, change or question back). */
export type PendingBannerOut = { message: ChatMessageOut | null };

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
  | { type: 'done'; replyId: string | null; limited: boolean; answerKind: ChatAnswerKind | null; actionId: string | null }
  | { type: 'deferred'; replyId: string | null; text: string | null }
  /** `retry`: «Попробуйте ещё раз» with a NEW client_id. */
  | { type: 'error'; replyId: string | null; code: string; messageRu: string; messageKk: string; retry: boolean }
  /** Resume of a finished reply: replace what was shown. */
  | { type: 'snapshot'; message: ChatMessageOut }
  /** Several in one reply = the same action growing: replace by `action.id`. */
  | { type: 'action'; action: ActionOut; changedItemIds: string[]; tasks?: TaskOut[]; expenses?: ExpenseOut[] }
  /** Week 9: a reminder phrase read as `/reminders/parse` would (S13; nothing saved). */
  | { type: 'reminder_draft'; replyId: string | null; draft: ReminderParseOut; createdVia: 'voice' | 'typed' }
  | { type: 'page_patch'; patch: PagePatchOut }
  /** `needs_choice`, `confirm`, `confirm_manual`. */
  | { type: 'proposal'; proposal: ProposalOut }
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

// --- week 8: reminders, fires, phone events — docs/api/reminders.md (2026-11-08) ---
// Every reminder shape is here and the decoding in endpoints.ts.

export type ReminderLevel = 'alarm' | 'notification';
export type ReminderKind = 'normal' | 'test';
export type ReminderCreatedVia = 'voice' | 'typed' | 'agent_suggestion' | 'manual_form';
export type ReminderParseSource = 'rules' | 'llm' | 'user_edit';
export type ReminderStatus = 'scheduled' | 'fired' | 'snoozed' | 'done' | 'missed' | 'cancelled';
/** The same moment on the clock of the reminder's zone: show it, do not recompute. */
export type LocalDateTime = { date: string; time: string };

export type ReminderOut = {
  id: string;
  client_id: string | null;
  title: string;
  body: string | null;
  due_at: string;
  tz: string;
  local: LocalDateTime | null;
  rrule: string | null;
  offsets: number[];
  level: ReminderLevel;
  kind: ReminderKind;
  created_via: ReminderCreatedVia | null;
  parse_source: ReminderParseSource | null;
  sensitivity: 'health' | null;
  status: ReminderStatus;
  snooze_until: string | null;
  item_id: string | null;
  when_text: string | null;
  version: number;
  seq: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type FireState = 'planned' | 'fired' | 'acked' | 'snoozed' | 'missed' | 'cancelled';

export type FireOut = {
  id: string;
  reminder_id: string;
  /** `reminder_id:occurrence(UTC, Z):offset_min:snooze_n` — the local alarm id. */
  key: string;
  occurrence_at: string;
  fire_at: string;
  offset_min: number;
  snooze_n: number;
  /** Always 0 from the server: the phone makes repeats 1–3 itself. */
  repeat_n: number;
  state: FireState;
  target_device_id: string | null;
  seq: number;
  updated_at: string;
};

/** POST /reminders (also offline, through the outbox: the same `client_id` → the same reminder). */
export type ReminderCreateIn = {
  client_id: string;
  title: string;
  body?: string | null;
  /** Either `due_at` or `local` (read on `tz`'s clock). */
  due_at?: string;
  local?: LocalDateTime;
  tz: string;
  rrule?: string | null;
  offsets?: number[];
  level: ReminderLevel;
  created_via: ReminderCreatedVia;
  parse_source?: ReminderParseSource | null;
  sensitivity?: 'health' | null;
  item_id?: string | null;
  /** Week 9: the chat reply the draft came from (`reminder_draft`). */
  message_id?: string | null;
};

/** PATCH /reminders/{id} («Перенести»). */
export type ReminderPatchIn = {
  version: number;
  title?: string;
  due_at?: string;
  offsets?: number[];
  level?: ReminderLevel;
};

/** POST /reminders, POST /reminders/test, PATCH and DELETE /reminders/{id}; `action` from week 9. */
export type ReminderWithFiresOut = { reminder: ReminderOut | null; fires: FireOut[]; action?: ActionOut | null };

/** GET /reminders/fires — the planning window, with this phone's device id. */
export type FiresWindowOut = { device_id: string | null; fires: FireOut[]; reminders: ReminderOut[] };

export type ReminderParseIn = { text: string; created_via: ReminderCreatedVia; tz?: string };

export type ReminderDraft = {
  title: string;
  due_at: string | null;
  tz: string;
  local: LocalDateTime | null;
  rrule: string | null;
  offsets: number[];
  level: ReminderLevel;
  /** No time was said: 9:00 was put in — the time is highlighted on S13. */
  time_assumed: boolean;
  when_text: string | null;
  saved_text: string | null;
};

export type ReminderParseReason = 'not_understood' | 'no_ai' | 'ai_unavailable' | 'check_failed' | 'past';

export type ReminderParseOut = {
  status: 'ok' | 'ambiguous' | 'form';
  source: 'rules' | 'llm' | null;
  reason: ReminderParseReason | null;
  message: string | null;
  draft: ReminderDraft | null;
  options: ReminderDraft[];
  /** The server's Ф-1 setting: `rules_first` (code first) or `llm` (default, Ф-1 not taken). */
  parser: 'rules_first' | 'llm' | null;
};

export type ReminderEventKind =
  | 'scheduled_local'
  | 'schedule_failed'
  | 'fired_local'
  | 'shown'
  | 'dismissed'
  | 'acked'
  | 'snoozed';

/** `fire_id` or `fire_key` (the server accepts either; schemas.py `ReminderEventIn`). */
export type ReminderEventIn = {
  client_id: string;
  fire_id?: string;
  fire_key?: string;
  event: ReminderEventKind;
  at: string;
  meta?: Record<string, unknown>;
};

export type ReminderEventResult = { client_id: string; status: 'applied' | 'duplicate' | 'not_found' | 'invalid' };

/** `actions` (week 9): one per late «Сделано» on a missed fire, with «Отменить». */
export type ReminderEventsOut = { results: ReminderEventResult[]; fires: FireOut[]; actions: ActionOut[] };

export type ReminderSettingsOut = {
  parser: 'rules_first' | 'llm' | null;
  alarm_device_policy: 'last_active' | 'all' | null;
  snooze_minutes: number;
  /** «Другое время» may go at most this far (`meta.until` ≤ event `at` + this). */
  snooze_max_hours: number;
  repeat_minutes: number[];
  horizon_days: number;
};

export type ReminderActiveOut = { device_id: string | null; retargeted: number };

/** Data of a server backup push (no text unless `push_content`). */
export type ReminderPushData = { type: 'reminder_backup' | 'reminder_missed'; fire_id: string | null; reminder_id: string | null };

// --- week 9: «Сегодня», «Дела», «Покупки», suggestions, S20, S30 — docs/api/today.md,
// actions.md, reminders.md, pages.md (see the reconcile date in mobile/README.md) ---

/** `todo` = «Дела», `shopping` = «Покупки». */
export type TaskListKey = 'todo' | 'shopping';

/** One line of a list. Each task has its own record (`item_id`): it is a page row like any record. */
export type TaskOut = {
  id: string;
  client_id: string | null;
  item_id: string | null;
  list_key: TaskListKey;
  title: string;
  /** «Сколько», «Где купить» (shopping only): free text ≤60. */
  qty: string | null;
  where: string | null;
  /** «Когда» of a to-do (`YYYY-MM-DD` on the person's clock), or null. */
  due_date: string | null;
  done: boolean;
  done_at: string | null;
  version: number;
  seq: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

/** POST /tasks (offline through the outbox: the same `client_id` → the same task). */
export type TaskCreateIn = {
  client_id: string;
  list_key: TaskListKey;
  title: string;
  qty?: string | null;
  where?: string | null;
  due_date?: string | null;
};

/**
 * PATCH /tasks/{id} (today.md): `version` + only the keys that change. Week 11а sends `qty` («− 2 +»
 * on «Покупки») and `due_date` («На завтра» on «Дела»). No `client_id` on the server: a retry after a
 * lost answer gets `409 conflict`, and the phone compares values.
 */
export type TaskPatchIn = {
  version: number;
  /** Week 12 (today.md): outbox-safe; a repeat returns the first task + action (`repeated: true`). */
  client_id?: string;
  title?: string;
  qty?: string | null;
  where?: string | null;
  due_date?: string | null;
  list_key?: TaskListKey;
};

/** Week 11а `POST /tasks/clear-done` (today.md): the bought lines the person saw, one action. */
export type TasksClearDoneIn = { client_id: string; list_key: TaskListKey; task_ids: string[] };
export type TasksClearDoneOut = { tasks: TaskOut[]; action: ActionOut | null; page_patches: PagePatchOut[]; repeated: boolean };

/** POST /tasks/{id}/done: one tap = one call. `done: false` = «Вернуть». */
export type TaskDoneIn = { client_id: string; done: boolean };

/** POST, PATCH, DELETE /tasks…, /done: the task as it is now and its action (null: nothing changed). */
export type TaskWriteOut = { task: TaskOut | null; action: ActionOut | null; page_patches: PagePatchOut[]; repeated: boolean };

/** What [Да] of a suggestion does on the phone (today.md «Suggestions»). */
export type SuggestionDo = { type: string; phrase: string | null; page_id: string | null };

/** A tip (≤1) or a data proposal (≤2) on «Сегодня». */
export type SuggestionOut = {
  id: string;
  kind: 'tip' | 'data_proposal' | string;
  key: string;
  text_ru: string;
  yes_label: string | null;
  no_label: string | null;
  do: SuggestionDo | null;
  status: string;
  expires_at: string | null;
  seq: number;
};

export type SuggestionAcceptOut = {
  suggestion: SuggestionOut | null;
  action: ActionOut | null;
  task: TaskOut | null;
  reminder_draft: ReminderParseOut | null;
};

/** An occurrence on «Сегодня»: the reminder, its own fire (`offset_min: 0`), its state. */
export type TodayReminderOut = {
  reminder: ReminderOut;
  fire: FireOut | null;
  occurrence_at: string;
  local_time: string | null;
  state: string | null;
};

export type TodaySection = 'banner' | 'missed' | 'today' | 'done_for_you' | 'proposals' | 'tip' | string;

/** GET /today (S06). */
export type TodayOut = {
  date: string | null;
  tz: string | null;
  greeting: string | null;
  sections: TodaySection[];
  today: {
    reminders: TodayReminderOut[];
    tasks: TaskOut[];
    shopping: { page_id: string | null; count: number; titles: string[] } | null;
  };
  missed: TodayReminderOut[];
  done_for_you: { actions: ActionOut[]; count_today: number };
  banner: ChatMessageOut | null;
  proposals: SuggestionOut[];
  tip: SuggestionOut | null;
  empty: boolean;
  example: string | null;
};

/** S30 «Что я для вас настроил» (pages.md `GET /habits`). */
export type HabitOut = {
  id: string;
  kind: string;
  text_ru: string;
  text_kk: string | null;
  page: ChatPageRef | null;
  /** `screen_exclusion`: the record taken off the page (only «Убрать»). */
  item_id: string | null;
  /** In /sync: `candidate` | `active` | `disabled` (show only `active`); GET /habits lists active ones. */
  status: string;
  evidence_count: number;
  seq: number;
  updated_at: string | null;
};

export type HabitRemoveOut = { removed: boolean; repeated: boolean; action: ActionOut | null };

/** PATCH /habits/{id} («Изменить»: the rule's page). */
export type HabitPatchOut = { habit: HabitOut | null; action: ActionOut | null; repeated: boolean };

/** GET /actions: newest first. */
export type ActionsPageOut = { actions: ActionOut[]; has_more: boolean };

// --- week 10: repeats («Объединить?», «37 → 1»), stacks on pages, Telegram import ---
// Written from 3-engineering §3.3, §3.7, §4.6, §4.9, §6.3, §6.10 while docs/api/duplicates.md and
// import.md were being written; the decoders in endpoints.ts are lenient, so a renamed field is a
// change there only (see the reconcile notes in mobile/README.md «Week 10»).

/** One record of a group, as the group card shows it. `role`: `keep` = the one that stays. */
export type DuplicateMemberOut = {
  item_id: string;
  role: 'keep' | 'merge';
  title: string | null;
  snippet: string | null;
  kind: string | null;
  occurred_at: string | null;
  created_at: string | null;
  score: number | null;
};

export type DuplicateStatus = 'auto_merged' | 'suggested' | 'merged' | 'dismissed' | 'undone';

/** `duplicate_groups` (R-25): what the person sees; `near` + `suggested` = «Объединить?». */
export type DuplicateGroupOut = {
  id: string;
  kind: 'exact' | 'near';
  status: DuplicateStatus;
  keep_item_id: string | null;
  /** `most_complete` | `newest`: why that one stays («самая полная» / «самая новая»). */
  keep_rule: string | null;
  member_count: number;
  origin: string | null;
  members: DuplicateMemberOut[];
  action_id: string | null;
  seq: number;
  created_at: string | null;
  decided_at: string | null;
};

/** POST /duplicates/groups/{id}/merge | dismiss. `keep_item_id`: the person chose another one to keep. */
export type DuplicateDecisionIn = { client_id: string; keep_item_id?: string };

export type DuplicateDecisionOut = { group: DuplicateGroupOut | null; action: ActionOut | null; repeated: boolean };

/** Something that waits for «Да» (S25): the cleanup «37 → 1», an import, anything external. */
export type PendingActionOut = {
  id: string;
  kind: string;
  status: string;
  preview: Record<string, unknown>;
  expires_at: string | null;
  action_id: string | null;
  seq: number;
  created_at: string | null;
};

/** What a `cleanup_batch` preview says, read by code from the server's numbers. */
export type CleanupPreview = { before: number; after: number; removed: number; groups: number };

/** POST /duplicates/cleanup/plan: one «Да» for all exact repeats + the near groups to decide one by one. */
export type CleanupPlanOut = { pending_action: PendingActionOut | null; preview: CleanupPreview | null; groups: DuplicateGroupOut[] };

/** POST /pending-actions/{id}/confirm: the «Да». `action` has the one «Отменить» of the whole batch. */
export type PendingConfirmOut = { pending_action: PendingActionOut | null; action: ActionOut | null };

/** A stack (`collections`): shown as a group on its page; its rows there carry `group_key = title`. */
export type CollectionOut = {
  id: string;
  page_id: string | null;
  kind: string;
  title: string;
  title_kk: string | null;
  icon: string;
  item_count: number;
  /** «было 37, убрал 23 повтора». */
  before_after: { before: number | null; after: number | null; removed: number | null } | null;
  created_by: string | null;
  last_opened_at: string | null;
  hidden_at: string | null;
  seq: number;
  updated_at: string | null;
  deleted_at: string | null;
};

/** Changes of a stack: the stack as it is now and the action with «Отменить». */
export type CollectionWriteOut = { collection: CollectionOut | null; action: ActionOut | null; page_patches: PagePatchOut[] };

export type ImportStatus = 'created' | 'awaiting_code' | 'running' | 'paused_budget' | 'done' | 'failed' | 'cancelled';

/** POST /imports/telegram/file: the uploaded `result.json` or zip. Pages: by their rules (`auto_rule`). */
export type ImportFileIn = { client_id: string; upload_id: string };

/** GET /imports/{id}: progress and the summary («Перенёс 1 200 заметок…»). */
export type ImportOut = {
  id: string;
  client_id: string | null;
  source: string;
  status: ImportStatus;
  total: number;
  processed: number;
  /** New records made by this import. */
  created_count: number;
  /** Repeats inside the file: not made twice. */
  skipped_dups: number;
  /** Brought by an earlier import already (R-28): not made again. */
  seen_before: number;
  /** The server's own one-line summary, when it has one. */
  summary_ru: string | null;
  /** `{"video": 34, "sticker": 12}`: media without text are not brought over. */
  skipped_media: Record<string, number>;
  failed: number;
  /** «Разложил в 9 стопок». */
  stacks: number;
  /** Near repeats waiting for «Объединить?». */
  similar_groups: number;
  /** The cleanup «Повторов: 214 — убрать?» waiting for its «Да». */
  cleanup: PendingActionOut | null;
  /** The import itself, with «Отменить» (hides what it brought). */
  action_id: string | null;
  error: string | null;
  seq: number;
  started_at: string | null;
  finished_at: string | null;
};

// --- week 12: «Расходы» (docs/api/expenses.md, 3-engineering 3.12) ---
// Every expense shape is here and the decoding in endpoints.ts, so a contract change is two files.
// Money is text: a decimal string with two places («5000.00»), never parsed into a float.

export type ExpenseDirection = 'expense' | 'income' | 'refund' | 'transfer_own';

export type ExpenseMethod = 'cash' | 'card' | 'kaspi' | 'transfer' | 'other';

/** One spending (expenses.md «Expense»). */
export type ExpenseOut = {
  id: string;
  client_id: string | null;
  /** Its own record (kind `note`): the row on the page; shown only while that record is live. */
  item_id: string | null;
  amount: string;
  currency: string;
  /** The keys' «1200+350» (only `+` / `−`), or null; `amount` is what code computed from it. */
  expression: string | null;
  /** The day on the person's clock. */
  spent_on: string;
  category_id: string | null;
  /** The system key or `own:<id>`, for icons. */
  category_key: string | null;
  payee: string | null;
  method: ExpenseMethod | null;
  direction: ExpenseDirection;
  /** What it was on, in the person's words («бензин»): the line title, then `payee`, then the category. */
  note: string | null;
  source: string;
  parse_source: 'rules' | 'llm' | 'user_edit' | null;
  /** «Проверьте» (R-36): `["amount"]` until «Верно». */
  review_fields: string[];
  /** Week 13: the lines of a receipt (`total` found by code in its text), or null. */
  line_items: { name: string; qty: string | null; total: string | null }[] | null;
  /** Week 13: the statement import this row came from, or null. */
  statement_id: string | null;
  ai_generated: boolean;
  version: number;
  seq: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

/** A category: the person's copy of the 8 system ones, the hidden service «Переводы», own ones. */
export type ExpenseCategoryOut = {
  id: string;
  client_id: string | null;
  key: string;
  title: string;
  title_kk: string | null;
  icon: string | null;
  system: boolean;
  /** «Переводы»: never a chip, its expenses are in no total. */
  service: boolean;
  /** Byte order of the string. */
  position: string | null;
  /** The person ordered the chips by hand: sort by `position`, else by use. */
  manual: boolean;
  pinned: boolean;
  hidden: boolean;
  version: number;
  seq: number;
};

/** POST /expenses: `expression` (keys) or `amount`; idempotent by `client_id`. */
export type ExpenseCreateIn = {
  client_id: string;
  expression?: string | null;
  amount?: string | null;
  currency: string;
  spent_on: string;
  category_id: string | null;
  note?: string | null;
  payee?: string | null;
  method?: ExpenseMethod | null;
  direction?: ExpenseDirection;
  source: 'form' | 'typed';
};

/** PATCH /expenses/{id}: `version` + the keys that change; `confirm: ["amount"]` = «Верно». */
export type ExpensePatchIn = {
  client_id: string;
  version?: number;
  amount?: string;
  expression?: string | null;
  currency?: string;
  spent_on?: string;
  category_id?: string | null;
  note?: string | null;
  payee?: string | null;
  method?: ExpenseMethod | null;
  direction?: ExpenseDirection;
  confirm?: string[];
};

/** POST / PATCH / DELETE: the expense now and its action («Отменить»). */
export type ExpenseWriteOut = { expense: ExpenseOut | null; action: ActionOut | null; page_patches: PagePatchOut[]; repeated: boolean };

/** GET /expense-categories: in chip order, then hidden, then service. */
export type ExpenseCategoriesListOut = { order: 'manual' | 'frequency'; categories: ExpenseCategoryOut[] };

/** PATCH /expense-categories/reorder: the chips in the person's new order (by id). */
export type ExpenseCategoriesReorderIn = { client_id: string; ids: string[] };
export type ExpenseCategoriesOut = { categories: ExpenseCategoryOut[]; action: ActionOut | null; repeated: boolean };

export type ExpenseAggregateQuery = {
  period: 'week' | 'month' | 'year' | 'all' | 'custom';
  date?: string;
  from?: string;
  to?: string;
  group_by?: 'category' | 'month' | 'payee' | 'method';
  currency?: string;
};

/** GET /expenses/aggregate: sums by currency (never added together), counted by `calc.py`. */
export type ExpenseAggregateOut = {
  calc_version: string | null;
  period: { kind: string; from: string; to: string } | null;
  totals: { currency: string; total: string; expense: string | null; refund: string | null; income: string | null; count: number }[];
  groups: { key: string | null; title: string | null; currency: string; total: string; count: number }[];
  review_count: number;
  basis_ids: string[];
};

// --- week 13: «Расходы 2» — receipts, fiscal QR, bank statements, repeats of spendings ---
// (docs/api/expenses.md «Week 13», 3-engineering 4.11, 6.13). The phone reads nothing in a picture
// or a PDF: the server reads them and code checks every number. Money is text, as in week 12.

/** POST /expenses/from-item: `receipt` = a photo / screenshot, `shared_receipt` = a Kaspi / bank receipt shared in. */
export type ReceiptFromItemIn = { client_id: string; item_id: string; kind: 'receipt' | 'shared_receipt'; save?: boolean };

/** POST /expenses/from-qr: the link of a fiscal receipt's QR, decoded on the phone (the phone never opens it). */
export type ReceiptFromQrIn = { client_id: string; url: string; item_id?: string | null };

/** What code found for the form when it could not confirm an amount (`status: "form"`). */
export type ReceiptDraftOut = {
  amount: string | null;
  currency: string;
  spent_on: string | null;
  category_key: string | null;
  note: string | null;
  payee: string | null;
  review_fields: string[];
};

/** «Похоже, эта трата уже есть»: `keep` stays on «Объединить», `other` goes to the trash with its record. */
export type ExpenseDuplicateOut = {
  id: string;
  status: 'suggested' | 'merged' | 'dismissed' | 'undone';
  keep: ExpenseOut;
  other: ExpenseOut;
  text_ru: string | null;
  action_id: string | null;
  created_at: string | null;
  decided_at: string | null;
};

/**
 * The answer of from-item / from-qr. `ok` saved (strip with «Отменить»); `waiting` = the text is not
 * read yet, ask again after `retry_after` s; `form` = no amount code could confirm (the keys, with
 * `draft`); `exists` = this record / fiscal receipt already has its spending.
 */
export type ReceiptOut = {
  status: 'ok' | 'waiting' | 'form' | 'exists';
  expense: ExpenseOut | null;
  action: ActionOut | null;
  page_patches: PagePatchOut[];
  draft: ReceiptDraftOut | null;
  duplicate: ExpenseDuplicateOut | null;
  message: string | null;
  retry_after: number | null;
  repeated: boolean;
};

export type StatementStatus = 'proposed' | 'confirmed' | 'undone' | 'rejected' | 'expired';

/** One line of the check of code's sums against the bank's own summary, to the tiyn. */
export type StatementCheckLineOut = { key: string; title: string; bank: string | null; ours: string | null; ok: boolean };

/** What «Да» adds, by kind (code, `calc.py`). `transfers` and `transfer_own` are in no total. */
export type StatementAddsOut = { expense: string; refund: string; income: string; transfers: string; transfer_own: string };

/** A bank statement PDF read by code: the plan («Нашёл 86 операций за октябрь, 4 уже есть»), then one «Да». */
export type StatementOut = {
  id: string;
  client_id: string | null;
  item_id: string | null;
  status: StatementStatus;
  bank: string | null;
  parser: 'template' | 'model' | null;
  currency: string;
  period_from: string | null;
  period_to: string | null;
  rows_found: number;
  rows_new: number;
  rows_existing: number;
  rows_similar: number;
  /** null for `parser: model` (no bank summary to check against). */
  check: { ok: boolean; lines: StatementCheckLineOut[] } | null;
  adds: StatementAddsOut | null;
  summary_ru: string | null;
  error: string | null;
  pending_action_id: string | null;
  action_id: string | null;
  created_at: string | null;
  decided_at: string | null;
};

/** One operation of the plan (GET /expenses/statements/{id}, only while `proposed`). */
export type StatementRowOut = {
  n: number;
  date: string;
  amount: string;
  currency: string;
  kind: string;
  direction: ExpenseDirection;
  description: string | null;
  method: ExpenseMethod | null;
  category_key: string | null;
  note: string | null;
  /** `existing`: not created («уже есть»); `similar`: created and offered for «Объединить?». */
  state: 'new' | 'existing' | 'similar';
  existing_expense_id: string | null;
  review_fields: string[];
};

/** POST /expenses/statements. */
export type StatementIn = { client_id: string; item_id: string };
export type StatementPlanOut = { statement: StatementOut | null; pending_action: PendingActionOut | null; repeated: boolean };
export type StatementWithRowsOut = { statement: StatementOut | null; rows: StatementRowOut[] };
/** «Да»: every new and similar row is a spending in one `bulk_create_expenses` action (one «Отменить»). */
export type StatementConfirmOut = { statement: StatementOut | null; action: ActionOut | null; created: number; duplicates: ExpenseDuplicateOut[]; repeated: boolean };

/** POST /expenses/duplicates/{id}/merge: `keep_id` only to keep the other one. */
export type ExpenseMergeIn = { client_id: string; keep_id?: string };
export type ExpenseMergeOut = { duplicate: ExpenseDuplicateOut | null; expense: ExpenseOut | null; action: ActionOut | null; repeated: boolean };

// --- week 14: КП — company profile, «Мой прайс», documents (docs/api/kp.md; 3-engineering 3.6, 4.7, 6.7) ---

/** Roles of a file the phone uploads (schemas.py `ClientFileRole`): logo, signature and stamp are always kept (R-34). */
export type UploadRole = 'original' | 'company_logo' | 'company_template' | 'signature' | 'stamp' | 'price_list';

export type KpVatMode = 'included' | 'on_top' | 'none';

/** `bank` is the bank's name. The server replaces the whole `bank` / `contacts` object on PUT. */
export type CompanyBankOut = { iban: string | null; bik: string | null; bank: string | null; kbe: string | null };
export type CompanyContactsOut = { phone: string | null; email: string | null; website: string | null };

/** `ip` ИП · `too` ТОО · `ao` АО · `other` (models_kp.LegalForm). */
export type LegalForm = 'ip' | 'too' | 'ao' | 'other';

/**
 * GET/PUT /company-profile (routes/kp.py, kp/profile.py `profile_dict`). Numbers to check after a
 * photo are in `review_fields` (`bin_iin`, `bank.iban`, …). Files by their public id.
 */
export type CompanyProfileOut = {
  name: string | null;
  legal_form: string | null;
  bin_iin: string | null;
  address: string | null;
  bank: CompanyBankOut;
  contacts: CompanyContactsOut;
  /** null: not said yet (the КП then uses «в сумме»; `false` → «без НДС»). */
  vat_payer: boolean | null;
  logo_file_id: string | null;
  signature_file_id: string | null;
  stamp_file_id: string | null;
  review_fields: string[];
  version: number;
  /** A name and a БИН/ИИН: enough for a КП. */
  complete: boolean;
  updated_at: string | null;
};

/**
 * PUT /company-profile: only the keys that changed (a `bank` / `contacts` object goes whole);
 * `review_fields` set = «Верно» on the rest. A stale `base_version` → 409 `conflict` with
 * `details.profile`. Logo / signature / stamp: the `file_id` of an upload with that role.
 */
export type CompanyProfileIn = {
  client_id: string;
  base_version?: number;
  name?: string | null;
  legal_form?: LegalForm | null;
  bin_iin?: string | null;
  address?: string | null;
  bank?: Partial<CompanyBankOut>;
  contacts?: Partial<CompanyContactsOut>;
  vat_payer?: boolean | null;
  logo_file_id?: string | null;
  signature_file_id?: string | null;
  stamp_file_id?: string | null;
  review_fields?: string[];
};

export type CompanyProfileWriteOut = { profile: CompanyProfileOut; action: ActionOut | null; repeated: boolean };

/** One price of «Мой прайс» (kp/pricelist.py `item_dict`). `price` is a decimal string «450.00». */
export type PriceItemOut = {
  id: string;
  client_id: string | null;
  price_list_id: string | null;
  name: string;
  unit: string | null;
  price: string;
  currency: string;
  /** «проверьте» on the price (read from a photo / a file). */
  review: boolean;
  source_ref: string | null;
  updated_at: string | null;
  /** Phone-only: removed here, not answered yet. */
  deleted_at: string | null;
};

/** A price of a past КП not in the price list (GET /price-lists/history). */
export type PastPriceOut = { name: string; unit: string | null; price: string; currency: string; price_source: string; client: string | null; created_at: string | null };

export type PriceRowIn = { name: string; unit?: string | null; price: string };
/** POST /price-lists/items: the answer's `items` are in the order of the rows (a known name gets the new price). */
export type PriceItemsIn = { client_id: string; items: PriceRowIn[]; source?: 'typed_sequence' | 'voice' };
export type PriceItemsOut = { items: PriceItemOut[]; action: ActionOut | null; repeated: boolean };
/** PATCH /price-lists/items/{id}; `checked: true` = «Верно». */
export type PriceItemPatchIn = { client_id: string; name?: string; unit?: string | null; price?: string; checked?: boolean };
export type PriceItemWriteOut = { item: PriceItemOut | null; action: ActionOut | null; repeated: boolean };
/** GET /price-lists/items?q=&limit=&offset=. */
export type PriceSearchOut = { items: PriceItemOut[]; next_offset: number | null };

/** `price_list:<id>#<item>` | `past_kp:<document_id>#v<n>` | `manual` | `missing` (kp/prices.py). */
export type PriceSource = string;

/** One line of a КП version (kp/service.py `items_dicts`). Money and quantities are decimal strings. */
export type KpItemOut = {
  id: string;
  name: string;
  unit: string | null;
  qty: string | null;
  /** null = no price: «укажите цену» (never guessed). */
  unit_price: string | null;
  discount_pct: string;
  price_source: PriceSource;
  /** The server's caption by `price_source` («из прайса», «из КП ТОО Арман, 3 окт»); with «— та ли позиция?» when `price_review`. */
  price_label: string | null;
  /** The price list's position is not the same words: «та ли позиция?». */
  price_review: boolean;
  matched_name: string | null;
  source_ref: string | null;
  /** Fields the model read to check («проверьте»): `qty`, `name`… */
  review_fields: string[];
  /** The server's line amount (`kp/calc.py`), null without a price. */
  amount: string | null;
};

/** The data of a version as the phone uses it (the server's `version.data` + `client` + `items`). */
export type KpDataOut = {
  number: string | null;
  date: string | null;
  currency: string;
  /** `review`: «проверьте» marks (`client.bin`). */
  client: { name: string | null; bin: string | null; contact: string | null; review: string[] };
  vat: { mode: KpVatMode; rate: string | null; rounding: 'per_line' | 'on_total' };
  items: KpItemOut[];
  discount_total_pct: string;
  terms: Record<string, string | number | null>;
};

/** `document_versions.totals` (kp/calc.py `Totals.as_json`): money as text with two places. */
export type KpTotalsOut = {
  lines_sum: string;
  discount_total: string;
  amount: string;
  net: string;
  vat: string;
  total: string;
  vat_rate: string | null;
  rounding: 'per_line' | 'on_total';
  priced: number;
  missing: number;
  complete: boolean;
  calc_version: string | null;
};

/** GET /documents/{id} `version` (kp/service.py `version_dict`). */
export type KpVersionOut = {
  n: number;
  author: 'initial' | 'tap_edit' | 'agent_request' | 'revert' | string;
  created_at: string | null;
  data: KpDataOut;
  totals: KpTotalsOut | null;
  changed_paths: string[];
  valid_until: string | null;
  price_summary: { price_list: number; past_kp: number; manual: number; missing: number };
  /** Required fields (Ф-17, `kp.required_fields`) still empty: the PDF waits for them. */
  missing_required: string[];
  sent_at: string | null;
  ai_generated: boolean;
};

/** `extracting`: KP_EXTRACT reads the ТЗ; `ready`: a PDF of the current version exists; `failed`: `error` says why. */
export type DocumentStatus = 'extracting' | 'draft' | 'ready' | 'sent' | 'archived' | 'failed';
/** The card file's status strip, set by the person (models_kp.DealStatus). */
export type DealStatus = 'draft' | 'sent' | 'seen' | 'accepted' | 'declined';

/** A КП as a row of the card file (kp/service.py `rows_dicts`; also /sync `documents`). */
export type DocumentOut = {
  id: string;
  client_id: string | null;
  /** The record that is this КП on «Документы и КП» (`items.kind = kp`). */
  item_id: string | null;
  kind: 'kp' | 'letter' | string;
  title: string | null;
  number: string | null;
  date: string | null;
  client_name: string | null;
  currency: string;
  total: string | null;
  missing_prices: number;
  lines: number;
  status: DocumentStatus;
  deal_status: DealStatus;
  current_version_n: number | null;
  sent_version_n: number | null;
  progress: { state: string | null; done: number; total: number; message: string | null; partial: boolean } | null;
  error: string | null;
  ai_generated: boolean;
  /** The row's own version (optimistic lock), not a КП version. */
  row_version: number;
  seq: number;
  created_at: string | null;
  updated_at: string | null;
  deleted_at: string | null;
};

/** GET /documents/{id}, POST /documents/kp, /patch, /revert: the row, its current version, whether S19 is needed first. */
export type KpFullOut = {
  document: DocumentOut;
  version: KpVersionOut | null;
  needs_profile: boolean;
  action: ActionOut | null;
  /** «Итого: 1 240 000 → 1 218 500 ₸». */
  change_text: string | null;
  /** US-21 «Обновить в прайсе?»: typed prices «Мой прайс» does not have. */
  price_offers: { line_id: string; name: string; unit: string | null; price: string; price_item_id: string | null; old_price: string | null }[];
  repeated: boolean;
};

/** POST /documents/kp (202): the ТЗ records (≤10) → `kp:extract`. `409 kp_source_not_ready` while a record is still read. */
export type KpCreateIn = { client_id: string; item_ids: string[]; wishes?: string | null };

/** One RFC 6902 op on the whitelist (kp/patch.py): lines by id, `/items/<id>/unit_price|qty|…`, `/vat/mode`, `/discount_total_pct`. */
export type JsonPatchOp = { op: 'replace' | 'add' | 'remove'; path: string; value?: unknown };

/** POST /documents/{id}/patch — tap-edits, no model; a stale `base_version` → 409 `conflict` with the full document. */
export type KpPatchIn = { client_id: string; base_version: number; ops: JsonPatchOp[]; save_prices?: boolean };

/** POST /documents/{id}/status. */
export type DocumentStatusIn = { client_id: string; deal_status: DealStatus };
export type DocumentStatusOut = { document: DocumentOut | null; action: ActionOut | null; repeated: boolean };

/** POST /documents/{id}/render?format=pdf: `file.url` is an API path (`/v1/documents/{id}/files/{fid}`), fetched with the session. */
export type KpRenderOut = { url: string; file_name: string; version_n: number; total: string | null; document: DocumentOut | null };
