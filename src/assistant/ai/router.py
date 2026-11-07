"""AI router (spec 5.2-5.4): one entry point `Router.run` for every LLM task.

Order of checks per call:
1. consent filter (ai_cross_border + its provider list) - before anything else;
2. user budget by profile (may refuse, may forbid escalation);
3. provider plan: enabled, not switched off (quota), within our monthly budget (80% -> end of
   route, 100% -> skipped), fallback emergency daily cap, circuit breaker closed/half-open;
4. PII masking + untrusted wrapping, then providers in order with fallback on 429 (short
   retry-after: wait and retry once), quota/402 (provider off until manual reset), 5xx /
   timeout, invalid output (one repair attempt on the same provider), refusal.
While streaming, a switch happens only before the first token; afterwards -> StreamInterrupted.
Every attempt and every block is a provider_usage row; costs go to provider and user budgets.
"""

import asyncio
import contextlib
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any, TypeVar

from pydantic import BaseModel, ValidationError

from assistant.ai.adapters.base import ProviderAdapter, strict_json_schema
from assistant.ai.breaker import CircuitBreaker
from assistant.ai.budget import Alert, BudgetPolicy, UserDecision, log_alert
from assistant.ai.masking import Masker
from assistant.ai.prompting import TaskInputs, build_messages
from assistant.ai.routes import RouteTable
from assistant.ai.store import AIStore, UsageRecord
from assistant.ai.types import (
    AdapterRequest,
    AdapterResponse,
    AIConsentRequired,
    AIUnavailable,
    BudgetClass,
    BudgetExceeded,
    LLMTask,
    Message,
    Outcome,
    ProviderError,
    ProviderTimeout,
    QuotaExceeded,
    RateLimited,
    Result,
    ServerError,
    StreamInterrupted,
    Tier,
    TokenHook,
    ToolSpec,
    Usage,
)
from assistant.config import Settings

log = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)

STREAM_TOTAL_TIMEOUT_S = 180.0
REPAIR_PROMPT = ("Your previous answer did not match the required JSON schema. Errors: {errors}. "
                 "Answer again with JSON that matches the schema exactly.")  # fmt: skip
_BREAKER_FAILURES = (ServerError, ProviderTimeout, RateLimited)


class _StreamUnmasker:
    """Forwards streamed deltas with placeholders restored; holds back a split `⟨..`."""

    def __init__(self, masker: Masker, hook: TokenHook) -> None:
        self.masker = masker
        self.hook = hook
        self.pending = ""
        self.started = asyncio.Event()

    async def __call__(self, delta: str) -> None:
        self.started.set()
        text = self.pending + delta
        cut = text.rfind("⟨")
        if cut != -1 and "⟩" not in text[cut:] and len(text) - cut < 24:
            self.pending, text = text[cut:], text[:cut]
        else:
            self.pending = ""
        if text:
            await self.hook(self.masker.unmask(text))

    async def flush(self) -> None:
        if self.pending:
            await self.hook(self.masker.unmask(self.pending))
            self.pending = ""


@dataclass
class _Ctx:
    task: LLMTask
    budget_class: BudgetClass
    user_id: int | None
    profile: str | None
    job_id: int | None
    prompt_version: str | None
    images: int


