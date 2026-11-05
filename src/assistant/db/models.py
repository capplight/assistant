"""Database schema. The single contract between bot, worker, scheduler and Q&A.

All timestamps are timezone-aware UTC. Wall-clock times of events (a flight at 07:40 in
Phu Quoc) are stored as UTC plus the IANA tz of the place, so reminders fire on local time.
"""

import enum
import uuid
from datetime import date, datetime, time

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
    UniqueConstraint,
    Uuid,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, TSVECTOR
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

from assistant.db.ids import uuid7

EMBEDDING_DIM = 1024


class Base(DeclarativeBase):
    pass


def _enum(cls: type[enum.Enum]) -> Enum:
    return Enum(cls, name=cls.__name__.lower(), values_callable=lambda e: [m.value for m in e])


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
    last_active_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

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
    """One thing the user sent: a link, screenshot, forwarded post, note."""

    __tablename__ = "items"
    __table_args__ = (
        UniqueConstraint("user_id", "url_hash", name="uq_items_user_url"),
        Index("ix_items_tsv", "tsv", postgresql_using="gin"),
        Index(
            "ix_items_embedding",
            "embedding",
            postgresql_using="hnsw",
            postgresql_ops={"embedding": "vector_cosine_ops"},
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    trip_id: Mapped[int | None] = mapped_column(
        ForeignKey("trips.id", ondelete="SET NULL"), index=True
    )
    kind: Mapped[ItemKind] = mapped_column(_enum(ItemKind))
    source: Mapped[ItemSource] = mapped_column(_enum(ItemSource))
    status: Mapped[ItemStatus] = mapped_column(_enum(ItemStatus), default=ItemStatus.PENDING)

    # Input as received
    raw_text: Mapped[str | None] = mapped_column(Text)
    url: Mapped[str | None] = mapped_column(Text)
    url_hash: Mapped[str | None] = mapped_column(String(64))  # sha256 of normalized url
    telegram_file_id: Mapped[str | None] = mapped_column(String(255))
    telegram_chat_id: Mapped[int] = mapped_column(BigInteger)
    telegram_message_id: Mapped[int] = mapped_column(BigInteger)

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
    # Filled by trigger from title/summary/raw_text (see migration), 'simple' config: ru+kk+en mix.
    tsv: Mapped[str | None] = mapped_column(TSVECTOR)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    processed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

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
    __tablename__ = "reminders"
    __table_args__ = (Index("ix_reminders_due", "status", "due_at"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    trip_id: Mapped[int | None] = mapped_column(ForeignKey("trips.id", ondelete="CASCADE"))
    booking_id: Mapped[int | None] = mapped_column(
        ForeignKey("bookings.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[str] = mapped_column(String(64))  # e.g. booking_day_before, trip_daily_plan
    due_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    text: Mapped[str] = mapped_column(Text)
    payload: Mapped[dict | None] = mapped_column(JSONB)
    status: Mapped[ReminderStatus] = mapped_column(
        _enum(ReminderStatus), default=ReminderStatus.SCHEDULED
    )
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


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


class ProcessedUpdate(Base):
    """Telegram update_id we already handled: webhook retries must not create duplicates."""

    __tablename__ = "processed_updates"

    update_id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
