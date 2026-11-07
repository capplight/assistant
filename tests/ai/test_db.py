"""AI tables (migration 0005) against a real Postgres migrated to head. Rolled back after each
test. Skipped unless DATABASE_URL is set."""

import os
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from assistant.ai import FakeAdapter, LLMTask, PgAIStore, Router, RouteTable
from assistant.ai.store import (
    EPOCH,
    BudgetKey,
    Period,
    Scope,
    SpendAdd,
    UsageRecord,
    ensure_usage_partitions,
)
from assistant.db.models import User
from assistant.db.models_v2 import Consent
from tests.ai.conftest import NOW, ROUTES, Note, make_settings

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set"),
]


@pytest.fixture
async def db():
    engine = create_async_engine(os.environ["DATABASE_URL"])
    async with engine.connect() as conn:
        trans = await conn.begin()
        maker = async_sessionmaker(bind=conn, expire_on_commit=False,
                                   join_transaction_mode="create_savepoint")  # fmt: skip
        try:
            yield maker
        finally:
            await trans.rollback()
    await engine.dispose()


async def _user(maker, profile="regular") -> int:
    async with maker() as s, s.begin():
        u = User(profile=profile)
        s.add(u)
        await s.flush()
        return u.id


async def test_tables_and_partitions_exist(db):
    async with db() as s:
        names = set((await s.execute(text(
            "SELECT tablename FROM pg_tables WHERE tablename LIKE 'provider_usage%' "
            "OR tablename IN ('budgets', 'usage_counters', 'ai_provider_state')"
        ))).scalars())  # fmt: skip
        kind = await s.scalar(text(
            "SELECT relkind::text FROM pg_class WHERE relname = 'provider_usage'"))
    assert {"budgets", "usage_counters", "ai_provider_state", "provider_usage_default",
            "provider_usage_2026_11", "provider_usage_2027_12"} <= names  # fmt: skip
    assert kind == "p"  # partitioned


async def test_add_spend_accumulates_atomically_with_state(db):
    store = PgAIStore(db)
    key = BudgetKey(Scope.USER, "42", "all", Period.MONTH, datetime(2026, 10, 31, 19, tzinfo=UTC))
    assert (await store.spent([key]))[key] == 0
    totals = [await store.add_spend([SpendAdd(key, Decimal("0.5"), Decimal("3"))])
              for _ in range(5)]
    assert [t[key] for t in totals] == [Decimal(x) for x in ("0.5", "1", "1.5", "2", "2.5")]
    assert (await store.spent([key]))[key] == Decimal("2.5")
    async with db() as s:
        assert await s.scalar(text("SELECT state FROM budgets WHERE key = '42'")) == "warn"
    await store.add_spend([SpendAdd(key, Decimal("0.5"), Decimal("3"))])
    async with db() as s:
        assert await s.scalar(text("SELECT state FROM budgets WHERE key = '42'")) == "off"
    once = BudgetKey(Scope.USER, "42", "import", Period.ONCE, EPOCH)
    await store.add_spend([SpendAdd(once, Decimal("1"), None)])
    assert (await store.spent([once]))[once] == Decimal("1")


async def test_record_usage_goes_to_month_partition_and_checks_enums(db):
    store = PgAIStore(db)
    at = datetime(2026, 11, 7, 6, tzinfo=UTC)
    await store.record_usage(UsageRecord(
        task="enrich", budget_class="background", provider="anthropic", model="claude-haiku-5-5",
        outcome="ok", user_id=None, tokens_in=10, tokens_out=5, cost_usd=Decimal("0.000123"),
        latency_ms=321, created_at=at))  # fmt: skip
    async with db() as s:
        row = (await s.execute(text(
            "SELECT tableoid::regclass::text, cost_usd, outcome FROM provider_usage "
            "WHERE latency_ms = 321"))).one()  # fmt: skip
    assert row == ("provider_usage_2026_11", Decimal("0.000123"), "ok")
    with pytest.raises(IntegrityError):
        await store.record_usage(UsageRecord(task="x", budget_class="background", provider="p",
                                             model="m", outcome="weird", created_at=at))


async def test_ensure_usage_partitions_is_idempotent(db):
    async with db() as s, s.begin():
        await ensure_usage_partitions(s, datetime(2028, 1, 15, tzinfo=UTC), months=1)
        await ensure_usage_partitions(s, datetime(2028, 1, 15, tzinfo=UTC), months=1)
        names = set((await s.execute(text(
            "SELECT tablename FROM pg_tables WHERE tablename LIKE 'provider_usage_2028%'"
        ))).scalars())  # fmt: skip
    assert names == {"provider_usage_2028_01", "provider_usage_2028_02"}


async def test_provider_off_state(db):
    store = PgAIStore(db)
    await store.set_provider_off("openai", "quota")
    assert await store.providers_off() == {"openai": "quota"}
    await store.clear_provider_off("openai")
    assert await store.providers_off() == {}


async def test_profile_and_consent_lookup(db):
    store = PgAIStore(db, legacy_consent_providers=["anthropic"])
    uid = await _user(db, "work")
    assert await store.user_profile(uid) == "work"
    assert await store.consent_providers(uid) is None
    async with db() as s, s.begin():
        s.add(Consent(user_id=uid, kind="ai_cross_border", version="legacy-bot", providers=[],
                      granted_at=NOW - timedelta(days=30)))
    assert await store.consent_providers(uid) == frozenset({"anthropic"})
    async with db() as s, s.begin():
        s.add(Consent(user_id=uid, kind="ai_cross_border", version="ai-2026-11-v1",
                      providers=["Anthropic", "OpenAI", "Google", "Groq"], granted_at=NOW))
    assert await store.consent_providers(uid) == frozenset(
        {"anthropic", "openai", "google", "groq"})
    async with db() as s, s.begin():
        await s.execute(text("UPDATE consents SET revoked_at = now() WHERE user_id = :u"),
                        {"u": uid})
    assert await store.consent_providers(uid) is None


async def test_router_end_to_end_on_postgres(db):
    settings = make_settings()
    store = PgAIStore(db)
    uid = await _user(db, "regular")
    async with db() as s, s.begin():
        s.add(Consent(user_id=uid, kind="ai_cross_border", version="ai-2026-11-v1",
                      providers=["Anthropic", "OpenAI"], granted_at=NOW - timedelta(days=1)))
    router = Router(settings=settings, routes=RouteTable(ROUTES, settings), store=store,
                    adapters={"anthropic": FakeAdapter("anthropic", [Note(title="x")])},
                    clock=lambda: NOW, alert=lambda m: None)  # fmt: skip
    res = await router.run(LLMTask.DUP_JUDGE, Note, _inputs(), user_id=uid)
    assert res.data.title == "x"
    async with db() as s:
        usage = (await s.execute(text(
            "SELECT provider, outcome, cost_usd FROM provider_usage WHERE user_id = :u"),
            {"u": uid})).all()  # fmt: skip
        spent = dict((await s.execute(text(
            "SELECT scope || ':' || class || ':' || period, spent_usd FROM budgets "
            "WHERE key IN (:u, 'anthropic')"), {"u": str(uid)})).all())  # fmt: skip
    assert usage == [("anthropic", "ok", res.cost_usd)] and res.cost_usd > 0
    assert spent["user:all:month"] == res.cost_usd
    assert spent["user:background:day"] == res.cost_usd
    assert spent["provider:all:month"] == res.cost_usd


def _inputs():
    from assistant.ai import TaskInputs

    return TaskInputs(system="s", instruction="i")
