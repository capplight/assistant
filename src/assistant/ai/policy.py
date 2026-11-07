"""When the strong model may run, and which routes may use provider batches. Enforced in code.

The route table only names models; it cannot widen these rules: `validate_route` refuses to load
a table that breaks them, and `Router.run` asks `strong_denial` before every escalation.

Strong model (spec 5.2, 5.4, founder's option B):
1. Always strong: only the `documents` tasks in ALWAYS_STRONG (KP; numbers are computed by code).
2. Any other task runs light unless it names an allowed reason from ESCALATION_RULES, backed by a
   number our code holds: confidence of a light attempt < 0.6, more than 5 sources, >= 2 steps.
3. A low-confidence escalation also needs >= 80 characters of input: a short phrase is not
   worth the strong model, whatever the model says about its confidence.
4. Budget: none at >= 80% of the wallet (budget.py). Cap: settings.ai_strong_daily_per_user.
5. Batch calls never escalate. A denied escalation runs light; it never fails the task.
"""

import enum
from dataclasses import dataclass
from typing import Protocol

from assistant.ai.types import BudgetClass, LLMTask, Tier


class StrongReason(enum.StrEnum):
    LOW_CONFIDENCE = "low_confidence"  # a light attempt reported low confidence
    MANY_SOURCES = "many_sources"  # comparison over many sources
    MULTI_STEP = "multi_step"  # a planned multi-step action (chat)
    LOW_TOOL_CONFIDENCE = "low_tool_confidence"  # unsure which tool to pick (chat)


@dataclass(frozen=True)
class StrongRequest:
    """Evidence for an escalation. Filled by the caller's code, checked here."""

    reason: StrongReason
    confidence: float | None = None
    sources: int | None = None
    steps: int | None = None


class BatchMode(enum.StrEnum):
    OFF = "off"  # someone is waiting for this task
    BULK = "bulk"  # only records nobody is waiting for (import, backlog); live ones run now
    ALWAYS = "always"  # nothing on screen depends on it


LOW_CONFIDENCE_BELOW = 0.6  # spec 5.2
MIN_INPUT_CHARS = 80
MANY_SOURCES_ABOVE = 5  # spec says ">N" without a number [proposal]
MULTI_STEP_FROM = 2

ALWAYS_STRONG = frozenset({LLMTask.KP_EXTRACT, LLMTask.KP_EDIT, LLMTask.PROFILE_EXTRACT,
                           LLMTask.PRICE_LIST_EXTRACT})  # fmt: skip
_CONFIDENCE = frozenset({StrongReason.LOW_CONFIDENCE})
_SOURCES = frozenset({StrongReason.MANY_SOURCES})
ESCALATION_RULES: dict[LLMTask, frozenset[StrongReason]] = {
    LLMTask.ENRICH: _CONFIDENCE,
    LLMTask.EXPENSE_EXTRACT: _CONFIDENCE,
    LLMTask.ANSWER: _SOURCES,
    LLMTask.QUERY_PLAN: _SOURCES,
    LLMTask.ANSWER_GENERAL: _SOURCES,
    LLMTask.STACK_SUMMARY: _SOURCES,
    LLMTask.CHAT: frozenset({StrongReason.MANY_SOURCES, StrongReason.MULTI_STEP,
                             StrongReason.LOW_TOOL_CONFIDENCE}),
}  # fmt: skip
BATCH_CLASSES = frozenset({BudgetClass.BACKGROUND, BudgetClass.IMPORT})


def strong_denial(task: LLMTask, req: StrongRequest, input_chars: int) -> str | None:
    """Why this escalation is not allowed (a short code), or None when it is."""
    if req.reason not in ESCALATION_RULES.get(task, frozenset()):
        return "reason_not_allowed"
    match req.reason:
        case StrongReason.LOW_CONFIDENCE | StrongReason.LOW_TOOL_CONFIDENCE:
            if req.confidence is None or req.confidence >= LOW_CONFIDENCE_BELOW:
                return "confidence_not_low"
            if req.reason is StrongReason.LOW_CONFIDENCE and input_chars < MIN_INPUT_CHARS:
                return "input_too_short"
        case StrongReason.MANY_SOURCES:
            if req.sources is None or req.sources <= MANY_SOURCES_ABOVE:
                return "too_few_sources"
        case StrongReason.MULTI_STEP:
            if req.steps is None or req.steps < MULTI_STEP_FROM:
                return "too_few_steps"
    return None


class _RouteLike(Protocol):
    task: LLMTask
    budget_class: BudgetClass
    tier: Tier
    escalate: Tier | None
    batch: BatchMode


def validate_route(route: _RouteLike) -> None:
    """A route may not grant more than the rules above."""
    if route.tier is Tier.STRONG and route.task not in ALWAYS_STRONG:
        raise ValueError(f"routes: {route.task} may not run on the strong tier")
    if route.task in ALWAYS_STRONG and route.budget_class is not BudgetClass.DOCUMENTS:
        raise ValueError(f"routes: {route.task} must use the documents budget")
    if route.escalate is not None and route.task not in ESCALATION_RULES:
        raise ValueError(f"routes: {route.task} has no escalation rule")
    # The strong-tier tasks are documents, so this also keeps batches on the light tier.
    if route.batch is not BatchMode.OFF and route.budget_class not in BATCH_CLASSES:
        raise ValueError(f"routes: {route.task} ({route.budget_class}) may not use batches")
