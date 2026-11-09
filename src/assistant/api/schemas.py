"""Request/response models of /v1. Public ids are UUIDs; internal bigint ids never leave the API."""

import json
import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import AwareDatetime, BaseModel, Field, field_validator, model_validator

from assistant.db.models_v2 import ConsentKind, Platform, PushProvider

LocaleStr = Literal["ru", "kk"]
Sha256Hex = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]


# --- auth ---


class AnonymousIn(BaseModel):
    # Random secret the app generates once and keeps in Keychain/Keystore (>= 32 bytes, b64url).
    device_key: str = Field(min_length=32, max_length=256)
    locale: LocaleStr = "ru"
    tz: str = Field(default="Asia/Almaty", max_length=64)


class RefreshIn(BaseModel):
    refresh_token: str = Field(min_length=16, max_length=256)


class UserOut(BaseModel):
    id: uuid.UUID
    display_name: str | None
    locale: str
    tz: str
    country: str | None
    is_anonymous: bool  # no verified phone yet
    age_confirmed: bool


class TokenPair(BaseModel):
    token_type: Literal["Bearer"] = "Bearer"
    access_token: str
    access_expires_at: datetime
    refresh_token: str
    refresh_expires_at: datetime
    user: UserOut


class AnonymousOut(TokenPair):
    created: bool  # False = this device key already had an account (reinstall with Keychain)


class OtpRequestIn(BaseModel):
    phone: str = Field(min_length=10, max_length=20)
    purpose: Literal["link", "login"] | None = None  # default: link when signed in, else login


class OtpRequestOut(BaseModel):
    challenge_id: uuid.UUID
    expires_at: datetime
    dev_code: str | None = None  # only with API_DEV_MODE=true and the fake SMS sender


class OtpVerifyIn(BaseModel):
    challenge_id: uuid.UUID
    phone: str = Field(min_length=10, max_length=20)
    code: str = Field(pattern=r"^\d{6}$")


class OtpVerifyOut(TokenPair):
    # True when the phone already belonged to another account and we signed into it.
    # Moving the anonymous account's data/consents into it is not implemented yet.
    account_switched: bool
    # Consents of the account these tokens are for (docs/api/auth.md), same as GET /v1/consents.
    app_enabled: bool  # pd_processing + terms active; false: show S05 before anything else
    ai_enabled: bool  # pd_processing + terms + ai_cross_border active


class MePatchIn(BaseModel):
    display_name: str | None = Field(default=None, max_length=100)  # null or blank: forget it


# --- devices ---


class DeviceIn(BaseModel):
    client_id: uuid.UUID  # stable per app install; repeat POST = update
    platform: Platform
    os_version: str | None = Field(default=None, max_length=64)
    manufacturer: str | None = Field(default=None, max_length=64)
    model: str | None = Field(default=None, max_length=64)
    app_version: str | None = Field(default=None, max_length=32)
    push_provider: PushProvider | None = None
    push_token: str | None = Field(default=None, max_length=4096)
    capabilities: dict[str, Any] = Field(default_factory=dict)


class DeviceOut(BaseModel):
    id: uuid.UUID
    client_id: uuid.UUID | None
    platform: str
    app_version: str | None
    push_provider: str | None
    has_push_token: bool
    capabilities: dict[str, Any]
    last_active_at: datetime | None


# --- consents ---


class ConsentTextOut(BaseModel):
    kind: ConsentKind
    version: str
    locale: str
    text: str
    text_hash: str
    providers: list[str]


class ConsentGrantIn(BaseModel):
    kind: ConsentKind
    version: str = Field(max_length=64)
    text_hash: Sha256Hex
    locale: LocaleStr


class ConsentsIn(BaseModel):
    consents: list[ConsentGrantIn] = Field(min_length=1, max_length=10)
    screen: Literal["S05", "settings", "import"]
    age_confirmed_18: bool = False  # required true when `terms` is granted


class ConsentOut(BaseModel):
    id: uuid.UUID
    kind: str
    version: str
    providers: list[str]
    text_hash: str | None
    locale: str | None
    screen: str | None
    granted_at: datetime
    revoked_at: datetime | None


class ConsentsOut(BaseModel):
    active: list[ConsentOut]  # latest non-revoked per kind
    history: list[ConsentOut]  # everything, newest first
    ai_enabled: bool  # pd_processing + terms + ai_cross_border active
    app_enabled: bool  # pd_processing + terms active


# --- uploads ---

ClientFileRole = Literal[
    "original", "company_logo", "company_template", "signature", "stamp", "price_list"
]


class UploadIn(BaseModel):
    client_id: uuid.UUID | None = None
    mime: str = Field(pattern=r"^[\w.+-]+/[\w.+-]+$", max_length=127)
    bytes: int = Field(gt=0)
    sha256: Sha256Hex
    role: ClientFileRole = "original"


class PresignedPutOut(BaseModel):
    url: str
    method: str
    headers: dict[str, str]
    expires_at: datetime


class UploadOut(BaseModel):
    id: uuid.UUID
    state: str
    put: PresignedPutOut | None  # null once completed
    file_id: uuid.UUID | None


