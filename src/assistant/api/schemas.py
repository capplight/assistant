"""Request/response models of /v1. Public ids are UUIDs; internal bigint ids never leave the API."""

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field

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
    ai_generated: bool
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
    base_seq: int | None = None  # optimistic check: 409 conflict if the record changed since


class ItemListOut(BaseModel):
    items: list[ItemOut]
    next_cursor: str | None


class TombstoneOut(BaseModel):
    entity: Literal["item"]
    id: uuid.UUID
    seq: int
    deleted_at: datetime


class SyncOut(BaseModel):
    items: list[ItemOut]  # changed since `since`, incl. trashed (deleted_at) and hidden ones
    tombstones: list[TombstoneOut]  # purged for good: drop locally
    next_since: int  # pass as `since` next time
    has_more: bool  # true: call again right away with next_since
