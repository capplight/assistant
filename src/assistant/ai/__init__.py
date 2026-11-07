"""AI layer (spec 3-engineering 5): router, provider adapters, budgets, masking, consent filter.

Public API (other modules import only from here):
    router = build_router(settings, sessionmaker)
    result = await router.run(LLMTask.ENRICH, MySchema, TaskInputs(...), user_id=user.id)
    result.data  # validated MySchema, PII restored; result.ai_generated is always True
Errors: AIConsentRequired, BudgetExceeded(reason), AIUnavailable (queue + backoff),
StreamInterrupted (show "Попробуйте ещё раз").
"""

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from assistant.ai.adapters import FakeAdapter, ProviderAdapter, build_adapters
from assistant.ai.breaker import BreakerState, CircuitBreaker
from assistant.ai.consent import ai_consent_providers
from assistant.ai.masking import Masker
from assistant.ai.policy import BatchMode, StrongReason, StrongRequest
from assistant.ai.prompting import TaskInputs, UntrustedPart, neutralize
from assistant.ai.router import PreparedBatchRequest, Router
from assistant.ai.routes import RouteTable, load_routes
from assistant.ai.store import (
    MemoryAIStore,
    PgAIStore,
    ensure_usage_partitions,
    next_month_start,
    period_starts,
)
from assistant.ai.types import (
    AIConsentRequired,
    AIError,
    AIUnavailable,
    BadOutput,
    BatchEntry,
    BatchUnavailable,
    BudgetClass,
    BudgetExceeded,
    ImagePart,
    LLMTask,
    Outcome,
    ProviderError,
    Result,
    StaleBatchResult,
    StreamInterrupted,
    ToolCall,
    ToolSpec,
)
from assistant.config import Settings


def build_router(settings: Settings, sessionmaker: async_sessionmaker[AsyncSession]) -> Router:
    """Production wiring: real adapters for providers with a key, Postgres store."""
    return Router(
        settings=settings,
        routes=load_routes(settings),
        adapters=build_adapters(settings),
        store=PgAIStore(sessionmaker,
                        legacy_consent_providers=settings.ai_legacy_consent_providers),
    )  # fmt: skip


__all__ = [
    "AIConsentRequired", "AIError", "AIUnavailable", "BadOutput", "BatchEntry", "BatchMode",
    "BatchUnavailable", "BreakerState", "BudgetClass",
    "BudgetExceeded", "CircuitBreaker", "FakeAdapter", "ImagePart", "LLMTask", "Masker",
    "MemoryAIStore", "Outcome", "PgAIStore", "PreparedBatchRequest", "ProviderAdapter",
    "ProviderError", "Result", "RouteTable", "Router", "StaleBatchResult", "StreamInterrupted",
    "StrongReason", "StrongRequest", "TaskInputs", "ToolCall", "ToolSpec", "UntrustedPart",
    "ai_consent_providers", "build_adapters", "build_router", "ensure_usage_partitions",
    "load_routes", "neutralize", "next_month_start", "period_starts",
]  # fmt: skip