class AiPingOut(BaseModel):
    ok: bool


# --- items (records) and sync ---

ItemKindIn = Literal["note", "voice", "image", "screenshot", "pdf", "docx", "xlsx", "link",
                     "file_other"]  # fmt: skip
ItemSourceIn = Literal["typed", "mic", "share", "camera", "files"]
MAX_ITEM_TEXT = 100_000


class SourceMetaIn(BaseModel):
    """What the phone may say about a capture. Only these keys are kept: the rest of
    items.source_meta belongs to the server. Voice: fragments of one recording, linked by
    recording_id (fragment 0 uses the recording id as its client_id). Share: file_name, mime."""

    recording_id: uuid.UUID | None = None
    fragment: int | None = Field(default=None, ge=0, le=63)
    fragments: int | None = Field(default=None, ge=1, le=64)
    duration_ms: int | None = Field(default=None, ge=0)
    total_duration_ms: int | None = Field(default=None, ge=0)
    file_name: str | None = Field(default=None, max_length=255)
    mime: str | None = Field(default=None, max_length=127)

    @model_validator(mode="after")
    def _fragment_fits(self) -> "SourceMetaIn":
        if self.recording_id is not None and self.fragment is None:
            raise ValueError("recording_id needs fragment")
        if self.fragment is not None and self.fragments is not None \
                and self.fragment >= self.fragments:
            raise ValueError("fragment out of range")
        return self


class ItemCreateIn(BaseModel):
    """Exactly one of `text`, `upload_id`, `url`. With `upload_id`, `text` may be added as a
    caption (Share sheet note); it is kept in source_meta.caption, not in the record text."""

    client_id: uuid.UUID  # made on the phone; repeat POST with it = same record (idempotent)
    kind: ItemKindIn | None = None  # default: note for text, link for url, from mime for uploads
    source: ItemSourceIn = "typed"
    text: str | None = Field(default=None, max_length=MAX_ITEM_TEXT)
    upload_id: uuid.UUID | None = None  # a completed /v1/uploads id
    url: str | None = Field(default=None, max_length=4096, pattern=r"^https?://")
    title: str | None = Field(default=None, max_length=500)
    occurred_at: datetime | None = None  # when it happened on the phone (offline capture)
    content_hash: Sha256Hex | None = None  # phone-side hash; the server recomputes it
    source_meta: SourceMetaIn | None = None


class ReviewFieldOut(BaseModel):
    kind: str  # phone | iin_bin | iban | amount | doc_number | transcript
    value: str | None
    state: Literal["unverified", "verified"]


class ItemFileOut(BaseModel):
    id: uuid.UUID
    role: str
    mime: str
    bytes: int
    sha256: str
    state: str  # active | trash | pinned | purged
    keep_reason: str | None
    trash_until: datetime | None  # "Оригинал удалю через N дн."


class ItemOut(BaseModel):
    id: uuid.UUID
    client_id: uuid.UUID | None
    kind: str
    source: str
    status: str  # pending | processing | ready | needs_review | needs_consent | failed
    title: str | None
    text: str | None
    text_lang: str | None
    summary: str | None
    review_fields: dict[str, ReviewFieldOut]
    merged_fragments: list[dict[str, Any]]
    source_meta: dict[str, Any]
    confidence: float | None
    ai_generated: bool  # the record itself was created by the assistant
    ai_fields: list[str]  # fields it wrote on the person's own record: title, summary
    # The single label (R-06): show it, as is, next to generated content. None: nothing generated.
    ai_label: str | None
    # pending | queued_batch | done | no_consent | deferred_budget | failed | skipped | null
    enrich_state: str | None
    content_hash: str | None
    original_sha256: str | None
    canonical_id: uuid.UUID | None  # set when hidden as a repeat of another record
    hidden_reason: str | None  # duplicate_merged | null
    error: str | None  # short code, e.g. pdf_encrypted, ingest_failed
    files: list[ItemFileOut]
    seq: int
    occurred_at: datetime | None
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None  # in "Удалённые записи" when set
    purge_after: datetime | None


class DuplicateOut(BaseModel):
    canonical_id: uuid.UUID
    canonical_created_at: datetime
    undo_path: str  # POST here = "Отменить" (same as POST /v1/actions/{action_id}/undo)
    action_id: uuid.UUID | None = None  # week 10: the `auto_merge_exact` action


class ItemCreateOut(BaseModel):
    item: ItemOut
    created: bool  # False = this client_id was already stored (retry)
    auto_merged: bool  # exact repeat: hidden and attached to `duplicate.canonical_id`
    duplicate: DuplicateOut | None


