"""App (mobile) schema, part 1: accounts, sessions, devices, consents, uploads, files.

Tables come from migrations 0002 and 0003 (frozen SQL). Conventions (spec 3-engineering, 3):
internal `bigint` PK, external `public_id` UUIDv7, `client_id` + UNIQUE(user_id, client_id) for
idempotent creation, enums as `text + CHECK` (allowed values are the StrEnums below and must
match the CHECKs in the migrations).
"""

import enum
import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    DateTime,
    ForeignKey,
    Integer,
    LargeBinary,
    Text,
    UniqueConstraint,
    Uuid,
    func,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from assistant.db.ids import uuid7
from assistant.db.models import Base


class Locale(enum.StrEnum):
    RU = "ru"
    KK = "kk"


class UserStatus(enum.StrEnum):
    ACTIVE = "active"
    DELETION_PENDING = "deletion_pending"
    DELETED = "deleted"


class UserProfile(enum.StrEnum):
    FAMILY_BETA = "family_beta"
    REGULAR = "regular"
    WORK = "work"


class AuthProvider(enum.StrEnum):
    ANON_DEVICE = "anon_device"
    PHONE = "phone"
    APPLE = "apple"  # reserved, after MVP
    GOOGLE = "google"  # reserved, after MVP


class OtpPurpose(enum.StrEnum):
    LINK = "link"
    LOGIN = "login"
    DELETE_CONFIRM = "delete_confirm"
    WEB_DELETE = "web_delete"


class Platform(enum.StrEnum):
    IOS = "ios"
    ANDROID = "android"
    WEB = "web"


class PushProvider(enum.StrEnum):
    FCM = "fcm"
    APNS = "apns"


class ConsentKind(enum.StrEnum):
    PD_PROCESSING = "pd_processing"
    AI_CROSS_BORDER = "ai_cross_border"
    TERMS = "terms"  # includes "I am 18+", also writes users.age_confirmed_at
    PUSH_CONTENT = "push_content"
    ANALYTICS = "analytics"
    TELEGRAM_IMPORT = "telegram_import"
    HUMAN_REVIEW = "human_review"


class ConsentScreen(enum.StrEnum):
    S05 = "S05"
    SETTINGS = "settings"
    IMPORT = "import"
    LEGACY_BOT = "legacy_bot"


class UploadState(enum.StrEnum):
    PENDING = "pending"
    COMPLETED = "completed"
    FAILED = "failed"
    EXPIRED = "expired"


class FileRole(enum.StrEnum):
    ORIGINAL = "original"
    COMPANY_LOGO = "company_logo"
    COMPANY_TEMPLATE = "company_template"
    SIGNATURE = "signature"
    STAMP = "stamp"
    KP_RENDER = "kp_render"
    PRICE_LIST = "price_list"
    EXPORT = "export"


class FileState(enum.StrEnum):
    ACTIVE = "active"
    TRASH = "trash"
    PINNED = "pinned"
    PURGED = "purged"


class PinnedBy(enum.StrEnum):
    USER = "user"
    AUTO_RULE = "auto_rule"
    POLICY = "policy"


class KeepReason(enum.StrEnum):
    LOW_CONFIDENCE = "low_confidence"
    SIZE_RULE = "size_rule"
    DEAL_ACTIVE = "deal_active"
    TEMPLATE = "template"
    SIGNATURE = "signature"
    USER_PIN = "user_pin"
    SENT_KP = "sent_kp"


def _now() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), server_default=func.now())


