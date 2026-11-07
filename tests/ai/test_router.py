"""Router with fake adapters: routing, every fallback trigger, breaker, consent, masking,
streaming, tool calls, cost accounting."""

import asyncio
from decimal import Decimal

import pytest

from assistant.ai import (
    AIConsentRequired,
    AIUnavailable,
    BudgetExceeded,
    FakeAdapter,
    LLMTask,
    Outcome,
    StreamInterrupted,
    TaskInputs,
    ToolCall,
    ToolSpec,
    UntrustedPart,
)
from assistant.ai.policy import StrongReason, StrongRequest
from assistant.ai.types import (
    BadOutput,
    BudgetClass,
    ProviderTimeout,
    QuotaExceeded,
    RateLimited,
    Refused,
    ServerError,
    Usage,
)
from tests.ai.conftest import Note, make_env, make_settings

IIN = "900101300126"


def inputs(text: str = "Кафе Жания, тел +7 701 123 45 67") -> TaskInputs:
    return TaskInputs(system="Extract a note.", instruction="Fill the schema.",
                      untrusted=[UntrustedPart("message", text)], prompt_version="test.v1")


def ok(title: str = "ok", **kw) -> Note:
    return Note(title=title, **kw)


def outcomes(env) -> list[tuple[str, str]]:
    return [(r.provider, r.outcome) for r in env.store.usage]


async def test_routes_to_light_model_of_primary_and_accounts_cost():
    a = FakeAdapter("anthropic", [ok()], usage=Usage(tokens_in=1000, tokens_out=200,
                                                     cached_in=500))  # fmt: skip
    env = make_env({"anthropic": a, "openai": FakeAdapter("openai", [ok()])})
    res = await env.router.run(LLMTask.DUP_JUDGE, Note, inputs(), user_id=1)
    assert res.data == ok() and res.provider == "anthropic" and res.ai_generated
    assert a.requests[0].model == "claude-haiku-5-5" and a.requests[0].effort == "low"
    # 1000*1.0 + 200*5.0 + 500*0.1 per 1M
    assert res.cost_usd == Decimal("0.002050")
    [row] = env.store.usage
    assert (row.provider, row.model, row.outcome, row.task) == (
        "anthropic", "claude-haiku-5-5", "ok", "dup_judge")
    assert row.cost_usd == Decimal("0.002050") and row.prompt_version == "test.v1"
    assert row.cached_in == 500 and row.user_id == 1 and row.budget_class == "background"
    spent = {(k.scope, k.cls, k.period): v for k, v in env.store.budgets.items()}
    assert spent[("provider", "all", "month")] == Decimal("0.002050")
    assert spent[("user", "background", "day")] == Decimal("0.002050")
    assert spent[("user", "all", "month")] == Decimal("0.002050")


MANY = StrongRequest(StrongReason.MANY_SOURCES, sources=9)


async def test_strong_escalation_and_block_at_80_percent():
    a = FakeAdapter("anthropic", [ok()])
    env = make_env({"anthropic": a})
    res = await env.router.run(LLMTask.ANSWER, Note, inputs(), user_id=1, strong=MANY)
    assert a.requests[-1].model == "claude-sonnet-5-5" and not res.escalation_blocked
    await env.router.budget.charge_user(1, "regular", BudgetClass.ANSWERS, Decimal("2.5"),
                                        env.now[0])
    res = await env.router.run(LLMTask.ANSWER, Note, inputs(), user_id=1, strong=MANY)
    assert a.requests[-1].model == "claude-haiku-5-5" and res.escalation_blocked
    assert res.budget_warning


async def test_documents_task_uses_strong_tier():
    a = FakeAdapter("anthropic", [ok()])
    env = make_env({"anthropic": a})
    await env.router.run(LLMTask.KP_EXTRACT, Note, inputs(), user_id=1)
    assert a.requests[0].model == "claude-sonnet-5-5"


@pytest.mark.parametrize("error,outcome", [
    (ServerError("http 503"), "server_error"),
    (RateLimited("429", retry_after=30), "rate_limited"),
    (RateLimited("429", retry_after=None), "rate_limited"),
    (Refused("refusal"), "refused"),
    (BadOutput("max_tokens"), "invalid_output"),
])  # fmt: skip
async def test_fallback_triggers(error, outcome):
    a = FakeAdapter("anthropic", [error])
    o = FakeAdapter("openai", [ok("from openai")])
    env = make_env({"anthropic": a, "openai": o})
    res = await env.router.run(LLMTask.DUP_JUDGE, Note, inputs(), user_id=1)
    assert res.provider == "openai" and res.fallback_from == "anthropic"
    assert res.data.title == "from openai" and o.requests[0].model == "gpt-5-mini"
    assert outcomes(env) == [("anthropic", outcome), ("openai", "ok")]
    assert env.store.usage[1].fallback_from == "anthropic"
    assert env.sleeps == []


