"""Google Gemini adapter (google-genai SDK): response_json_schema + application/json,
functionDeclarations for tools, vision for OCR, streaming.

Checked live on 2026-11-12 (device test, gemini-3.5-flash-lite, google-genai 3.2.0, free tier):
structured output together with function tools, streamed text, a streamed function_call, the
replay of the model's turn and function_response parts. Vision (OCR) is still UNVERIFIED live.

A streamed answer comes in chunks; every chunk holds parts of one candidate. Text parts (not
`thought` parts) are the answer, `function_call` parts can sit in any chunk (often not the last
one, which may carry only finish_reason and usage), so the response is built from all parts of
all chunks, never from the last chunk alone (that read a function call as "empty").

Tool loops: the model's Content (all parts, thought signatures included: Gemini 3 needs them
back) is replayed as it came (`ProviderTurn`); results go back as `function_response` parts in
a user turn, with the call's id when the model gave one.

Thinking: `thinking_level` from the request effort through `settings.ai_gemini_thinking`
(light tier -> minimal by default: the fastest live).

Prompt caching: implicit only (automatic on a stable prefix, read from
`cached_content_token_count`). Explicit context caches bill storage per hour, and our traffic
does not repay it. Batch mode is not implemented: Gemini is a fallback and OCR route, both live.
"""

import re
from typing import Any

from assistant.ai.adapters.base import error_text_of, looks_like_quota
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
    ToolCall,
    Usage,
)

_REFUSAL_REASONS = {"SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII",
                    "IMAGE_SAFETY"}  # fmt: skip
# Our id for a function call the model sent without one: never sent back to Google.
SYNTHETIC_ID_PREFIX = "gemini_call_"


class GeminiAdapter:
    name = "google"

    def __init__(self, api_key: str = "", *, client: Any = None,
                 thinking: dict[str, str] | None = None) -> None:  # fmt: skip
        self._api_key = api_key
        self._client = client
        self._thinking = dict(thinking or {})

    def _get_client(self) -> Any:
        if self._client is None:
            from google import genai  # lazy

            self._client = genai.Client(api_key=self._api_key or None)
        return self._client

    def request_parts(self, req: AdapterRequest) -> tuple[list[Any], Any]:
        from google.genai import types

        contents = []
        for m in req.messages:
            if m.raw is not None and m.raw.provider == "google":
                contents.append(m.raw.payload)
                continue
            parts = [types.Part(function_response=types.FunctionResponse(
                id=None if r.call_id.startswith(SYNTHETIC_ID_PREFIX) else r.call_id,
                name=r.name, response={"error" if r.is_error else "result": r.content}))
                for r in m.tool_results]  # fmt: skip
            parts += [types.Part.from_bytes(data=i.data, mime_type=i.media_type)
                      for i in m.images]  # fmt: skip
            if m.text or not (m.tool_results or m.tool_calls):
                parts.append(types.Part.from_text(text=m.text))
            parts += [types.Part.from_function_call(name=c.name, args=c.arguments)
                      for c in m.tool_calls]  # fmt: skip
            contents.append(types.Content(role="model" if m.role == "assistant" else "user",
                                          parts=parts))  # fmt: skip
        cfg: dict[str, Any] = {
            "system_instruction": req.system,
            "max_output_tokens": req.max_tokens,
            # Google rejects a deadline under 10 s (400, device test 2026-11-12); the router
            # still cuts the call at the route's own timeout.
            "http_options": types.HttpOptions(timeout=int(max(req.timeout_s, 10) * 1000)),
        }
        level = self._thinking.get(req.effort or "")
        if level:
            cfg["thinking_config"] = types.ThinkingConfig(thinking_level=level.upper())
        if req.tools:
            cfg["tools"] = [types.Tool(function_declarations=[
                types.FunctionDeclaration(name=t.name, description=t.description,
                                          parameters_json_schema=t.parameters)
                for t in req.tools])]  # fmt: skip
            # The SDK would run Python callables itself; we run our own loop.
            cfg["automatic_function_calling"] = types.AutomaticFunctionCallingConfig(
                disable=True)
            if req.tool_choice == "none":
                cfg["tool_config"] = types.ToolConfig(
                    function_calling_config=types.FunctionCallingConfig(mode="NONE"))
        if req.json_schema is not None:
            cfg["response_mime_type"] = "application/json"
            cfg["response_json_schema"] = req.json_schema
        return contents, types.GenerateContentConfig(**cfg)

    async def generate(self, req: AdapterRequest) -> AdapterResponse:
        from google.genai import errors

        client = self._get_client()
        contents, config = self.request_parts(req)
        try:
            if req.on_token is None:
                resp = await client.aio.models.generate_content(
                    model=req.model, contents=contents, config=config)
                return _to_response([resp], req.model)
            chunks: list[Any] = []
            stream = await client.aio.models.generate_content_stream(
                model=req.model, contents=contents, config=config)
            async for chunk in stream:
                chunks.append(chunk)
                for part in _parts(chunk):
                    if part.text and not getattr(part, "thought", None):
                        await req.on_token(part.text)
            if not chunks:
                raise ServerError("empty stream")
            return _to_response(chunks, req.model)
        except ProviderError:
            raise
        except TimeoutError as exc:
            raise ProviderTimeout("timeout") from exc
        except errors.APIError as exc:
            code = int(getattr(exc, "code", 0) or 0)
            message = error_text_of(exc)
            # Every 429 is a rate limit: Google's free-tier per-minute 429 says "You exceeded
            # your current quota, please check your plan and billing details" too, and must not
            # switch Google off until a manual reset.
            if code == 429:
                raise RateLimited(f"http {code}", retry_after=_retry_delay(message)) from exc
            if code == 402 or looks_like_quota(message):
                raise QuotaExceeded(f"http {code}") from exc
            if code >= 500:
                raise ServerError(f"http {code}") from exc
            if code in (408, 504):
                raise ProviderTimeout(f"http {code}") from exc
            raise ProviderRequestError(f"http {code}: {message[:300]}") from exc  # fmt: skip
        except Exception as exc:
            if type(exc).__name__ in ("ReadTimeout", "ConnectTimeout", "TimeoutException"):
                raise ProviderTimeout(type(exc).__name__) from exc
            if type(exc).__name__ in ("ConnectError", "RemoteProtocolError"):
                raise ServerError(type(exc).__name__) from exc
            raise


