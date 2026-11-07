"""Anthropic adapter: Messages API, output_config.format json_schema, tools, streaming,
prompt caching on the system block.

UNVERIFIED against the live API (no key yet): request shape follows the installed SDK
(anthropic 2.x: messages.create(output_config=...), messages.stream(...)).
"""

import base64
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
    QuotaExceeded,
    RateLimited,
    Refused,
    ServerError,
    ToolCall,
    Usage,
)


class AnthropicAdapter:
    name = "anthropic"

    def __init__(self, api_key: str = "", *, client: Any = None) -> None:
        self._api_key = api_key
        self._client = client

    def _get_client(self) -> Any:
        if self._client is None:
            from anthropic import AsyncAnthropic  # lazy: SDK only inside its adapter

            # Retries are the router's job (fallback to another provider instead of waiting).
            self._client = AsyncAnthropic(api_key=self._api_key or None, max_retries=0)
        return self._client

    def request_kwargs(self, req: AdapterRequest) -> dict[str, Any]:
        messages = []
        for m in req.messages:
            content: list[dict[str, Any]] = []
            for img in m.images:
                content.append({"type": "image", "source": {
                    "type": "base64", "media_type": img.media_type,
                    "data": base64.standard_b64encode(img.data).decode()}})  # fmt: skip
            content.append({"type": "text", "text": m.text})
            messages.append({"role": m.role, "content": content})
        output_config: dict[str, Any] = {}
        if req.json_schema is not None:
            output_config["format"] = {"type": "json_schema", "schema": req.json_schema}
        if req.effort:
            output_config["effort"] = req.effort
        kwargs: dict[str, Any] = {
            "model": req.model,
            "max_tokens": req.max_tokens,
            # Cache the stable prefix (system prompt); tools render before it.
            "system": [{"type": "text", "text": req.system,
                        "cache_control": {"type": "ephemeral"}}],
            "messages": messages,
            "timeout": req.timeout_s,
        }  # fmt: skip
        if output_config:
            kwargs["output_config"] = output_config
        if req.tools:
            kwargs["tools"] = [{"name": t.name, "description": t.description,
                                "input_schema": t.parameters} for t in req.tools]  # fmt: skip
        return kwargs

    async def generate(self, req: AdapterRequest) -> AdapterResponse:
        import anthropic

        client = self._get_client()
        kwargs = self.request_kwargs(req)
        try:
            if req.on_token is None:
                msg = await client.messages.create(**kwargs)
            else:
                async with client.messages.stream(**kwargs) as stream:
                    async for delta in stream.text_stream:
                        await req.on_token(delta)
                    msg = await stream.get_final_message()
        except anthropic.APITimeoutError as exc:
            raise ProviderTimeout(type(exc).__name__) from exc
        except anthropic.RateLimitError as exc:
            if looks_like_quota(error_text_of(exc)):
                raise QuotaExceeded(type(exc).__name__) from exc
            raise RateLimited(type(exc).__name__,
                              retry_after=retry_after_seconds(exc.response.headers)) from exc
        except anthropic.APIStatusError as exc:
            raise _map_status(exc.status_code, error_text_of(exc)) from exc
        except anthropic.APIConnectionError as exc:
            raise ServerError(type(exc).__name__) from exc
        except TimeoutError as exc:
            raise ProviderTimeout("timeout") from exc
        return _to_response(msg, req.model)


def _map_status(status: int, message: str) -> ProviderError:
    if status == 402 or looks_like_quota(message):
        return QuotaExceeded(f"http {status}")
    if status == 429:
        return RateLimited(f"http {status}")
    if status >= 500 or status == 529:
        return ServerError(f"http {status}")
    if status in (408,):
        return ProviderTimeout(f"http {status}")
    return ProviderRequestError(f"http {status}")


def _to_response(msg: Any, model: str) -> AdapterResponse:
    u = msg.usage
    usage = Usage(
        tokens_in=u.input_tokens or 0,
        tokens_out=u.output_tokens or 0,
        cached_in=getattr(u, "cache_read_input_tokens", 0) or 0,
        cache_write_in=getattr(u, "cache_creation_input_tokens", 0) or 0,
    )
    if msg.stop_reason == "refusal":
        raise Refused("refusal", usage=usage)
    if msg.stop_reason == "max_tokens":
        raise BadOutput("max_tokens", usage=usage)
    texts, calls = [], []
    for block in msg.content:
        if block.type == "text":
            texts.append(block.text)
        elif block.type == "tool_use":
            calls.append(ToolCall(block.id, block.name, dict(block.input or {})))
    return AdapterResponse("".join(texts), usage, getattr(msg, "model", model) or model,
                           tool_calls=calls, request_id=getattr(msg, "_request_id", None))