async def test_timeout_falls_back():
    class Slow(FakeAdapter):
        async def generate(self, req):
            self.requests.append(req)
            await asyncio.sleep(1)
            raise AssertionError("not reached")

    env = make_env({"anthropic": Slow("anthropic"), "openai": FakeAdapter("openai", [ok()])})
    res = await env.router.run(LLMTask.DUP_JUDGE, Note, inputs(), user_id=1)
    assert res.provider == "openai"
    assert outcomes(env) == [("anthropic", "timeout"), ("openai", "ok")]


async def test_short_retry_after_waits_and_retries_same_provider_once():
    a = FakeAdapter("anthropic", [RateLimited("429", retry_after=1.0), ok("second try")])
    env = make_env({"anthropic": a, "openai": FakeAdapter("openai", [ok()])})
    res = await env.router.run(LLMTask.DUP_JUDGE, Note, inputs(), user_id=1)
    assert res.provider == "anthropic" and res.data.title == "second try"
    assert env.sleeps == [1.0] and res.attempts == 2
    assert outcomes(env) == [("anthropic", "rate_limited"), ("anthropic", "ok")]


async def test_quota_turns_provider_off_until_manual_reset():
    a = FakeAdapter("anthropic", [QuotaExceeded("402"), ok("back")])
    o = FakeAdapter("openai", [ok("fallback")])
    env = make_env({"anthropic": a, "openai": o})
    res = await env.router.run(LLMTask.DUP_JUDGE, Note, inputs(), user_id=1)
    assert res.provider == "openai"
    assert env.store.off == {"anthropic": "quota"}
    assert any("quota" in x for x in env.alerts)
    await env.router.run(LLMTask.DUP_JUDGE, Note, inputs(), user_id=1)
    assert a.calls == 1  # skipped while off
    await env.store.clear_provider_off("anthropic")
    res = await env.router.run(LLMTask.DUP_JUDGE, Note, inputs(), user_id=1)
    assert res.provider == "anthropic" and res.data.title == "back"


async def test_invalid_output_gets_one_repair_on_same_provider():
    a = FakeAdapter("anthropic", ['{"title": 5', ok("repaired")])
    env = make_env({"anthropic": a, "openai": FakeAdapter("openai", [ok()])})
    res = await env.router.run(LLMTask.DUP_JUDGE, Note, inputs(), user_id=1)
    assert res.provider == "anthropic" and res.data.title == "repaired"
    repair = a.requests[1].messages
    assert [m.role for m in repair] == ["user", "assistant", "user"]
    assert "did not match" in repair[-1].text
    assert outcomes(env) == [("anthropic", "invalid_output"), ("anthropic", "ok")]
    # the failed attempt still cost money and was charged
    assert env.store.usage[0].cost_usd > 0


async def test_invalid_twice_moves_to_next_provider():
    a = FakeAdapter("anthropic", ['{"nope": 1}'])
    o = FakeAdapter("openai", [ok("openai")])
    env = make_env({"anthropic": a, "openai": o})
    res = await env.router.run(LLMTask.DUP_JUDGE, Note, inputs(), user_id=1)
    assert a.calls == 2 and res.provider == "openai"


async def test_all_refuse_raises_unavailable_with_refused():
    env = make_env({"anthropic": FakeAdapter("anthropic", [Refused("r")]),
                    "openai": FakeAdapter("openai", [Refused("r")])})  # fmt: skip
    with pytest.raises(AIUnavailable) as e:
        await env.router.run(LLMTask.DUP_JUDGE, Note, inputs(), user_id=1)
    assert e.value.last_outcome is Outcome.REFUSED


async def test_circuit_opens_after_5_errors_and_is_recorded():
    a = FakeAdapter("anthropic", [ServerError("503")])
    o = FakeAdapter("openai", [ok()])
    env = make_env({"anthropic": a, "openai": o})
    for _ in range(5):
        await env.router.run(LLMTask.DUP_JUDGE, Note, inputs(), user_id=1)
    assert ("anthropic", "circuit_open") in outcomes(env)
    await env.router.run(LLMTask.DUP_JUDGE, Note, inputs(), user_id=1)
    assert a.calls == 5  # open: skipped
    env.mono.t += 120  # half-open: one trial, success closes
    a.steps = [ok("healthy")]
    res = await env.router.run(LLMTask.DUP_JUDGE, Note, inputs(), user_id=1)
    assert res.provider == "anthropic" and a.calls == 6


