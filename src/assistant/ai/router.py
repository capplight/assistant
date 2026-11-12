"""AI router (spec 5.2-5.4): one entry point `Router.run` for every LLM task.

Order of checks per call:
1. consent filter (ai_cross_border + its provider list) - before anything else;
2. user budget by profile (may refuse, may forbid escalation);
3. provider plan: enabled, not switched off (quota), within our monthly budget (80% -> end of
   route, 100% -> skipped), fallback emergency daily cap, circuit breaker closed/half-open;
4. PII masking + untrusted wrapping, then providers in order with fallback on 429 (short
   retry-after: wait and retry once), quota/402 (provider off until manual reset), 5xx /
   timeout, invalid output (one repair attempt on the same provider), refusal.
While streaming, a switch (or a repair) happens while nothing has reached the person; afterwards
-> StreamInterrupted. "Reached" is the hook's call: a hook that returns False got raw deltas it
has not shown yet (the chat shows only checked sentences of the `answer` field), and its
`reset()`, if it has one, is called before the next attempt so text of a failed attempt is
dropped. A hook that returns None counts every non-empty delta as shown.
Every attempt and every block is a provider_usage row; costs go to provider and user budgets.
"""

import asyncio
import contextlib
import hashlib
import json
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any, TypeVar

from pydantic import BaseModel, ValidationError

from assistant.ai.adapters.base import ProviderAdapter, strict_json_schema
from assistant.ai.breaker import BreakerState, CircuitBreaker
from assistant.ai.budget import Alert, BudgetPolicy, UserDecision, log_alert
from assistant.ai.masking import Masker
from assistant.ai.policy import BatchMode, StrongRequest, strong_denial
from assistant.ai.prompting import TaskInputs, build_messages
from assistant.ai.routes import Route, RouteTable
from assistant.ai.store import AIStore, UsageRecord, period_starts
from assistant.ai.types import (
    AdapterRequest,
    AdapterResponse,
    AIConsentRequired,
    AIUnavailable,
    BadOutput,
    BatchUnavailable,
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
    StaleBatchResult,
    StreamInterrupted,
    Tier,
    TokenHook,
    ToolSpec,
    Usage,
)
from assistant.config import Settings
from assistant.logs import error_text

log = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)

STREAM_TOTAL_TIMEOUT_S = 180.0
BATCH_CACHE_TTL = "1h"  # batches run longer than 5 minutes (Anthropic's advice)
REPAIR_PROMPT = ("Your previous answer did not match the required JSON schema. Errors: {errors}. "
                 "Answer again with JSON that matches the schema exactly.")  # fmt: skip
_BREAKER_FAILURES = (ServerError, ProviderTimeout, RateLimited)


class _StreamUnmasker:
    """Forwards streamed deltas with placeholders restored; holds back a split `⟨..`.

    `started`: a non-empty delta arrived in the current attempt (the first-token deadline).
    `shown`: something reached the person (no switch after that). `fed`: the hook got text in
    the current attempt (reset it before another one). Deltas of an attempt that ended (a call
    being cancelled after a timeout) are dropped."""

    def __init__(self, masker: Masker, hook: TokenHook) -> None:
        self.masker = masker
        self.hook = hook
        self.pending = ""
        self.started = asyncio.Event()
        self.shown = False
        self.fed = False
        self._attempt = 0

    def attempt(self) -> TokenHook:
        """A fresh hook for one provider call."""
        self._attempt += 1
        self.started = asyncio.Event()
        self.pending = ""
        n = self._attempt

        async def on_token(delta: str) -> None:
            if n == self._attempt and delta:
                await self._feed(delta)

        return on_token

    def close(self) -> None:
        """The attempt failed: later deltas of its call are ignored."""
        self._attempt += 1

    async def restart(self) -> None:
        """Before another attempt: the hook forgets the text of the failed one."""
        if self.fed:
            reset = getattr(self.hook, "reset", None)
            if reset is not None:
                reset()
            self.fed = False

    async def _send(self, text: str) -> None:
        self.fed = True
        if await self.hook(text) is not False:
            self.shown = True

    async def _feed(self, delta: str) -> None:
        self.started.set()
        text = self.pending + delta
        cut = text.rfind("⟨")
        if cut != -1 and "⟩" not in text[cut:] and len(text) - cut < 24:
            self.pending, text = text[cut:], text[:cut]
        else:
            self.pending = ""
        if text:
            await self._send(self.masker.unmask(text))

    async def flush(self) -> None:
        if self.pending:
            await self._send(self.masker.unmask(self.pending))
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
    batch: bool = False


