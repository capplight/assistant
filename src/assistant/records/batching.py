"""Provider batches for enrichment (about half price, up to hours of delay; routes.yaml `batch`).

Worker tick, safe to run from any number of workers (SKIP LOCKED):
    flush_batches: queued requests -> claim -> prepare (consent, budget) -> provider batch
    poll_batches:  ended batch -> charge at batch price -> validate -> store; past its deadline
                   -> cancel; anything that failed, expired or was cancelled -> a live job

Rows hold no text. The prompt is rebuilt from the record, both to send it and to read the answer:
the masking table lives only in memory (spec 5.7), and a changed record no longer matches
payload_sha256, so an answer about old text is dropped. A record the person opens is pulled out
(enrich.promote_if_waiting). Batch answers never escalate to the strong model (ai/policy.py).
No transaction is open during a provider call.
"""

import logging
from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from assistant.ai import (
    AIConsentRequired,
    BadOutput,
    BatchUnavailable,
    BudgetExceeded,
    LLMTask,
    PreparedBatchRequest,
    ProviderError,
    Router,
    StaleBatchResult,
)
from assistant.config import Settings
from assistant.db.models import Item
from assistant.db.models_ai import AIBatch, AIBatchRequest
from assistant.db.models_v2 import EnrichState
from assistant.logs import error_text
from assistant.records import enrich, store

log = logging.getLogger(__name__)

TASK = LLMTask.ENRICH
MAX_PER_BATCH = 1000
STUCK_SUBMITTING = timedelta(hours=1)


def _custom_id(request_id: int) -> str:
    return f"r{request_id}"


async def batch_tick(maker: async_sessionmaker[AsyncSession], router: Router,
                     settings: Settings) -> None:  # fmt: skip
    await _release_stuck(maker)
    await flush_batches(maker, router, settings)
    await poll_batches(maker, router, settings)


async def _release_stuck(maker: async_sessionmaker[AsyncSession]) -> None:
    """A worker died between claiming and sending. If the batch did reach the provider we pay for
    an unused answer; the record still gets its enrichment."""
    cutoff = store.now_utc() - STUCK_SUBMITTING
    async with maker() as s:
        stuck = list(await s.scalars(
            select(AIBatch).where(AIBatch.status == "submitting", AIBatch.created_at < cutoff)
            .with_for_update(skip_locked=True)
        ))  # fmt: skip
        for batch in stuck:
            batch.status, batch.error_kind = "failed", "stuck"
            rows = await s.scalars(select(AIBatchRequest).where(
                AIBatchRequest.batch_id == batch.id, AIBatchRequest.state == "submitted"))
            for row in rows:
                row.state, row.batch_id = "queued", None
        await s.commit()


async def flush_batches(maker: async_sessionmaker[AsyncSession], router: Router,
                        settings: Settings) -> int:  # fmt: skip
    """Send what has queued up. Returns how many requests went out."""
    if not router.batching_available(TASK):
        await _all_queued_go_live(maker)
        return 0
    provider = settings.ai_primary_provider
    route = router.routes.route(TASK)
    model = router.routes.model(provider, route.tier)
    assert model is not None
    claimed = await _claim(maker, settings, provider, model, route.batch_max_wait_h)
    if claimed is None:
        return 0
    batch_id, rows = claimed

    # Prepare outside the claim's transaction: the store opens its own short sessions.
    prepared: list[tuple[int, PreparedBatchRequest]] = []
    for request_id, item_id, user_id in rows:
        async with maker() as s:
            item = await s.get(Item, item_id)
            inputs = enrich.build_inputs(item) if item and enrich.enrichable(item) else None
        if inputs is None:
            await _close_request(maker, request_id, "superseded")
            continue
        try:
            prepared.append((request_id, await router.prepare_batch(
                TASK, enrich.Envelope, inputs, user_id=user_id)))  # fmt: skip
        except AIConsentRequired:
            await _close_request(maker, request_id, "failed", item_state=EnrichState.NO_CONSENT)
        except BudgetExceeded as exc:
            await _close_request(maker, request_id, "failed", budget=exc.reason,
                                 tz=router.s.budget_tz)  # fmt: skip
        except BatchUnavailable:
            await _to_live(maker, request_id, "unavailable")
    if not prepared:
        await _finish_batch_row(maker, batch_id, "ended", None)
        return 0

    adapter = router.adapters[provider]
    try:
        provider_id = await adapter.submit_batch(  # type: ignore[attr-defined]
            [(_custom_id(rid), p.request) for rid, p in prepared])
    except ProviderError as exc:
        log.warning("batch %s: submit failed: %s", batch_id, type(exc).__name__)
        for rid, _ in prepared:
            await _to_live(maker, rid, "submit_failed")
        await _finish_batch_row(maker, batch_id, "failed", type(exc).__name__)
        return 0

    async with maker() as s:
        batch = await s.get(AIBatch, batch_id, with_for_update=True)
        assert batch is not None
        batch.provider_batch_id = provider_id
        batch.status = "in_progress"
        batch.request_count = len(prepared)
        batch.next_poll_at = store.now_utc() + timedelta(seconds=settings.ai_batch_poll_seconds)
        for rid, p in prepared:
            row = await s.get(AIBatchRequest, rid)
            if row is not None:
                row.payload_sha256 = p.payload_sha256
        await s.commit()
    log.info("batch %s sent: %s requests", batch_id, len(prepared))
    return len(prepared)