async def test_no_consent_refuses_before_any_call():
    a = FakeAdapter("anthropic", [ok()])
    env = make_env({"anthropic": a}, consent=None)
    with pytest.raises(AIConsentRequired):
        await env.router.run(LLMTask.DUP_JUDGE, Note, inputs(), user_id=1)
    assert a.calls == 0 and outcomes(env) == [("anthropic", "consent_blocked")]


async def test_consent_provider_list_filters_route():
    a = FakeAdapter("anthropic", [ok()])
    o = FakeAdapter("openai", [ok("openai")])
    env = make_env({"anthropic": a, "openai": o}, consent=frozenset({"openai"}))
    res = await env.router.run(LLMTask.DUP_JUDGE, Note, inputs(), user_id=1)
    assert res.provider == "openai" and a.calls == 0
    env2 = make_env({"anthropic": a}, consent=frozenset({"groq"}))
    with pytest.raises(AIConsentRequired):
        await env2.router.run(LLMTask.DUP_JUDGE, Note, inputs(), user_id=1)


async def test_no_user_requires_explicit_no_personal_data():
    env = make_env({"anthropic": FakeAdapter("anthropic", [ok()])}, user_id=None)
    with pytest.raises(AIConsentRequired):
        await env.router.run(LLMTask.DUP_JUDGE, Note, inputs(), user_id=None)
    res = await env.router.run(LLMTask.DUP_JUDGE, Note, inputs(), user_id=None,
                               no_personal_data=True)  # fmt: skip
    assert res.provider == "anthropic" and env.store.budgets  # provider still charged


async def test_budget_block_is_recorded_and_raised():
    a = FakeAdapter("anthropic", [ok()])
    env = make_env({"anthropic": a})
    await env.router.budget.charge_user(1, "regular", BudgetClass.BACKGROUND, Decimal("0.1"),
                                        env.now[0])  # fmt: skip
    with pytest.raises(BudgetExceeded):
        await env.router.run(LLMTask.DUP_JUDGE, Note, inputs(), user_id=1)
    assert a.calls == 0 and outcomes(env) == [("anthropic", "budget_blocked")]
    assert env.store.usage[0].error_kind == "daily_soft"


async def test_pii_masked_in_request_and_restored_in_result():
    def echo(req):
        text = req.messages[0].text
        assert IIN not in text and "701 123 45 67" not in text
        return Note(title="client ⟨BIN_1⟩", phone="⟨PHONE_1⟩")

    a = FakeAdapter("anthropic", [echo])
    env = make_env({"anthropic": a})
    res = await env.router.run(LLMTask.DUP_JUDGE, Note,
                               inputs(f"ИИН {IIN}, тел +7 701 123 45 67"), user_id=1)
    assert res.data.title == f"client {IIN}" and res.data.phone == "+7 701 123 45 67"
    assert "<untrusted_data>" in a.requests[0].messages[0].text


async def test_enrich_keeps_phones_visible():
    a = FakeAdapter("anthropic", [ok()])
    env = make_env({"anthropic": a})
    await env.router.run(LLMTask.ENRICH, Note, inputs("тел +7 701 123 45 67"), user_id=1)
    assert "+7 701 123 45 67" in a.requests[0].messages[0].text


async def test_stream_tokens_forwarded_unmasked():
    got: list[str] = []

    async def hook(delta: str) -> None:
        got.append(delta)

    a = FakeAdapter("anthropic", [Note(title="⟨PHONE_1⟩")], stream_chunks=7)
    env = make_env({"anthropic": a})
    res = await env.router.run(LLMTask.ANSWER, Note, inputs("+7 701 123 45 67"), user_id=1,
                               stream=hook)  # fmt: skip
    assert "".join(got) == res.data.model_dump_json()
    assert "+7 701 123 45 67" in "".join(got)


async def test_stream_switches_before_first_token_only():
    async def hook(delta: str) -> None:
        pass

    env = make_env({"anthropic": FakeAdapter("anthropic", [ServerError("503")]),
                    "openai": FakeAdapter("openai", [ok("o")])})  # fmt: skip
    res = await env.router.run(LLMTask.ANSWER, Note, inputs(), user_id=1, stream=hook)
    assert res.provider == "openai"

    class DiesMidStream(FakeAdapter):
        async def generate(self, req):
            self.requests.append(req)
            await req.on_token('{"title": "par')
            raise ServerError("connection reset")

    o = FakeAdapter("openai", [ok()])
    env = make_env({"anthropic": DiesMidStream("anthropic"), "openai": o})
    with pytest.raises(StreamInterrupted):
        await env.router.run(LLMTask.ANSWER, Note, inputs(), user_id=1, stream=hook)
    assert o.calls == 0


