"""Chat cost report and ops alerts (week 17): pure aggregation and alert rules, then the same
against Postgres with dedup (db tests skip without DATABASE_URL)."""

import os
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import text

from assistant.ai.costs import (
    Snapshot,
    StepRow,
    build_report,
    check_alerts,
    evaluate,
    percentile,
    render_table,
    summarize,
)
from assistant.notify import FakeNotifier
from tests.ai.conftest import make_settings

NOW = datetime(2026, 11, 12, 7, 0, tzinfo=UTC)  # 12:00 in Almaty
STRONG = frozenset({"claude-sonnet-5-5"})


def row(minutes: int = 0, *, uid: int | None = 1, profile: str | None = "regular",
        provider: str = "anthropic", model: str = "claude-haiku-5-5", outcome: str = "ok",
        cost: str = "0.001", latency: int | None = 900, tin: int = 2000, cached: int = 4000,
        out: int = 200) -> StepRow:  # fmt: skip
    return StepRow(NOW - timedelta(minutes=minutes), uid, profile, provider, model, outcome,
                   Decimal(cost), latency, tin, out, cached, 0)  # fmt: skip


def test_percentile_is_linear_like_postgres():
    assert percentile([], 0.5) is None
    assert percentile([1.0, 2.0, 3.0, 4.0], 0.5) == 2.5
    assert percentile([1.0, 2.0, 3.0, 4.0, 5.0], 0.95) == pytest.approx(4.8)


def test_summarize_one_day_with_profiles_fallback_and_target():
    rows = [row(1, cost="0.0007"), row(2, cost="0.0012"), row(3, cost="0.003"),
            row(4, cost="0.004", provider="openai", model="gpt-5-mini", uid=2,
                profile="family_beta"),
            row(5, cost="0.02", model="claude-sonnet-5-5"),
            row(6, outcome="server_error", cost="0", latency=None)]  # fmt: skip
    rep = summarize(rows, tz="Asia/Almaty", primary="anthropic", strong=STRONG,
                    turns={"2026-11-12": 4}, user_spend={"2026-11-12": [0.01, 0.2, 0.05]},
                    median_target=0.003)  # fmt: skip
    assert len(rep) == 1
    d = rep[0]
    assert d.day == "2026-11-12" and d.total.steps == 5 and d.total.failed == 1
    assert d.total.cost_median == 0.003 and d.median_in_target is True
    assert d.total.fallback_share == 0.2 and d.total.strong_share == 0.2
    assert d.total.cache_read_share == round(24000 / 36000, 4)
    assert d.steps_per_turn == 1.25 and d.turns == 4
    assert d.user_day_usd_max == 0.2 and d.user_day_usd_p50 == 0.05
    assert set(d.by_profile) == {"regular", "family_beta"}
    assert d.by_profile["family_beta"].steps == 1
    table = render_table(rep)
    assert "2026-11-12" in table and "ok" in table
    over = summarize([row(cost="0.01")], tz="Asia/Almaty", primary="anthropic", strong=STRONG,
                     median_target=0.003)[0]  # fmt: skip
    assert over.median_in_target is False


def test_local_day_boundary_is_almaty():
    late = StepRow(datetime(2026, 11, 11, 19, 30, tzinfo=UTC), 1, None, "anthropic", "m", "ok",
                   Decimal("0.001"), 10)  # 00:30 on the 12th in Almaty
    assert summarize([late], tz="Asia/Almaty", primary="anthropic", strong=STRONG)[0].day \
        == "2026-11-12"  # fmt: skip


def test_alert_rules_and_keys():
    s = make_settings()
    snap = Snapshot(
        now=NOW, day="2026-11-12", yesterday="2026-11-11",
        fallback={"openai": (NOW - timedelta(minutes=15), NOW - timedelta(minutes=1)),
                  "google": (NOW - timedelta(minutes=5), NOW)},  # only 5 min: not yet
        providers_off={"anthropic": ("quota", NOW - timedelta(hours=1))},
        family_spend={7: 0.51, 8: 0.49}, chat_steps={7: 61, 8: 60},
        dear_steps={9: (2, 0.07)}, yesterday_steps=25, yesterday_median=0.004)
    alerts = {a.kind: a for a in evaluate(snap, s)}
    assert set(alerts) == {"fallback_in_use", "provider_off", "family_daily", "chat_steps",
                           "chat_step_cost", "chat_median"}
    assert alerts["fallback_in_use"].dedup_key.startswith("fallback_in_use:openai:")
    assert alerts["family_daily"].user_id == 7 and alerts["chat_steps"].user_id == 7
    assert alerts["chat_step_cost"].dedup_key == "chat_step_cost:9:2026-11-12"
    for a in alerts.values():  # numbers and ids only
        assert "+7" not in a.text and "@" not in a.text
    stale = Snapshot(now=NOW, day="d", yesterday="y",
                     fallback={"openai": (NOW - timedelta(hours=2), NOW - timedelta(hours=1))},
                     yesterday_steps=5, yesterday_median=0.5)  # fmt: skip
    assert evaluate(stale, s) == []  # fallback no longer in use; too few steps for a median


