"""Adapters against stub SDK clients (no network): request shape, response and error mapping.

These prove our mapping logic. Gemini and Groq wire formats were checked live on 2026-11-12
(device test); the shapes below copy what those APIs sent.
"""

import json
from types import SimpleNamespace as NS

import pytest
from pydantic import BaseModel

from assistant.ai.adapters import AnthropicAdapter, GroqAdapter, OpenAIAdapter, build_adapters
from assistant.ai.adapters.base import strict_json_schema
from assistant.ai.adapters.gemini_adapter import GeminiAdapter
from assistant.ai.adapters.gemini_adapter import _to_response as gemini_response
from assistant.ai.adapters.openai_adapter import _chat_to_result, _responses_to_result
from assistant.ai.types import (
    AdapterRequest,
    BadOutput,
    ImagePart,
    Message,
    ProviderRequestError,
    ProviderTimeout,
    QuotaExceeded,
    RateLimited,
    Refused,
    ServerError,
    ToolCall,
    ToolResult,
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


def _chat_resp(content=None, tool_calls=None, finish="stop"):
    usage = NS(prompt_tokens=100, completion_tokens=10, prompt_tokens_details=None)
    return NS(id="g1", model="gpt-oss", usage=usage, choices=[NS(
        finish_reason=finish, message=NS(content=content, refusal=None, tool_calls=tool_calls))])


class _GroqCompletions:
    def __init__(self, results):
        self.results = list(results)
        self.calls: list[dict] = []

    async def create(self, **kw):
        self.calls.append(kw)
        result = self.results.pop(0)
        if isinstance(result, Exception):
            raise result
        if kw.get("stream"):
            async def gen():
                for chunk in result:
                    yield chunk
            return gen()
        return result


def _groq(results):
    completions = _GroqCompletions(results)
    return GroqAdapter(client=NS(chat=NS(completions=completions))), completions


def _tc(name, args, id_="fc_1"):
    return NS(id=id_, function=NS(name=name, arguments=args))


def test_groq_request_shapes():
    plain = GroqAdapter(client=object()).request_kwargs(req())
    assert plain["messages"][0] == {"role": "system", "content": "sys"}
    assert plain["response_format"]["json_schema"]["schema"] == SCHEMA
    # json mode is refused together with tools: a tool step has tools, no response_format
    step = GroqAdapter(client=object()).request_kwargs(req(tools=(TOOL,), model="openai/gpt-oss"))
    assert "response_format" not in step and step["tools"][0]["function"]["name"] == "lookup"
    assert step["reasoning_effort"] == "low"
    assert "json" not in step["messages"][0]["content"].lower()  # no prompt-level JSON order
    # the last step (and the answer call) has the strict schema and no tools
    last = GroqAdapter(client=object()).request_kwargs(req(tools=(TOOL,), tool_choice="none"))
    assert "tools" not in last and last["response_format"]["json_schema"]["strict"] is True


def test_groq_tool_history_replay():
    call = ToolCall("fc_1", "lookup", {"q": "x"})
    msgs = (Message("user", "q"), Message("assistant", "", tool_calls=(call,)),
            Message("user", "", tool_results=(ToolResult("fc_1", "lookup", '{"r":1}'),)))
    kw = GroqAdapter(client=object()).request_kwargs(req(messages=msgs, tools=(TOOL,)),
                                                    answer_only=True)  # fmt: skip
    assert [m["role"] for m in kw["messages"]] == ["system", "user", "assistant", "tool"]
    assert kw["messages"][2]["tool_calls"][0]["function"] == {"name": "lookup",
                                                             "arguments": '{"q": "x"}'}
    assert kw["messages"][3] == {"role": "tool", "tool_call_id": "fc_1", "content": '{"r":1}'}


def test_groq_response_mapping():
    assert _chat_to_result(_chat_resp('{"title":"g"}'), "m").text == '{"title":"g"}'
    with pytest.raises(BadOutput):
        _chat_to_result(_chat_resp(finish="length"), "m")
    r = _chat_to_result(_chat_resp(tool_calls=[_tc("lookup", '{"q":"a"}')]), "m")
    assert r.tool_calls[0].arguments == {"q": "a"}
    with pytest.raises(BadOutput):
        _chat_to_result(_chat_resp(tool_calls=[_tc("lookup", '{"q":')]), "m")


async def test_groq_tool_step_without_calls_asks_for_the_structured_answer():
    """gpt-oss ended a step after a tool result with empty content (device test): the answer
    is asked again without tools, with the schema, and that call streams."""
    chunk = lambda content=None, finish=None, usage=None: NS(  # noqa: E731
        usage=usage, choices=[NS(delta=NS(content=content, tool_calls=None),
                                 finish_reason=finish)])
    u = NS(prompt_tokens=50, completion_tokens=5, prompt_tokens_details=None)
    a, comp = _groq([_chat_resp(""), [chunk('{"title":'), chunk('"g"}', "stop"),
                                      chunk(usage=u)]])
    got = []

    async def hook(d):
        got.append(d)

    r = await a.generate(req(tools=(TOOL,), on_token=hook))
    assert r.text == '{"title":"g"}' and "".join(got) == r.text
    assert "tools" in comp.calls[0] and "response_format" not in comp.calls[0]
    assert "tools" not in comp.calls[1] and comp.calls[1]["response_format"]
    assert r.usage.tokens_in == 150  # both calls are paid


async def test_groq_tool_step_with_calls_or_full_json_is_one_call():
    a, comp = _groq([_chat_resp(tool_calls=[_tc("lookup", '{"q":"a"}')])])
    r = await a.generate(req(tools=(TOOL,)))
    assert r.tool_calls[0].name == "lookup" and len(comp.calls) == 1
    a, comp = _groq([_chat_resp('{"title":"g","items":[]}')])
    got = []

    async def hook(d):
        got.append(d)

    r = await a.generate(req(tools=(TOOL,), on_token=hook))
    assert r.text == '{"title":"g","items":[]}' and got == [r.text] and len(comp.calls) == 1


async def test_groq_streamed_tool_call_deltas_are_assembled():
    def chunk(tcs=None, finish=None):
        return NS(usage=None, choices=[NS(delta=NS(content=None, tool_calls=tcs),
                                          finish_reason=finish)])
    stream = [chunk([NS(index=0, id="fc_9", function=NS(name="lookup", arguments='{"q":'))]),
              chunk([NS(index=0, id=None, function=NS(name=None, arguments='"pho"}'))]),
              chunk(finish="tool_calls")]
    a, _ = _groq([stream])

    async def hook(d):
        raise AssertionError("tool steps do not stream")

    r = await a._once(req(), {"model": "m"}, hook)
    assert [(c.id, c.name, c.arguments) for c in r.tool_calls] == [("fc_9", "lookup",
                                                                     {"q": "pho"})]


def _openai_status(cls, status, message):
    import httpx2 as httpx

    request = httpx.Request("POST", "https://api.groq.com/openai/v1/chat/completions")
    response = httpx.Response(status, request=request, headers={"retry-after": "4"})
    return cls(message, response=response, body={"error": {"message": message}})


async def test_groq_limit_errors_never_switch_groq_off():
    """Groq's per-minute 429 / 413 end with a link to its billing page (device test): that is a
    rate limit, not a quota stop that needs a manual reset."""
    import openai

    msg = ("Rate limit reached for model `openai/gpt-oss-120b` on tokens per minute (TPM): "
           "Limit 8000, Used 6738, Requested 1911. Please try again in 4.8s. Need more tokens? "
           "Upgrade to Dev Tier today at https://console.groq.com/settings/billing")
    a, _ = _groq([_openai_status(openai.RateLimitError, 429, msg)])
    with pytest.raises(RateLimited) as e:
        await a.generate(req())
    assert e.value.retry_after == 4.0
    a, _ = _groq([_openai_status(openai.APIStatusError, 413, "Request too large. " + msg)])
    with pytest.raises(ProviderRequestError):
        await a.generate(req())
    a, _ = _groq([_openai_status(openai.RateLimitError, 429, "You exceeded your current quota")])
    with pytest.raises(QuotaExceeded):
        await a.generate(req())


async def test_groq_stream_error_event_mapping():
    import httpx2 as httpx
    import openai

    bad = openai.APIError("Tool call validation failed: attempted to call tool 'json' which was "
                          "not in request.tools", httpx.Request("POST", "https://x"), body=None)
    a, _ = _groq([bad])
    with pytest.raises(BadOutput):
        await a.generate(req(tools=(TOOL,)))


# --- Gemini (google-genai installed: real types; shapes as the live API streamed them) ---


def _gchunk(parts=None, finish=None, usage=None):
    from google.genai import types

    cand = types.Candidate(content=types.Content(role="model", parts=parts or []),
                           finish_reason=finish)  # fmt: skip
    return types.GenerateContentResponse(candidates=[cand], usage_metadata=usage,
                                         model_version="gemini-x", response_id="r1")


def _gusage(prompt=1000, cached=200, out=30, thoughts=20):
    from google.genai import types

    return types.GenerateContentResponseUsageMetadata(
        prompt_token_count=prompt, cached_content_token_count=cached,
        candidates_token_count=out, thoughts_token_count=thoughts)


class _GeminiModels:
    def __init__(self, result):
        self.result = result
        self.config = None

    async def generate_content(self, *, model, contents, config):
        self.config, self.contents = config, contents
        if isinstance(self.result, Exception):
            raise self.result
        return self.result

    async def generate_content_stream(self, *, model, contents, config):
        self.config, self.contents = config, contents
        if isinstance(self.result, Exception):
            raise self.result

        async def gen():
            for c in self.result:
                yield c
        return gen()


def _gemini(result, **kw):
    models = _GeminiModels(result)
    return GeminiAdapter(client=NS(aio=NS(models=models)), **kw), models


def test_gemini_response_mapping():
    from google.genai import types

    resp = _gchunk([types.Part(text='{"title":"g"}')], "STOP", _gusage())
    r = gemini_response([resp], "gemini-x")
    assert r.text == '{"title":"g"}' and r.raw is None
    assert (r.usage.tokens_in, r.usage.cached_in, r.usage.tokens_out) == (800, 200, 50)
    blocked = types.GenerateContentResponse(
        prompt_feedback=types.GenerateContentResponsePromptFeedback(block_reason="SAFETY"))
    with pytest.raises(Refused):
        gemini_response([blocked], "m")
    with pytest.raises(Refused):
        gemini_response([_gchunk([types.Part(text="x")], "SAFETY")], "m")
    with pytest.raises(BadOutput):
        gemini_response([_gchunk([types.Part(text="x")], "MAX_TOKENS")], "m")
    with pytest.raises(BadOutput):
        gemini_response([_gchunk([], "STOP")], "m")


async def test_gemini_stream_function_call_in_an_earlier_chunk():
    """Device test 2026-11-12: the function_call came in one chunk and the last chunk held only
    the finish reason and usage; reading the last chunk alone gave "empty"."""
    from google.genai import types

    fc = types.Part(function_call=types.FunctionCall(id="call_7", name="lookup",
                                                     args={"q": "pho"}),
                    thought_signature=b"sig")  # fmt: skip
    chunks = [_gchunk([types.Part(text="thinking...", thought=True)]), _gchunk([fc]),
              _gchunk([], "STOP", _gusage())]
    a, _ = _gemini(chunks)
    got = []

    async def hook(d):
        got.append(d)

    r = await a.generate(req(tools=(TOOL,), on_token=hook))
    assert got == [] and r.text == ""
    assert [(c.id, c.name, c.arguments) for c in r.tool_calls] == [("call_7", "lookup",
                                                                     {"q": "pho"})]
    assert r.raw is not None and r.raw.provider == "google"
    assert [p.thought_signature for p in r.raw.payload.parts if p.function_call] == [b"sig"]
    assert r.usage.tokens_out == 50


async def test_gemini_stream_text_skips_thoughts_and_empty_parts():
    from google.genai import types

    chunks = [_gchunk([types.Part(text="plan", thought=True)]),
              _gchunk([types.Part(text='{"title":')]), _gchunk([types.Part(text="")]),
              _gchunk([types.Part(text='"g"}')], "STOP", _gusage())]
    a, _ = _gemini(chunks)
    got = []

    async def hook(d):
        got.append(d)

    r = await a.generate(req(on_token=hook))
    assert got == ['{"title":', '"g"}'] and r.text == '{"title":"g"}'


def test_gemini_request_tools_replay_and_thinking():
    from google.genai import types

    a = GeminiAdapter(client=object(), thinking={"low": "minimal"})
    turn = types.Content(role="model", parts=[types.Part(function_call=types.FunctionCall(
        id="call_7", name="lookup", args={}))])  # fmt: skip
    from assistant.ai.types import ProviderTurn

    msgs = (Message("user", "q"),
            Message("assistant", "", tool_calls=(ToolCall("call_7", "lookup", {}),),
                    raw=ProviderTurn("google", turn)),
            Message("user", "", tool_results=(ToolResult("call_7", "lookup", "{}"),
                                              ToolResult("gemini_call_1", "lookup", "{}"))))
    contents, cfg = a.request_parts(req(messages=msgs, tools=(TOOL,), timeout_s=5))
    assert contents[1] is turn  # replayed as it came (thought signatures)
    ids = [p.function_response.id for p in contents[2].parts]
    assert ids == ["call_7", None]  # our own ids never go back to Google
    assert cfg.thinking_config.thinking_level == types.ThinkingLevel.MINIMAL
    assert cfg.http_options.timeout == 10_000  # Google's minimum deadline
    assert cfg.automatic_function_calling.disable is True
    assert cfg.response_json_schema == SCHEMA
    _, strong = a.request_parts(req(effort="medium"))
    assert strong.thinking_config is None


async def test_gemini_429_is_a_rate_limit_even_with_quota_words():
    from google.genai import errors

    exc = errors.APIError(429, {"error": {"code": 429, "status": "RESOURCE_EXHAUSTED",
        "message": "You exceeded your current quota, please check your plan and billing "
                   "details. Please retry in 31.5s."}})  # fmt: skip
    a, _ = _gemini(exc)
    with pytest.raises(RateLimited) as e:
        await a.generate(req())
    assert e.value.retry_after == 31.5


def test_keys_never_surface_in_settings_repr_or_usage_rows():
    s = make_settings(openai_api_key="sk-secret-123", anthropic_api_key="sk-ant-xyz")
    assert "sk-secret-123" not in repr(s) and "sk-ant-xyz" not in str(s.model_dump())
    adapters = build_adapters(s)
    assert all("sk-" not in repr(a) for a in adapters.values())
