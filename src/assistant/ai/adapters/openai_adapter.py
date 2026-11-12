"""OpenAI adapter (Responses API, json_schema strict, function tools, streaming) and the Groq
adapter (OpenAI-compatible Chat Completions at api.groq.com).

OpenAI (Responses API): UNVERIFIED against the live API (no key yet); written to the
documented openai>=1.x shapes; check at the week-0 bake-off.
Groq: checked live on 2026-11-12 (device test, openai/gpt-oss-120b, openai SDK 3.49, free
tier): strict json_schema, streamed text, tool calls (plain and streamed), the tool loop with
`tool` messages, and 429 handling. Groq vision (images) is still UNVERIFIED live.

Prompt caching is automatic on both, for long enough prefixes: we keep the prefix stable and read
`cached_tokens`. OpenAI also gets `prompt_cache_key` (the schema name, never user data) to keep
one task's calls on the same cache. Batch APIs exist on both but are not implemented here: only
the primary provider batches, and a batch task on a fallback provider runs live.

Tool loops: Responses API input items `function_call` / `function_call_output`; with tools,
`include=["reasoning.encrypted_content"]` (store=False keeps nothing on OpenAI's side) and the
output items are replayed as they came (`ProviderTurn`). Groq: assistant `tool_calls` + `tool`
messages (checked live), with the two-call step described below.
"""

import base64
import json
from typing import Any

from assistant.ai.adapters.base import (
    error_text_of,
    looks_like_quota,
    retry_after_seconds,
)
from assistant.ai.types import (
    AdapterRequest,
    AdapterResponse,
    BadOutput,
    ProviderError,
    ProviderRequestError,
    ProviderTimeout,
    ProviderTurn,
    QuotaExceeded,
    RateLimited,
    Refused,
    ServerError,
    TokenHook,
    ToolCall,
    Usage,
)

GROQ_BASE_URL = "https://api.groq.com/openai/v1"
# Groq + tools + structured answer (device test 2026-11-12, openai/gpt-oss-120b): json mode is
# refused together with tools (400 "json mode cannot be combined with tool/function calling");
# a JSON instruction in the prompt made gpt-oss call a tool named `json` that does not exist
# (Groq fails the stream: "tool call validation failed"); without it gpt-oss often ends a step
# after a tool result with empty content. What works: a step offers the tools without json mode;
# when the model calls no tool, the answer is asked again without tools, with the strict
# json_schema (tool history included - Groq accepts it). The last step (tool_choice "none")
# goes straight to that answer call.


def map_openai_error(exc: Exception) -> ProviderError | None:
    """openai SDK exception -> our error (None = not an SDK error)."""
    import openai

    if isinstance(exc, openai.APITimeoutError):
        return ProviderTimeout(type(exc).__name__)
    if isinstance(exc, openai.RateLimitError):
        # OpenAI sends insufficient_quota as a 429: it is a billing stop, not a rate limit.
        # Only that code / its own words: Groq's ordinary per-minute 429 links to its billing
        # page ("Upgrade to Dev Tier ... /settings/billing"), and reading that as a quota stop
        # switched Groq off until a manual reset (device test 2026-11-12).
        code = getattr(exc, "code", None) or ""
        text = error_text_of(exc).lower()
        if code == "insufficient_quota" or "insufficient_quota" in text or (
                "exceeded your current quota" in text):
            return QuotaExceeded(type(exc).__name__)
        return RateLimited(type(exc).__name__,
                           retry_after=retry_after_seconds(exc.response.headers))  # fmt: skip
    if isinstance(exc, openai.APIStatusError):
        status = exc.status_code
        if status == 402 or looks_like_quota(error_text_of(exc)):
            return QuotaExceeded(f"http {status}")
        if status >= 500:
            return ServerError(f"http {status}")
        if status == 408:
            return ProviderTimeout(f"http {status}")
        return ProviderRequestError(f"http {status}: {error_text_of(exc)[:300]}")
    if isinstance(exc, openai.APIConnectionError):
        return ServerError(type(exc).__name__)
    if isinstance(exc, openai.APIError):
        # An error event inside a stream (no HTTP status). Groq checks the model's tool calls
        # and fails the stream on a call to a tool that was not offered ("tool call validation
        # failed", gpt-oss, device test 2026-11-12): the model's output was bad, not the service.
        if "tool call validation failed" in error_text_of(exc).lower():
            return BadOutput("tool call validation failed")
        return ServerError(f"stream error: {error_text_of(exc)[:600]}")
    return None


