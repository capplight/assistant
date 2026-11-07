"""Route table (packaged routes.yaml), prices, circuit breaker states."""

from decimal import Decimal

from assistant.ai import BreakerState, CircuitBreaker, LLMTask, load_routes
from assistant.ai.types import BudgetClass, Tier, Usage
from tests.ai.conftest import Clock, make_settings


def test_packaged_routes_cover_every_task():
    s = make_settings(model_fast="claude-haiku-5-5", model_strong="claude-sonnet-5-5")
    table = load_routes(s)
    for task in LLMTask:
        route = table.route(task)
        assert route.chain, task
        for provider in route.chain:
            for tier in (route.tier, route.escalate or route.tier):
                model = table.model(provider, tier)
                assert model and table.has_price(model), (task, provider, tier)
    assert table.model("anthropic", Tier.LIGHT) == "claude-haiku-5-5"
    assert table.model("anthropic", Tier.STRONG) == "claude-sonnet-5-5"


def test_route_rules_from_spec():
    table = load_routes(make_settings(ai_fallback_provider="google"))
    for task in (LLMTask.KP_EXTRACT, LLMTask.KP_EDIT, LLMTask.PROFILE_EXTRACT,
                 LLMTask.PRICE_LIST_EXTRACT):  # fmt: skip
        r = table.route(task)
        assert r.budget_class is BudgetClass.DOCUMENTS and r.tier is Tier.STRONG
    assert table.route(LLMTask.ENRICH).chain == ("anthropic", "google")  # fallback from settings
    assert table.route(LLMTask.ENRICH).mask_contacts is False
    assert table.route(LLMTask.DUP_JUDGE).mask_contacts is True
    assert table.route(LLMTask.VISION_OCR).chain == ("google", "anthropic")
    assert table.route(LLMTask.IMPORT_SUMMARIZE).budget_class is BudgetClass.IMPORT
    assert table.route(LLMTask.ANSWER).timeout_s == 8


def test_price_cost():
    table = load_routes(make_settings())
    usage = Usage(tokens_in=1_000_000, tokens_out=100_000, cached_in=500_000,
                  cache_write_in=200_000)  # fmt: skip
    # sonnet 5.5: 2.00 + 1.00 + 0.10 + 0.50
    assert table.price("claude-sonnet-5-5").cost(usage) == Decimal("3.600000")
    assert table.price("no-such-model") == table.price("default")


def test_breaker_opens_after_5_errors_in_window_then_half_open():
    clock = Clock()
    b = CircuitBreaker(failures=5, window_s=60, open_s=120, clock=clock)
    for _ in range(4):
        assert b.record_failure("anthropic", "m") is False
    assert b.state("anthropic", "m") is BreakerState.CLOSED
    assert b.record_failure("anthropic", "m") is True  # 5th: transition
    assert b.state("anthropic", "m") is BreakerState.OPEN and not b.allow("anthropic", "m")
    assert b.allow("anthropic", "other-model")  # per (provider, model)

    clock.t += 119
    assert not b.allow("anthropic", "m")
    clock.t += 1
    assert b.state("anthropic", "m") is BreakerState.HALF_OPEN
    assert b.allow("anthropic", "m") is True  # one trial
    assert b.allow("anthropic", "m") is False  # second concurrent call waits
    assert b.record_failure("anthropic", "m") is True  # trial failed -> open again
    assert b.state("anthropic", "m") is BreakerState.OPEN

    clock.t += 120
    assert b.allow("anthropic", "m")
    b.record_success("anthropic", "m")
    assert b.state("anthropic", "m") is BreakerState.CLOSED


def test_breaker_window_slides():
    clock = Clock()
    b = CircuitBreaker(failures=5, window_s=60, open_s=120, clock=clock)
    for _ in range(4):
        b.record_failure("p", "m")
    clock.t += 61
    assert b.record_failure("p", "m") is False  # old errors expired
    assert b.state("p", "m") is BreakerState.CLOSED