async def _claim(
    maker: async_sessionmaker[AsyncSession], settings: Settings, provider: str, model: str,
    max_wait_h: float,
) -> tuple[int, list[tuple[int, int, int]]] | None:  # fmt: skip
    """Queued -> submitted, under a new ai_batches row. None: too early, or nothing to send."""
    now = store.now_utc()
    async with maker() as s:
        queued = AIBatchRequest.state == "queued"
        count, oldest = (await s.execute(
            select(func.count(), func.min(AIBatchRequest.created_at)).where(queued)
        )).one()  # fmt: skip
        if not count:
            await s.commit()
            return None
        waited = (now - oldest).total_seconds()
        if (count < settings.ai_batch_flush_min_requests
                and waited < settings.ai_batch_flush_seconds):  # fmt: skip
            await s.commit()
            return None
        # Users with a batch still running wait: their wallet has not seen those costs yet.
        busy = select(AIBatchRequest.user_id).where(AIBatchRequest.state == "submitted")
        rows = list(await s.scalars(
            select(AIBatchRequest).where(queued, AIBatchRequest.user_id.not_in(busy))
            .order_by(AIBatchRequest.created_at).limit(MAX_PER_BATCH)
            .with_for_update(skip_locked=True)
        ))  # fmt: skip
        per_user: dict[int, int] = {}
        chosen = []
        for row in rows:
            n = per_user.get(row.user_id, 0)
            if n < settings.ai_batch_user_requests:
                per_user[row.user_id] = n + 1
                chosen.append(row)
        if not chosen:
            await s.commit()
            return None
        batch = AIBatch(provider=provider, model=model, task=TASK.value, status="submitting",
                        request_count=len(chosen), next_poll_at=now,
                        deadline_at=now + timedelta(hours=max_wait_h))  # fmt: skip
        s.add(batch)
        await s.flush()
        out = []
        for row in chosen:
            row.batch_id, row.state = batch.id, "submitted"
            out.append((row.id, row.item_id, row.user_id))
        batch_id = batch.id
        await s.commit()
    return batch_id, out


async def poll_batches(maker: async_sessionmaker[AsyncSession], router: Router,
                       settings: Settings) -> int:  # fmt: skip
    """Handle each due batch once, one short claim each. Returns how many finished."""
    finished = 0
    seen: list[int] = []
    while True:
        now = store.now_utc()
        async with maker() as s:
            batch = await s.scalar(
                select(AIBatch)
                .where(AIBatch.status.in_(("in_progress", "canceling")),
                       AIBatch.next_poll_at <= now, AIBatch.id.not_in(seen))
                .order_by(AIBatch.next_poll_at).limit(1).with_for_update(skip_locked=True)
            )  # fmt: skip
            if batch is None:
                await s.commit()
                return finished
            batch.next_poll_at = now + timedelta(seconds=settings.ai_batch_poll_seconds)
            batch_id, provider, model = batch.id, batch.provider, batch.model
            seen.append(batch_id)
            provider_id, status, deadline = batch.provider_batch_id, batch.status, batch.deadline_at
            await s.commit()
        adapter = router.adapters.get(provider)
        if adapter is None or provider_id is None:
            log.warning("batch %s: no adapter for %s", batch_id, provider)
            continue
        try:
            if not await adapter.batch_ended(provider_id):  # type: ignore[attr-defined]
                if now >= deadline and status != "canceling":
                    await adapter.cancel_batch(provider_id)  # type: ignore[attr-defined]
                    await _set_batch_status(maker, batch_id, "canceling")
                continue
            entries = await adapter.batch_results(provider_id)  # type: ignore[attr-defined]
        except ProviderError as exc:
            log.warning("batch %s: poll failed: %s", batch_id, type(exc).__name__)
            continue
        for entry in entries:
            await _handle_entry(maker, router, batch_id, provider, model, entry)
        await _sweep_unanswered(maker, batch_id)
        await _finish_batch_row(maker, batch_id, "ended", None)
        finished += 1