def _data_url(media_type: str, data: bytes) -> str:
    return f"data:{media_type};base64,{base64.standard_b64encode(data).decode()}"


class OpenAIAdapter:
    name = "openai"

    def __init__(self, api_key: str = "", *, client: Any = None) -> None:
        self._api_key = api_key
        self._client = client

    def _get_client(self) -> Any:
        if self._client is None:
            from openai import AsyncOpenAI  # lazy

            self._client = AsyncOpenAI(api_key=self._api_key or None, max_retries=0)
        return self._client

    def request_kwargs(self, req: AdapterRequest) -> dict[str, Any]:
        items: list[dict[str, Any]] = []
        for m in req.messages:
            if m.role == "assistant":
                if m.raw is not None and m.raw.provider == "openai":
                    items.extend(m.raw.payload)
                    continue
                if m.text:
                    items.append({"role": "assistant", "content": m.text})
                items.extend({"type": "function_call", "call_id": c.id, "name": c.name,
                              "arguments": json.dumps(c.arguments, ensure_ascii=False)}
                             for c in m.tool_calls)  # fmt: skip
                continue
            items.extend({"type": "function_call_output", "call_id": r.call_id,
                          "output": r.content} for r in m.tool_results)  # fmt: skip
            if not m.text and not m.images and m.tool_results:
                continue
            content: list[dict[str, Any]] = [
                {"type": "input_image", "image_url": _data_url(i.media_type, i.data)}
                for i in m.images
            ]
            content.append({"type": "input_text", "text": m.text})
            items.append({"role": "user", "content": content})
        kwargs: dict[str, Any] = {
            "model": req.model,
            "instructions": req.system,
            "input": items,
            "max_output_tokens": req.max_tokens,
            "store": False,  # no server-side retention of our users' data
            "timeout": req.timeout_s,
        }
        if req.json_schema is not None:
            kwargs["text"] = {"format": {"type": "json_schema", "name": req.schema_name[:64],
                                         "schema": req.json_schema, "strict": True}}
        if req.cache_ttl is not None and req.schema_name:
            kwargs["prompt_cache_key"] = req.schema_name[:64]
        if req.tools:
            kwargs["tools"] = [{"type": "function", "name": t.name, "description": t.description,
                                "parameters": t.parameters, "strict": True} for t in req.tools]
            kwargs["include"] = ["reasoning.encrypted_content"]
            if req.tool_choice == "none":
                kwargs["tool_choice"] = "none"
        return kwargs  # fmt: skip

    async def generate(self, req: AdapterRequest) -> AdapterResponse:
        client = self._get_client()
        kwargs = self.request_kwargs(req)
        try:
            if req.on_token is None:
                resp = await client.responses.create(**kwargs)
            else:
                resp = None
                stream = await client.responses.create(**kwargs, stream=True)
                async for event in stream:
                    if event.type == "response.output_text.delta":
                        await req.on_token(event.delta)
                    elif event.type in ("response.completed", "response.incomplete"):
                        resp = event.response
                    elif event.type == "response.failed":
                        raise ServerError("response.failed")
                if resp is None:
                    raise ServerError("stream ended without a response")
        except ProviderError:
            raise
        except TimeoutError as exc:
            raise ProviderTimeout("timeout") from exc
        except Exception as exc:
            mapped = map_openai_error(exc)
            if mapped is None:
                raise
            raise mapped from exc
        return _responses_to_result(resp, req.model)


