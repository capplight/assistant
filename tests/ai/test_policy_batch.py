"""Strong-model rules, route validation, prompt cache settings, provider batches."""

from decimal import Decimal
from types import SimpleNamespace as NS

import pytest

from assistant.ai import (
    AIConsentRequired,
    BatchMode,
    BatchUnavailable,
    FakeAdapter,
    LLMTask,
    RouteTable,
    StaleBatchResult,
    StrongReason,
    StrongRequest,
    TaskInputs,
    UntrustedPart,
    load_routes,
)
from assistant.ai.adapters import AnthropicAdapter
from assistant.ai.adapters.base import strict_json_schema
from assistant.ai.policy import ALWAYS_STRONG, ESCALATION_RULES, strong_denial
from assistant.ai.types import AdapterRequest, Message, ProviderRequestError, ServerError, Usage
from tests.ai.conftest import ROUTES, Note, make_env, make_settings

LONG = "x" * 100
LOW = StrongRequest(StrongReason.LOW_CONFIDENCE, confidence=0.4)


def inputs(text: str = LONG) -> TaskInputs:
    return TaskInputs(system="sys", instruction="go", untrusted=[UntrustedPart("doc", text)],
                      prompt_version="t.v1")  # fmt: skip


def answer(**kw) -> dict:
    return {"title": "t", "phone": None, "confidence": 0.9, **kw}


# --- strong model


@pytest.mark.parametrize("task,req,chars,expected", [
    (LLMTask.ENRICH, LOW, 100, None),
    (LLMTask.ENRICH, StrongRequest(StrongReason.LOW_CONFIDENCE, confidence=0.6), 100,
     "confidence_not_low"),
    (LLMTask.ENRICH, StrongRequest(StrongReason.LOW_CONFIDENCE), 100, "confidence_not_low"),
    (LLMTask.ENRICH, LOW, 79, "input_too_short"),
    (LLMTask.ENRICH, StrongRequest(StrongReason.MANY_SOURCES, sources=9), 100,
     "reason_not_allowed"),
    (LLMTask.ANSWER, StrongRequest(StrongReason.MANY_SOURCES, sources=6), 1, None),
    (LLMTask.ANSWER, StrongRequest(StrongReason.MANY_SOURCES, sources=5), 1, "too_few_sources"),
    (LLMTask.ANSWER, LOW, 100, "reason_not_allowed"),
    (LLMTask.CHAT, StrongRequest(StrongReason.MULTI_STEP, steps=2), 1, None),
    (LLMTask.CHAT, StrongRequest(StrongReason.MULTI_STEP, steps=1), 1, "too_few_steps"),
    (LLMTask.CHAT, StrongRequest(StrongReason.LOW_TOOL_CONFIDENCE, confidence=0.3), 1, None),
    (LLMTask.DUP_JUDGE, LOW, 100, "reason_not_allowed"),
    (LLMTask.DRAFT, StrongRequest(StrongReason.MANY_SOURCES, sources=99), 1, "reason_not_allowed"),
])  # fmt: skip
def test_strong_rules(task, req, chars, expected):
    assert strong_denial(task, req, chars) == expected


def test_route_table_cannot_widen_the_rules():
    s = make_settings()

    def table(**task):
        return RouteTable({**ROUTES, "tasks": task}, s)

    with pytest.raises(ValueError, match="strong tier"):
        table(draft={"budget_class": "answers", "tier": "strong"})
    with pytest.raises(ValueError, match="no escalation rule"):
        table(draft={"budget_class": "answers", "escalate": "strong"})
    with pytest.raises(ValueError, match="documents budget"):
        table(kp_extract={"budget_class": "background", "tier": "strong"})
    with pytest.raises(ValueError, match="may not use batches"):
        table(answer={"budget_class": "answers", "batch": "always"})
    with pytest.raises(ValueError, match="may not use batches"):
        table(kp_extract={"budget_class": "documents", "tier": "strong", "batch": "always"})


def test_packaged_routes():
    t = load_routes(make_settings(model_fast="claude-haiku-5-5", model_strong="claude-sonnet-5-5"))
    assert {task for task in LLMTask if t.route(task).batch is not BatchMode.OFF} == {
        LLMTask.ENRICH, LLMTask.DUP_JUDGE, LLMTask.IMPORT_SUMMARIZE}  # fmt: skip
    assert t.route(LLMTask.ENRICH).batch is BatchMode.BULK
    for task in LLMTask:
        assert (t.route(task).tier.value == "strong") == (task in ALWAYS_STRONG)
        assert t.route(task).escalate is None or task in ESCALATION_RULES
    assert t.batch_multiplier("anthropic") == Decimal("0.5")
    assert t.batch_multiplier("openai") == Decimal(1)
    # Retired names stay out, and every routed model has a real price.
    for provider in ("anthropic", "openai", "google", "groq"):
        for tier in (t.route(LLMTask.ENRICH).tier, t.route(LLMTask.KP_EDIT).tier):
            model = t.model(provider, tier)
            assert model and t.has_price(model)
            assert "gemini-2.5" not in model and "llama" not in model


