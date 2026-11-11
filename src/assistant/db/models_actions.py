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
    """The kinds the app writes; the CHECK in 0011 holds the full list of the spec."""

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
    CREATE_REMINDER = "create_reminder"  # week 9
    EDIT_REMINDER = "edit_reminder"  # week 9: changed or deleted by the person
    DELETE_SCREEN = "delete_screen"  # week 9: «Убрать страницу»
    SCREEN_CUSTOMIZE = "screen_customize"  # week 9: name, icon, layout
    FACET_EDIT = "facet_edit"  # week 9: a task changed or ticked
    AUTO_MERGE_EXACT = "auto_merge_exact"  # week 10: an exact repeat merged on save
    MERGE_GROUP = "merge_group"  # week 10: «Объединить?» → «Да» (one group or several)
    DISMISS_GROUP = "dismiss_group"  # week 10: «Это разные» (0015 adds it to the CHECK)
    CLEANUP_BATCH = "cleanup_batch"  # week 10: «37 → 1», one «Да» for every exact repeat
    IMPORT_BATCH = "import_batch"  # week 10: a Telegram import
    CREATE_STACK = "create_stack"  # week 10: a stack shows up (with «Отменить»)
    STACK_ADD = "stack_add"
    STACK_REMOVE = "stack_remove"
    DELETE_STACK = "delete_stack"
    SCREEN_VIEW_CHANGE = "screen_view_change"  # week 11: set_view (S38 or the assistant)
    SCREEN_RESET = "screen_reset"  # week 11: «Вернуть как было»
    CREATE_EXPENSE = "create_expense"  # week 12: «Расходы» (already in the 0011 CHECK)
    EDIT_EXPENSE = "edit_expense"
    BULK_CREATE_EXPENSES = "bulk_create_expenses"  # week 13: a bank statement after «Да»
    MERGE_EXPENSES = "merge_expenses"  # week 13: «Объединить?» of two expenses (0019)
    DISMISS_EXPENSES = "dismiss_expenses"  # week 13 «Это разные» of two expenses (0020)
    CREATE_KP = "create_kp"  # week 14: a КП made from a ТЗ (in the 0011 CHECK)
    EDIT_KP = "edit_kp"  # week 14: tap edits, «Вернуть версию», the status strip, «Убрать»
    COMPANY_PROFILE_EDIT = "company_profile_edit"  # week 14: «Моя компания» (0020)
    PRICE_LIST_EDIT = "price_list_edit"  # week 14: «Мой прайс» (0020)
    SEND_EXTERNAL = "send_external"  # week 15: «Отправили? — Да» (in the 0011 CHECK; no undo)


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
