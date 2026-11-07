"""Adapters against stub SDK clients (no network): request shape, response and error mapping.

These prove our mapping logic only; the real wire formats are unverified until keys exist.
"""

import json
from types import SimpleNamespace as NS

import pytest
from pydantic import BaseModel

from assistant.ai.adapters import AnthropicAdapter, GroqAdapter, OpenAIAdapter, build_adapters
from assistant.ai.adapters.base import strict_json_schema
from assistant.ai.adapters.gemini_adapter import _to_response as gemini_response
from assistant.ai.adapters.openai_adapter import _chat_to_result, _responses_to_result
from assistant.ai.types import (
    AdapterRequest,
    BadOutput,
    ImagePart,
    Message,
    ProviderTimeout,
    QuotaExceeded,
    RateLimited,
    Refused,
    ServerError,
    ToolSpec,
)
from tests.ai.conftest import make_settings


class Inner(BaseModel):
    name: str
    qty: int | None = None


class Outer(BaseModel):
    title: str
    items: list[Inner] = []


SCHEMA = strict_json_schema(Outer)
TOOL = ToolSpec("lookup", "Find", {"type": "object", "properties": {"q": {"type": "string"}}})


def req(**kw) -> AdapterRequest:
    base = dict(model="m", system="sys", schema_name="Outer", json_schema=SCHEMA,
                messages=(Message("user", "hi", (ImagePart(b"\x89PNG", "image/png"),)),),
                max_tokens=100, timeout_s=5.0, effort="low")  # fmt: skip
    base.update(kw)
    return AdapterRequest(**base)


def test_strict_schema_inlines_refs_and_closes_objects():
    s = SCHEMA
    assert "$defs" not in json.dumps(s) and "$ref" not in json.dumps(s)
    assert s["additionalProperties"] is False and s["required"] == ["title", "items"]
    inner = s["properties"]["items"]["items"]
    assert inner["additionalProperties"] is False and inner["required"] == ["name", "qty"]
    assert "title" not in inner and "default" not in json.dumps(s)


def test_build_adapters_only_for_configured_keys():
    s = make_settings(anthropic_api_key="sk-test", groq_api_key="gsk-test")
    assert sorted(build_adapters(s)) == ["anthropic", "groq"]
    assert build_adapters(make_settings()) == {}


# --- Anthropic (SDK installed: real exception classes) ---


class _AnthropicMessages:
    def __init__(self, result):
        self.result = result
        self.kwargs = None

    async def create(self, **kw):
        self.kwargs = kw
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


def _anthropic_msg(stop="end_turn", content=None):
    return NS(stop_reason=stop, model="claude-haiku-5-5",
              content=content or [NS(type="text", text='{"title": "x", "items": []}')],
              usage=NS(input_tokens=10, output_tokens=5, cache_read_input_tokens=100,
                       cache_creation_input_tokens=7))  # fmt: skip


async def test_anthropic_request_and_response():
    messages = _AnthropicMessages(_anthropic_msg())
    a = AnthropicAdapter(client=NS(messages=messages))
    resp = await a.generate(req(tools=(TOOL,)))
    kw = messages.kwargs
    assert kw["output_config"] == {"format": {"type": "json_schema", "schema": SCHEMA},
                                   "effort": "low"}
    assert kw["system"][0]["cache_control"] == {"type": "ephemeral"}
    assert kw["messages"][0]["content"][0]["type"] == "image"
    assert kw["tools"][0]["input_schema"] == TOOL.parameters
    assert resp.text == '{"title": "x", "items": []}'
    assert (resp.usage.tokens_in, resp.usage.cached_in, resp.usage.cache_write_in) == (10, 100, 7)


async def test_anthropic_stop_reasons_and_tool_use():
    a = AnthropicAdapter(client=NS(messages=_AnthropicMessages(_anthropic_msg("refusal"))))
    with pytest.raises(Refused):
        await a.generate(req())
    a = AnthropicAdapter(client=NS(messages=_AnthropicMessages(_anthropic_msg("max_tokens"))))
    with pytest.raises(BadOutput):
        await a.generate(req())
    tool_use = NS(type="tool_use", id="t1", name="lookup", input={"q": "pho"})
    a = AnthropicAdapter(client=NS(messages=_AnthropicMessages(
        _anthropic_msg("tool_use", [tool_use]))))
    resp = await a.generate(req())
    assert resp.tool_calls[0].name == "lookup" and resp.tool_calls[0].arguments == {"q": "pho"}


def _status_error(cls, status, body=None, headers=None):
    import httpx2

    request = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
    response = httpx2.Response(status, request=request, headers=headers or {})
    return cls("error", response=response, body=body)