async def test_denied_escalation_runs_light_and_says_why():
    a = FakeAdapter("anthropic", [answer()])
    env = make_env({"anthropic": a})
    short = await env.router.run(LLMTask.ENRICH, Note, inputs("коротко"), user_id=1, strong=LOW)
    assert a.requests[-1].model == "claude-haiku-5-5"
    assert short.escalation_blocked and short.escalation_denied == "input_too_short"
    ok = await env.router.run(LLMTask.ENRICH, Note, inputs(), user_id=1, strong=LOW)
    assert a.requests[-1].model == "claude-sonnet-5-5" and ok.escalation_denied is None


async def test_daily_cap_on_escalations_ignores_documents():
    a = FakeAdapter("anthropic", [answer()])
    env = make_env({"anthropic": a}, settings=make_settings(ai_strong_daily_per_user=2))
    await env.router.run(LLMTask.KP_EXTRACT, Note, inputs(), user_id=1)  # strong, not an escalation
    for _ in range(2):
        res = await env.router.run(LLMTask.ENRICH, Note, inputs(), user_id=1, strong=LOW)
        assert res.escalation_denied is None
    res = await env.router.run(LLMTask.ENRICH, Note, inputs(), user_id=1, strong=LOW)
    assert res.escalation_denied == "daily_cap" and a.requests[-1].model == "claude-haiku-5-5"
    assert await env.router.escalation_denial(LLMTask.ENRICH, LOW, inputs(), 1) == "daily_cap"


# --- prompt cache


def _req(**kw) -> AdapterRequest:
    return AdapterRequest(model="m", system="sys", messages=(Message("user", "hi"),),
                          schema_name="S", json_schema=strict_json_schema(Note), **kw)  # fmt: skip


def test_anthropic_cache_ttl_comes_from_the_request():
    a = AnthropicAdapter(client=object())
    assert a.request_kwargs(_req())["system"][0]["cache_control"] == {"type": "ephemeral"}
    long = a.request_kwargs(_req(cache_ttl="1h"))["system"][0]["cache_control"]
    assert long == {"type": "ephemeral", "ttl": "1h"}
    assert "cache_control" not in a.request_kwargs(_req(cache_ttl=None))["system"][0]


async def test_route_cache_setting_reaches_the_adapter():
    raw = {**ROUTES, "tasks": {"dup_judge": {"budget_class": "background", "cache": "off"}}}
    a = FakeAdapter("anthropic", [answer()])
    env = make_env({"anthropic": a})
    env.router.routes = RouteTable(raw, env.settings)
    await env.router.run(LLMTask.DUP_JUDGE, Note, inputs(), user_id=1)
    assert a.requests[-1].cache_ttl is None


def test_cost_with_long_cache_writes_and_batch_price():
    table = RouteTable(ROUTES, make_settings())
    price = table.price("claude-haiku-5-5")  # the test table: in 1.0, default 1h write = 2 x in
    usage = Usage(tokens_in=1_000_000, cache_write_1h_in=1_000_000)
    assert price.cost(usage) == Decimal("3.000000")
    assert price.cost(usage, Decimal("0.5")) == Decimal("1.500000")


# --- Anthropic batches, against a fake SDK client (UNVERIFIED against the live API)


class _Batches:
    def __init__(self, rows):
        self.rows = rows
        self.created = None

    async def create(self, *, requests):
        self.created = requests
        return NS(id="msgbatch_1")

    async def retrieve(self, batch_id):
        return NS(processing_status="ended")

    async def results(self, batch_id):
        rows = self.rows

        async def gen():
            for r in rows:
                yield r

        return gen()

    async def cancel(self, batch_id):
        self.cancelled = batch_id


def _message(text='{"title": "x"}', stop="end_turn"):
    return NS(stop_reason=stop, model="m", content=[NS(type="text", text=text)],
              usage=NS(input_tokens=10, output_tokens=5, cache_read_input_tokens=4,
                       cache_creation_input_tokens=7,
                       cache_creation=NS(ephemeral_1h_input_tokens=7)))  # fmt: skip


