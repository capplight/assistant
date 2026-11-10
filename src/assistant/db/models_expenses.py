"""«Расходы» (migrations 0018, 0019, frozen SQL; spec 3.12): expenses, categories, statement
imports and expense repeats (week 13; `seq` on both since 0020). Allowed values are
the StrEnums below and must match the CHECKs in the migration. `seq` is set by the `sync_seq_bump`
trigger."""

import enum
import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
    Boolean,
    Date,
    DateTime,
    FetchedValue,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
    Uuid,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from assistant.db.ids import uuid7
from assistant.db.models import Base

# The 8 founder-approved categories in their default order, then the hidden service one.
SYSTEM_KEYS = ("groceries", "home", "transport", "health", "family", "cafe_gifts", "utilities",
               "other")  # fmt: skip
TRANSFERS_KEY = "transfers"
UNHIDEABLE = frozenset({"other", TRANSFERS_KEY})
MAX_OWN_CATEGORIES = 30
AMOUNT_MAX = Decimal("999999999999.99")  # numeric(14, 2)


class Direction(enum.StrEnum):
    EXPENSE = "expense"
    INCOME = "income"
    REFUND = "refund"
    TRANSFER_OWN = "transfer_own"


class Method(enum.StrEnum):
    CASH = "cash"
    CARD = "card"
    KASPI = "kaspi"
    TRANSFER = "transfer"
    OTHER = "other"


class ExpenseSource(enum.StrEnum):
    TYPED = "typed"
    VOICE = "voice"
    FORM = "form"
    RECEIPT_OCR = "receipt_ocr"
    RECEIPT_QR = "receipt_qr"
    SHARED_RECEIPT = "shared_receipt"
    STATEMENT_PDF = "statement_pdf"
    PASTED_TEXT = "pasted_text"


TRUSTED_SOURCES = frozenset({ExpenseSource.TYPED, ExpenseSource.FORM})  # no «Проверьте» (R-36)


class ParseSource(enum.StrEnum):
    RULES = "rules"
    LLM = "llm"
    USER_EDIT = "user_edit"


def _seq() -> Mapped[int]:
    return mapped_column(BigInteger, server_default=FetchedValue(), server_onupdate=FetchedValue())


class ExpenseCategory(Base):
    __tablename__ = "expense_categories"
    __mapper_args__ = {"eager_defaults": True}

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    public_id: Mapped[uuid.UUID] = mapped_column(Uuid, default=uuid7, unique=True)
    client_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    key: Mapped[str] = mapped_column(Text)
    title: Mapped[str] = mapped_column(Text)
    title_kk: Mapped[str | None] = mapped_column(Text)
    icon: Mapped[str | None] = mapped_column(Text)
    parent_id: Mapped[int | None] = mapped_column(
        ForeignKey("expense_categories.id", ondelete="SET NULL")
    )
    created_by: Mapped[str] = mapped_column(Text)
    service: Mapped[bool] = mapped_column(Boolean, default=False)
    position: Mapped[str] = mapped_column(Text)
    manual_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    pinned: Mapped[bool] = mapped_column(Boolean, default=False)
    hidden_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    version: Mapped[int] = mapped_column(Integer, default=1)
    seq: Mapped[int] = _seq()
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class ExpenseEntry(Base):
    __tablename__ = "expense_entries"
    __mapper_args__ = {"eager_defaults": True}

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    public_id: Mapped[uuid.UUID] = mapped_column(Uuid, default=uuid7, unique=True)
    client_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    item_id: Mapped[int] = mapped_column(ForeignKey("items.id", ondelete="CASCADE"))
    amount: Mapped[Decimal] = mapped_column(Numeric(14, 2))
    currency: Mapped[str] = mapped_column(String(3), default="KZT")
    expression: Mapped[str | None] = mapped_column(Text)
    spent_on: Mapped[date] = mapped_column(Date)
    spent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    category_id: Mapped[int | None] = mapped_column(
        ForeignKey("expense_categories.id", ondelete="SET NULL")
    )
    payee: Mapped[str | None] = mapped_column(Text)
    payee_norm: Mapped[str | None] = mapped_column(Text)
    method: Mapped[str | None] = mapped_column(Text)
    direction: Mapped[str] = mapped_column(Text, default=Direction.EXPENSE)
    note: Mapped[str | None] = mapped_column(Text)
    source: Mapped[str] = mapped_column(Text)
    parse_source: Mapped[str | None] = mapped_column(Text)
    review_fields: Mapped[list] = mapped_column(JSONB, default=list)
    statement_import_id: Mapped[int | None] = mapped_column(
        ForeignKey("statement_imports.id", ondelete="SET NULL")
    )
    source_ref: Mapped[str | None] = mapped_column(Text)  # statement row / fiscal receipt key
    dedup_key: Mapped[str | None] = mapped_column(Text)
    line_items: Mapped[list | None] = mapped_column(JSONB)
    ai_generated: Mapped[bool] = mapped_column(Boolean, default=False)
    version: Mapped[int] = mapped_column(Integer, default=1)
    seq: Mapped[int] = _seq()
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class StatementStatus(enum.StrEnum):
    PARSED = "parsed"
    PROPOSED = "proposed"
    CONFIRMED = "confirmed"
    UNDONE = "undone"
    REJECTED = "rejected"
    EXPIRED = "expired"
    FAILED = "failed"