class ItemPatchIn(BaseModel):
    title: str | None = Field(default=None, max_length=500)
    text: str | None = Field(default=None, max_length=MAX_ITEM_TEXT)
    verify: list[str] = Field(default_factory=list, max_length=100)  # review_fields keys: «Верно»
    # «Исправить»: review_fields key -> the person's value. Needs base_seq.
    corrections: dict[str, Annotated[str, Field(max_length=500)]] = Field(
        default_factory=dict, max_length=100)
    base_seq: int | None = None  # optimistic check: 409 conflict if the record changed since

    @field_validator("corrections")
    @classmethod
    def _one_line_values(cls, values: dict[str, str]) -> dict[str, str]:
        cleaned = {key: " ".join(value.split()) for key, value in values.items()}
        if not all(cleaned.values()):
            raise ValueError("a correction cannot be empty")
        return cleaned

    @model_validator(mode="after")
    def _corrections_need_base(self) -> "ItemPatchIn":
        if self.corrections and self.base_seq is None:
            raise ValueError("corrections need base_seq")
        return self


class ItemListOut(BaseModel):
    items: list[ItemOut]
    next_cursor: str | None


class TombstoneOut(BaseModel):
    entity: Literal["item", "screen", "screen_item", "conversation_message", "action"]
    id: uuid.UUID
    seq: int
    deleted_at: datetime


# --- pages (docs/api/pages.md) ---

PageIcon = Literal["people", "documents", "shopping", "money", "health", "home", "work", "other"]
PageCreatedByIn = Literal["user", "onboarding_gallery", "onboarding_blank", "onboarding_phrase"]
PageTitle = Annotated[str, Field(min_length=1, max_length=60)]


class TemplateOut(BaseModel):
    key: str
    version: int
    title: dict[str, str | None]
    description: dict[str, str | None]
    icon: str
    preview_ref: str | None
    singleton: bool
    facet: str
    fields: list[dict[str, Any]]
    layouts: list[str]
    default_layout: str
    default_view: dict[str, Any]
    aggregates: list[dict[str, Any]]
    auto_rule: dict[str, Any]
    min_app_version: str | None


class TemplateListOut(BaseModel):
    templates: list[TemplateOut]


class PageOut(BaseModel):
    id: uuid.UUID
    client_id: uuid.UUID | None
    kind: str
    template_key: str
    template_version: int
    title: str
    title_kk: str | None
    icon: str
    position: str
    layout: str
    view_state: dict[str, Any]
    field_prefs: list[dict[str, Any]]
    custom_fields: list[dict[str, Any]]
    customized: bool
    view_version: int
    created_by: str
    hidden_at: datetime | None
    last_opened_at: datetime | None
    seq: int
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None


class PageListOut(BaseModel):
    pages: list[PageOut]


class PageCreateIn(BaseModel):
    client_id: uuid.UUID
    template_key: str = Field(max_length=64)
    title: PageTitle | None = None
    icon: PageIcon | None = None
    layout: str | None = Field(default=None, max_length=32)
    created_by: PageCreatedByIn = "user"


class PageCreateOut(BaseModel):
    page: PageOut
    created: bool
    revived: bool = False  # True: a removed singleton page came back, with its id and order
    action: "ActionOut | None" = None  # week 9: «Отменить» removes the page again


class PagePatchIn(BaseModel):
    client_id: uuid.UUID | None = None  # week 11: outbox repeats return the first action
    title: PageTitle | None = None
    icon: PageIcon | None = None
    layout: str | None = Field(default=None, max_length=32)
    base_view_version: int | None = None


class PageItemOut(BaseModel):
    id: uuid.UUID
    page_id: uuid.UUID
    item_id: uuid.UUID
    position: str | None
    group_key: str | None
    manual_order: bool
    manual_at: datetime | None
    pinned: bool
    added_by: str
    removed_at: datetime | None
    seq: int
    updated_at: datetime
    updated_by: str
    # week 11 (0016): colour on this page and who set it; the free-board place (weeks 16а-16б)
    appearance: dict[str, Any] = {}
    board_x: float | None = None
    board_y: float | None = None
    board_z: int | None = None
    board_manual: bool = False
    done_at: datetime | None = None  # week 11: the checklist tick of this row (views.md)


class PageEntryOut(BaseModel):
    link: PageItemOut
    item: ItemOut
    fields: dict[str, Any]
    task: "TaskOut | None" = None  # week 9: on «Дела» / «Покупки»


class PageItemsOut(BaseModel):
    entries: list[PageEntryOut]
    next_cursor: uuid.UUID | None


class PageItemAddIn(BaseModel):
    item_id: uuid.UUID


class PageItemAddOut(BaseModel):
    link: PageItemOut
    created: bool
    action: "ActionOut | None" = None  # week 9


# --- page views (week 11, docs/api/views.md) ---

FieldType = Literal["text", "number", "money", "date", "bool"]
NoteColor = Literal["yellow", "pink", "green", "blue", "peach", "white"]


class FieldPrefIn(BaseModel):
    field_id: str = Field(min_length=1, max_length=40)
    visible: bool = True


class NewFieldIn(BaseModel):
    # the phone's own id for a field made offline (`c_` + 4-40 of [0-9a-z_-]): values typed into
    # it before the sync map to it; a repeat with the same id adds nothing
    id: str | None = Field(default=None, pattern=r"^c_[0-9a-z_-]{4,40}$")
    title: str = Field(min_length=1, max_length=40)
    type: FieldType = "text"


