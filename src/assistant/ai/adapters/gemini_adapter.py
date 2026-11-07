"""Google Gemini adapter (google-genai SDK): response_json_schema + application/json,
functionDeclarations for tools, vision for OCR, streaming.

UNVERIFIED against the live API (no key yet, `google-genai` not installed in dev): written to
the documented google-genai shapes; check at the week-0 bake-off (notably which JSON-schema
keywords response_json_schema accepts together with tools).

Prompt caching: implicit only (automatic on a stable prefix, read from
`cached_content_token_count`). Explicit context caches bill storage per hour, and our traffic
does not repay it. Batch mode is not implemented: Gemini is a fallback and OCR route, both live.
"""

from typing import Any

from assistant.ai.adapters.base import error_text_of, looks_like_quota
from assistant.ai.types import (
    AdapterRequest,
    AdapterResponse,
    BadOutput,
    ProviderError,
    ProviderRequestError,
    ProviderTimeout,
    QuotaExceeded,
    RateLimited,
    Refused,
    ServerError,
    ToolCall,
    Usage,
)

_REFUSAL_REASONS = {"SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII",
                    "IMAGE_SAFETY"}  # fmt: skip


class GeminiAdapter:
    name = "google"

    def __init__(self, api_key: str = "", *, client: Any = None) -> None:
        self._api_key = api_key
        self._client = client

    def _get_client(self) -> Any:
        if self._client is None:
            from google import genai  # lazy

            self._client = genai.Client(api_key=self._api_key or None)
        return self._client

    def request_parts(self, req: AdapterRequest) -> tuple[list[Any], Any]:
        from google.genai import types

        contents = []
        for m in req.messages:
            parts = [types.Part.from_bytes(data=i.data, mime_type=i.media_type) for i in m.images]
            parts.append(types.Part.from_text(text=m.text))
            contents.append(types.Content(role="model" if m.role == "assistant" else "user",
                                          parts=parts))  # fmt: skip
        cfg: dict[str, Any] = {
            "system_instruction": req.system,
            "max_output_tokens": req.max_tokens,
            "http_options": types.HttpOptions(timeout=int(req.timeout_s * 1000)),
        }
        if req.tools:
            cfg["tools"] = [types.Tool(function_declarations=[
                types.FunctionDeclaration(name=t.name, description=t.description,
                                          parameters_json_schema=t.parameters)
                for t in req.tools])]  # fmt: skip
        if req.json_schema is not None and not req.tools:
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
                return _to_response(resp, req.model)
            texts: list[str] = []
            last = None
            stream = await client.aio.models.generate_content_stream(
                model=req.model, contents=contents, config=config)
            async for chunk in stream:
                last = chunk
                piece = _safe_text(chunk)
                if piece:
                    texts.append(piece)
                    await req.on_token(piece)
            if last is None:
                raise ServerError("empty stream")
            result = _to_response(last, req.model, text_override="".join(texts))
            return result
        except ProviderError:
            raise
        except TimeoutError as exc:
            raise ProviderTimeout("timeout") from exc
        except errors.APIError as exc:
            code = int(getattr(exc, "code", 0) or 0)
            message = error_text_of(exc)
            if code == 402 or ("billing" in message.lower()) or (
                    code != 429 and looks_like_quota(message)):
                raise QuotaExceeded(f"http {code}") from exc
            if code == 429:
                raise RateLimited(f"http {code}") from exc
            if code >= 500:
                raise ServerError(f"http {code}") from exc
            if code in (408, 504):
                raise ProviderTimeout(f"http {code}") from exc
            raise ProviderRequestError(f"http {code}") from exc  # fmt: skip
        except Exception as exc:
            if type(exc).__name__ in ("ReadTimeout", "ConnectTimeout", "TimeoutException"):
                raise ProviderTimeout(type(exc).__name__) from exc
            if type(exc).__name__ in ("ConnectError", "RemoteProtocolError"):
                raise ServerError(type(exc).__name__) from exc
            raise


def _safe_text(resp: Any) -> str:
    try:
        return resp.text or ""
    except (ValueError, AttributeError):
        return ""


def _to_response(resp: Any, model: str, *, text_override: str | None = None) -> AdapterResponse:
    um = getattr(resp, "usage_metadata", None)
    prompt = getattr(um, "prompt_token_count", 0) or 0
    cached = getattr(um, "cached_content_token_count", 0) or 0
    out = (getattr(um, "candidates_token_count", 0) or 0) + (
        getattr(um, "thoughts_token_count", 0) or 0)
    usage = Usage(tokens_in=max(0, prompt - cached), tokens_out=out, cached_in=cached)
    feedback = getattr(resp, "prompt_feedback", None)
    if feedback is not None and getattr(feedback, "block_reason", None):
        raise Refused(str(feedback.block_reason), usage=usage)
    candidates = getattr(resp, "candidates", None) or []
    if candidates:
        reason = str(getattr(candidates[0], "finish_reason", "") or "").rsplit(".", 1)[-1]
        if reason in _REFUSAL_REASONS:
            raise Refused(reason, usage=usage)
        if reason == "MAX_TOKENS":
            raise BadOutput("max_tokens", usage=usage)
    calls = [ToolCall(getattr(fc, "id", None) or f"call_{i}", fc.name, dict(fc.args or {}))
             for i, fc in enumerate(getattr(resp, "function_calls", None) or [])]
    text = text_override if text_override is not None else _safe_text(resp)
    if not text and not calls:
        raise BadOutput("empty", usage=usage)
    return AdapterResponse(text, usage, getattr(resp, "model_version", None) or model,
                           tool_calls=calls, request_id=getattr(resp, "response_id", None))


