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
