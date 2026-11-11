"""Database schema. The single contract between bot, worker, scheduler and Q&A.

All timestamps are timezone-aware UTC. Wall-clock times of events (a flight at 07:40 in
Phu Quoc) are stored as UTC plus the IANA tz of the place, so reminders fire on local time.
"""

import enum
import uuid
from datetime import date, datetime, time

import sqlalchemy as sa
from geoalchemy2 import Geography
from pgvector.sqlalchemy import Vector
from sqlalchemy import (
    BigInteger,
    Boolean,
    Date,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    Time,
    TypeDecorator,
    UniqueConstraint,
    Uuid,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, TSVECTOR
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship
from sqlalchemy.schema import FetchedValue

from assistant.db.ids import uuid7

EMBEDDING_DIM = 1024


class Base(DeclarativeBase):
    pass


def _enum(cls: type[enum.Enum]) -> Enum:
    return Enum(cls, name=cls.__name__.lower(), values_callable=lambda e: [m.value for m in e])


class TextEnum(TypeDecorator):
    """`text + CHECK` column read as a StrEnum member when the value is known, else as str.

    items.kind/source/status became text in 0004 and hold both legacy bot values (this module's
    enums) and app values (assistant.db.models_v2.RecordKind etc.). StrEnum == str, so legacy
    comparisons keep working and new values never raise LookupError.
    """

    impl = Text
    cache_ok = True

    def __init__(self, enum_cls: type[enum.StrEnum]) -> None:
        super().__init__()
        self.enum_cls = enum_cls

    def process_bind_param(self, value, dialect):  # type: ignore[no-untyped-def]
        return None if value is None else str(value)

    def process_result_value(self, value, dialect):  # type: ignore[no-untyped-def]
        if value is None:
            return None
        try:
            return self.enum_cls(value)
        except ValueError:
            return value


class ItemKind(enum.StrEnum):
    TEXT = "text"
    LINK = "link"
    PHOTO = "photo"
    VIDEO = "video"
    DOCUMENT = "document"
    VOICE = "voice"


class ItemSource(enum.StrEnum):
    INSTAGRAM = "instagram"
    TIKTOK = "tiktok"
    TELEGRAM = "telegram"
    WHATSAPP = "whatsapp"
    YOUTUBE = "youtube"
    WEB = "web"
    USER = "user"  # typed by the user, own photo/screenshot


class ItemStatus(enum.StrEnum):
    PENDING = "pending"
    PROCESSING = "processing"
    DONE = "done"
    NEEDS_INPUT = "needs_input"  # bot asked the user a clarifying question
    FAILED = "failed"


class Category(enum.StrEnum):
    FOOD = "food"
    BEACH = "beach"
    SIGHT = "sight"
    STAY = "stay"
    TRANSPORT = "transport"
    BOOKING = "booking"
    TIP = "tip"
    SHOPPING = "shopping"
    OTHER = "other"


class BookingType(enum.StrEnum):
    FLIGHT = "flight"
    HOTEL = "hotel"
    TRANSFER = "transfer"
    TOUR = "tour"
    OTHER = "other"


class JobStatus(enum.StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"


class ReminderStatus(enum.StrEnum):
    SCHEDULED = "scheduled"
    SENT = "sent"
    CANCELLED = "cancelled"
    FAILED = "failed"


class User(Base):
    """A person. Telegram bot users have telegram_id; app users start anonymous (migration 0002).

    Text enums (locale, profile, autonomy_mode, ...) are `text + CHECK` in the DB; allowed values
    live in assistant.db.models_v2 (UserStatus etc.) and in migration 0002.
    """

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    # Nullable since 0002: app users have no Telegram account (legacy bot users keep theirs).
    telegram_id: Mapped[int | None] = mapped_column(BigInteger, unique=True)
    first_name: Mapped[str | None] = mapped_column(String(255))
    language: Mapped[str] = mapped_column(String(8), default="ru")
    # Home timezone; trips carry their own.
    tz: Mapped[str] = mapped_column(String(64), default="Asia/Almaty")
    # Legacy bot consent (foreign AI providers, law 94-V, art. 16). The app uses `consents`;
    # 0003 backfilled it there as kind=ai_cross_border, version=legacy-bot.
    consent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    # --- 0002: app accounts (spec 3-engineering 3.1) ---
    public_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, unique=True, default=uuid7, server_default=text("gen_random_uuid()")
    )
    display_name: Mapped[str | None] = mapped_column(Text)
    locale: Mapped[str] = mapped_column(Text, default="ru", server_default="ru")  # ru|kk
    country: Mapped[str | None] = mapped_column(Text)  # KZ|KG|..., from phone code / store
    age_confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    profile: Mapped[str] = mapped_column(Text, default="regular", server_default="regular")
    autonomy_mode: Mapped[str] = mapped_column(Text, default="ask", server_default="ask")
    autonomy_offer_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    plan: Mapped[str] = mapped_column(Text, default="free", server_default="free")
    alarm_device_policy: Mapped[str] = mapped_column(
        Text, default="last_active", server_default="last_active"
    )
    quiet_from: Mapped[time] = mapped_column(
        Time, default=time(22, 0), server_default=text("'22:00'")
    )
    quiet_to: Mapped[time] = mapped_column(Time, default=time(8, 0), server_default=text("'08:00'"))
    status: Mapped[str] = mapped_column(Text, default="active", server_default="active")
    delete_requested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    delete_after: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # 0015: tombstones up to this seq were deleted (retention): an older `since` resyncs fully
    sync_floor_seq: Mapped[int] = mapped_column(BigInteger, default=0, server_default="0")
    last_active_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # 0022: first launch (spec 3.11): gallery | blank | phrase_first | skipped
    onboarding_path: Mapped[str | None] = mapped_column(Text)
    onboarding_done_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    welcome_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    trips: Mapped[list["Trip"]] = relationship(back_populates="user", cascade="all, delete-orphan")


class Trip(Base):
    __tablename__ = "trips"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(255))
    destination: Mapped[str | None] = mapped_column(String(255))
    starts_on: Mapped[date | None] = mapped_column(Date)
    ends_on: Mapped[date | None] = mapped_column(Date)
    tz: Mapped[str | None] = mapped_column(String(64))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    user: Mapped[User] = relationship(back_populates="trips")


