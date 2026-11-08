"""Repeats, stacks, imports, product events (migration 0015, frozen SQL; spec 3.3, 3.7, 3.8).

Allowed values are the StrEnums below and must match the CHECKs in 0015. `seq` is set by the
`sync_seq_bump` trigger.
"""

import enum
import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
    DateTime,
    FetchedValue,
    Float,
    ForeignKey,
    Integer,
    LargeBinary,
    Numeric,
    Text,
    Uuid,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from assistant.db.ids import uuid7
from assistant.db.models import Base


class DupKind(enum.StrEnum):
    EXACT = "exact"
    NEAR = "near"


class DupStatus(enum.StrEnum):
    AUTO_MERGED = "auto_merged"
    SUGGESTED = "suggested"
    MERGED = "merged"
    DISMISSED = "dismissed"
    UNDONE = "undone"


class DupOrigin(enum.StrEnum):
    ON_SAVE = "on_save"
    CLEANUP = "cleanup"
    IMPORT = "import"


class DupMethod(enum.StrEnum):
    HASH = "hash"
    SIMHASH = "simhash"
    TRGM = "trgm"
    EMBEDDING = "embedding"
    LLM_JUDGE = "llm_judge"


class ImportStatus(enum.StrEnum):
    CREATED = "created"
    AWAITING_CODE = "awaiting_code"
    RUNNING = "running"
    PAUSED_BUDGET = "paused_budget"
    DONE = "done"
    FAILED = "failed"
    CANCELLED = "cancelled"


def _seq() -> Mapped[int]:
    return mapped_column(BigInteger, server_default=FetchedValue(), server_onupdate=FetchedValue())


def _ts() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), server_default=func.now())


class DuplicateGroup(Base):
    __tablename__ = "duplicate_groups"
    __mapper_args__ = {"eager_defaults": True}

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    public_id: Mapped[uuid.UUID] = mapped_column(Uuid, default=uuid7, unique=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text)
    keep_item_id: Mapped[int | None] = mapped_column(ForeignKey("items.id", ondelete="SET NULL"))
    keep_rule: Mapped[str] = mapped_column(Text, default="most_complete")
    member_count: Mapped[int] = mapped_column(Integer, default=0)
    origin: Mapped[str] = mapped_column(Text)
    import_id: Mapped[int | None] = mapped_column(ForeignKey("imports.id", ondelete="SET NULL"))
    action_id: Mapped[int | None] = mapped_column(ForeignKey("actions.id", ondelete="SET NULL"))
    seq: Mapped[int] = _seq()
    created_at: Mapped[datetime] = _ts()
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class DuplicateGroupMember(Base):
    __tablename__ = "duplicate_group_members"

    group_id: Mapped[int] = mapped_column(
        ForeignKey("duplicate_groups.id", ondelete="CASCADE"), primary_key=True
    )
    item_id: Mapped[int] = mapped_column(ForeignKey("items.id", ondelete="CASCADE"),
                                         primary_key=True)  # fmt: skip
    role: Mapped[str] = mapped_column(Text)  # keep | merge
    score: Mapped[float | None] = mapped_column(Float)