async def test_anthropic_batch_shapes_and_results():
    rows = [
        NS(custom_id="r1", result=NS(type="succeeded", message=_message())),
        NS(custom_id="r2", result=NS(type="succeeded", message=_message(stop="refusal"))),
        NS(custom_id="r3", result=NS(type="expired")),
        NS(custom_id="r4", result=NS(type="canceled")),
        NS(custom_id="r5", result=NS(type="errored", error=NS(
            error=NS(type="invalid_request_error")))),
        NS(custom_id="r6", result=NS(type="errored", error=NS(error=NS(type="api_error")))),
    ]  # fmt: skip
    batches = _Batches(rows)
    a = AnthropicAdapter(client=NS(messages=NS(batches=batches)))
    assert a.supports_batch
    assert await a.submit_batch([("r1", _req(cache_ttl="1h"))]) == "msgbatch_1"
    sent = batches.created[0]
    assert sent["custom_id"] == "r1" and "timeout" not in sent["params"]
    assert sent["params"]["system"][0]["cache_control"]["ttl"] == "1h"
    assert await a.batch_ended("msgbatch_1")
    out = {e.custom_id: e for e in await a.batch_results("msgbatch_1")}
    good = out["r1"].response
    assert good.text == '{"title": "x"}'
    assert good.usage.cache_write_1h_in == 7 and good.usage.cache_write_in == 0
    assert out["r2"].error is not None and out["r2"].error.usage is not None
    assert isinstance(out["r3"].error, ServerError) and isinstance(out["r4"].error, ServerError)
    assert isinstance(out["r5"].error, ProviderRequestError)
    assert isinstance(out["r6"].error, ServerError)


# --- prepare_batch / finish_batch


def batch_env(**kw):
    raw = {**ROUTES, "batch_discount": {"anthropic": 0.5},
           "tasks": {**ROUTES["tasks"],
                     "dup_judge": {"budget_class": "background", "batch": "always"}}}
    a = FakeAdapter("anthropic", [answer()], supports_batch=True,
                    usage=Usage(tokens_in=1_000_000, tokens_out=0))  # fmt: skip
    env = make_env({"anthropic": a}, **kw)
    env.router.routes = RouteTable(raw, env.settings)
    return env, a


async def test_batch_consent_is_checked_before_sending():
    env, a = batch_env(consent=None)
    with pytest.raises(AIConsentRequired):
        await env.router.prepare_batch(LLMTask.DUP_JUDGE, Note, inputs(), user_id=1)
    assert a.calls == 0


async def test_batch_off_or_no_support_means_live():
    env, a = batch_env()
    with pytest.raises(BatchUnavailable):
        await env.router.prepare_batch(LLMTask.ANSWER, Note, inputs(), user_id=1)
    a.supports_batch = False
    assert not env.router.batching_available(LLMTask.DUP_JUDGE)
    with pytest.raises(BatchUnavailable):
        await env.router.prepare_batch(LLMTask.DUP_JUDGE, Note, inputs(), user_id=1)


async def test_batch_needs_the_primary_first_in_line():
    env, _ = batch_env()
    await env.store.set_provider_off("anthropic", "quota")
    with pytest.raises(BatchUnavailable):
        await env.router.prepare_batch(LLMTask.DUP_JUDGE, Note, inputs(), user_id=1)


BIN = "900101300126"  # a valid check digit


async def test_batch_round_trip_half_price_and_mask_rebuilt():
    env, a = batch_env()
    text = f"{LONG} БИН {BIN}"
    p = await env.router.prepare_batch(LLMTask.DUP_JUDGE, Note, inputs(text), user_id=1)
    assert p.request.cache_ttl == "1h" and p.request.on_token is None
    sent = p.request.messages[0].text
    assert BIN not in sent and "⟨BIN_1⟩" in sent
    a.steps = [answer(title="⟨BIN_1⟩")]
    resp = await a.generate(p.request)
    res = await env.router.finish_batch(LLMTask.DUP_JUDGE, Note, inputs(text), user_id=1,
                                        provider=p.provider, model=p.model,
                                        payload_sha256=p.payload_sha256, response=resp)  # fmt: skip
    assert res.data is not None and res.data.title == BIN
    # The test table: Haiku at $1 per 1M in; half price.
    assert res.cost_usd == Decimal("0.500000")
    row = env.store.usage[-1]
    assert row.batch and row.cost_usd == Decimal("0.500000") and row.outcome == "ok"


async def test_batch_answer_is_paid_but_dropped_when_stale_or_consent_gone():
    env, a = batch_env()
    p = await env.router.prepare_batch(LLMTask.DUP_JUDGE, Note, inputs(), user_id=1)
    resp = await a.generate(p.request)
    kw = dict(user_id=1, provider=p.provider, model=p.model, payload_sha256=p.payload_sha256,
              response=resp)  # fmt: skip
    with pytest.raises(StaleBatchResult):
        await env.router.finish_batch(LLMTask.DUP_JUDGE, Note, inputs("другой текст"), **kw)
    env.store.consents[1] = None
    with pytest.raises(AIConsentRequired):
        await env.router.finish_batch(LLMTask.DUP_JUDGE, Note, inputs(), **kw)
    assert [r.outcome for r in env.store.usage if r.batch] == ["ok", "ok"]