class Router:
    def __init__(
        self, *, settings: Settings, routes: RouteTable, adapters: dict[str, ProviderAdapter],
        store: AIStore, breaker: CircuitBreaker | None = None, alert: Alert = log_alert,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
        monotonic: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], Any] = asyncio.sleep,
    ) -> None:  # fmt: skip
        self.s = settings
        self.routes = routes
        self.adapters = adapters
        self.store = store
        self.alert = alert
        self.clock = clock
        self.monotonic = monotonic
        self.sleep = sleep
        self.breaker = breaker or CircuitBreaker(
            failures=settings.ai_breaker_failures, window_s=settings.ai_breaker_window_s,
            open_s=settings.ai_breaker_open_s, clock=monotonic)  # fmt: skip
        self.budget = BudgetPolicy(settings, store, alert=alert)
        self._fallback_since: float | None = None
        self._fallback_alerted = False

    # --- public ---

    async def run(
        self, task: LLMTask, schema: type[T], inputs: TaskInputs, *, user_id: int | None,
        no_personal_data: bool = False, strong: bool = False, stream: TokenHook | None = None,
        tools: list[ToolSpec] | tuple[ToolSpec, ...] = (), continuing: bool = False,
        job_id: int | None = None,
    ) -> Result[T]:  # fmt: skip
        """Run one task. `user_id=None` is allowed only with `no_personal_data=True`
        (synthetic eval data). `strong` asks for the route's escalation tier; `continuing`
        marks a started document task that must not be cut off by the budget."""
        route = self.routes.route(task)
        now = self.clock()
        ctx = _Ctx(task, route.budget_class, user_id, None, job_id,
                   inputs.prompt_version, len(inputs.images))  # fmt: skip
        first = route.chain[0] if route.chain else "none"

        # 1. consent
        if user_id is None:
            if not no_personal_data:
                raise AIConsentRequired("user_id is required for personal data")
            chain = list(route.chain)
        else:
            allowed = await self.store.consent_providers(user_id)
            chain = [p for p in route.chain if allowed is not None and p in allowed]
            if not chain:
                await self._record(ctx, first, "-", Outcome.CONSENT_BLOCKED)
                raise AIConsentRequired("no active ai_cross_border consent for this route")

        # 2. user budget
        decision = UserDecision(True, False)
        if user_id is not None:
            ctx.profile = await self.store.user_profile(user_id)
            try:
                decision = await self.budget.check_user(
                    user_id, ctx.profile, route.budget_class, now, continuing=continuing)
            except BudgetExceeded as exc:
                await self._record(ctx, chain[0], "-", Outcome.BUDGET_BLOCKED,
                                   error_kind=exc.reason)  # fmt: skip
                raise

        tier = route.tier
        escalation_blocked = False
        if strong and route.escalate is not None:
            if decision.escalation_allowed:
                tier = route.escalate
            else:
                escalation_blocked = True

        # 3. providers
        plan = await self.budget.provider_plan(chain, now)
        order = [p for p in plan.order if p in self.adapters]
        if not order:
            raise AIUnavailable(f"no provider available: {plan.excluded or 'no adapters'}")

        # 4. call
        masker = Masker(mask_contacts=route.mask_contacts)
        system, messages = build_messages(inputs, masker)
        json_schema = strict_json_schema(schema)
        unmasker = _StreamUnmasker(masker, stream) if stream is not None else None

        attempt = 0
        last: Outcome | None = None
        tried: list[str] = []
        for provider in order:
            model = self.routes.model(provider, tier)
            if model is None or not self.breaker.allow(provider, model):
                continue
            fallback_from = tried[0] if tried else None
            tried.append(provider)
            msgs: tuple[Message, ...] = messages
            repaired = retried_429 = False
            while True:
                attempt += 1
                req = AdapterRequest(
                    model=model, system=system, messages=msgs, schema_name=schema.__name__,
                    json_schema=json_schema, tools=tuple(tools), max_tokens=route.max_tokens,
                    timeout_s=route.timeout_s,
                    effort="low" if tier is Tier.LIGHT else "medium", on_token=unmasker,
                )  # fmt: skip
                t0 = self.monotonic()
                try:
                    resp = await self._call(self.adapters[provider], req, route.timeout_s,
                                            unmasker)  # fmt: skip
                except ProviderError as exc:
                    latency = int((self.monotonic() - t0) * 1000)
                    last = exc.outcome
                    await self._account(ctx, provider, model, exc.usage or Usage(), exc.outcome,
                                        latency, attempt, fallback_from, now,
                                        error_kind=type(exc).__name__)  # fmt: skip
                    if unmasker is not None and unmasker.started.is_set():
                        raise StreamInterrupted(type(exc).__name__) from exc
                    if (isinstance(exc, RateLimited) and not retried_429
                            and exc.retry_after is not None
                            and exc.retry_after < self.s.ai_retry_after_max_s):
                        retried_429 = True
                        await self.sleep(exc.retry_after)
                        continue  # fmt: skip
                    await self._after_failure(ctx, provider, model, exc, now)
                    break

                latency = int((self.monotonic() - t0) * 1000)
                data: T | None = None
                if not resp.tool_calls:
                    try:
                        data = schema.model_validate_json(resp.text)
                    except ValidationError as ve:
                        last = Outcome.INVALID_OUTPUT
                        await self._account(ctx, provider, model, resp.usage,
                                            Outcome.INVALID_OUTPUT, latency, attempt,
                                            fallback_from, now, request_id=resp.request_id,
                                            error_kind="ValidationError")  # fmt: skip
                        self.breaker.release(provider, model)
                        if unmasker is not None and unmasker.started.is_set():
                            raise StreamInterrupted("invalid output") from ve
                        if not repaired:
                            repaired = True
                            errors = "; ".join(
                                f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}"
                                for e in ve.errors(include_input=False, include_url=False)
                            )[:2000]
                            msgs = (*messages, Message("assistant", resp.text[:20000]),
                                    Message("user", REPAIR_PROMPT.format(errors=errors)))
                            continue  # fmt: skip
                        break

                self.breaker.record_success(provider, model)
                cost = await self._account(ctx, provider, model, resp.usage, Outcome.OK, latency,
                                           attempt, fallback_from, now,
                                           request_id=resp.request_id)  # fmt: skip
                if unmasker is not None:
                    await unmasker.flush()
                self._track_fallback(provider)
                return self._result(schema, data, resp, masker, provider, cost, attempt,
                                    fallback_from, escalation_blocked, decision.warning)

        raise AIUnavailable(f"all providers failed for {task}: tried {tried}", last_outcome=last)

    # --- internals ---

    async def _call(self, adapter: ProviderAdapter, req: AdapterRequest, timeout_s: float,
                    unmasker: _StreamUnmasker | None) -> AdapterResponse:
        """Whole call within timeout_s; for streams timeout_s is the first-token deadline."""
        if unmasker is None:
            try:
                return await asyncio.wait_for(adapter.generate(req), timeout_s)
            except TimeoutError as exc:
                raise ProviderTimeout("timeout") from exc
        call = asyncio.ensure_future(adapter.generate(req))
        started = asyncio.ensure_future(unmasker.started.wait())
        try:
            done, _ = await asyncio.wait({call, started}, timeout=timeout_s,
                                         return_when=asyncio.FIRST_COMPLETED)  # fmt: skip
            if not done:
                raise ProviderTimeout("first token")
            return await asyncio.wait_for(call, STREAM_TOTAL_TIMEOUT_S)
        except TimeoutError as exc:
            raise ProviderTimeout("stream") from exc
        finally:
            for fut in (call, started):
                if not fut.done():
                    fut.cancel()
                    with contextlib.suppress(asyncio.CancelledError, Exception):
                        await fut

    async def _after_failure(self, ctx: _Ctx, provider: str, model: str, exc: ProviderError,
                             now: datetime) -> None:
        if isinstance(exc, _BREAKER_FAILURES):
            if self.breaker.record_failure(provider, model):
                await self._record(ctx, provider, model, Outcome.CIRCUIT_OPEN)
                log.warning("circuit open for %s/%s", provider, model)
            return
        # Not an availability signal (quota, refusal, bad output, 4xx): a half-open trial
        # ends without a verdict, so the next call may try again.
        self.breaker.release(provider, model)
        if isinstance(exc, QuotaExceeded):
            await self.store.set_provider_off(provider, "quota")
            self.alert(f"{provider}: quota / payment error, provider off until manual reset")

    async def _account(
        self, ctx: _Ctx, provider: str, model: str, usage: Usage, outcome: Outcome,
        latency_ms: int, attempt: int, fallback_from: str | None, now: datetime, *,
        request_id: str | None = None, error_kind: str | None = None,
    ) -> Decimal:  # fmt: skip
        if not self.routes.has_price(model):
            log.warning("no price for model %s, using the default (expensive) price", model)
        cost = self.routes.price(model).cost(usage)
        await self._record(ctx, provider, model, outcome, usage=usage, cost=cost,
                           latency_ms=latency_ms, attempt=attempt, fallback_from=fallback_from,
                           request_id=request_id, error_kind=error_kind)  # fmt: skip
        if cost > 0:
            await self.budget.charge_provider(provider, cost, now)
            if ctx.user_id is not None:
                await self.budget.charge_user(ctx.user_id, ctx.profile, ctx.budget_class,
                                              cost, now)
        return cost

    async def _record(
        self, ctx: _Ctx, provider: str, model: str, outcome: Outcome, *,
        usage: Usage | None = None, cost: Decimal = Decimal(0), latency_ms: int | None = None,
        attempt: int = 1, fallback_from: str | None = None, request_id: str | None = None,
        error_kind: str | None = None,
    ) -> None:  # fmt: skip
        u = usage or Usage()
        rec = UsageRecord(
            task=ctx.task.value, budget_class=ctx.budget_class.value, provider=provider,
            model=model,
            outcome=outcome.value, user_id=ctx.user_id, request_id=request_id,
            tokens_in=u.tokens_in, tokens_out=u.tokens_out, cached_in=u.cached_in,
            cache_write_in=u.cache_write_in, images=ctx.images, cost_usd=cost,
            latency_ms=latency_ms, fallback_from=fallback_from, attempt=attempt,
            job_id=ctx.job_id, prompt_version=ctx.prompt_version, error_kind=error_kind,
        )  # fmt: skip
        try:
            await self.store.record_usage(rec)
        except Exception:  # accounting must never break the user's request
            log.exception("provider_usage write failed")

    def _track_fallback(self, provider: str) -> None:
        if provider == self.s.ai_primary_provider:
            self._fallback_since, self._fallback_alerted = None, False
            return
        now = self.monotonic()
        if self._fallback_since is None:
            self._fallback_since = now
        elif (not self._fallback_alerted
              and now - self._fallback_since > self.s.ai_fallback_alert_minutes * 60):
            self._fallback_alerted = True
            self.alert(f"serving from fallback provider {provider} for more than "
                       f"{self.s.ai_fallback_alert_minutes:g} min")  # fmt: skip

    @staticmethod
    def _result(schema: type[T], data: T | None, resp: AdapterResponse, masker: Masker,
                provider: str, cost: Decimal, attempts: int, fallback_from: str | None,
                escalation_blocked: bool, warning: bool) -> Result[T]:
        if data is not None and len(masker):
            data = schema.model_validate(masker.unmask_obj(data.model_dump(mode="json")))
        calls = [type(c)(c.id, c.name, masker.unmask_obj(c.arguments)) for c in resp.tool_calls]
        return Result(data=data, tool_calls=calls, provider=provider, model=resp.model,
                      usage=resp.usage, cost_usd=cost, attempts=attempts,
                      fallback_from=fallback_from, escalation_blocked=escalation_blocked,
                      budget_warning=warning)  # fmt: skip

