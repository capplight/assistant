"""Anthropic adapter: Messages API, output_config.format json_schema, tools, streaming,
prompt caching on the system block, Message Batches.

UNVERIFIED against the live API (no key yet): request shape follows the installed SDK
(anthropic 2.x: messages.create(output_config=...), messages.stream(...),
messages.batches.create/retrieve/results/cancel). Check `cache_read_input_tokens` > 0 on the
first real traffic: a prefix under the model's minimum (about 512 tokens) silently never caches.
Batch results are kept by Anthropic for 29 days and batches are not eligible for zero retention.

Tool loops (skill `claude-api`, checked 2026-11-07): tools and output_config.format go in one
request; tools are `strict`; forced tool_choice (any/tool) is rejected by current models, so only
`auto` / `none`; parallel tool_use blocks are answered with all tool_result blocks in one user
message; the assistant turn (thinking blocks with signatures + tool_use) is replayed unchanged
(`ProviderTurn`), as the API requires within a tool loop. UNVERIFIED live: the replay dumps SDK
blocks with model_dump(exclude_none) and sends them back as params.
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
    BatchEntry,
    Message,
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


class AnthropicAdapter:
    name = "anthropic"
    supports_batch = True

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
        messages = [{"role": m.role, "content": _content(m)} for m in req.messages]
        output_config: dict[str, Any] = {}
        if req.json_schema is not None:
            output_config["format"] = {"type": "json_schema", "schema": req.json_schema}
        if req.effort:
            output_config["effort"] = req.effort
        kwargs: dict[str, Any] = {
            "model": req.model,
            "max_tokens": req.max_tokens,
            "system": [_system_block(req)],
            "messages": messages,
            "timeout": req.timeout_s,
        }  # fmt: skip
        if output_config:
            kwargs["output_config"] = output_config
        if req.tools:
            kwargs["tools"] = [{"name": t.name, "description": t.description,
                                "input_schema": t.parameters, "strict": True}
                               for t in req.tools]  # fmt: skip
            if req.tool_choice == "none":
                kwargs["tool_choice"] = {"type": "none"}
        return kwargs

    # --- Message Batches: half price, most finish within an hour, 24 hours at most ---

    async def _batch_call(self, call: Any) -> Any:
        import anthropic

        try:
            return await call
        except anthropic.APITimeoutError as exc:
            raise ProviderTimeout(type(exc).__name__) from exc
        except anthropic.RateLimitError as exc:
            raise RateLimited(type(exc).__name__) from exc
        except anthropic.APIStatusError as exc:
            raise _map_status(exc.status_code, error_text_of(exc)) from exc
        except anthropic.APIConnectionError as exc:
            raise ServerError(type(exc).__name__) from exc

    async def submit_batch(self, requests: list[tuple[str, AdapterRequest]]) -> str:
        items = []
        for custom_id, req in requests:
            params = self.request_kwargs(req)
            params.pop("timeout", None)  # not a request parameter inside a batch
            items.append({"custom_id": custom_id, "params": params})
        batch = await self._batch_call(self._get_client().messages.batches.create(requests=items))
        return batch.id

    async def batch_ended(self, batch_id: str) -> bool:
        batch = await self._batch_call(self._get_client().messages.batches.retrieve(batch_id))
        return batch.processing_status == "ended"

    async def batch_results(self, batch_id: str) -> list[BatchEntry]:
        """Results come in any order: entries are keyed by custom_id. Only `succeeded` is billed."""
        stream = await self._batch_call(self._get_client().messages.batches.results(batch_id))
        out: list[BatchEntry] = []
        async for row in stream:
            out.append(_batch_entry(row))
        return out

    async def cancel_batch(self, batch_id: str) -> None:
        await self._batch_call(self._get_client().messages.batches.cancel(batch_id))

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


def _content(m: Message) -> list[dict[str, Any]]:
    if m.raw is not None and m.raw.provider == "anthropic":
        return list(m.raw.payload)  # the model's own turn, thinking blocks included
    content: list[dict[str, Any]] = []
    for r in m.tool_results:  # tool_result blocks come first in a user turn
        block: dict[str, Any] = {"type": "tool_result", "tool_use_id": r.call_id,
                                 "content": r.content}  # fmt: skip
        if r.is_error:
            block["is_error"] = True
        content.append(block)
    for img in m.images:
        content.append({"type": "image", "source": {
            "type": "base64", "media_type": img.media_type,
            "data": base64.standard_b64encode(img.data).decode()}})  # fmt: skip
    if m.text or not (m.tool_results or m.tool_calls):
        content.append({"type": "text", "text": m.text})
    for c in m.tool_calls:
        content.append({"type": "tool_use", "id": c.id, "name": c.name, "input": c.arguments})
    return content


def _raw_turn(msg: Any) -> ProviderTurn | None:
    blocks = []
    for block in getattr(msg, "content", None) or []:
        dump = getattr(block, "model_dump", None)
        if dump is None:
            return None
        blocks.append(dump(mode="json", exclude_none=True))
    return ProviderTurn("anthropic", blocks)


def _system_block(req: AdapterRequest) -> dict[str, Any]:
    """Tools render before the system prompt, so this one breakpoint covers both."""
    block: dict[str, Any] = {"type": "text", "text": req.system}
    if req.cache_ttl == "1h":
        block["cache_control"] = {"type": "ephemeral", "ttl": "1h"}
    elif req.cache_ttl is not None:
        block["cache_control"] = {"type": "ephemeral"}
    return block


def _batch_entry(row: Any) -> BatchEntry:
    result = row.result
    if result.type == "succeeded":
        try:
            return BatchEntry(row.custom_id, response=_to_response(result.message, ""))
        except ProviderError as exc:
            return BatchEntry(row.custom_id, error=exc)
    if result.type == "errored":
        kind = getattr(getattr(result.error, "error", result.error), "type", "")
        if kind in ("invalid_request_error", "invalid_request"):
            return BatchEntry(row.custom_id, error=ProviderRequestError(str(kind)))
    return BatchEntry(row.custom_id, error=ServerError(str(result.type)))  # expired, canceled, ...


def _map_status(status: int, message: str) -> ProviderError:
    if status == 402 or looks_like_quota(message):
        return QuotaExceeded(f"http {status}")
    if status == 429:
        return RateLimited(f"http {status}")
    if status >= 500 or status == 529:
        return ServerError(f"http {status}")
    if status in (408,):
        return ProviderTimeout(f"http {status}")
    return ProviderRequestError(f"http {status}: {message[:300]}")


def _to_response(msg: Any, model: str) -> AdapterResponse:
    u = msg.usage
    writes = getattr(u, "cache_creation_input_tokens", 0) or 0
    long_writes = getattr(getattr(u, "cache_creation", None), "ephemeral_1h_input_tokens", 0) or 0
    usage = Usage(
        tokens_in=u.input_tokens or 0,
        tokens_out=u.output_tokens or 0,
        cached_in=getattr(u, "cache_read_input_tokens", 0) or 0,
        cache_write_in=max(0, writes - long_writes),
        cache_write_1h_in=long_writes,
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
                           tool_calls=calls, request_id=getattr(msg, "_request_id", None),
                           raw=_raw_turn(msg) if calls else None)