_RETRY_RE = re.compile(r"retry(?:Delay'?\"?:\s*'?\"?| in )(\d+(?:\.\d+)?)s", re.IGNORECASE)


def _retry_delay(message: str) -> float | None:
    """Google puts the wait into the error body ("retryDelay": "31s" / "Please retry in 3.2s")."""
    m = _RETRY_RE.search(message)
    return float(m.group(1)) if m else None


def _candidate(resp: Any) -> Any:
    candidates = getattr(resp, "candidates", None) or []
    return candidates[0] if candidates else None


def _parts(resp: Any) -> list[Any]:
    cand = _candidate(resp)
    content = getattr(cand, "content", None) if cand is not None else None
    return list(getattr(content, "parts", None) or [])


def _to_response(chunks: list[Any], model: str) -> AdapterResponse:
    """One answer from its chunks (a plain call is one chunk). Usage, finish reason, ids come
    from the last chunk that has them; text and calls from all parts in order."""
    um = next((c.usage_metadata for c in reversed(chunks)
               if getattr(c, "usage_metadata", None) is not None), None)  # fmt: skip
    prompt = getattr(um, "prompt_token_count", 0) or 0
    cached = getattr(um, "cached_content_token_count", 0) or 0
    out = (getattr(um, "candidates_token_count", 0) or 0) + (
        getattr(um, "thoughts_token_count", 0) or 0)
    usage = Usage(tokens_in=max(0, prompt - cached), tokens_out=out, cached_in=cached)
    for c in chunks:
        feedback = getattr(c, "prompt_feedback", None)
        if feedback is not None and getattr(feedback, "block_reason", None):
            raise Refused(str(feedback.block_reason), usage=usage)
    reason = ""
    for c in chunks:
        cand = _candidate(c)
        if cand is not None and getattr(cand, "finish_reason", None):
            reason = str(cand.finish_reason).rsplit(".", 1)[-1]
    if reason in _REFUSAL_REASONS:
        raise Refused(reason, usage=usage)
    if reason == "MAX_TOKENS":
        raise BadOutput("max_tokens", usage=usage)
    parts = [p for c in chunks for p in _parts(c)]
    texts: list[str] = []
    calls: list[ToolCall] = []
    for p in parts:
        fc = getattr(p, "function_call", None)
        if fc is not None:
            calls.append(ToolCall(getattr(fc, "id", None) or f"{SYNTHETIC_ID_PREFIX}{len(calls)}",
                                  fc.name, dict(fc.args or {})))  # fmt: skip
        elif getattr(p, "text", None) and not getattr(p, "thought", None):
            texts.append(p.text)
    text = "".join(texts)
    if not text.strip() and not calls:
        raise BadOutput(f"empty ({reason or 'no finish reason'})", usage=usage)
    raw = None
    if calls:
        from google.genai import types

        raw = ProviderTurn("google", types.Content(role="model", parts=parts))
    last = chunks[-1]
    return AdapterResponse(text, usage, getattr(last, "model_version", None) or model,
                           tool_calls=calls, request_id=getattr(last, "response_id", None),
                           raw=raw)  # fmt: skip