@dataclass(frozen=True)
class PreparedBatchRequest:
    """Passed every check; ready to go into a provider batch."""

    request: AdapterRequest
    provider: str
    model: str
    payload_sha256: str


def _payload_hash(system: str, messages: tuple[Message, ...]) -> str:
    """Hash of the masked prompt: it holds no PII. Images are out of scope for batches."""
    body = json.dumps([system, [(m.role, m.text) for m in messages]], ensure_ascii=False)
    return hashlib.sha256(body.encode()).hexdigest()


def _input_chars(inputs: TaskInputs) -> int:
    return sum(len(p.text) for p in inputs.untrusted) + sum(len(c) for c in inputs.context)


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
        no_personal_data: bool = False, strong: StrongRequest | None = None,
        stream: TokenHook | None = None,
        tools: list[ToolSpec] | tuple[ToolSpec, ...] = (), continuing: bool = False,
        job_id: int | None = None, masker: Masker | None = None,
        pin_provider: str | None = None, tool_choice: str = "auto",
        avoid: tuple[str, ...] = (),
    ) -> Result[T]:  # fmt: skip
        """Run one task. `user_id=None` is allowed only with `no_personal_data=True`
        (synthetic eval data). `strong` asks for the route's escalation tier with the evidence
        ai/policy.py checks (denied = runs light); `continuing` marks a started document task
        that must not be cut off by the budget.

        Tool loops (CHAT): pass one `masker` for every step of the turn (stable placeholders),
        and `pin_provider` = the provider of the first step: after a tool call there is no
        switch (spec 5.5). Consent, budgets and the provider plan are still checked each step;
        a pinned provider that is no longer allowed -> AIUnavailable. `avoid`: providers that
        already failed this turn (the caller moves a tool loop on while nothing was shown)."""
        route = self.routes.route(task)
        now = self.clock()
        ctx = _Ctx(task, route.budget_class, user_id, None, job_id,
                   inputs.prompt_version, len(inputs.images))  # fmt: skip

        chain, decision = await self._admit(ctx, route, user_id, now, no_personal_data, continuing)

        tier = route.tier
        denied = None
        if strong is not None:
            denied = await self._escalation_denial(task, route, strong, inputs, user_id, decision,
                                                   now)  # fmt: skip
            if denied is None:
                assert route.escalate is not None
                tier = route.escalate
            else:
                log.info("escalation denied for %s: %s", task, denied)

        # 3. providers
        plan = await self.budget.provider_plan(chain, now)
        order = [p for p in plan.order if p in self.adapters]
        if pin_provider is not None:
            order = [p for p in order if p == pin_provider]
        order = [p for p in order if p not in avoid]
        if not order:
            raise AIUnavailable(f"no provider available: {plan.excluded or 'no adapters'}")

        # 4. call
        masker = masker if masker is not None else Masker(mask_contacts=route.mask_contacts)
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
                if unmasker is not None:
                    await unmasker.restart()
                req = AdapterRequest(
                    model=model, system=system, messages=msgs, schema_name=schema.__name__,
                    json_schema=json_schema, tools=tuple(tools), max_tokens=route.max_tokens,
                    timeout_s=route.timeout_s, cache_ttl=route.cache_ttl,
                    effort="low" if tier is Tier.LIGHT else "medium",
                    on_token=unmasker.attempt() if unmasker is not None else None,
                    tool_choice=tool_choice if tools else "auto",
                )  # fmt: skip
                t0 = self.monotonic()
                try:
                    resp = await self._call(self.adapters[provider], req, route.timeout_s,
                                            unmasker)  # fmt: skip
                except ProviderError as exc:
                    if unmasker is not None:
                        unmasker.close()
                    latency = int((self.monotonic() - t0) * 1000)
                    last = exc.outcome
                    # The reason, short: a 400 from a provider names the schema field it rejected.
                    log.warning("%s: %s/%s failed (%s): %s", task, provider, model,
                                type(exc).__name__, error_text(exc)[:300])  # fmt: skip
                    await self._account(ctx, provider, model, exc.usage or Usage(), exc.outcome,
                                        latency, attempt, fallback_from, now,
                                        error_kind=type(exc).__name__)  # fmt: skip
                    if unmasker is not None and unmasker.shown:
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
                        log.warning("%s: %s/%s answer failed validation (%d errors)", task,
                                    provider, model, ve.error_count())  # fmt: skip
                        await self._account(ctx, provider, model, resp.usage,
                                            Outcome.INVALID_OUTPUT, latency, attempt,
                                            fallback_from, now, request_id=resp.request_id,
                                            error_kind="ValidationError")  # fmt: skip
                        self.breaker.release(provider, model)
                        if unmasker is not None and unmasker.shown:
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
                                    fallback_from, denied, decision.warning)

        raise AIUnavailable(f"all providers failed for {task}: tried {tried}", last_outcome=last)

    async def escalation_denial(self, task: LLMTask, req: StrongRequest, inputs: TaskInputs,
                                user_id: int | None) -> str | None:  # fmt: skip
        """Ask before paying for a second attempt: run(strong=...) re-checks all of it."""
        route = self.routes.route(task)
        now = self.clock()
        decision = UserDecision(True, False)
        if user_id is not None:
            profile = await self.store.user_profile(user_id)
            try:
                decision = await self.budget.check_user(user_id, profile, route.budget_class, now)
            except BudgetExceeded:
                return "over_budget"
        return await self._escalation_denial(task, route, req, inputs, user_id, decision, now)

    # --- provider batches (ai/policy.py BatchMode; the caller owns queueing and polling) ---

    def batching_available(self, task: LLMTask) -> bool:
        adapter = self.adapters.get(self.s.ai_primary_provider)
        return (self.routes.route(task).batch is not BatchMode.OFF
                and getattr(adapter, "supports_batch", False))  # fmt: skip

    async def charge_batch_answer(self, task: LLMTask, provider: str, model: str,
                                  response: AdapterResponse, *,
                                  user_id: int | None) -> Decimal:  # fmt: skip
        """An answer nobody will use (record deleted, or pulled out and done live): still paid."""
        route = self.routes.route(task)
        ctx = _Ctx(task, route.budget_class, user_id, None, None, None, 0, batch=True)
        if user_id is not None:
            ctx.profile = await self.store.user_profile(user_id)
        return await self._account(ctx, provider, model, response.usage, Outcome.OK, None, 1, None,
                                   self.clock(), request_id=response.request_id)  # fmt: skip

    async def prepare_batch(self, task: LLMTask, schema: type[T], inputs: TaskInputs, *,
                            user_id: int) -> PreparedBatchRequest:  # fmt: skip
        """All checks of a live call, at sending time. BatchUnavailable = run the task live.
        Budgets are charged when results arrive (finish_batch)."""
        route = self.routes.route(task)
        if route.batch is BatchMode.OFF:
            raise BatchUnavailable(f"batches are off for {task}")
        now = self.clock()
        ctx = _Ctx(task, route.budget_class, user_id, None, None, inputs.prompt_version,
                   len(inputs.images), batch=True)  # fmt: skip
        chain, _ = await self._admit(ctx, route, user_id, now, False, False)
        plan = await self.budget.provider_plan(chain, now)
        provider = self.s.ai_primary_provider
        # Only the primary, while it is first in line. Anything else goes the normal live way.
        if not plan.order or plan.order[0] != provider:
            raise BatchUnavailable("primary provider is not first on the route")
        adapter = self.adapters.get(provider)
        model = self.routes.model(provider, route.tier)
        if adapter is None or model is None or not getattr(adapter, "supports_batch", False):
            raise BatchUnavailable(f"{provider} has no batch support")
        if self.breaker.state(provider, model) is not BreakerState.CLOSED:
            raise BatchUnavailable("circuit is not closed")
        masker = Masker(mask_contacts=route.mask_contacts)
        system, messages = build_messages(inputs, masker)
        req = AdapterRequest(
            model=model, system=system, messages=messages, schema_name=schema.__name__,
            json_schema=strict_json_schema(schema), max_tokens=route.max_tokens,
            timeout_s=route.timeout_s, effort="low",
            cache_ttl=None if route.cache_ttl is None else BATCH_CACHE_TTL,
        )  # fmt: skip
        return PreparedBatchRequest(req, provider, model, _payload_hash(system, messages))

    async def finish_batch(
        self, task: LLMTask, schema: type[T], inputs: TaskInputs, *, user_id: int, provider: str,
        model: str, payload_sha256: str, response: AdapterResponse,
    ) -> Result[T]:  # fmt: skip
        """One successful batch answer: charge at the batch price, then validate and unmask.

        Raises AIConsentRequired (revoked since sending; the answer is dropped), StaleBatchResult
        (the record changed) or BadOutput. `inputs` are rebuilt by the caller: the masking table
        lives only in memory, so it is recomputed from the same text."""
        route = self.routes.route(task)
        now = self.clock()
        ctx = _Ctx(task, route.budget_class, user_id, None, None, inputs.prompt_version,
                   len(inputs.images), batch=True)  # fmt: skip
        ctx.profile = await self.store.user_profile(user_id)
        cost = await self._account(ctx, provider, model, response.usage, Outcome.OK, None, 1, None,
                                   now, request_id=response.request_id)  # fmt: skip
        allowed = await self.store.consent_providers(user_id)
        if allowed is None or provider not in allowed:
            raise AIConsentRequired("consent revoked while the batch ran")
        masker = Masker(mask_contacts=route.mask_contacts)
        system, messages = build_messages(inputs, masker)
        if _payload_hash(system, messages) != payload_sha256:
            raise StaleBatchResult(str(task))
        try:
            data = schema.model_validate_json(response.text)
        except ValidationError as ve:
            await self._record(ctx, provider, model, Outcome.INVALID_OUTPUT,
                               error_kind="ValidationError")  # fmt: skip
            raise BadOutput("batch answer failed validation") from ve
        return self._result(schema, data, response, masker, provider, cost, 1, None, None, False)

    # --- internals ---

    async def _admit(self, ctx: _Ctx, route: Route, user_id: int | None, now: datetime,
                     no_personal_data: bool, continuing: bool) -> tuple[list[str], UserDecision]:
        """1. consent, 2. user budget. Raises before anything leaves the country."""
        first = route.chain[0] if route.chain else "none"
        if user_id is None:
            if not no_personal_data:
                raise AIConsentRequired("user_id is required for personal data")
            return list(route.chain), UserDecision(True, False)
        allowed = await self.store.consent_providers(user_id)
        chain = [p for p in route.chain if allowed is not None and p in allowed]
        if not chain:
            await self._record(ctx, first, "-", Outcome.CONSENT_BLOCKED)
            raise AIConsentRequired("no active ai_cross_border consent for this route")
        ctx.profile = await self.store.user_profile(user_id)
        try:
            decision = await self.budget.check_user(
                user_id, ctx.profile, route.budget_class, now, continuing=continuing)
        except BudgetExceeded as exc:
            await self._record(ctx, chain[0], "-", Outcome.BUDGET_BLOCKED, error_kind=exc.reason)
            raise
        return chain, decision

    async def _escalation_denial(self, task: LLMTask, route: Route, req: StrongRequest,
                                 inputs: TaskInputs, user_id: int | None,
                                 decision: UserDecision, now: datetime) -> str | None:  # fmt: skip
        if route.escalate is None:
            return "no_escalation_on_route"
        denied = strong_denial(task, req, _input_chars(inputs))
        if denied is not None:
            return denied
        if not decision.escalation_allowed:
            return "over_budget"
        if user_id is not None:
            day, _ = period_starts(now, self.s.budget_tz)
            used = await self.store.strong_calls_since(user_id, day, self.routes.strong_models())
            if used >= self.s.ai_strong_daily_per_user:
                return "daily_cap"
        return None


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
            if not call.done():
                unmasker.close()  # whatever the cancelled call still streams is dropped
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
        multiplier = self.routes.batch_multiplier(provider) if ctx.batch else Decimal(1)
        cost = self.routes.price(model).cost(usage, multiplier)
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
            cache_write_in=u.cache_write_in + u.cache_write_1h_in, images=ctx.images,
            cost_usd=cost, batch=ctx.batch, created_at=self.clock(),
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
                denied: str | None, warning: bool) -> Result[T]:
        if data is not None and len(masker):
            data = schema.model_validate(masker.unmask_obj(data.model_dump(mode="json")))
        calls = [type(c)(c.id, c.name, masker.unmask_obj(c.arguments)) for c in resp.tool_calls]
        return Result(data=data, tool_calls=calls, provider=provider, model=resp.model,
                      usage=resp.usage, cost_usd=cost, attempts=attempts,
                      fallback_from=fallback_from, escalation_blocked=denied is not None,
                      escalation_denied=denied, budget_warning=warning,
                      raw=resp.raw)  # fmt: skip