class DuplicateCandidate(Base):
    __tablename__ = "duplicate_candidates"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    item_a: Mapped[int] = mapped_column(ForeignKey("items.id", ondelete="CASCADE"))
    item_b: Mapped[int] = mapped_column(ForeignKey("items.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(Text)
    score: Mapped[float] = mapped_column(Float)
    method: Mapped[str] = mapped_column(Text)
    signals: Mapped[dict] = mapped_column(JSONB, default=dict)
    verdict: Mapped[str | None] = mapped_column(Text)
    group_id: Mapped[int | None] = mapped_column(
        ForeignKey("duplicate_groups.id", ondelete="SET NULL")
    )
    created_at: Mapped[datetime] = _ts()


class Collection(Base):
    """A stack. Shown as a group on its page (`screen_id`): its rows there carry
    `group_key = title`."""

    __tablename__ = "collections"
    __mapper_args__ = {"eager_defaults": True}

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    public_id: Mapped[uuid.UUID] = mapped_column(Uuid, default=uuid7, unique=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(Text, default="smart")
    key: Mapped[str | None] = mapped_column(Text)
    title: Mapped[str] = mapped_column(Text)
    title_kk: Mapped[str | None] = mapped_column(Text)
    icon: Mapped[str] = mapped_column(Text)
    rule: Mapped[dict] = mapped_column(JSONB, default=dict)
    item_count: Mapped[int] = mapped_column(Integer, default=0)
    before_after: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_by: Mapped[str] = mapped_column(Text, default="agent")
    screen_id: Mapped[int | None] = mapped_column(ForeignKey("screens.id", ondelete="SET NULL"))
    action_id: Mapped[int | None] = mapped_column(ForeignKey("actions.id", ondelete="SET NULL"))
    last_opened_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    hidden_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    seq: Mapped[int] = _seq()
    created_at: Mapped[datetime] = _ts()
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class CollectionItem(Base):
    __tablename__ = "collection_items"

    collection_id: Mapped[int] = mapped_column(
        ForeignKey("collections.id", ondelete="CASCADE"), primary_key=True
    )
    item_id: Mapped[int] = mapped_column(ForeignKey("items.id", ondelete="CASCADE"),
                                         primary_key=True)  # fmt: skip
    score: Mapped[float | None] = mapped_column(Float)
    added_by: Mapped[str] = mapped_column(Text, default="agent")
    removed_by_user_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = _ts()


class Import(Base):
    __tablename__ = "imports"
    __mapper_args__ = {"eager_defaults": True}

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    public_id: Mapped[uuid.UUID] = mapped_column(Uuid, default=uuid7, unique=True)
    client_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    source: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, default=ImportStatus.CREATED)
    consent_id: Mapped[int | None] = mapped_column(ForeignKey("consents.id", ondelete="SET NULL"))
    file_id: Mapped[int | None] = mapped_column(ForeignKey("files.id", ondelete="SET NULL"))
    total: Mapped[int] = mapped_column(Integer, default=0)
    processed: Mapped[int] = mapped_column(Integer, default=0)
    created_count: Mapped[int] = mapped_column(Integer, default=0)
    skipped_dups: Mapped[int] = mapped_column(Integer, default=0)
    skipped_media: Mapped[dict] = mapped_column(JSONB, default=dict)
    failed: Mapped[int] = mapped_column(Integer, default=0)
    cursor: Mapped[dict] = mapped_column(JSONB, default=dict)
    session_enc: Mapped[bytes | None] = mapped_column(LargeBinary)
    session_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    budget_usd: Mapped[Decimal] = mapped_column(Numeric(12, 6), default=Decimal("1.0"))
    cost_usd: Mapped[Decimal] = mapped_column(Numeric(12, 6), default=Decimal("0"))
    summary: Mapped[dict] = mapped_column(JSONB, default=dict)
    action_id: Mapped[int | None] = mapped_column(ForeignKey("actions.id", ondelete="SET NULL"))
    error: Mapped[str | None] = mapped_column(Text)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    seq: Mapped[int] = _seq()
    created_at: Mapped[datetime] = _ts()
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class ImportSeen(Base):
    __tablename__ = "import_seen"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    source_family: Mapped[str] = mapped_column(Text)
    external_id: Mapped[str] = mapped_column(Text)
    item_id: Mapped[int | None] = mapped_column(ForeignKey("items.id", ondelete="SET NULL"))
    import_id: Mapped[int | None] = mapped_column(ForeignKey("imports.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = _ts()


class AnalyticsEvent(Base):
    """`analytics.events`: facts only (what was tapped), never content (R-40)."""

    __tablename__ = "events"
    __table_args__ = {"schema": "analytics"}

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    client_id: Mapped[uuid.UUID] = mapped_column(Uuid)
    user_pseudo: Mapped[str] = mapped_column(Text)
    device_pseudo: Mapped[str | None] = mapped_column(Text)
    name: Mapped[str] = mapped_column(Text)
    props: Mapped[dict] = mapped_column(JSONB, default=dict)
    platform: Mapped[str | None] = mapped_column(Text)
    app_version: Mapped[str | None] = mapped_column(Text)
    client_ts: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    received_at: Mapped[datetime] = _ts()
