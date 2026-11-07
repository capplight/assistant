"""`user_habits` (migration 0012, frozen SQL; spec 3.4): what the assistant learned or was told to
do for this person, shown in «Что я для вас настроил» (week 9). Week 7 writes `placement_rule`.
`seq` is set by the `sync_seq_bump` trigger."""

import enum
import uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, FetchedValue, ForeignKey, Integer, Text, Uuid, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from assistant.db.ids import uuid7
from assistant.db.models import Base


class HabitKind(enum.StrEnum):
    """Kinds week 7 writes; the CHECK in 0012 holds the full list of the spec."""

    PLACEMENT_RULE = "placement_rule"


class HabitSource(enum.StrEnum):
    USER_EXPLICIT = "user_explicit"
    LEARNED_UNDO = "learned_undo"
    LEARNED_EDIT = "learned_edit"


class HabitStatus(enum.StrEnum):
    CANDIDATE = "candidate"  # seen once: kept, not used
    ACTIVE = "active"
    DISABLED = "disabled"  # the person turned it off: never switched on again by learning


class UserHabit(Base):
    __tablename__ = "user_habits"
    __mapper_args__ = {"eager_defaults": True}

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    public_id: Mapped[uuid.UUID] = mapped_column(Uuid, default=uuid7, unique=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(Text)
    key: Mapped[str] = mapped_column(Text)
    value: Mapped[dict] = mapped_column(JSONB, default=dict)
    source: Mapped[str] = mapped_column(Text)
    evidence_count: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(Text, default=HabitStatus.ACTIVE)
    seq: Mapped[int] = mapped_column(
        BigInteger, server_default=FetchedValue(), server_onupdate=FetchedValue()
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
