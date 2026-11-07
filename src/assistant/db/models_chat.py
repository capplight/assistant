"""Conversation and feedback schema (migration 0010, frozen SQL; spec 3.7, 3.13).

Allowed values of the text enums below must match the CHECKs in 0010.
"""

import enum
import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    Text,
    Uuid,
    func,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from assistant.db.ids import uuid7
from assistant.db.models import Base


class MessageRole(enum.StrEnum):
    USER = "user"
    ASSISTANT = "assistant"
    TOOL = "tool"


class InputKind(enum.StrEnum):
    TYPED = "typed"
    VOICE = "voice"
    SHARE = "share"


class AnswerKind(enum.StrEnum):
    ACTION = "action"
    TEXT = "text"
    CHOICE = "choice"
    DEFERRED = "deferred"


class MessageState(enum.StrEnum):
    PENDING = "pending"
    DONE = "done"
    DEFERRED = "deferred"
    FAILED = "failed"


class Delivery(enum.StrEnum):
    STREAMED = "streamed"
    BANNER_PENDING = "banner_pending"
    BANNER_SHOWN = "banner_shown"
    OPENED = "opened"
    DISMISSED = "dismissed"


class FeedbackTarget(enum.StrEnum):
    ANSWER = "answer"
    KP = "kp"
    ITEM = "item"
    REMINDER = "reminder"


class FeedbackReason(enum.StrEnum):
    WRONG = "wrong"
    OFFENSIVE = "offensive"
    OTHER = "other"


class Conversation(Base):
    __tablename__ = "conversations"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    public_id: Mapped[uuid.UUID] = mapped_column(Uuid, default=uuid7, unique=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(Text, default="main")
    summary: Mapped[str | None] = mapped_column(Text)
    summary_upto_msg_id: Mapped[int | None] = mapped_column(BigInteger)
    summary_version: Mapped[int | None] = mapped_column(Integer)
    msg_count: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class ConversationMessage(Base):
    __tablename__ = "conversation_messages"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    public_id: Mapped[uuid.UUID] = mapped_column(Uuid, default=uuid7, unique=True)
    client_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    conversation_id: Mapped[int] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE")
    )
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    role: Mapped[str] = mapped_column(Text)
    reply_to_id: Mapped[int | None] = mapped_column(
        ForeignKey("conversation_messages.id", ondelete="SET NULL")
    )
    screen_id: Mapped[int | None] = mapped_column(ForeignKey("screens.id", ondelete="SET NULL"))
    input_kind: Mapped[str | None] = mapped_column(Text)
    content: Mapped[str] = mapped_column(Text, default="")
    answer_kind: Mapped[str | None] = mapped_column(Text)
    state: Mapped[str] = mapped_column(Text, default=MessageState.DONE)
    tool_calls: Mapped[list] = mapped_column(JSONB, default=list)
    tool_results_ref: Mapped[list] = mapped_column(JSONB, default=list)
    citations: Mapped[list] = mapped_column(JSONB, default=list)
    checked: Mapped[dict | None] = mapped_column(JSONB)
    action_ids: Mapped[list[int]] = mapped_column(ARRAY(BigInteger), default=list)
    pending_action_ids: Mapped[list[int]] = mapped_column(ARRAY(BigInteger), default=list)
    delivery: Mapped[str | None] = mapped_column(Text)
    push_sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ai_generated: Mapped[bool] = mapped_column(Boolean, default=False)
    prompt_version: Mapped[str | None] = mapped_column(Text)
    cost_usd: Mapped[Decimal] = mapped_column(Numeric(12, 6), default=Decimal(0))
    error_code: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Feedback(Base):
    __tablename__ = "feedback"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    public_id: Mapped[uuid.UUID] = mapped_column(Uuid, default=uuid7, unique=True)
    client_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    target: Mapped[str] = mapped_column(Text)
    target_ref: Mapped[uuid.UUID] = mapped_column(Uuid)
    reason: Mapped[str] = mapped_column(Text)
    comment: Mapped[str | None] = mapped_column(Text)
    allow_anonymized_example: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