# --- Postgres ---



@pytest.fixture
async def maker():
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    engine = create_async_engine(os.environ["DATABASE_URL"])
    async with engine.connect() as conn:
        trans = await conn.begin()
        yield async_sessionmaker(bind=conn, expire_on_commit=False,
                                 join_transaction_mode="create_savepoint")
        await trans.rollback()
    await engine.dispose()


async def _user(s, profile: str) -> int:  # type: ignore[no-untyped-def]
    return await s.scalar(text(
        "INSERT INTO users (public_id, profile, language, tz) "
        "VALUES (gen_random_uuid(), :p, 'ru', 'Asia/Almaty') "
        "RETURNING id"),
        {"p": profile})  # fmt: skip


async def _usage(s, uid, provider, cost, at, *, task="chat", outcome="ok"):  # type: ignore[no-untyped-def]
    await s.execute(text("""
        INSERT INTO provider_usage (created_at, user_id, task, budget_class, provider, model,
            tokens_in, tokens_out, cached_in, cost_usd, latency_ms, outcome)
        VALUES (:at, :u, :t, 'answers', :p, 'claude-haiku-5-5', 2000, 200, 4000, :c, 800, :o)
    """), {"at": at, "u": uid, "t": task, "p": provider, "c": cost, "o": outcome})


@pytest.mark.db
@pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set")
async def test_report_and_alerts_against_postgres_fire_once(maker):
    s = make_settings()
    async with maker() as ss:
        await ss.execute(text("DELETE FROM ops_alerts"))
        fam = await _user(ss, "family_beta")
        reg = await _user(ss, "regular")
        for i in range(62):  # >60 steps today
            await _usage(ss, reg, "anthropic", "0.0008", NOW - timedelta(minutes=200 + i))
        await _usage(ss, fam, "anthropic", "0.06", NOW - timedelta(minutes=30))  # >$0.05
        # primary answered last 40 min ago; the fallback since 30 min, still now
        await _usage(ss, fam, "anthropic", "0.001", NOW - timedelta(minutes=40), task="enrich")
        await _usage(ss, fam, "openai", "0.002", NOW - timedelta(minutes=30), task="enrich")
        await _usage(ss, fam, "openai", "0.002", NOW - timedelta(minutes=2))
        day = datetime(2026, 11, 11, 19, 0, tzinfo=UTC)  # 12 Nov 00:00 Almaty
        await ss.execute(text("""
            INSERT INTO budgets (scope, key, class, period, period_start, spent_usd)
            VALUES ('user', :k, 'all', 'day', :d, 0.75), ('user', :r, 'all', 'day', :d, 0.06)
        """), {"k": str(fam), "r": str(reg), "d": day})  # fmt: skip
        await ss.execute(text("""
            INSERT INTO ai_provider_state (provider, state, reason, changed_at)
            VALUES ('google', 'off', 'quota', :t)
            ON CONFLICT (provider) DO UPDATE SET state = 'off', reason = 'quota', changed_at = :t
        """), {"t": NOW - timedelta(hours=1)})  # fmt: skip
        await ss.commit()

    reports = await build_report(maker, s, days=2, now=NOW)
    today = reports[-1]
    assert today.day == "2026-11-12" and today.total.steps == 64
    assert today.user_day_usd_max == 0.75
    assert today.by_profile["regular"].steps == 62
    assert today.total.fallback_share == round(1 / 64, 4)

    notifier = FakeNotifier()
    s2 = make_settings(ops_alert_chat_id=-100)
    first = await check_alerts(maker, s2, now=NOW, notifier=notifier)
    kinds = {a.kind for a in first}
    assert {"chat_steps", "chat_step_cost", "family_daily", "fallback_in_use",
            "provider_off"} <= kinds
    assert len(notifier.sent) == len(first) and all(m.chat_id == -100 for m in notifier.sent)
    again = await check_alerts(maker, s2, now=NOW + timedelta(minutes=5), notifier=notifier)
    assert {a.dedup_key for a in again} == {a.dedup_key for a in first}
    assert len(notifier.sent) == len(first)  # nothing is sent twice
    async with maker() as ss:
        hits = await ss.scalar(text("SELECT min(hits) FROM ops_alerts"))
        unsent = await ss.scalar(text("SELECT count(*) FROM ops_alerts WHERE sent_at IS NULL"))
        await ss.execute(text("DELETE FROM users WHERE id = :u"), {"u": reg})  # cascades
        left = await ss.scalar(text("SELECT count(*) FROM ops_alerts WHERE user_id = :u"),
                               {"u": reg})  # fmt: skip
    assert hits == 2 and unsent == 0 and left == 0