class RenameFieldIn(BaseModel):
    field_id: str = Field(min_length=1, max_length=40)
    title: str = Field(min_length=1, max_length=40)


class FilterIn(BaseModel):
    field: str = Field(min_length=1, max_length=40)
    op: Literal["eq", "empty", "not_empty"] = "eq"
    value: str | int | float | bool | None = None


class ColorIn(BaseModel):
    item_id: uuid.UUID
    color: NoteColor | None


class PinIn(BaseModel):
    item_id: uuid.UUID
    pinned: bool


class ViewIn(BaseModel):
    """`POST /v1/pages/{id}/view`. A key left out stays; `null` on a view key = the template's."""

    client_id: uuid.UUID | None = None
    base_view_version: int | None = None
    layout: str | None = Field(default=None, max_length=32)
    board: bool | None = None
    sort: str | None = Field(default=None, max_length=40)
    sort_dir: Literal["asc", "desc"] | None = None
    group_by: str | None = Field(default=None, max_length=40)
    group_order: list[str] | None = Field(default=None, max_length=30)
    filters: list[FilterIn] | None = Field(default=None, max_length=5)
    period: Literal["week", "month", "year"] | None = None
    today_tile: Literal["auto", "pinned", "hidden"] | None = None
    title: PageTitle | None = None
    icon: PageIcon | None = None
    fields: list[FieldPrefIn] | None = Field(default=None, max_length=40)
    show_fields: list[str] = Field(default=[], max_length=40)
    hide_fields: list[str] = Field(default=[], max_length=40)
    add_fields: list[NewFieldIn] = Field(default=[], max_length=5)
    rename_fields: list[RenameFieldIn] = Field(default=[], max_length=5)
    remove_fields: list[str] = Field(default=[], max_length=5)
    colors: list[ColorIn] = Field(default=[], max_length=500)
    pins: list[PinIn] = Field(default=[], max_length=500)
    reset: bool = False


class FieldsPutIn(BaseModel):
    """`PUT /v1/pages/{id}/fields` (spec 4.10): the fields part of ViewIn."""

    client_id: uuid.UUID | None = None
    fields: list[FieldPrefIn] | None = Field(default=None, max_length=40)
    add_fields: list[NewFieldIn] = Field(default=[], max_length=5)
    rename_fields: list[RenameFieldIn] = Field(default=[], max_length=5)
    remove_fields: list[str] = Field(default=[], max_length=5)


class ResetIn(BaseModel):
    client_id: uuid.UUID | None = None


class ViewOut(BaseModel):
    page: "PageOut"
    changed: bool
    repeated: bool
    action: "ActionOut | None"
    page_patch: dict[str, Any]


class PageItemPatchIn(BaseModel):
    """`PATCH /v1/pages/{id}/items/{item_id}`: colour, «приколоть», own field values."""

    client_id: uuid.UUID | None = None
    color: NoteColor | None = None  # null = no colour; leave out to keep
    pinned: bool | None = None
    done: bool | None = None  # the checklist tick (week 11)
    values: dict[str, Any] | None = None  # own field id -> value (null clears)


class PageItemPatchOut(BaseModel):
    link: PageItemOut
    values: dict[str, Any]
    repeated: bool
    action: "ActionOut | None"
    page_patch: dict[str, Any]


class ItemFacetOut(BaseModel):
    id: uuid.UUID
    page_id: uuid.UUID
    item_id: uuid.UUID
    data: dict[str, Any]
    updated_by: str
    seq: int
    updated_at: datetime


class StackToPageIn(BaseModel):
    client_id: uuid.UUID | None = None
    title: PageTitle | None = None


class PageWithActionOut(PageOut):
    """PATCH / DELETE / restore of a page: the page plus the action it wrote (week 9)."""

    action: "ActionOut | None" = None


class PageSummaryOut(BaseModel):
    page_id: uuid.UUID
    item_count: int
    last_titles: list[str]
    aggregates: dict[str, Any]
    seq: int
    updated_at: datetime


class PageRefOut(BaseModel):
    id: uuid.UUID
    title: str
    icon: str


class SearchHitOut(BaseModel):
    item_id: uuid.UUID
    kind: str
    status: str
    title: str | None
    snippet: str
    highlights: list[list[int]]  # [start, end) in `snippet`, UTF-16 units
    occurred_at: datetime | None
    created_at: datetime
    ai_label: str | None
    pages: list[PageRefOut]
    matched_by: list[str]  # words | typo | meaning


class SearchOut(BaseModel):
    results: list[SearchHitOut]
    semantic: bool  # false: search by meaning did not run this time


