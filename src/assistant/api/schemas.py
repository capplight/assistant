"""Request/response models of /v1. Public ids are UUIDs; internal bigint ids never leave the API."""

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

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
    undo_path: str  # POST here = "Отменить" (until actions/inverse exist)


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
    entity: Literal["item", "screen", "screen_item"]
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


class PagePatchIn(BaseModel):
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


class PageEntryOut(BaseModel):
    link: PageItemOut
    item: ItemOut
    fields: dict[str, Any]


class PageItemsOut(BaseModel):
    entries: list[PageEntryOut]
    next_cursor: uuid.UUID | None


class PageItemAddIn(BaseModel):
    item_id: uuid.UUID


class PageItemAddOut(BaseModel):
    link: PageItemOut
    created: bool


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
    screens: list[PageOut]  # pages, incl. removed ones (deleted_at)
    screen_items: list[PageItemOut]  # item-on-page links, incl. removed ones (removed_at)
    screen_summaries: list[PageSummaryOut]  # gone with their page: no tombstones of their own
    tombstones: list[TombstoneOut]  # purged for good: drop locally
    next_since: int  # pass as `since` next time
    has_more: bool  # true: call again right away with next_since


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

    @field_validator("text")
    @classmethod
    def _text(cls, value: str) -> str:
        value = value.strip()
        if not value or len(value) > 2000:
            raise ValueError("text must be 1...2000 characters")
        return value


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
