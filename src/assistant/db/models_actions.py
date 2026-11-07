"""«Что я сделал» (migration 0011, frozen SQL; spec 3.7): one row per change the person or the
agent made, with the recipe to undo it (`inverse`, run by assistant.actions). `seq` is set by the
`sync_seq_bump` trigger."""

import enum
import uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, FetchedValue, ForeignKey, Text, Uuid, func
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from assistant.db.ids import uuid7
from assistant.db.models import Base

UNDO_DAYS = 30


class ActionKind(enum.StrEnum):
    """The kinds week 6 writes; the CHECK in 0011 holds the full list of the spec."""

    SAVE_ITEM = "save_item"
    DELETE_ITEM = "delete_item"
    USER_EDIT = "user_edit"
    CREATE_SCREEN = "create_screen"
    SCREEN_REORDER_ITEMS = "screen_reorder_items"
    SCREEN_MOVE_ITEMS = "screen_move_items"
    SCREEN_ADD_ITEM = "screen_add_item"
    SCREEN_REMOVE_ITEM = "screen_remove_item"
    REORDER_SCREENS = "reorder_screens"  # week 7: tab order by hand
    HABIT_CHANGE = "habit_change"  # week 7: a learned placement rule turned off


class Initiator(enum.StrEnum):
    USER = "user"
    AGENT = "agent"


class Action(Base):
    __tablename__ = "actions"
    __mapper_args__ = {"eager_defaults": True}

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    public_id: Mapped[uuid.UUID] = mapped_column(Uuid, default=uuid7, unique=True)
    client_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(Text)
    scope: Mapped[str] = mapped_column(Text, default="internal")
    initiated_by: Mapped[str] = mapped_column(Text)
    summary: Mapped[dict] = mapped_column(JSONB, default=dict)
    payload: Mapped[dict] = mapped_column(JSONB, default=dict)
    inverse: Mapped[list] = mapped_column(JSONB, default=list)
    undoable_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    undone_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    undo_of_action_id: Mapped[int | None] = mapped_column(
        ForeignKey("actions.id", ondelete="SET NULL")
    )
    source_item_ids: Mapped[list[int]] = mapped_column(ARRAY(BigInteger), default=list)
    screen_id: Mapped[int | None] = mapped_column(ForeignKey("screens.id", ondelete="SET NULL"))
    message_id: Mapped[int | None] = mapped_column(
        ForeignKey("conversation_messages.id", ondelete="SET NULL")
    )
    seq: Mapped[int] = mapped_column(
        BigInteger, server_default=FetchedValue(), server_onupdate=FetchedValue()
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
