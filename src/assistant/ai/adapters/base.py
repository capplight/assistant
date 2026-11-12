"""ProviderAdapter protocol and helpers shared by adapters.

An adapter does one provider call: it maps `AdapterRequest` to the SDK, streams text deltas
through `on_token` when set, and maps SDK errors to `assistant.ai.types` errors:
429 -> RateLimited(retry_after), 402/insufficient_quota/billing -> QuotaExceeded,
5xx/connection -> ServerError, timeout -> ProviderTimeout, safety stop -> Refused,
truncated/empty -> BadOutput. Validation against the Pydantic schema happens in the router.
SDKs are imported lazily inside each adapter, so a missing SDK breaks only that provider.
"""

import copy
import re
from typing import Any, Protocol, runtime_checkable

from pydantic import BaseModel

from assistant.ai.types import AdapterRequest, AdapterResponse, BatchEntry


@runtime_checkable
class ProviderAdapter(Protocol):
    name: str  # anthropic | openai | google | groq | fake...

    async def generate(self, req: AdapterRequest) -> AdapterResponse: ...


@runtime_checkable
class BatchAdapter(Protocol):
    """A provider batch (about half price, hours of delay). `supports_batch` says it is real."""

    supports_batch: bool

    async def submit_batch(self, requests: list[tuple[str, AdapterRequest]]) -> str: ...

    async def batch_ended(self, batch_id: str) -> bool: ...

    async def batch_results(self, batch_id: str) -> list[BatchEntry]: ...

    async def cancel_batch(self, batch_id: str) -> None: ...


def strict_json_schema(schema: type[BaseModel]) -> dict[str, Any]:
    """Pydantic JSON schema in the strict subset every provider accepts.

    $refs inlined (Gemini), additionalProperties=false and every property required (OpenAI
    strict, Anthropic structured outputs), no title/default keys. Optional fields stay
    nullable through their anyOf [.., null].
    """
    raw = schema.model_json_schema()
    defs = raw.pop("$defs", {})

    def walk(node: Any, depth: int = 0) -> Any:
        if depth > 40:
            raise ValueError("schema too deep (recursive models are not supported)")
        if isinstance(node, list):
            return [walk(n, depth + 1) for n in node]
        if not isinstance(node, dict):
            return node
        if "$ref" in node:
            target = defs[node["$ref"].rsplit("/", 1)[-1]]
            merged = {**copy.deepcopy(target), **{k: v for k, v in node.items() if k != "$ref"}}
            return walk(merged, depth + 1)
        out: dict[str, Any] = {}
        for k, v in node.items():
            if k in ("properties", "patternProperties") and isinstance(v, dict):
                # keys here are field names (a field may be called "title"), not keywords
                out[k] = {name: walk(sub, depth + 1) for name, sub in v.items()}
            elif k not in ("title", "default"):
                out[k] = walk(v, depth + 1)
        if out.get("type") == "object" and "properties" in out:
            out["additionalProperties"] = False
            out["required"] = list(out["properties"].keys())
        return out

    return walk(raw)


def retry_after_seconds(headers: Any) -> float | None:
    try:
        value = headers.get("retry-after") if headers is not None else None
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


QUOTA_MARKERS = ("insufficient_quota", "billing", "credit balance", "quota exceeded",
                 "payment required", "exceeded your current quota")  # fmt: skip


def error_text_of(exc: Exception) -> str:
    """Message plus the JSON error body (SDKs keep the provider's error text there)."""
    body = getattr(exc, "body", None)
    return f"{exc} {body!r}" if body is not None else str(exc)


def looks_like_quota(message: str) -> bool:
    # Links do not count: Groq ends ordinary limit errors with ".../settings/billing".
    m = re.sub(r"https?://\S+", "", message.lower())
    return any(marker in m for marker in QUOTA_MARKERS)