class SyncOut(BaseModel):
    items: list[ItemOut]  # changed since `since`, incl. trashed (deleted_at) and hidden ones
    actions: list["ActionOut"] = []  # «Что я сделал» (docs/api/actions.md)
    conversation_messages: list["ChatMessageOut"] = []  # among the newest 50 (chat.md)
    screens: list[PageOut]  # pages, incl. removed ones (deleted_at)
    screen_items: list[PageItemOut]  # item-on-page links, incl. removed ones (removed_at)
    screen_summaries: list[PageSummaryOut]  # gone with their page: no tombstones of their own
    reminders: list["ReminderOut"] = []  # app reminders, incl. deleted (reminders.md)
    reminder_fires: list["FireOut"] = []  # their fires: state changes, retargets, new snoozes
    tasks: list["TaskOut"] = []  # week 9 (today.md), incl. deleted ones
    suggestions: list["SuggestionOut"] = []  # week 9, status changes too
    pending_actions: list["PendingActionOut"] = []  # week 9 (actions.md)
    habits: list["HabitSyncOut"] = []  # week 9 (pages.md)
    item_facets: list[ItemFacetOut] = []  # week 11: values of the pages' own fields (views.md)
    tombstones: list[TombstoneOut]  # purged for good: drop locally
    next_since: int  # pass as `since` next time
    has_more: bool  # true: call again right away with next_since
    # 0015: `since` is older than the tombstones kept (90 days): drop the local copy (keep the
    # outbox) and sync again from since=0. Everything else in the response is empty.
    full_resync: bool = False


# --- chat (docs/api/chat.md) ---


class ChatMessageIn(BaseModel):
    client_id: uuid.UUID
    text: str = Field(max_length=4000)
    page_id: uuid.UUID | None = None
    visible_item_ids: list[uuid.UUID] = Field(default_factory=list, max_length=40)
    view_version: int | None = None
    selected_item_id: uuid.UUID | None = None
    lang: LocaleStr | None = None
    input_kind: Literal["typed", "voice", "share"] = "typed"
    choice: "ChatChoiceIn | None" = None

    @field_validator("text")
    @classmethod
    def _text(cls, value: str) -> str:
        value = value.strip()
        if not value or len(value) > 2000:
            raise ValueError("text must be 1...2000 characters")
        return value


class ChatChoiceIn(BaseModel):
    reply_id: uuid.UUID
    option: str = Field(min_length=1, max_length=40)


class ChatCitationOut(BaseModel):
    ref: str
    item_id: uuid.UUID
    chunk_id: uuid.UUID | None = None
    page: PageRefOut | None
    title: str
    label: str
    occurred_at: datetime | None


class ChatMessageOut(BaseModel):
    id: uuid.UUID
    client_id: uuid.UUID | None
    role: Literal["user", "assistant", "tool"]
    reply_to: uuid.UUID | None
    page: PageRefOut | None
    input_kind: str | None
    text: str
    answer_kind: str | None
    state: Literal["pending", "done", "deferred", "failed"]
    citations: list[ChatCitationOut]
    checked: dict[str, Any] | None
    delivery: str | None
    ai_label: str | None
    action: "ActionOut | None" = None
    proposal: dict[str, Any] | None = None
    choice: dict[str, Any] | None = None
    error_code: str | None = None
    seq: int = 0
    created_at: datetime


class ChatMessagesOut(BaseModel):
    messages: list[ChatMessageOut]
    has_more_before: bool
    has_more_after: bool


class PendingBannerOut(BaseModel):
    message: ChatMessageOut | None


class DeliveryIn(BaseModel):
    delivery: Literal["banner_shown", "opened", "dismissed"]


class FeedbackIn(BaseModel):
    client_id: uuid.UUID | None = None
    target: Literal["answer", "kp", "item", "reminder"]
    target_ref: uuid.UUID
    reason: Literal["wrong", "offensive", "other"]
    comment: str | None = Field(default=None, max_length=1000)
    allow_anonymized_example: bool = False


class FeedbackOut(BaseModel):
    id: uuid.UUID
    created_at: datetime


# --- actions (docs/api/actions.md) ---


class ActionChangeOut(BaseModel):
    item_id: uuid.UUID | None
    title: str
    kind: str
    text: str
    page_id: uuid.UUID | None
    reverted: bool
    task_id: uuid.UUID | None = None  # week 9: a task row
    reminder_id: uuid.UUID | None = None  # week 9: a reminder row (item_id null)
    key: str | None = None  # week 11: a view setting row (item_id null); «Вернуть» = undo keys


class ActionSummaryOut(BaseModel):
    ru: str
    kk: str | None


class ActionOut(BaseModel):
    id: uuid.UUID
    kind: str
    scope: str
    initiated_by: str
    summary: ActionSummaryOut
    page: PageRefOut | None
    changes: list[ActionChangeOut]
    changed_item_ids: list[uuid.UUID]
    created_page_id: uuid.UUID | None
    undoable: bool
    undoable_until: datetime | None
    undone_at: datetime | None
    undo_of: uuid.UUID | None
    message_id: uuid.UUID | None
    seq: int
    created_at: datetime


class ReminderEventActionOut(ActionOut):
    event_client_id: uuid.UUID  # the `client_id` of the `acked` event that made this action


class ActionsOut(BaseModel):
    actions: list[ActionOut]
    has_more: bool


class UndoIn(BaseModel):
    client_id: uuid.UUID | None = None
    item_ids: list[uuid.UUID] | None = Field(default=None, max_length=500)
    keys: list[str] | None = Field(default=None, max_length=100)  # week 11: view rows