class AuthIdentity(Base):
    """How a user signs in. subject_hash = HMAC-SHA256(settings.hash_key, subject)."""

    __tablename__ = "auth_identities"
    __table_args__ = (
        UniqueConstraint("provider", "subject_hash", name="uq_auth_identities_subject"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    provider: Mapped[str] = mapped_column(Text)
    subject_hash: Mapped[str] = mapped_column(Text)
    # AES-GCM of the E.164 phone (KMS). Not written yet: no crypto/KMS in week 1.
    subject_enc: Mapped[bytes | None] = mapped_column(LargeBinary)
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = _now()


class Device(Base):
    __tablename__ = "devices"
    __table_args__ = (UniqueConstraint("user_id", "client_id", name="uq_devices_user_client"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    public_id: Mapped[uuid.UUID] = mapped_column(Uuid, unique=True, default=uuid7)
    client_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    platform: Mapped[str] = mapped_column(Text)
    os_version: Mapped[str | None] = mapped_column(Text)
    manufacturer: Mapped[str | None] = mapped_column(Text)
    model: Mapped[str | None] = mapped_column(Text)
    app_version: Mapped[str | None] = mapped_column(Text)
    push_provider: Mapped[str | None] = mapped_column(Text)
    push_token: Mapped[str | None] = mapped_column(Text)
    capabilities: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")
    last_active_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_sync_seq: Mapped[int] = mapped_column(BigInteger, default=0, server_default="0")
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = _now()
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class AuthSession(Base):
    """One refresh-token chain per sign-in. Rotation: new row, old row revoked, rotated_from set."""

    __tablename__ = "auth_sessions"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    public_id: Mapped[uuid.UUID] = mapped_column(Uuid, unique=True, default=uuid7)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    device_id: Mapped[int | None] = mapped_column(ForeignKey("devices.id", ondelete="SET NULL"))
    refresh_hash: Mapped[str] = mapped_column(Text, unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    rotated_from: Mapped[int | None] = mapped_column(
        ForeignKey("auth_sessions.id", ondelete="SET NULL")
    )
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = _now()


class OtpChallenge(Base):
    __tablename__ = "otp_challenges"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    public_id: Mapped[uuid.UUID] = mapped_column(Uuid, unique=True, default=uuid7)
    phone_hash: Mapped[str] = mapped_column(Text)
    purpose: Mapped[str] = mapped_column(Text)
    code_hash: Mapped[str] = mapped_column(Text)
    attempts: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    device_id: Mapped[int | None] = mapped_column(ForeignKey("devices.id", ondelete="SET NULL"))
    ip_hash: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = _now()


class Consent(Base):
    """One grant of one consent kind. Active = latest row of the kind with revoked_at IS NULL."""

    __tablename__ = "consents"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    public_id: Mapped[uuid.UUID] = mapped_column(Uuid, unique=True, default=uuid7)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(Text)
    version: Mapped[str] = mapped_column(Text)
    providers: Mapped[list[str]] = mapped_column(ARRAY(Text), default=list, server_default="{}")
    text_hash: Mapped[str | None] = mapped_column(Text)  # sha256 hex of the text shown
    locale: Mapped[str | None] = mapped_column(Text)
    granted_at: Mapped[datetime] = _now()
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    device_id: Mapped[int | None] = mapped_column(ForeignKey("devices.id", ondelete="SET NULL"))
    ip_hash: Mapped[str | None] = mapped_column(Text)
    screen: Mapped[str | None] = mapped_column(Text)


class File(Base):
    """A stored object in S3 (KZ). Originals go to trash after ingest (spec 7.1)."""

    __tablename__ = "files"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    public_id: Mapped[uuid.UUID] = mapped_column(Uuid, unique=True, default=uuid7)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    item_id: Mapped[int | None] = mapped_column(ForeignKey("items.id", ondelete="SET NULL"))
    role: Mapped[str] = mapped_column(Text)
    storage_key: Mapped[str] = mapped_column(Text, unique=True)
    mime: Mapped[str] = mapped_column(Text)
    bytes: Mapped[int] = mapped_column(BigInteger)
    sha256: Mapped[str] = mapped_column(Text)
    state: Mapped[str] = mapped_column(Text, default="active", server_default="active")
    pinned_by: Mapped[str | None] = mapped_column(Text)
    keep_reason: Mapped[str | None] = mapped_column(Text)
    trash_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    purged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = _now()
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class Upload(Base):
    """A presigned PUT handed to the phone. Completing it verifies the object and makes a File."""

    __tablename__ = "uploads"
    __table_args__ = (UniqueConstraint("user_id", "client_id", name="uq_uploads_user_client"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    public_id: Mapped[uuid.UUID] = mapped_column(Uuid, unique=True, default=uuid7)
    client_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(Text, default="original", server_default="original")
    storage_key: Mapped[str] = mapped_column(Text, unique=True)
    mime: Mapped[str] = mapped_column(Text)
    bytes: Mapped[int] = mapped_column(BigInteger)  # declared by the client, checked on complete
    sha256: Mapped[str] = mapped_column(Text)  # declared hex, checked on complete
    state: Mapped[str] = mapped_column(Text, default="pending", server_default="pending")
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    file_id: Mapped[int | None] = mapped_column(ForeignKey("files.id", ondelete="SET NULL"))
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = _now()
