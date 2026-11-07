"""Budget transitions per profile and per provider (spec 5.3/5.4, 02-resolutions 2.2)."""

from datetime import timedelta
from decimal import Decimal

import pytest

from assistant.ai import BudgetClass, BudgetExceeded, MemoryAIStore
from assistant.ai.budget import BudgetPolicy
from tests.ai.conftest import NOW, make_settings

D = Decimal


def policy(**kw):
    alerts: list[str] = []
    store = MemoryAIStore()
    return BudgetPolicy(make_settings(**kw), store, alert=alerts.append), store, alerts


async def test_regular_background_daily_soft_limit_resets_next_day():
    p, _, _ = policy()
    await p.check_user(1, "regular", BudgetClass.BACKGROUND, NOW)
    await p.charge_user(1, "regular", BudgetClass.BACKGROUND, D("0.10"), NOW)
    with pytest.raises(BudgetExceeded) as e:
        await p.check_user(1, "regular", BudgetClass.BACKGROUND, NOW)
    assert e.value.reason == "daily_soft"
    # answers are not hit by the daily soft cap
    await p.check_user(1, "regular", BudgetClass.ANSWERS, NOW)
    await p.check_user(1, "regular", BudgetClass.BACKGROUND, NOW + timedelta(days=1))


async def test_day_boundary_is_almaty_midnight():
    p, _, _ = policy()
    late = NOW.replace(hour=18, minute=59)  # 23:59 Almaty
    await p.charge_user(1, "regular", BudgetClass.BACKGROUND, D("0.10"), late)
    with pytest.raises(BudgetExceeded):
        await p.check_user(1, "regular", BudgetClass.BACKGROUND, late)
    await p.check_user(1, "regular", BudgetClass.BACKGROUND, late + timedelta(minutes=2))


async def test_regular_monthly_hard_and_escalation_cutoff():
    p, _, _ = policy()
    await p.charge_user(1, "regular", BudgetClass.ANSWERS, D("2.39"), NOW)
    d = await p.check_user(1, "regular", BudgetClass.ANSWERS, NOW)
    assert d.escalation_allowed and not d.warning
    await p.charge_user(1, "regular", BudgetClass.DOCUMENTS, D("0.01"), NOW)  # 2.40 = 80%
    d = await p.check_user(1, "regular", BudgetClass.ANSWERS, NOW)
    assert not d.escalation_allowed and d.warning
    await p.charge_user(1, "regular", BudgetClass.ANSWERS, D("0.60"), NOW)  # 3.00
    for cls in (BudgetClass.ANSWERS, BudgetClass.DOCUMENTS, BudgetClass.BACKGROUND):
        with pytest.raises(BudgetExceeded) as e:
            await p.check_user(1, "regular", cls, NOW)
        assert e.value.reason == "monthly_hard"
    # a started document task is not cut off
    await p.check_user(1, "regular", BudgetClass.DOCUMENTS, NOW, continuing=True)
    # next month: fresh wallet
    await p.check_user(1, "regular", BudgetClass.ANSWERS, NOW.replace(month=12, day=2))


async def test_work_documents_are_a_separate_wallet():
    p, _, _ = policy(budget_work_documents_monthly_usd=5.0)
    await p.charge_user(1, "work", BudgetClass.ANSWERS, D("8.00"), NOW)
    with pytest.raises(BudgetExceeded):
        await p.check_user(1, "work", BudgetClass.ANSWERS, NOW)
    # documents still fine: own wallet, no daily threshold
    await p.charge_user(1, "work", BudgetClass.DOCUMENTS, D("3.00"), NOW)
    d = await p.check_user(1, "work", BudgetClass.DOCUMENTS, NOW)
    assert d.escalation_allowed
    await p.charge_user(1, "work", BudgetClass.DOCUMENTS, D("2.00"), NOW)
    with pytest.raises(BudgetExceeded) as e:
        await p.check_user(1, "work", BudgetClass.DOCUMENTS, NOW)
    assert e.value.reason == "documents_monthly"
    await p.check_user(1, "work", BudgetClass.DOCUMENTS, NOW, continuing=True)


async def test_family_beta_unlimited_with_daily_alert_once():
    p, _, alerts = policy()
    for _ in range(3):
        await p.charge_user(7, "family_beta", BudgetClass.BACKGROUND, D("0.30"), NOW)
        d = await p.check_user(7, "family_beta", BudgetClass.BACKGROUND, NOW)
        assert d.escalation_allowed
    assert len(alerts) == 1 and "user 7" in alerts[0]


async def test_import_once():
    p, _, _ = policy()
    await p.charge_user(1, "regular", BudgetClass.IMPORT, D("1.00"), NOW)
    with pytest.raises(BudgetExceeded) as e:
        await p.check_user(1, "regular", BudgetClass.IMPORT, NOW + timedelta(days=60))
    assert e.value.reason == "import_once"
    # import spend does not eat the monthly wallet
    await p.check_user(1, "regular", BudgetClass.ANSWERS, NOW)


async def test_provider_80_percent_moves_to_end_100_percent_off_until_next_month():
    p, _, alerts = policy(ai_provider_monthly_usd={"anthropic": 100.0, "openai": 100.0})
    plan = await p.provider_plan(["anthropic", "openai"], NOW)
    assert plan.order == ["anthropic", "openai"]
    await p.charge_provider("anthropic", D("80"), NOW)
    assert any("80%" in a for a in alerts)
    plan = await p.provider_plan(["anthropic", "openai"], NOW)
    assert plan.order == ["openai", "anthropic"]
    await p.charge_provider("anthropic", D("20"), NOW)
    plan = await p.provider_plan(["anthropic", "openai"], NOW)
    assert plan.order == ["openai"] and plan.excluded == {"anthropic": "monthly_budget"}
    plan = await p.provider_plan(["anthropic", "openai"], NOW.replace(month=12, day=1, hour=0))
    assert plan.order == ["anthropic", "openai"]


async def test_fallback_cap_share_of_primary_and_emergency_daily():
    p, _, alerts = policy(ai_fallback_emergency_daily_usd=15.0)
    assert p.provider_monthly_limit("openai") == D("50.0")  # 0.5 x primary 100
    await p.charge_provider("openai", D("15"), NOW)
    assert any("emergency" in a for a in alerts)
    plan = await p.provider_plan(["anthropic", "openai"], NOW)
    assert plan.excluded == {"openai": "fallback_daily"}
    plan = await p.provider_plan(["anthropic", "openai"], NOW + timedelta(days=1))
    assert plan.order == ["anthropic", "openai"]


async def test_disabled_and_manually_off_providers_are_excluded():
    p, store, _ = policy(ai_providers_enabled=["anthropic", "openai"])
    await store.set_provider_off("openai", "quota")
    plan = await p.provider_plan(["anthropic", "openai", "google"], NOW)
    assert plan.order == ["anthropic"]
    assert plan.excluded == {"openai": "off:quota", "google": "disabled"}
    await store.clear_provider_off("openai")
    assert (await p.provider_plan(["openai"], NOW)).order == ["openai"]