class UndoOut(BaseModel):
    action: ActionOut
    undo: ActionOut
    partial: bool
    repeated: bool
    message_ru: str | None
    page_patches: list[dict[str, Any]]


# --- manual order (week 7, docs/api/pages.md "Manual order") ---

RankKey = Annotated[str, Field(min_length=1, max_length=128)]
MoveReason = Literal["newer_move", "anchor_gone", "nothing_to_do", "page_removed", "timed"]


class _Anchored(BaseModel):
    client_id: uuid.UUID
    client_ts: AwareDatetime | None = None
    position: RankKey | None = None  # the phone's own key; used when it can be trusted


class ItemMoveIn(_Anchored):
    item_id: uuid.UUID
    after_item_id: uuid.UUID | None = None
    before_item_id: uuid.UUID | None = None
    base_seq: int | None = Field(default=None, ge=0)
    group_key: str | None = Field(default=None, min_length=1, max_length=64)
    base_view_version: int | None = None

    @model_validator(mode="after")
    def _anchors(self) -> "ItemMoveIn":
        if self.after_item_id is None and self.before_item_id is None:
            raise ValueError("after_item_id or before_item_id is required")
        if self.item_id in (self.after_item_id, self.before_item_id):
            raise ValueError("an item is not its own neighbour")
        return self


class ItemMoveOut(BaseModel):
    moved: bool
    reason: MoveReason | None
    repeated: bool
    rebased: bool
    link: PageItemOut
    action: "ActionOut | None"
    page_patch: dict[str, Any]


class MoveToPageIn(BaseModel):
    client_id: uuid.UUID
    client_ts: AwareDatetime | None = None
    mode: Literal["move", "also_show"]
    from_page_id: uuid.UUID | None = None
    to_page_ids: list[uuid.UUID] = Field(min_length=1, max_length=19)

    @model_validator(mode="after")
    def _pages(self) -> "MoveToPageIn":
        if self.mode == "move":
            if self.from_page_id is None or len(set(self.to_page_ids)) != 1:
                raise ValueError("move: from_page_id and exactly one page in to_page_ids")
            if self.from_page_id in self.to_page_ids:
                raise ValueError("move: to the same page")
        return self


class MoveToPageOut(BaseModel):
    moved: bool
    reason: MoveReason | None
    repeated: bool
    links: list[PageItemOut]
    action: "ActionOut | None"
    page_patches: list[dict[str, Any]]
    learned_ru: str | None


class RemoveFromPageOut(BaseModel):
    removed: bool
    repeated: bool
    link: PageItemOut
    action: "ActionOut | None"
    page_patch: dict[str, Any]
    still_on: list[PageRefOut]


class PageReorderIn(_Anchored):
    page_id: uuid.UUID
    after_page_id: uuid.UUID | None = None
    before_page_id: uuid.UUID | None = None

    @model_validator(mode="after")
    def _anchors(self) -> "PageReorderIn":
        if self.after_page_id is None and self.before_page_id is None:
            raise ValueError("after_page_id or before_page_id is required")
        if self.page_id in (self.after_page_id, self.before_page_id):
            raise ValueError("a page is not its own neighbour")
        return self


class PageReorderOut(BaseModel):
    moved: bool
    reason: MoveReason | None
    repeated: bool
    page: PageOut
    action: "ActionOut | None"


class HabitOut(BaseModel):
    id: uuid.UUID
    kind: str
    text_ru: str
    page: PageRefOut
    envelope_type: str | None
    evidence_count: int
    updated_at: datetime
    item_id: uuid.UUID | None = None  # screen_exclusion: the record taken off the page


class HabitSyncOut(BaseModel):
    """A learned rule in /v1/sync (week 9), whatever its status."""

    id: uuid.UUID
    kind: str
    status: str
    text_ru: str
    page: PageRefOut | None
    envelope_type: str | None
    evidence_count: int
    updated_at: datetime
    seq: int


class HabitsOut(BaseModel):
    habits: list[HabitOut]


class HabitOffOut(BaseModel):
    removed: bool
    repeated: bool
    action: "ActionOut | None"


ChatMessageIn.model_rebuild()
ChatMessageOut.model_rebuild()
ItemMoveOut.model_rebuild()
MoveToPageOut.model_rebuild()
RemoveFromPageOut.model_rebuild()
PageReorderOut.model_rebuild()
HabitOffOut.model_rebuild()


# --- reminders (docs/api/reminders.md) ---

