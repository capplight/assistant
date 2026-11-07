"""Persistence for the AI layer: spend counters (budgets), provider_usage rows, provider off-state,
user profile and AI consent lookups.

`MemoryAIStore` serves tests and local runs without a DB; `PgAIStore` uses tables from
migration 0005. Each Pg method is its own short transaction: no transaction is ever held open
across a provider call.
"""

import enum
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Protocol
from zoneinfo import ZoneInfo

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from assistant.ai.consent import ai_consent_providers
from assistant.db.models import User
from assistant.db.models_ai import ProviderState, ProviderUsage

EPOCH = datetime(1970, 1, 1, tzinfo=UTC)


class Scope(enum.StrEnum):
    USER = "user"
    PROVIDER = "provider"
    FALLBACK_PROVIDER = "fallback_provider"
    GLOBAL = "global"


class Period(enum.StrEnum):
    DAY = "day"
    MONTH = "month"
    ONCE = "once"


ALL = "all"  # budgets.class for a wallet across classes


@dataclass(frozen=True)
class BudgetKey:
    scope: Scope
    key: str
    cls: str  # BudgetClass value or "all"
    period: Period
    period_start: datetime


@dataclass(frozen=True)
class SpendAdd:
    key: BudgetKey
    amount: Decimal
    limit: Decimal | None


@dataclass
class UsageRecord:
    task: str
    budget_class: str
    provider: str
    model: str
    outcome: str
    user_id: int | None = None
    request_id: str | None = None
    tokens_in: int = 0
    tokens_out: int = 0
    cached_in: int = 0
    cache_write_in: int = 0
    images: int = 0
    batch: bool = False
    cost_usd: Decimal = Decimal(0)
    latency_ms: int | None = None
    fallback_from: str | None = None
    attempt: int = 1
    job_id: int | None = None
    prompt_version: str | None = None
    error_kind: str | None = None  # exception class name only, never message text
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))


def period_starts(now: datetime, tz: str) -> tuple[datetime, datetime]:
    """(day start, month start) of `now` in tz, as aware UTC datetimes."""
    local = now.astimezone(ZoneInfo(tz))
    day = local.replace(hour=0, minute=0, second=0, microsecond=0)
    month = day.replace(day=1)
    return day.astimezone(UTC), month.astimezone(UTC)


def next_month_start(month_start_utc: datetime, tz: str) -> datetime:
    local = month_start_utc.astimezone(ZoneInfo(tz))
    nxt = (local.replace(day=28) + timedelta(days=4)).replace(day=1)
    return nxt.astimezone(UTC)


def budget_state(total: Decimal, limit: Decimal | None) -> str:
    if limit is None or limit <= 0:
        return "ok"
    if total >= limit:
        return "off"
    return "warn" if total >= limit * Decimal("0.8") else "ok"


class AIStore(Protocol):
    async def spent(self, keys: list[BudgetKey]) -> dict[BudgetKey, Decimal]: ...

    async def add_spend(self, adds: list[SpendAdd]) -> dict[BudgetKey, Decimal]:
        """Atomically add; returns new totals."""
        ...

    async def record_usage(self, rec: UsageRecord) -> None: ...

    async def providers_off(self) -> dict[str, str]:
        """Providers switched off until manual reset (quota / 402): provider -> reason."""
        ...

    async def set_provider_off(self, provider: str, reason: str) -> None: ...

    async def clear_provider_off(self, provider: str) -> None: ...

    async def user_profile(self, user_id: int) -> str | None: ...

    async def consent_providers(self, user_id: int) -> frozenset[str] | None: ...

    async def strong_calls_since(self, user_id: int, since: datetime,
                                 models: frozenset[str]) -> int:
        """Successful calls of these models outside the documents class (escalations)."""
        ...