def _responses_to_result(resp: Any, model: str) -> AdapterResponse:
    u = resp.usage
    cached = getattr(getattr(u, "input_tokens_details", None), "cached_tokens", 0) or 0
    usage = Usage(tokens_in=max(0, (u.input_tokens or 0) - cached),
                  tokens_out=u.output_tokens or 0, cached_in=cached)  # fmt: skip
    if resp.status == "incomplete":
        reason = getattr(resp.incomplete_details, "reason", "")
        if reason == "content_filter":
            raise Refused("content_filter", usage=usage)
        raise BadOutput(reason or "incomplete", usage=usage)
    texts, calls = [], []
    for item in resp.output or []:
        if item.type == "function_call":
            calls.append(ToolCall(item.call_id, item.name, json.loads(item.arguments or "{}")))
        elif item.type == "message":
            for part in item.content or []:
                if part.type == "refusal":
                    raise Refused("refusal", usage=usage)
                if part.type == "output_text":
                    texts.append(part.text)
    raw = None
    items = list(resp.output or [])
    if calls and all(hasattr(item, "model_dump") for item in items):
        raw = ProviderTurn("openai", [item.model_dump(mode="json", exclude_none=True)
                                      for item in items])  # fmt: skip
    return AdapterResponse("".join(texts), usage, getattr(resp, "model", model) or model,
                           tool_calls=calls, request_id=getattr(resp, "id", None),
                           raw=raw)  # fmt: skip


class GroqAdapter:
    """Groq LLM via its OpenAI-compatible Chat Completions endpoint (STT stays in pipeline/stt)."""

    name = "groq"

    def __init__(self, api_key: str = "", *, client: Any = None,
                 base_url: str = GROQ_BASE_URL) -> None:
        self._api_key = api_key
        self._client = client
        self._base_url = base_url  # fmt: skip

    def _get_client(self) -> Any:
        if self._client is None:
            from openai import AsyncOpenAI  # lazy

            self._client = AsyncOpenAI(api_key=self._api_key or None, base_url=self._base_url,
                                       max_retries=0)  # fmt: skip
        return self._client

    def request_kwargs(self, req: AdapterRequest, *, answer_only: bool = False) -> dict[str, Any]:
        """`answer_only`: the structured answer of a tool loop step (tools left out)."""
        messages: list[dict[str, Any]] = [{"role": "system", "content": req.system}]
        for m in req.messages:
            if m.tool_calls:
                messages.append({"role": "assistant", "content": m.text or None, "tool_calls": [
                    {"id": c.id, "type": "function", "function": {
                        "name": c.name, "arguments": json.dumps(c.arguments, ensure_ascii=False)}}
                    for c in m.tool_calls]})  # fmt: skip
                continue
            messages.extend({"role": "tool", "tool_call_id": r.call_id, "content": r.content}
                            for r in m.tool_results)  # fmt: skip
            if m.tool_results and not m.text and not m.images:
                continue
            if m.images:
                content: list[dict[str, Any]] = [
                    {"type": "image_url", "image_url": {"url": _data_url(i.media_type, i.data)}}
                    for i in m.images
                ]
                content.append({"type": "text", "text": m.text})
                messages.append({"role": m.role, "content": content})
            else:
                messages.append({"role": m.role, "content": m.text})
        kwargs: dict[str, Any] = {"model": req.model, "messages": messages,
                                  "max_completion_tokens": req.max_tokens,
                                  "timeout": req.timeout_s}  # fmt: skip
        if req.effort in ("low", "medium", "high") and "gpt-oss" in req.model:
            kwargs["reasoning_effort"] = req.effort  # gpt-oss: shorter reasoning, faster
        structured = req.json_schema is not None
        if structured and (not req.tools or answer_only or req.tool_choice == "none"):
            kwargs["response_format"] = {"type": "json_schema", "json_schema": {
                "name": req.schema_name[:64], "schema": req.json_schema, "strict": True}}
            return kwargs
        if req.tools:
            kwargs["tools"] = [{"type": "function", "function": {
                "name": t.name, "description": t.description, "parameters": t.parameters}}
                for t in req.tools]
            if req.tool_choice == "none":
                kwargs["tool_choice"] = "none"
        return kwargs  # fmt: skip

    async def generate(self, req: AdapterRequest) -> AdapterResponse:
        """With tools and a schema, a step is up to two calls (note at the top): tools without
        json mode; when the model calls none, the structured answer without tools."""
        if not (req.tools and req.json_schema is not None and req.tool_choice != "none"):
            return await self._once(req, self.request_kwargs(req), req.on_token)
        first = await self._once(req, self.request_kwargs(req), None)
        if first.tool_calls:
            return first
        if _complete_json(first.text, req.json_schema):
            if req.on_token is not None:
                await req.on_token(first.text)
            return first
        second = await self._once(req, self.request_kwargs(req, answer_only=True), req.on_token)
        u1, u2 = first.usage, second.usage
        second.usage = Usage(tokens_in=u1.tokens_in + u2.tokens_in,
                             tokens_out=u1.tokens_out + u2.tokens_out,
                             cached_in=u1.cached_in + u2.cached_in)  # fmt: skip
        return second

    async def _once(self, req: AdapterRequest, kwargs: dict[str, Any],
                    on_token: TokenHook | None) -> AdapterResponse:  # fmt: skip
        client = self._get_client()
        try:
            if on_token is None:
                resp = await client.chat.completions.create(**kwargs)
                return _chat_to_result(resp, req.model)
            texts: list[str] = []
            usage = Usage()
            finish = None
            parts: dict[int, dict[str, str]] = {}  # streamed tool calls, by index
            stream = await client.chat.completions.create(
                **kwargs, stream=True, stream_options={"include_usage": True})
            async for chunk in stream:
                # Groq puts usage on the last chunk (`x_groq.usage` on older API versions).
                u = getattr(chunk, "usage", None) or getattr(
                    getattr(chunk, "x_groq", None), "usage", None)
                if u:
                    usage = _chat_usage(u)
                for choice in chunk.choices or []:
                    delta = choice.delta
                    # gpt-oss streams its reasoning in `delta.reasoning`: never shown, skipped.
                    if delta and delta.content:
                        texts.append(delta.content)
                        await on_token(delta.content)
                    for tc in getattr(delta, "tool_calls", None) or []:
                        part = parts.setdefault(tc.index, {"id": "", "name": "", "args": ""})
                        part["id"] = tc.id or part["id"]
                        fn = getattr(tc, "function", None)
                        if fn is not None:
                            part["name"] = fn.name or part["name"]
                            part["args"] += fn.arguments or ""
                    finish = choice.finish_reason or finish
        except ProviderError:
            raise
        except TimeoutError as exc:
            raise ProviderTimeout("timeout") from exc
        except Exception as exc:
            mapped = map_openai_error(exc)
            if mapped is None:
                raise
            raise mapped from exc
        if finish == "length":
            raise BadOutput("length", usage=usage)
        if finish == "content_filter":
            raise Refused("content_filter", usage=usage)
        try:
            calls = [ToolCall(v["id"] or f"call_{i}", v["name"], json.loads(v["args"] or "{}"))
                     for i, v in sorted(parts.items())]  # fmt: skip
        except json.JSONDecodeError as exc:
            raise BadOutput("tool arguments", usage=usage) from exc
        return AdapterResponse("".join(texts), usage, req.model, tool_calls=calls)