HHMM = Annotated[str, Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")]
ReminderLevelStr = Literal["alarm", "notification"]


class ReminderLocal(BaseModel):
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    time: HHMM


class ReminderIn(BaseModel):
    client_id: uuid.UUID
    title: str = Field(min_length=1, max_length=200)
    body: str | None = Field(default=None, max_length=2000)
    due_at: AwareDatetime | None = None
    local: ReminderLocal | None = None  # the manual form: read on `tz`'s clock
    tz: str | None = Field(default=None, max_length=64)  # default: the user's
    rrule: str | None = Field(default=None, max_length=200)
    offsets: list[int] = Field(default_factory=list, max_length=3)
    level: ReminderLevelStr = "notification"
    created_via: Literal["voice", "typed", "agent_suggestion", "manual_form"] | None = None
    parse_source: Literal["rules", "llm", "user_edit"] | None = None
    sensitivity: Literal["health"] | None = None
    message_id: uuid.UUID | None = None  # week 9: the chat reply the draft came from
    item_id: uuid.UUID | None = None

    @model_validator(mode="after")
    def _when(self) -> "ReminderIn":
        if (self.due_at is None) == (self.local is None):
            raise ValueError("exactly one of due_at, local")
        return self


class ReminderPatchIn(BaseModel):
    version: int = Field(ge=1)
    title: str | None = Field(default=None, min_length=1, max_length=200)
    body: str | None = Field(default=None, max_length=2000)
    due_at: AwareDatetime | None = None
    local: ReminderLocal | None = None
    tz: str | None = Field(default=None, max_length=64)
    rrule: str | None = Field(default=None, max_length=200)
    offsets: list[int] | None = Field(default=None, max_length=3)
    level: ReminderLevelStr | None = None
    sensitivity: Literal["health"] | None = None


class ReminderParseIn(BaseModel):
    text: str = Field(min_length=1, max_length=500)
    created_via: Literal["typed", "voice"] = "typed"
    tz: str | None = Field(default=None, max_length=64)


class ReminderOut(BaseModel):
    id: uuid.UUID
    client_id: uuid.UUID | None
    title: str
    body: str | None
    due_at: datetime
    tz: str
    local: ReminderLocal
    rrule: str | None
    offsets: list[int]
    level: str
    kind: str
    created_via: str | None
    parse_source: str | None
    sensitivity: str | None
    status: str
    snooze_until: datetime | None
    item_id: uuid.UUID | None
    when_text: str
    version: int
    seq: int
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None


class FireOut(BaseModel):
    id: uuid.UUID
    reminder_id: uuid.UUID
    key: str
    occurrence_at: datetime
    fire_at: datetime
    offset_min: int
    snooze_n: int
    repeat_n: int
    state: str
    target_device_id: uuid.UUID | None
    push_fallback_at: datetime
    missed_at: datetime
    push_sent_at: datetime | None
    fired_at: datetime | None
    acked_at: datetime | None
    seq: int
    updated_at: datetime


class ReminderWithFiresOut(BaseModel):
    reminder: ReminderOut
    fires: list[FireOut]
    action: "ActionOut | None" = None  # week 9: «Что я сделал» + «Отменить»


class ReminderListOut(BaseModel):
    reminders: list[ReminderOut]


class FiresWindowOut(BaseModel):
    device_id: uuid.UUID | None
    fires: list[FireOut]
    reminders: list[ReminderOut]


class ReminderDraftOut(BaseModel):
    title: str
    due_at: datetime
    tz: str
    local: ReminderLocal
    rrule: str | None
    offsets: list[int]
    level: str
    time_assumed: bool
    when_text: str
    saved_text: str


class ReminderParseResultOut(BaseModel):
    status: Literal["ok", "ambiguous", "form"]
    source: Literal["rules", "llm"] | None
    reason: str | None
    message: str | None
    draft: ReminderDraftOut | None
    options: list[ReminderDraftOut]
    parser: Literal["rules_first", "llm"]


class ReminderEventIn(BaseModel):
    client_id: uuid.UUID
    fire_id: uuid.UUID | None = None
    fire_key: str | None = Field(default=None, max_length=200)
    event: str = Field(max_length=32)
    at: AwareDatetime
    meta: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _ref(self) -> "ReminderEventIn":
        if self.fire_id is None and not self.fire_key:
            raise ValueError("fire_id or fire_key")
        if len(json.dumps(self.meta, ensure_ascii=False)) > 2048:
            raise ValueError("meta too large")
        return self


class ReminderEventsIn(BaseModel):
    events: list[ReminderEventIn] = Field(min_length=1, max_length=200)


class ReminderEventResult(BaseModel):
    client_id: uuid.UUID
    status: Literal["applied", "duplicate", "not_found", "invalid"]


class ReminderEventsOut(BaseModel):
    results: list[ReminderEventResult]
    fires: list[FireOut]
    # week 9: a late «Сделано» on a missed one, with «Отменить»; `event_client_id` links each to
    # the event that made it.
    actions: list["ReminderEventActionOut"] = []


class ReminderActiveOut(BaseModel):
    device_id: uuid.UUID
    retargeted: int


class ReminderSettingsOut(BaseModel):
    parser: Literal["rules_first", "llm"]
    quiet_from: str
    quiet_to: str
    alarm_device_policy: Literal["last_active", "all"]
    push_content: bool
    snooze_minutes: int
    snooze_max_hours: int  # «Другое время»: meta.until at most this far after the event
    repeat_minutes: list[int]
    push_fallback_minutes: int
    missed_minutes: int
    offsets_allowed: list[int]
    horizon_days: int


class ReminderSettingsPatchIn(BaseModel):
    quiet_from: HHMM | None = None
    quiet_to: HHMM | None = None
    alarm_device_policy: Literal["last_active", "all"] | None = None


# --- tasks, «Сегодня», suggestions, pending «Да» (docs/api/today.md, week 9) ---

ListKeyStr = Literal["todo", "shopping"]
DateStr = Annotated[str, Field(pattern=r"^\d{4}-\d{2}-\d{2}$")]


class TaskOut(BaseModel):
    id: uuid.UUID
    client_id: uuid.UUID | None
    item_id: uuid.UUID | None
    list_key: str
    title: str
    qty: str | None
    where: str | None
    due_date: str | None
    done: bool
    done_at: datetime | None
    version: int
    seq: int
    created_at: datetime
    updated_at: datetime
    deleted_at: datetime | None


class TasksOut(BaseModel):
    tasks: list[TaskOut]


class TaskIn(BaseModel):
    client_id: uuid.UUID
    list_key: ListKeyStr
    title: str = Field(min_length=1, max_length=200)
    qty: str | None = Field(default=None, max_length=60)
    where: str | None = Field(default=None, max_length=60)
    due_date: DateStr | None = None


class TaskPatchIn(BaseModel):
    version: int
    title: str | None = Field(default=None, min_length=1, max_length=200)
    qty: str | None = Field(default=None, max_length=60)
    where: str | None = Field(default=None, max_length=60)
    due_date: DateStr | None = None
    list_key: ListKeyStr | None = None


class TaskDoneIn(BaseModel):
    client_id: uuid.UUID
    done: bool = True


class TasksClearDoneIn(BaseModel):
    """`POST /v1/tasks/clear-done` («Убрать все купленные», week 11а)."""

    client_id: uuid.UUID
    list_key: ListKeyStr = "shopping"
    task_ids: list[uuid.UUID] | None = Field(default=None, max_length=500)


class TasksClearedOut(BaseModel):
    tasks: list[TaskOut]
    action: "ActionOut | None"
    page_patches: list[dict[str, Any]] = []
    repeated: bool = False


class TaskCreatedOut(BaseModel):
    task: TaskOut
    action: "ActionOut | None"
    page_patches: list[dict[str, Any]] = []
    repeated: bool = False


class TaskChangedOut(BaseModel):
    task: TaskOut
    action: "ActionOut | None"
    repeated: bool = False


class SuggestionOut(BaseModel):
    id: uuid.UUID
    kind: str
    key: str
    text_ru: str
    yes_label: str
    no_label: str
    do: dict[str, Any]
    source_item_id: uuid.UUID | None
    status: str
    expires_at: datetime | None
    seq: int
    created_at: datetime


class SuggestionsOut(BaseModel):
    proposals: list[SuggestionOut]
    tip: SuggestionOut | None


class SuggestionAcceptIn(BaseModel):
    client_id: uuid.UUID | None = None


class SuggestionAcceptOut(BaseModel):
    suggestion: SuggestionOut
    action: "ActionOut | None" = None
    task: TaskOut | None = None
    reminder_draft: dict[str, Any] | None = None


class SuggestionDismissOut(BaseModel):
    suggestion: SuggestionOut


class PendingActionOut(BaseModel):
    id: uuid.UUID
    kind: str
    status: str
    preview: dict[str, Any]
    expires_at: datetime
    message_id: uuid.UUID | None
    action_id: uuid.UUID | None
    seq: int
    created_at: datetime
    decided_at: datetime | None


class TodayReminderOut(BaseModel):
    reminder: ReminderOut
    fire: FireOut
    occurrence_at: datetime
    local_time: str
    state: str


class TodayShoppingOut(BaseModel):
    page_id: uuid.UUID | None
    count: int
    titles: list[str]


class TodayDueOut(BaseModel):
    reminders: list[TodayReminderOut]
    tasks: list[TaskOut]
    shopping: TodayShoppingOut | None


class DoneForYouOut(BaseModel):
    actions: list["ActionOut"]
    count_today: int


class TodayOut(BaseModel):
    date: str
    tz: str
    greeting: str
    sections: list[str]
    today: TodayDueOut
    missed: list[TodayReminderOut]
    done_for_you: DoneForYouOut
    banner: "ChatMessageOut | None"
    proposals: list[SuggestionOut]
    tip: SuggestionOut | None
    empty: bool
    example: str | None


class HabitPatchIn(BaseModel):
    page_id: uuid.UUID
    client_id: uuid.UUID | None = None


class HabitPatchOut(BaseModel):
    habit: HabitOut
    action: "ActionOut | None"
    repeated: bool = False


for _m in (ReminderEventsOut, HabitPatchOut, PageCreateOut, PageEntryOut, PageItemAddOut,
           PageWithActionOut, ReminderWithFiresOut,
           TaskCreatedOut, TaskChangedOut, SuggestionAcceptOut, DoneForYouOut, TodayOut):
    _m.model_rebuild()
SyncOut.model_rebuild()  # after the reminder shapes it refers to
