"""App reminders, part 2: fires and phone events (migration 0013; spec 3-engineering 3.x, 6.6).

The reminder rows themselves are `assistant.db.models.Reminder` (the legacy table, generalized):
app rows have `kind` in APP_KINDS. Enums are `text + CHECK`; allowed values below must match
the CHECKs in 0013.
"""

import enum
import uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Integer, Text, UniqueConstraint, Uuid, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column
from sqlalchemy.schema import FetchedValue

from assistant.db.ids import uuid7
from assistant.db.models import Base


class AppReminderKind(enum.StrEnum):
    NORMAL = "normal"
    TEST = "test"


APP_KINDS: tuple[str, ...] = tuple(k.value for k in AppReminderKind)


class AppReminderStatus(enum.StrEnum):
    SCHEDULED = "scheduled"
    FIRED = "fired"
    ACKED = "acked"
    SNOOZED = "snoozed"
    DONE = "done"
    CANCELLED = "cancelled"
    MISSED = "missed"


class ReminderLevel(enum.StrEnum):
    ALARM = "alarm"
    NOTIFICATION = "notification"


class CreatedVia(enum.StrEnum):
    VOICE = "voice"
    TYPED = "typed"
    AGENT_SUGGESTION = "agent_suggestion"
    MANUAL_FORM = "manual_form"


class ParseSource(enum.StrEnum):
    RULES = "rules"
    LLM = "llm"
    USER_EDIT = "user_edit"


class FireState(enum.StrEnum):
    PLANNED = "planned"
    FIRED = "fired"
    ACKED = "acked"
    SNOOZED = "snoozed"
    MISSED = "missed"
    CANCELLED = "cancelled"


class FireEvent(enum.StrEnum):
    SCHEDULED_LOCAL = "scheduled_local"
    SCHEDULE_FAILED = "schedule_failed"
    FIRED_LOCAL = "fired_local"
    SHOWN = "shown"
    ACKED = "acked"
    SNOOZED = "snoozed"
    DISMISSED = "dismissed"
    PUSH_SENT = "push_sent"  # server only
    PUSH_FAILED = "push_failed"  # server only
    MISSED = "missed"  # server only


PHONE_EVENTS = frozenset({FireEvent.SCHEDULED_LOCAL, FireEvent.SCHEDULE_FAILED,
                          FireEvent.FIRED_LOCAL, FireEvent.SHOWN, FireEvent.ACKED,
                          FireEvent.SNOOZED, FireEvent.DISMISSED})  # fmt: skip


class ReminderFire(Base):
    __tablename__ = "reminder_fires"
    __table_args__ = (
        UniqueConstraint("reminder_id", "occurrence_at", "offset_min", "snooze_n",
                         name="uq_reminder_fires_key"),
    )  # fmt: skip
    __mapper_args__ = {"eager_defaults": True}

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    public_id: Mapped[uuid.UUID] = mapped_column(Uuid, unique=True, default=uuid7)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    reminder_id: Mapped[int] = mapped_column(ForeignKey("reminders.id", ondelete="CASCADE"))
    occurrence_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    fire_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    offset_min: Mapped[int] = mapped_column(Integer, default=0)
    repeat_n: Mapped[int] = mapped_column(Integer, default=0)
    snooze_n: Mapped[int] = mapped_column(Integer, default=0)
    state: Mapped[str] = mapped_column(Text, default=FireState.PLANNED)
    push_fallback_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    push_sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    missed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    fired_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    acked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    target_device_id: Mapped[int | None] = mapped_column(
        ForeignKey("devices.id", ondelete="SET NULL")
    )
    seq: Mapped[int] = mapped_column(
        BigInteger, server_default=FetchedValue(), server_onupdate=FetchedValue()
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class ReminderEvent(Base):
    """Journal of what phones and the server did with a fire (delivery metrics, spec 7)."""

    __tablename__ = "reminder_events"
    __table_args__ = (UniqueConstraint("fire_id", "client_id", name="uq_reminder_events_client"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    fire_id: Mapped[int] = mapped_column(ForeignKey("reminder_fires.id", ondelete="CASCADE"))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    device_id: Mapped[int | None] = mapped_column(ForeignKey("devices.id", ondelete="SET NULL"))
    client_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    event: Mapped[str] = mapped_column(Text)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    received_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    meta: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}")