def _complete_json(text: str, schema: dict[str, Any] | None) -> bool:
    """The tool step already wrote a JSON object with every required field."""
    try:
        data = json.loads(text)
    except ValueError:
        return False
    required = (schema or {}).get("required", [])
    return isinstance(data, dict) and all(k in data for k in required)


def _chat_usage(u: Any) -> Usage:
    cached = getattr(getattr(u, "prompt_tokens_details", None), "cached_tokens", 0) or 0
    return Usage(tokens_in=max(0, (u.prompt_tokens or 0) - cached),
                 tokens_out=u.completion_tokens or 0, cached_in=cached)  # fmt: skip


def _chat_to_result(resp: Any, model: str) -> AdapterResponse:
    usage = _chat_usage(resp.usage)
    choice = resp.choices[0]
    if choice.finish_reason == "length":
        raise BadOutput("length", usage=usage)
    if choice.finish_reason == "content_filter":
        raise Refused("content_filter", usage=usage)
    msg = choice.message
    if getattr(msg, "refusal", None):
        raise Refused("refusal", usage=usage)
    try:
        calls = [ToolCall(tc.id, tc.function.name, json.loads(tc.function.arguments or "{}"))
                 for tc in (msg.tool_calls or [])]  # fmt: skip
    except json.JSONDecodeError as exc:
        raise BadOutput("tool arguments", usage=usage) from exc
    return AdapterResponse(msg.content or "", usage, getattr(resp, "model", model) or model,
                           tool_calls=calls, request_id=getattr(resp, "id", None))  # fmt: skip