class Item(Base):
    """One record: a note, voice, photo, document, link (app) or a forwarded post (legacy bot).

    0004 generalized it for the app (spec 3-engineering 3.3) without dropping the travel
    columns. kind/source/status are text + CHECK holding both legacy values (ItemKind, ...)
    and app values (models_v2.RecordKind, RecordSource, RecordStatus). `seq` is set by the
    `items_sync_seq` trigger on every insert/update (shared `sync_seq`).
    """

    __tablename__ = "items"
    __table_args__ = (
        UniqueConstraint("user_id", "url_hash", name="uq_items_user_url"),
        UniqueConstraint("user_id", "client_id", name="uq_items_user_client"),
        Index("ix_items_tsv", "tsv", postgresql_using="gin"),
        Index(
            "ix_items_embedding",
            "embedding",
            postgresql_using="hnsw",
            postgresql_ops={"embedding": "vector_cosine_ops"},
        ),
        Index("ix_items_user_seq", "user_id", "seq"),
        Index("ix_items_user_content_hash", "user_id", "content_hash"),
        Index("ix_items_user_original_sha256", "user_id", "original_sha256"),
    )
    __mapper_args__ = {"eager_defaults": True}  # fetch trigger-set seq after INSERT/UPDATE

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    public_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, unique=True, default=uuid7, server_default=sa.text("gen_random_uuid()")
    )
    client_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    trip_id: Mapped[int | None] = mapped_column(
        ForeignKey("trips.id", ondelete="SET NULL"), index=True
    )
    kind: Mapped[str] = mapped_column(TextEnum(ItemKind))
    source: Mapped[str] = mapped_column(TextEnum(ItemSource))
    status: Mapped[str] = mapped_column(
        TextEnum(ItemStatus), default=ItemStatus.PENDING, server_default="pending"
    )

    # Input as received (legacy bot)
    raw_text: Mapped[str | None] = mapped_column(Text)
    url: Mapped[str | None] = mapped_column(Text)
    url_hash: Mapped[str | None] = mapped_column(String(64))  # sha256 of normalized url
    telegram_file_id: Mapped[str | None] = mapped_column(String(255))
    # Nullable since 0004 (app records have no Telegram message); copied into source_meta.
    telegram_chat_id: Mapped[int | None] = mapped_column(BigInteger)
    telegram_message_id: Mapped[int | None] = mapped_column(BigInteger)

    # Extraction result
    title: Mapped[str | None] = mapped_column(String(500))
    summary: Mapped[str | None] = mapped_column(Text)
    category: Mapped[Category | None] = mapped_column(_enum(Category))
    city: Mapped[str | None] = mapped_column(String(255))
    country: Mapped[str | None] = mapped_column(String(2))  # ISO 3166-1 alpha-2
    extracted: Mapped[dict | None] = mapped_column(JSONB)  # full structured output of the model
    confidence: Mapped[float | None] = mapped_column(Float)
    error: Mapped[str | None] = mapped_column(Text)

    embedding: Mapped[list[float] | None] = mapped_column(Vector(EMBEDDING_DIM))
    # Filled by trigger from title/summary/raw_text/text, 'simple' config: ru+kk+en mix.
    tsv: Mapped[str | None] = mapped_column(TSVECTOR)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    processed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # --- 0004: app record (spec 3-engineering 3.3) ---
    # Canonical text, stored instead of the original (OCR / transcript / extracted / typed).
    text: Mapped[str | None] = mapped_column(Text)
    text_lang: Mapped[str | None] = mapped_column(Text)  # ru|kk|en|other
    envelope: Mapped[dict | None] = mapped_column(JSONB)
    envelope_version: Mapped[int | None] = mapped_column(Integer)
    # {"<field id>": {"kind": "phone", "value": "...", "state": "unverified|verified"}}
    review_fields: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")
    merged_fragments: Mapped[list] = mapped_column(JSONB, default=list, server_default="[]")
    source_meta: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")
    occurred_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    content_hash: Mapped[str | None] = mapped_column(Text)  # sha256 hex of normalized text
    original_sha256: Mapped[str | None] = mapped_column(Text)
    simhash: Mapped[int | None] = mapped_column(BigInteger)
    canonical_item_id: Mapped[int | None] = mapped_column(
        ForeignKey("items.id", ondelete="SET NULL", name="fk_items_canonical")
    )
    hidden_reason: Mapped[str | None] = mapped_column(Text)  # duplicate_merged|trashed
    ai_generated: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    # --- 0006: enrichment (never holds the record back: `status` stays the ingest result) ---
    # models_v2.EnrichState; NULL = never considered (legacy rows, hidden fragments).
    enrich_state: Mapped[str | None] = mapped_column(Text)
    enriched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Fields the assistant wrote on the person's own record ("title", "summary"): R-06 label.
    ai_fields: Mapped[list] = mapped_column(JSONB, default=list, server_default="[]")
    # Voice: fragments of one recording (records/voice.py). fragment 0 is the visible record.
    recording_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    fragment_no: Mapped[int | None] = mapped_column(Integer)
    seq: Mapped[int] = mapped_column(
        BigInteger, server_default=FetchedValue(), server_onupdate=FetchedValue()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    purge_after: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    places: Mapped[list["Place"]] = relationship(secondary="item_places")


class Place(Base):
    """A real-world place resolved through a places provider. Shared across users (cache)."""

    __tablename__ = "places"
    __table_args__ = (UniqueConstraint("provider", "provider_place_id", name="uq_places_provider"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    provider: Mapped[str] = mapped_column(String(32))
    provider_place_id: Mapped[str] = mapped_column(String(255))
    name: Mapped[str] = mapped_column(String(500))
    address: Mapped[str | None] = mapped_column(Text)
    city: Mapped[str | None] = mapped_column(String(255))
    country: Mapped[str | None] = mapped_column(String(2))
    tz: Mapped[str | None] = mapped_column(String(64))
    geom = mapped_column(Geography(geometry_type="POINT", srid=4326), nullable=True)
    raw: Mapped[dict | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ItemPlace(Base):
    __tablename__ = "item_places"

    item_id: Mapped[int] = mapped_column(
        ForeignKey("items.id", ondelete="CASCADE"), primary_key=True
    )
    place_id: Mapped[int] = mapped_column(
        ForeignKey("places.id", ondelete="CASCADE"), primary_key=True
    )


class PlaceQuery(Base):
    """Cache of text query -> place, so the same 'Bánh Mì Phượng Hội An' is paid for once."""

    __tablename__ = "place_queries"

    query_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    query: Mapped[str] = mapped_column(Text)
    place_id: Mapped[int | None] = mapped_column(ForeignKey("places.id", ondelete="CASCADE"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Booking(Base):
    """Flight/hotel/transfer extracted from a screenshot or forwarded confirmation.

    No reminder is created until the user confirms the extracted details (confirmed_at).
    """

    __tablename__ = "bookings"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    trip_id: Mapped[int | None] = mapped_column(ForeignKey("trips.id", ondelete="SET NULL"))
    item_id: Mapped[int | None] = mapped_column(ForeignKey("items.id", ondelete="SET NULL"))
    type: Mapped[BookingType] = mapped_column(_enum(BookingType))
    title: Mapped[str] = mapped_column(String(500))
    confirmation_code: Mapped[str | None] = mapped_column(String(64))
    starts_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ends_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    tz: Mapped[str | None] = mapped_column(String(64))  # tz of the event location
    details: Mapped[dict | None] = mapped_column(JSONB)
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Reminder(Base):
    """Bot reminders (trip/booking, sent to Telegram) and, since 0013, app reminders.

    App rows have `kind` in assistant.db.models_reminders.APP_KINDS (`normal|test`) and use the
    0013 columns (title, tz, rrule, offsets, level, ...); their fires are `reminder_fires`. Bot
    rows keep their own kinds and `text`; only they are sent by assistant.scheduler. `status` is
    `text + CHECK` since 0013: ReminderStatus (bot) or models_reminders.AppReminderStatus (app).
    """

    __tablename__ = "reminders"
    __table_args__ = (
        Index("ix_reminders_due", "status", "due_at"),
        UniqueConstraint("user_id", "client_id", name="uq_reminders_user_client"),
    )
    __mapper_args__ = {"eager_defaults": True}  # fetch trigger-set seq after INSERT/UPDATE

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    trip_id: Mapped[int | None] = mapped_column(ForeignKey("trips.id", ondelete="CASCADE"))
    booking_id: Mapped[int | None] = mapped_column(
        ForeignKey("bookings.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[str] = mapped_column(String(64))  # e.g. booking_day_before, trip_daily_plan
    due_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    text: Mapped[str | None] = mapped_column(Text)  # bot rows; app rows use title/body
    payload: Mapped[dict | None] = mapped_column(JSONB)
    status: Mapped[str] = mapped_column(TextEnum(ReminderStatus), default=ReminderStatus.SCHEDULED)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    # --- 0013: app reminders (spec 3-engineering 3.x) ---
    public_id: Mapped[uuid.UUID] = mapped_column(
        Uuid, unique=True, default=uuid7, server_default=sa.text("gen_random_uuid()")
    )
    client_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    item_id: Mapped[int | None] = mapped_column(ForeignKey("items.id", ondelete="SET NULL"))
    title: Mapped[str | None] = mapped_column(Text)
    body: Mapped[str | None] = mapped_column(Text)
    tz: Mapped[str | None] = mapped_column(Text)
    rrule: Mapped[str | None] = mapped_column(Text)
    offsets: Mapped[list[int]] = mapped_column(
        sa.ARRAY(Integer), default=list, server_default="{}"
    )
    level: Mapped[str] = mapped_column(Text, default="notification", server_default="notification")
    created_via: Mapped[str | None] = mapped_column(Text)
    parse_source: Mapped[str | None] = mapped_column(Text)
    sensitivity: Mapped[str | None] = mapped_column(Text)
    snooze_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    expanded_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    version: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    seq: Mapped[int] = mapped_column(
        BigInteger, server_default=FetchedValue(), server_onupdate=FetchedValue()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Job(Base):
    """Postgres-backed job queue (FOR UPDATE SKIP LOCKED). See assistant.db.queue."""

    __tablename__ = "jobs"
    __table_args__ = (Index("ix_jobs_ready", "status", "run_after"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    kind: Mapped[str] = mapped_column(String(64))  # e.g. process_item
    payload: Mapped[dict] = mapped_column(JSONB)
    status: Mapped[JobStatus] = mapped_column(_enum(JobStatus), default=JobStatus.QUEUED)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    max_attempts: Mapped[int] = mapped_column(Integer, default=5)
    run_after: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    locked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    # 0004: e.g. item:<id>:ingest:v1; UNIQUE when set, so a re-enqueue is a no-op.
    idempotency_key: Mapped[str | None] = mapped_column(Text)


class ProcessedUpdate(Base):
    """Telegram update_id we already handled: webhook retries must not create duplicates."""

    __tablename__ = "processed_updates"

    update_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