async def _handle_entry(maker: async_sessionmaker[AsyncSession], router: Router, batch_id: int,
                        provider: str, model: str, entry) -> None:  # type: ignore[no-untyped-def]  # fmt: skip
    request_id = int(entry.custom_id.removeprefix("r"))
    async with maker() as s:
        row = await s.get(AIBatchRequest, request_id)
        if row is None or row.batch_id != batch_id:  # the record was deleted: still our money
            row_state = sha = user_id = item_id = None
        else:
            row_state, sha = row.state, row.payload_sha256
            user_id, item_id = row.user_id, row.item_id
        item = await s.get(Item, item_id) if item_id else None
        inputs = enrich.build_inputs(item) if item is not None else None
        text_sha = enrich.text_fingerprint(item.text) if item is not None else None

    if entry.error is not None or entry.response is None:  # not billed
        if row_state == "submitted":
            await _to_live(maker, request_id, type(entry.error).__name__)
        return
    if row_state != "submitted" or inputs is None or sha is None or user_id is None:
        await router.charge_batch_answer(TASK, provider, model, entry.response, user_id=user_id)
        return
    try:
        result = await router.finish_batch(
            TASK, enrich.Envelope, inputs, user_id=user_id, provider=provider, model=model,
            payload_sha256=sha, response=entry.response)  # fmt: skip
    except AIConsentRequired:
        await _close_request(maker, request_id, "failed", item_state=EnrichState.NO_CONSENT)
        return
    except StaleBatchResult:
        await _to_live(maker, request_id, "stale", state="superseded")
        return
    except BadOutput:
        await _to_live(maker, request_id, "invalid_output")
        return
    assert result.data is not None and text_sha is not None
    try:
        await enrich.store_envelope(maker, item_id, text_sha, result.data, provider=provider,
                                    model=model, escalated=False)  # fmt: skip
    except Exception as exc:  # paid for and charged: do not lose the rest of the batch
        log.warning("batch request %s: store failed: %s", request_id, error_text(exc))
        await _to_live(maker, request_id, "store_failed")
        return
    await _close_request(maker, request_id, "done")


async def _sweep_unanswered(maker: async_sessionmaker[AsyncSession], batch_id: int) -> None:
    """A batch ended without a line for some request: run those live."""
    async with maker() as s:
        ids = list(await s.scalars(select(AIBatchRequest.id).where(
            AIBatchRequest.batch_id == batch_id, AIBatchRequest.state == "submitted")))
    for rid in ids:
        await _to_live(maker, rid, "no_result")


async def _close_request(maker: async_sessionmaker[AsyncSession], request_id: int, state: str, *,
                         item_state: str | None = None, budget: str | None = None,
                         tz: str = "UTC") -> None:  # fmt: skip
    async with maker() as s:
        row = await s.get(AIBatchRequest, request_id, with_for_update=True)
        if row is None:
            await s.commit()
            return
        row.state, row.done_at = state, store.now_utc()
        item = await s.get(Item, row.item_id, with_for_update=True)
        if item is not None and budget is not None:
            await s.flush()  # frees the open-request slot before the record is parked again
            await enrich.defer_for_budget(s, item, budget, store.now_utc(), tz)
        elif item is not None and item_state:
            item.enrich_state = item_state
        await s.commit()


async def _to_live(maker: async_sessionmaker[AsyncSession], request_id: int, why: str, *,
                   state: str = "failed") -> None:  # fmt: skip
    """The batch did not work out for this record: a normal live job, at once."""
    async with maker() as s:
        row = await s.get(AIBatchRequest, request_id, with_for_update=True)
        if row is None:
            await s.commit()
            return
        row.state, row.done_at = state, store.now_utc()
        item = await s.get(Item, row.item_id, with_for_update=True)
        if item is not None:
            await enrich.enqueue_enrich(s, item, suffix=f":batch:{request_id}", live=True)
        await s.commit()
    log.info("batch request %s goes live: %s", request_id, why)


async def _all_queued_go_live(maker: async_sessionmaker[AsyncSession]) -> None:
    async with maker() as s:
        ids = list(await s.scalars(select(AIBatchRequest.id).where(
            AIBatchRequest.state == "queued").limit(MAX_PER_BATCH)))
    for rid in ids:
        await _to_live(maker, rid, "batching_unavailable")


async def _finish_batch_row(maker: async_sessionmaker[AsyncSession], batch_id: int, status: str,
                            error_kind: str | None) -> None:  # fmt: skip
    async with maker() as s:
        batch = await s.get(AIBatch, batch_id, with_for_update=True)
        if batch is not None:
            batch.status, batch.error_kind = status, error_kind
            batch.ended_at = store.now_utc()
        await s.commit()


async def _set_batch_status(maker: async_sessionmaker[AsyncSession], batch_id: int,
                            status: str) -> None:  # fmt: skip
    async with maker() as s:
        batch = await s.get(AIBatch, batch_id, with_for_update=True)
        if batch is not None:
            batch.status = status
        await s.commit()
