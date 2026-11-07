"""Shared types of the AI layer: tasks, budget classes, outcomes, requests, results, errors.

Adapters translate `AdapterRequest` into one provider SDK call and the provider's answer back
into `AdapterResponse`. Nothing here imports a provider SDK.
"""

import enum
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from pydantic import BaseModel


class LLMTask(enum.StrEnum):
    ENRICH = "enrich"
    INTENT = "intent"
    REMINDER_PARSE = "reminder_parse"
    ANSWER = "answer"
    ANSWER_GENERAL = "answer_general"
    QUERY_PLAN = "query_plan"
    KP_EXTRACT = "kp_extract"
    KP_EDIT = "kp_edit"
    DRAFT = "draft"
    STACK_NAME = "stack_name"
    STACK_SUMMARY = "stack_summary"
    DUP_JUDGE = "dup_judge"
    VISION_OCR = "vision_ocr"
    IMPORT_SUMMARIZE = "import_summarize"
    PROFILE_EXTRACT = "profile_extract"
    PRICE_LIST_EXTRACT = "price_list_extract"
    CHAT = "chat"
    CHAT_SUMMARIZE = "chat_summarize"
    PAGE_GROUP = "page_group"
    EXPENSE_EXTRACT = "expense_extract"


class BudgetClass(enum.StrEnum):
    BACKGROUND = "background"
    ANSWERS = "answers"
    DOCUMENTS = "documents"
    IMPORT = "import"


class Outcome(enum.StrEnum):
    """provider_usage.outcome (spec 3.8). Must match ck_provider_usage_outcome in 0005."""

    OK = "ok"
    RATE_LIMITED = "rate_limited"
    QUOTA = "quota"
    SERVER_ERROR = "server_error"
    TIMEOUT = "timeout"
    INVALID_OUTPUT = "invalid_output"
    REFUSED = "refused"
    CIRCUIT_OPEN = "circuit_open"
    BUDGET_BLOCKED = "budget_blocked"
    CONSENT_BLOCKED = "consent_blocked"


class Tier(enum.StrEnum):
    LIGHT = "light"
    STRONG = "strong"


# --- request / response between router and adapters ---


@dataclass(frozen=True)
class ImagePart:
    data: bytes
    media_type: str  # image/jpeg, image/png, ...
    label: str = ""


@dataclass(frozen=True)
class ToolSpec:
    """Provider-neutral tool definition; adapters map it to tools / functions / declarations.
    `parameters` is a strict JSON schema (every property required, optional ones nullable,
    additionalProperties false), so adapters may ask the provider for strict arguments."""

    name: str
    description: str
    parameters: dict[str, Any]  # JSON schema of the arguments (type: object)


@dataclass(frozen=True)
class ToolCall:
    id: str
    name: str
    arguments: dict[str, Any]


@dataclass(frozen=True)
class ToolResult:
    """Our answer to one ToolCall. `content` is the result as our code wrote it (JSON text);
    build_messages masks it and wraps it in <untrusted_data>: records are data, not orders."""

    call_id: str
    name: str
    content: str
    is_error: bool = False


@dataclass(frozen=True)
class ProviderTurn:
    """A provider's own assistant turn (Anthropic content blocks with thinking and signatures,
    Gemini Content with thought signatures, OpenAI output items with encrypted reasoning).
    Replayed as is to the same provider inside one tool loop; others rebuild from tool_calls."""

    provider: str
    payload: Any


@dataclass(frozen=True)
class Message:
    """role "user": text (+ images) and/or tool_results; role "assistant": text and/or
    tool_calls, with `raw` when the provider needs its own turn back."""

    role: str  # "user" | "assistant"
    text: str
    images: tuple[ImagePart, ...] = ()
    tool_calls: tuple[ToolCall, ...] = ()
    tool_results: tuple[ToolResult, ...] = ()
    raw: ProviderTurn | None = None


@dataclass
class Usage:
    """Normalised token counts. tokens_in excludes cache reads and cache writes."""

    tokens_in: int = 0
    tokens_out: int = 0
    cached_in: int = 0
    cache_write_in: int = 0  # 5-minute cache writes
    cache_write_1h_in: int = 0  # 1-hour cache writes (a higher price)