class StatementImport(Base):
    """A bank statement read into a plan (week 13). `rows` wait here until «Да»."""

    __tablename__ = "statement_imports"
    __mapper_args__ = {"eager_defaults": True}

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    public_id: Mapped[uuid.UUID] = mapped_column(Uuid, default=uuid7, unique=True)
    client_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    item_id: Mapped[int | None] = mapped_column(ForeignKey("items.id", ondelete="SET NULL"))
    bank_hint: Mapped[str] = mapped_column(Text)
    parser: Mapped[str] = mapped_column(Text)
    currency: Mapped[str] = mapped_column(String(3), default="KZT")
    period_from: Mapped[date | None] = mapped_column(Date)
    period_to: Mapped[date | None] = mapped_column(Date)
    rows_found: Mapped[int] = mapped_column(Integer, default=0)
    rows_new: Mapped[int] = mapped_column(Integer, default=0)
    rows_duplicate: Mapped[int] = mapped_column(Integer, default=0)
    rows_similar: Mapped[int] = mapped_column(Integer, default=0)
    rows: Mapped[list] = mapped_column(JSONB, default=list)
    check: Mapped[dict | None] = mapped_column("check", JSONB)
    adds: Mapped[dict] = mapped_column(JSONB, default=dict)
    status: Mapped[str] = mapped_column(Text)
    error: Mapped[str | None] = mapped_column(Text)
    pending_action_id: Mapped[int | None] = mapped_column(
        ForeignKey("pending_actions.id", ondelete="SET NULL")
    )
    action_id: Mapped[int | None] = mapped_column(ForeignKey("actions.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    seq: Mapped[int] = _seq()  # 0020: /v1/sync


class DuplicateStatus(enum.StrEnum):
    SUGGESTED = "suggested"
    MERGED = "merged"
    DISMISSED = "dismissed"


class ExpenseDuplicate(Base):
    """«Похоже, эта трата уже есть [Объединить?]»: a pair found by code (week 13)."""

    __tablename__ = "expense_duplicates"
    __mapper_args__ = {"eager_defaults": True}

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    public_id: Mapped[uuid.UUID] = mapped_column(Uuid, default=uuid7, unique=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    keep_id: Mapped[int] = mapped_column(ForeignKey("expense_entries.id", ondelete="CASCADE"))
    other_id: Mapped[int] = mapped_column(ForeignKey("expense_entries.id", ondelete="CASCADE"))
    status: Mapped[str] = mapped_column(Text, default=DuplicateStatus.SUGGESTED)
    reason: Mapped[str] = mapped_column(Text)  # statement | receipt | same_day
    action_id: Mapped[int | None] = mapped_column(ForeignKey("actions.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    seq: Mapped[int] = _seq()  # 0020: /v1/sync