class MemoryAIStore:
    def __init__(self) -> None:
        self.budgets: dict[BudgetKey, Decimal] = {}
        self.usage: list[UsageRecord] = []
        self.off: dict[str, str] = {}
        self.profiles: dict[int, str] = {}
        self.consents: dict[int, frozenset[str] | None] = {}

    async def spent(self, keys: list[BudgetKey]) -> dict[BudgetKey, Decimal]:
        return {k: self.budgets.get(k, Decimal(0)) for k in keys}

    async def add_spend(self, adds: list[SpendAdd]) -> dict[BudgetKey, Decimal]:
        out = {}
        for a in adds:
            self.budgets[a.key] = self.budgets.get(a.key, Decimal(0)) + a.amount
            out[a.key] = self.budgets[a.key]
        return out

    async def record_usage(self, rec: UsageRecord) -> None:
        self.usage.append(rec)

    async def providers_off(self) -> dict[str, str]:
        return dict(self.off)

    async def set_provider_off(self, provider: str, reason: str) -> None:
        self.off[provider] = reason

    async def clear_provider_off(self, provider: str) -> None:
        self.off.pop(provider, None)

    async def user_profile(self, user_id: int) -> str | None:
        return self.profiles.get(user_id)

    async def consent_providers(self, user_id: int) -> frozenset[str] | None:
        return self.consents.get(user_id)

    async def strong_calls_since(self, user_id: int, since: datetime,
                                 models: frozenset[str]) -> int:
        return sum(1 for r in self.usage if r.user_id == user_id and r.created_at >= since
                   and r.model in models and r.outcome == "ok" and r.budget_class != "documents")


_ADD_SPEND = text("""
INSERT INTO budgets (scope, key, class, period, period_start, limit_usd, spent_usd, state)
VALUES (:scope, :key, :cls, :period, :period_start, :limit, :amount, :state)
ON CONFLICT (scope, key, class, period, period_start) DO UPDATE SET
    spent_usd = budgets.spent_usd + EXCLUDED.spent_usd,
    limit_usd = EXCLUDED.limit_usd,
    state = CASE
        WHEN EXCLUDED.limit_usd IS NULL OR EXCLUDED.limit_usd <= 0 THEN 'ok'
        WHEN budgets.spent_usd + EXCLUDED.spent_usd >= EXCLUDED.limit_usd THEN 'off'
        WHEN budgets.spent_usd + EXCLUDED.spent_usd >= EXCLUDED.limit_usd * 0.8 THEN 'warn'
        ELSE 'ok' END,
    updated_at = now()
RETURNING spent_usd
""")

_SPENT = text("""
SELECT spent_usd FROM budgets
WHERE scope = :scope AND key = :key AND class = :cls AND period = :period
  AND period_start = :period_start
""")