TokenHook = Callable[[str], Awaitable[None]]


@dataclass(frozen=True)
class AdapterRequest:
    model: str
    system: str
    messages: tuple[Message, ...]
    schema_name: str
    json_schema: dict[str, Any] | None  # None = free text (not used by the router today)
    tools: tuple[ToolSpec, ...] = ()
    max_tokens: int = 4000
    timeout_s: float = 30.0
    effort: str | None = None  # Anthropic output_config.effort; others ignore it
    on_token: TokenHook | None = None  # set = stream text deltas through this hook
    cache_ttl: str | None = "5m"  # "5m" | "1h" | None; adapters without the choice ignore it
    # "auto" | "none" ("none": answer now, tools stay declared so the cached prefix holds).
    # Forced choices are not offered: current Anthropic models reject them.
    tool_choice: str = "auto"


@dataclass
class AdapterResponse:
    text: str  # raw JSON text of the structured answer ("" if only tool calls)
    usage: Usage
    model: str
    tool_calls: list[ToolCall] = field(default_factory=list)
    request_id: str | None = None
    raw: ProviderTurn | None = None  # the assistant turn to replay in a tool loop


@dataclass
class BatchEntry:
    """One result of a provider batch: an answer, or the error it would have raised live."""

    custom_id: str
    response: AdapterResponse | None = None
    error: "ProviderError | None" = None


# --- errors adapters raise (mapped from SDK exceptions) ---


class ProviderError(Exception):
    outcome: Outcome = Outcome.SERVER_ERROR

    def __init__(self, message: str = "", *, usage: Usage | None = None) -> None:
        super().__init__(message)
        self.usage = usage


class RateLimited(ProviderError):
    outcome = Outcome.RATE_LIMITED

    def __init__(self, message: str = "", *, retry_after: float | None = None) -> None:
        super().__init__(message)
        self.retry_after = retry_after


class QuotaExceeded(ProviderError):
    """402 / insufficient_quota / billing: the account is out of money. Off until manual reset."""

    outcome = Outcome.QUOTA


class ServerError(ProviderError):
    outcome = Outcome.SERVER_ERROR


class ProviderTimeout(ProviderError):
    outcome = Outcome.TIMEOUT


class Refused(ProviderError):
    outcome = Outcome.REFUSED


class BadOutput(ProviderError):
    """Truncated / empty output detected by the adapter (validation happens in the router)."""

    outcome = Outcome.INVALID_OUTPUT


class ProviderRequestError(ProviderError):
    """400-class error that another provider might not have (bad schema, unsupported model)."""

    outcome = Outcome.SERVER_ERROR


# --- errors the router raises to callers ---


class AIError(Exception):
    pass


class AIConsentRequired(AIError):
    """No active ai_cross_border consent, or no consented provider on the route."""


class BudgetExceeded(AIError):
    """User budget says no. reason: daily_soft | monthly_hard | documents_monthly | import_once."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class AIUnavailable(AIError):
    """Every provider on the route failed or is off. Callers queue the task with backoff."""

    def __init__(self, message: str, *, last_outcome: Outcome | None = None) -> None:
        super().__init__(message)
        self.last_outcome = last_outcome


class BatchUnavailable(AIError):
    """No batch now (route, adapter, primary provider off or busy): run the task live."""


class StaleBatchResult(AIError):
    """The record changed after the batch was sent: the answer is about the old text."""


class StreamInterrupted(AIError):
    """Provider failed after the first token was streamed: no switch (spec 5.3)."""


@dataclass
class Result[T: BaseModel]:
    data: T | None  # validated, unmasked; None when the model answered with tool calls
    tool_calls: list[ToolCall]
    provider: str
    model: str
    usage: Usage
    cost_usd: Decimal
    attempts: int
    fallback_from: str | None
    escalation_blocked: bool = False
    escalation_denied: str | None = None  # why: over_budget | daily_cap | a policy code
    budget_warning: bool = False
    raw: ProviderTurn | None = None  # replay in the next step of a tool loop (same provider)
    # Everything produced here is AI-generated content (spec 5.9): UI shows labels.ai_generated.
    ai_generated: bool = True