@pytest.mark.parametrize("make,expected", [
    (lambda a: _status_error(a.RateLimitError, 429, headers={"retry-after": "1.5"}), RateLimited),
    (lambda a: _status_error(a.InternalServerError, 500), ServerError),
    (lambda a: _status_error(a.APIStatusError, 529), ServerError),
    (lambda a: _status_error(a.APIStatusError, 402), QuotaExceeded),
    (lambda a: _status_error(a.BadRequestError, 400,
                             body={"error": {"message": "Your credit balance is too low"}}),
     QuotaExceeded),
    (lambda a: a.APITimeoutError(request=__import__("httpx2").Request("POST", "https://x")),
     ProviderTimeout),
])  # fmt: skip
async def test_anthropic_error_mapping(make, expected):
    import anthropic

    exc = make(anthropic)
    a = AnthropicAdapter(client=NS(messages=_AnthropicMessages(exc)))
    with pytest.raises(expected) as e:
        await a.generate(req())
    if expected is RateLimited:
        assert e.value.retry_after == 1.5


# --- OpenAI / Groq (SDK not installed in dev: shapes and response mapping only) ---


def test_openai_request_shape():
    kw = OpenAIAdapter(client=object()).request_kwargs(req(tools=(TOOL,)))
    assert kw["instructions"] == "sys" and kw["store"] is False
    assert kw["text"]["format"] == {"type": "json_schema", "name": "Outer", "schema": SCHEMA,
                                    "strict": True}
    assert kw["input"][0]["content"][0]["type"] == "input_image"
    assert kw["input"][0]["content"][0]["image_url"].startswith("data:image/png;base64,")
    assert kw["tools"][0]["type"] == "function" and kw["tools"][0]["name"] == "lookup"


def test_openai_response_mapping():
    usage = NS(input_tokens=1000, output_tokens=50, input_tokens_details=NS(cached_tokens=400))
    resp = NS(status="completed", model="gpt-5-mini", id="r1", usage=usage, output=[
        NS(type="message", content=[NS(type="output_text", text='{"title":"a"}')]),
        NS(type="function_call", call_id="c1", name="lookup", arguments='{"q":"x"}'),
    ])  # fmt: skip
    r = _responses_to_result(resp, "gpt-5-mini")
    assert r.text == '{"title":"a"}' and r.tool_calls[0].arguments == {"q": "x"}
    assert (r.usage.tokens_in, r.usage.cached_in) == (600, 400)
    with pytest.raises(Refused):
        _responses_to_result(NS(status="completed", usage=usage, output=[
            NS(type="message", content=[NS(type="refusal", refusal="no")])]), "m")
    with pytest.raises(BadOutput):
        _responses_to_result(NS(status="incomplete", usage=usage,
                                incomplete_details=NS(reason="max_output_tokens")), "m")


def test_groq_request_and_response():
    kw = GroqAdapter(client=object()).request_kwargs(req(tools=(TOOL,)))
    assert kw["messages"][0] == {"role": "system", "content": "sys"}
    assert kw["response_format"]["json_schema"]["schema"] == SCHEMA
    assert kw["tools"][0]["function"]["name"] == "lookup"
    usage = NS(prompt_tokens=100, completion_tokens=10, prompt_tokens_details=None)
    ok = NS(id="g1", model="llama", usage=usage, choices=[NS(finish_reason="stop", message=NS(
        content='{"title":"g"}', refusal=None, tool_calls=None))])
    assert _chat_to_result(ok, "llama").text == '{"title":"g"}'
    cut = NS(usage=usage, choices=[NS(finish_reason="length", message=None)])
    with pytest.raises(BadOutput):
        _chat_to_result(cut, "llama")


def test_gemini_response_mapping():
    um = NS(prompt_token_count=1000, cached_content_token_count=200, candidates_token_count=30,
            thoughts_token_count=20)
    resp = NS(text='{"title":"g"}', usage_metadata=um, prompt_feedback=None,
              candidates=[NS(finish_reason="FinishReason.STOP")], function_calls=None,
              model_version="gemini-2.5-flash", response_id="x")  # fmt: skip
    r = gemini_response(resp, "gemini-2.5-flash")
    assert r.text == '{"title":"g"}'
    assert (r.usage.tokens_in, r.usage.cached_in, r.usage.tokens_out) == (800, 200, 50)
    blocked = NS(text="", usage_metadata=um, prompt_feedback=NS(block_reason="SAFETY"),
                 candidates=[], function_calls=None)
    with pytest.raises(Refused):
        gemini_response(blocked, "m")
    safety = NS(text="", usage_metadata=um, prompt_feedback=None,
                candidates=[NS(finish_reason="SAFETY")], function_calls=None)
    with pytest.raises(Refused):
        gemini_response(safety, "m")


def test_keys_never_surface_in_settings_repr_or_usage_rows():
    s = make_settings(openai_api_key="sk-secret-123", anthropic_api_key="sk-ant-xyz")
    assert "sk-secret-123" not in repr(s) and "sk-ant-xyz" not in str(s.model_dump())
    adapters = build_adapters(s)
    assert all("sk-" not in repr(a) for a in adapters.values())