class PgAIStore:
    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession], *,
                 legacy_consent_providers: list[str] | tuple[str, ...] = ("anthropic",)) -> None:
        self._sm = sessionmaker
        self._legacy = tuple(legacy_consent_providers)  # fmt: skip

    @staticmethod
    def _params(k: BudgetKey) -> dict[str, object]:
        return {"scope": str(k.scope), "key": k.key, "cls": k.cls, "period": str(k.period),
                "period_start": k.period_start}  # fmt: skip

    async def spent(self, keys: list[BudgetKey]) -> dict[BudgetKey, Decimal]:
        out: dict[BudgetKey, Decimal] = {}
        async with self._sm() as s:
            for k in keys:
                v = await s.scalar(_SPENT, self._params(k))
                out[k] = Decimal(v) if v is not None else Decimal(0)
        return out

    async def add_spend(self, adds: list[SpendAdd]) -> dict[BudgetKey, Decimal]:
        out: dict[BudgetKey, Decimal] = {}
        # Fixed key order: two concurrent calls lock rows in the same order (no deadlock).
        ordered = sorted(adds, key=lambda a: (a.key.scope, a.key.key, a.key.cls, a.key.period,
                                              a.key.period_start))  # fmt: skip
        async with self._sm() as s, s.begin():
            for a in ordered:
                total = await s.scalar(_ADD_SPEND, {
                    **self._params(a.key), "limit": a.limit, "amount": a.amount,
                    "state": budget_state(a.amount, a.limit),
                })  # fmt: skip
                out[a.key] = Decimal(total)
        return out

    async def record_usage(self, rec: UsageRecord) -> None:
        async with self._sm() as s, s.begin():
            s.add(ProviderUsage(
                user_id=rec.user_id, task=rec.task, budget_class=rec.budget_class,
                provider=rec.provider, model=rec.model, request_id=rec.request_id,
                tokens_in=rec.tokens_in, tokens_out=rec.tokens_out, cached_in=rec.cached_in,
                cache_write_in=rec.cache_write_in, images=rec.images, cost_usd=rec.cost_usd,
                latency_ms=rec.latency_ms, outcome=rec.outcome, fallback_from=rec.fallback_from,
                attempt=rec.attempt, job_id=rec.job_id, prompt_version=rec.prompt_version,
                error_kind=rec.error_kind, created_at=rec.created_at, batch=rec.batch,
            ))  # fmt: skip

    async def providers_off(self) -> dict[str, str]:
        async with self._sm() as s:
            rows = await s.execute(
                select(ProviderState.provider, ProviderState.reason).where(
                    ProviderState.state == "off"
                )
            )
            return {p: r or "" for p, r in rows.all()}

    async def set_provider_off(self, provider: str, reason: str) -> None:
        async with self._sm() as s, s.begin():
            await s.execute(text("""
                INSERT INTO ai_provider_state (provider, state, reason, changed_at)
                VALUES (:p, 'off', :r, now())
                ON CONFLICT (provider) DO UPDATE SET state = 'off', reason = EXCLUDED.reason,
                    changed_at = now()
            """), {"p": provider, "r": reason})  # fmt: skip

    async def clear_provider_off(self, provider: str) -> None:
        async with self._sm() as s, s.begin():
            await s.execute(text(
                "UPDATE ai_provider_state SET state = 'ok', reason = NULL, changed_at = now() "
                "WHERE provider = :p"
            ), {"p": provider})  # fmt: skip

    async def user_profile(self, user_id: int) -> str | None:
        async with self._sm() as s:
            return await s.scalar(select(User.profile).where(User.id == user_id))

    async def consent_providers(self, user_id: int) -> frozenset[str] | None:
        async with self._sm() as s:
            return await ai_consent_providers(s, user_id, legacy_providers=self._legacy)

    async def strong_calls_since(self, user_id: int, since: datetime,
                                 models: frozenset[str]) -> int:
        async with self._sm() as s:
            n = await s.scalar(
                select(func.count()).select_from(ProviderUsage).where(
                    ProviderUsage.user_id == user_id, ProviderUsage.created_at >= since,
                    ProviderUsage.model.in_(models), ProviderUsage.outcome == "ok",
                    ProviderUsage.budget_class != "documents",
                ))  # fmt: skip
            return int(n or 0)


async def ensure_usage_partitions(session: AsyncSession, now: datetime, months: int = 3) -> None:
    """Create monthly provider_usage partitions for the next `months` months (UTC bounds).

    Run from a periodic job before a month starts; rows outside existing partitions land in
    provider_usage_default, which must stay empty for the months created here.
    """
    start = now.astimezone(UTC).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    for _ in range(months + 1):
        nxt = (start.replace(day=28) + timedelta(days=4)).replace(day=1)
        name = f"provider_usage_{start:%Y_%m}"
        await session.execute(text(
            f"CREATE TABLE IF NOT EXISTS {name} PARTITION OF provider_usage "
            f"FOR VALUES FROM ('{start.isoformat()}') TO ('{nxt.isoformat()}')"
        ))  # fmt: skip
        start = nxt
