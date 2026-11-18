"""Anthropic adapter: Messages API, output_config.format json_schema, tools, streaming,
prompt caching on the system block, Message Batches.

Checked live 2026-11-16 (claude-haiku-5-5, anthropic 2.3.0): streamed chat, tool loops with the
replayed assistant turn, structured outputs, prompt caching (`cache_read_input_tokens` reported
from the second call on). Batches stay unverified live (off by founder decision). Batch results
are kept by Anthropic for 29 days and batches are not eligible for zero retention.

Structured outputs, learned live: the grammar of a new schema (+ strict tools) compiles once
(~7-20 s on the first call, then cached 24 h), so the first call of the day may miss a short
first-token deadline and fall back. Schemas lose the keywords the API rejects (`maxItems`,
`minLength`, `minimum`...; `UNSUPPORTED_KEYWORDS`): the router validates the answer against the
Pydantic model anyway. At most `MAX_STRICT_UNIONS` nullable/union parameters per request across
the strict schemas, or the API answers 400: tools with the fewest unions stay `strict` while the
budget lasts, the rest go non-strict (their arguments are validated in code, chat/tools.py).

Tool loops (skill `claude-api`, checked 2026-11-07): tools and output_config.format go in one
request; tools are `strict`; forced tool_choice (any/tool) is rejected by current models, so only
`auto` / `none`; parallel tool_use blocks are answered with all tool_result blocks in one user
message; the assistant turn (thinking blocks with signatures + tool_use) is replayed unchanged
(`ProviderTurn`), as the API requires within a tool loop. UNVERIFIED live: the replay dumps SDK
blocks with model_dump(exclude_none) and sends them back as params.

Web search (Ф-86, checked live 2026-11-19 on claude-haiku-5-5): `web_search_20250305` and
`web_search_20260209` (with `allowed_callers: ["direct"]`) both work together with
output_config.format; the JSON answer carries no citation blocks, so sources are taken from the
`web_search_tool_result` blocks. `user_location.country` "KZ" is rejected (400), so only city and
time zone are sent. `pause_turn` is continued by sending the paused turn back (MAX_PAUSES).
"""

import base64
import dataclasses
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
    WebSearchSpec,
    WebSource,
)

UNSUPPORTED_KEYWORDS = frozenset({
    "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
    "minLength", "maxLength", "maxItems", "uniqueItems", "minProperties", "maxProperties",
})  # fmt: skip
MAX_STRICT_UNIONS = 16  # the API's limit (400 "too many parameters with union types")
MAX_PAUSES = 2  # `pause_turn` continuations of one web search turn
WEB_SOURCES_PER_SEARCH = 2
WEB_SOURCES_MAX = 4


def anthropic_schema(node: Any) -> Any:
    """A copy without the keywords structured outputs reject. `minItems` stays only as 0 or 1."""
    if isinstance(node, list):
        return [anthropic_schema(n) for n in node]
    if not isinstance(node, dict):
        return node
    out: dict[str, Any] = {}
    for k, v in node.items():
        if k in ("properties", "$defs", "definitions") and isinstance(v, dict):
            out[k] = {name: anthropic_schema(sub) for name, sub in v.items()}
        elif k in UNSUPPORTED_KEYWORDS:
            continue
        elif k == "minItems" and not (isinstance(v, int) and v in (0, 1)):
            continue
        else:
            out[k] = anthropic_schema(v)
    return out


def union_count(node: Any) -> int:
    """Parameters with `anyOf` or a type list (nullable optionals), as the API counts them."""
    if isinstance(node, list):
        return sum(union_count(n) for n in node)
    if not isinstance(node, dict):
        return 0
    own = int("anyOf" in node or isinstance(node.get("type"), list))
    return own + sum(union_count(v) for v in node.values())


def _tool_params(tools: Any, budget: int) -> list[dict[str, Any]]:
    """Fewest unions first get `strict` while the budget lasts; the list keeps its order."""
    cost = [union_count(t.parameters) for t in tools]
    strict: set[int] = set()
    for i in sorted(range(len(cost)), key=lambda i: (cost[i], i)):
        if cost[i] <= budget:
            strict.add(i)
            budget -= cost[i]
    out = []
    for i, t in enumerate(tools):
        tool: dict[str, Any] = {"name": t.name, "description": t.description,
                                "input_schema": anthropic_schema(t.parameters)}  # fmt: skip
        if i in strict:
            tool["strict"] = True
        out.append(tool)
    return out


