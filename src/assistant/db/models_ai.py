"""AI layer schema (migration 0005): provider_usage, budgets, usage_counters, ai_provider_state.

Spec 3-engineering 3.8. Enums are text + CHECK; allowed values are in assistant.ai.types
(Outcome, BudgetClass) and assistant.ai.store (Scope, Period) and must match 0005.
"""

from datetime import datetime
from decimal import Decimal

from sqlalchemy import BigInteger, DateTime, Integer, Numeric, PrimaryKeyConstraint, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from assistant.db.models import Base


class ProviderUsage(Base):
    """One row per provider attempt (also budget/consent/circuit events). Partitioned by month
    on created_at, so the PK includes created_at. user_id has no FK: rows outlive deletions
    (they hold no content) and FKs to partitioned tables complicate purges."""

    __tablename__ = "provider_usage"
    __table_args__ = (PrimaryKeyConstraint("id", "created_at"),)

    id: Mapped[int] = mapped_column(BigInteger, autoincrement=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True),
                                                 server_default=func.now())  # fmt: skip
    user_id: Mapped[int | None] = mapped_column(BigInteger)
    task: Mapped[str] = mapped_column(Text)
    budget_class: Mapped[str] = mapped_column(Text)
    provider: Mapped[str] = mapped_column(Text)
    model: Mapped[str] = mapped_column(Text)
    request_id: Mapped[str | None] = mapped_column(Text)
    tokens_in: Mapped[int] = mapped_column(Integer, default=0)
    tokens_out: Mapped[int] = mapped_column(Integer, default=0)
    cached_in: Mapped[int] = mapped_column(Integer, default=0)
    cache_write_in: Mapped[int] = mapped_column(Integer, default=0)
    audio_seconds: Mapped[Decimal | None] = mapped_column(Numeric(10, 2))
    images: Mapped[int] = mapped_column(Integer, default=0)
    cost_usd: Mapped[Decimal] = mapped_column(Numeric(12, 6), default=Decimal(0))
    latency_ms: Mapped[int | None] = mapped_column(Integer)
    outcome: Mapped[str] = mapped_column(Text)
    fallback_from: Mapped[str | None] = mapped_column(Text)
    attempt: Mapped[int] = mapped_column(Integer, default=1)
    job_id: Mapped[int | None] = mapped_column(BigInteger)
    prompt_version: Mapped[str | None] = mapped_column(Text)
    error_kind: Mapped[str | None] = mapped_column(Text)


class Budget(Base):
    """Spend counter for one wallet and period. Updated atomically (INSERT .. ON CONFLICT ..
    SET spent_usd = spent_usd + x RETURNING)."""

    __tablename__ = "budgets"
    __table_args__ = (PrimaryKeyConstraint("scope", "key", "class", "period", "period_start"),)

    scope: Mapped[str] = mapped_column(Text)
    key: Mapped[str] = mapped_column(Text)
    budget_class: Mapped[str] = mapped_column("class", Text)
    period: Mapped[str] = mapped_column(Text)
    period_start: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    limit_usd: Mapped[Decimal | None] = mapped_column(Numeric(12, 6))
    spent_usd: Mapped[Decimal] = mapped_column(Numeric(12, 6), default=Decimal(0))
    state: Mapped[str] = mapped_column(Text, default="ok")
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True),
                                                 server_default=func.now())  # fmt: skip


class UsageCounter(Base):
    __tablename__ = "usage_counters"
    __table_args__ = (PrimaryKeyConstraint("user_id", "period_start", "counter"),)

    user_id: Mapped[int] = mapped_column(BigInteger)
    period_start: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    counter: Mapped[str] = mapped_column(Text)
    value: Mapped[int] = mapped_column(BigInteger, default=0)


class ProviderState(Base):
    """Manual switch: quota/402 turns a provider off until someone resets it."""

    __tablename__ = "ai_provider_state"

    provider: Mapped[str] = mapped_column(Text, primary_key=True)
    state: Mapped[str] = mapped_column(Text, default="ok")  # ok | off
    reason: Mapped[str | None] = mapped_column(Text)
    changed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True),
                                                 server_default=func.now())  # fmt: skip