async def test_stream_first_token_timeout_falls_back():
    async def hook(delta: str) -> None:
        pass

    class NeverStarts(FakeAdapter):
        async def generate(self, req):
            self.requests.append(req)
            await asyncio.sleep(5)

    env = make_env({"anthropic": NeverStarts("anthropic"), "openai": FakeAdapter("openai",
                                                                                [ok()])})
    res = await env.router.run(LLMTask.ANSWER, Note, inputs(), user_id=1, stream=hook)
    assert res.provider == "openai"
    assert outcomes(env)[0] == ("anthropic", "timeout")


async def test_tool_calls_are_returned_unmasked():
    tool = ToolSpec("set_reminder", "Create a reminder",
                    {"type": "object", "properties": {"phone": {"type": "string"}}})
    a = FakeAdapter("anthropic", [[ToolCall("c1", "set_reminder", {"phone": "⟨PHONE_1⟩"})]])
    env = make_env({"anthropic": a})
    res = await env.router.run(LLMTask.CHAT, Note, inputs("позвонить +7 701 123 45 67"),
                               user_id=1, tools=[tool])  # fmt: skip
    assert res.data is None and a.requests[0].tools == (tool,)
    assert res.tool_calls == [ToolCall("c1", "set_reminder", {"phone": "+7 701 123 45 67"})]


async def test_provider_without_adapter_is_skipped_and_none_left_is_unavailable():
    env = make_env({"openai": FakeAdapter("openai", [ok()])})  # no anthropic key
    res = await env.router.run(LLMTask.DUP_JUDGE, Note, inputs(), user_id=1)
    assert res.provider == "openai" and res.fallback_from is None
    env = make_env({})
    with pytest.raises(AIUnavailable):
        await env.router.run(LLMTask.DUP_JUDGE, Note, inputs(), user_id=1)


async def test_fallback_serving_over_10_minutes_alerts_once():
    env = make_env({"anthropic": FakeAdapter("anthropic", [ServerError("503")]),
                    "openai": FakeAdapter("openai", [ok()])},
                   settings=make_settings(ai_breaker_failures=1000))  # fmt: skip
    await env.router.run(LLMTask.DUP_JUDGE, Note, inputs(), user_id=1)
    env.mono.t += 601
    await env.router.run(LLMTask.DUP_JUDGE, Note, inputs(), user_id=1)
    env.mono.t += 601
    await env.router.run(LLMTask.DUP_JUDGE, Note, inputs(), user_id=1)
    assert sum("fallback provider" in x for x in env.alerts) == 1


async def test_vision_ocr_prefers_google():
    g = FakeAdapter("google", [ok()])
    env = make_env({"anthropic": FakeAdapter("anthropic", [ok()]), "google": g})
    res = await env.router.run(LLMTask.VISION_OCR, Note, inputs(), user_id=1)
    assert res.provider == "google" and g.requests[0].model == "gemini-2.5-flash"


async def test_timeout_error_class_is_provider_timeout():
    env = make_env({"anthropic": FakeAdapter("anthropic", [ProviderTimeout("t")]),
                    "openai": FakeAdapter("openai", [ok()])})  # fmt: skip
    res = await env.router.run(LLMTask.DUP_JUDGE, Note, inputs(), user_id=1)
    assert res.provider == "openai"


async def test_half_open_trial_with_client_error_does_not_block_provider_forever():
    from assistant.ai.types import ProviderRequestError

    a = FakeAdapter("anthropic", [ServerError("503")])
    env = make_env({"anthropic": a, "openai": FakeAdapter("openai", [ok()])})
    for _ in range(5):
        await env.router.run(LLMTask.DUP_JUDGE, Note, inputs(), user_id=1)
    env.mono.t += 120
    a.steps = [ProviderRequestError("http 400")]
    await env.router.run(LLMTask.DUP_JUDGE, Note, inputs(), user_id=1)  # trial, no verdict
    a.steps = [ok("again")]
    res = await env.router.run(LLMTask.DUP_JUDGE, Note, inputs(), user_id=1)
    assert res.provider == "anthropic" and res.data.title == "again"