class AnthropicAdapter:
    name = "anthropic"
    supports_batch = True

    def __init__(self, api_key: str = "", *, client: Any = None) -> None:
        self._api_key = api_key
        self._client = client

    def warm(self) -> None:
        """Import the SDK at startup (in a thread), not inside the first call's timeout: on
        Windows the import alone took ~10 s with the event loop frozen (device test 2026-11-18)."""
        import anthropic  # noqa: F401

    def _get_client(self) -> Any:
        if self._client is None:
            from anthropic import AsyncAnthropic  # lazy: SDK only inside its adapter

            # Retries are the router's job (fallback to another provider instead of waiting).
            self._client = AsyncAnthropic(api_key=self._api_key or None, max_retries=0)
        return self._client

    def request_kwargs(self, req: AdapterRequest) -> dict[str, Any]:
        messages = [{"role": m.role, "content": _content(m)} for m in req.messages]
        output_config: dict[str, Any] = {}
        budget = MAX_STRICT_UNIONS
        if req.json_schema is not None:
            schema = anthropic_schema(req.json_schema)
            budget -= union_count(schema)
            output_config["format"] = {"type": "json_schema", "schema": schema}
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
        tools = _tool_params(req.tools, max(0, budget)) if req.tools else []
        if req.web_search is not None:
            tools.append(_web_search_tool(req.web_search))
        if tools:
            kwargs["tools"] = tools
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
        paused: list[Any] = []  # earlier parts of a web search turn the API paused
        try:
            while True:
                if req.on_token is None:
                    msg = await client.messages.create(**kwargs)
                else:
                    async with client.messages.stream(**kwargs) as stream:
                        async for delta in stream.text_stream:
                            await req.on_token(delta)
                        msg = await stream.get_final_message()
                if msg.stop_reason != "pause_turn" or len(paused) >= MAX_PAUSES:
                    break
                # A long server-tool turn (web search): send the paused turn back unchanged.
                paused.append(msg)
                turn = [b.model_dump(mode="json", exclude_none=True) for b in msg.content]
                kwargs = {**kwargs, "messages": [*kwargs["messages"],
                                                 {"role": "assistant", "content": turn}]}
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
        return _to_response(msg, req.model, paused)


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


def _usage(u: Any) -> Usage:
    writes = getattr(u, "cache_creation_input_tokens", 0) or 0
    long_writes = getattr(getattr(u, "cache_creation", None), "ephemeral_1h_input_tokens", 0) or 0
    searches = getattr(getattr(u, "server_tool_use", None), "web_search_requests", 0) or 0
    return Usage(
        tokens_in=u.input_tokens or 0,
        tokens_out=u.output_tokens or 0,
        cached_in=getattr(u, "cache_read_input_tokens", 0) or 0,
        cache_write_in=max(0, writes - long_writes),
        cache_write_1h_in=long_writes,
        web_searches=int(searches),
    )


def _web_search_tool(spec: WebSearchSpec) -> dict[str, Any]:
    tool: dict[str, Any] = {"type": spec.tool_type, "name": "web_search",
                            "max_uses": spec.max_uses}  # fmt: skip
    if spec.tool_type != "web_search_20250305":
        # Newer versions filter results through code execution by default; called directly
        # they behave like the basic tool and cost no code-execution tokens.
        tool["allowed_callers"] = ["direct"]
    loc = {k: v for k, v in (("city", spec.city), ("timezone", spec.timezone)) if v}
    if loc:
        tool["user_location"] = {"type": "approximate", **loc}
    return tool


def _web_sources(blocks: Any) -> list[WebSource]:
    """The first results of each search (the answer is JSON, so the API attaches no citation
    blocks to it): what the answer was written from, shown to the person as sources."""
    out: list[WebSource] = []
    seen: set[str] = set()
    for block in blocks or []:
        if getattr(block, "type", None) != "web_search_tool_result":
            continue
        content = getattr(block, "content", None)
        if not isinstance(content, list):  # an error object: nothing found
            continue
        for r in content[:WEB_SOURCES_PER_SEARCH]:
            url = getattr(r, "url", None)
            if url and url not in seen:
                seen.add(url)
                out.append(WebSource(url, getattr(r, "title", None) or url))
    return out[:WEB_SOURCES_MAX]


def _to_response(msg: Any, model: str, paused: list[Any] | None = None) -> AdapterResponse:
    usage = _usage(msg.usage)
    blocks: list[Any] = []
    for part in paused or []:  # a paused turn was paid too, and its searches count
        earlier = _usage(part.usage)
        usage = Usage(*(a + b for a, b in zip(dataclasses.astuple(usage),
                                               dataclasses.astuple(earlier), strict=True)))
        blocks += list(part.content)
    blocks += list(msg.content)
    if msg.stop_reason == "refusal":
        raise Refused("refusal", usage=usage)
    if msg.stop_reason == "max_tokens":
        raise BadOutput("max_tokens", usage=usage)
    texts, calls = [], []
    for block in blocks:
        if block.type == "text":
            texts.append(block.text)
        elif block.type == "tool_use":
            calls.append(ToolCall(block.id, block.name, dict(block.input or {})))
    starts = [i for i, t in enumerate(texts) if t.lstrip().startswith("{")]
    if len(texts) > 1 and starts:  # a word before a web search is not part of the JSON answer
        texts = texts[starts[0]:]
    return AdapterResponse("".join(texts), usage, getattr(msg, "model", model) or model,
                           tool_calls=calls, request_id=getattr(msg, "_request_id", None),
                           raw=_raw_turn(msg) if calls else None,
                           web_sources=_web_sources(blocks))


