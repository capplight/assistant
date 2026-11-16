"""worker-embed: `python -m assistant.memory` (spec 1). Claims `embed:item` jobs, picks up records
with no chunks yet, and once a night rebuilds page summaries.

No embedder configured: no job is claimed, they wait; search runs on words and typos (spec 8.1).
Embedder switched off (DeepInfra: no balance, bad key, outage): the job goes back to the queue
without using an attempt, nothing is claimed until the embedder's pause ends, one ops alert per
reason per day (kind `provider_off`). When it works again the back-fill picks up every record
still without chunks.
"""

import asyncio
import logging
import time
from datetime import UTC, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from assistant.ai import record_ops_alert
from assistant.db import queue
from assistant.db.models import Job, JobStatus
from assistant.embeddings import (
    ChunkEmbedder,
    EmbedderUnavailable,
    embedder_available,
    recipient_of,
)
from assistant.logs import error_text
from assistant.memory.embed_jobs import JOB_EMBED, enqueue_missing, run_embed
from assistant.memory.summaries import rebuild_summaries

log = logging.getLogger("assistant.memory.worker")
BACKFILL_EVERY_SECONDS = 60.0
SUMMARIES_EVERY_SECONDS = 24 * 3600.0
DOWN_RETRY_SECONDS = 300.0


async def run_one(maker: async_sessionmaker[AsyncSession], embedder: ChunkEmbedder) -> bool:
    """Claim and run one job. Returns False when there was none."""
    async with maker() as s:
        job = await queue.claim(s, [JOB_EMBED])
        await s.commit()
        if job is None:
            return False
        job_id, payload, locked_at = job.id, job.payload or {}, job.locked_at
    item_id = payload.get("item_id")
    error: str | None = None
    if not isinstance(item_id, int):
        error = "bad payload: no item_id"
    else:
        try:
            await run_embed(maker, embedder, item_id)
        except EmbedderUnavailable as e:
            await _put_back(maker, job_id, locked_at, e.reason)
            await _alert_down(maker, embedder, e.reason)
            return False
        except Exception as e:
            error = error_text(e)
            log.warning("embed job %s (item %s) failed: %s", job_id, item_id, error)
    async with maker() as s:
        job = await s.get(Job, job_id, with_for_update=True)
        # Queued anew while running (the text changed): that run decides.
        if job is not None and queue.still_mine(job, locked_at):
            if error is None:
                await queue.complete(s, job)
            else:
                await queue.fail(s, job, error)
        await s.commit()
    return True


async def _put_back(maker: async_sessionmaker[AsyncSession], job_id: int,
                    locked_at: datetime | None, reason: str) -> None:  # fmt: skip
    """Not the job's fault: queued again later, the attempt doesn't count."""
    async with maker() as s:
        job = await s.get(Job, job_id, with_for_update=True)
        if job is not None and queue.still_mine(job, locked_at):
            job.status = JobStatus.QUEUED
            job.locked_at = None
            job.attempts = max(0, job.attempts - 1)
            job.last_error = f"embedder unavailable: {reason}"
            job.run_after = datetime.now(UTC) + timedelta(seconds=DOWN_RETRY_SECONDS)
        await s.commit()


async def _alert_down(maker: async_sessionmaker[AsyncSession], embedder: ChunkEmbedder,
                      reason: str) -> None:  # fmt: skip
    day = datetime.now(UTC).date().isoformat()
    name = recipient_of(embedder) or embedder.model
    text = {"no_balance": f"{name}: no balance, search by meaning is off (top up the account)",
            "auth": f"{name}: key rejected, search by meaning is off"}.get(
                reason, f"{name}: unreachable, search by meaning is off for now")  # fmt: skip
    try:
        async with maker() as s:
            await record_ops_alert(s, "provider_off", f"embedder:{name}:{reason}:{day}", text,
                                   {"model": embedder.model, "reason": reason})  # fmt: skip
            await s.commit()
    except Exception as e:  # an alert must never stop the worker
        log.warning("ops alert not stored: %s", error_text(e))


async def backfill_once(maker: async_sessionmaker[AsyncSession], embedder: ChunkEmbedder) -> int:
    async with maker() as s:
        n = await enqueue_missing(s, embedder.model, recipient=recipient_of(embedder))
        await s.commit()
    return n


async def worker_loop(maker: async_sessionmaker[AsyncSession], embedder: ChunkEmbedder,
                      stop: asyncio.Event, poll: float) -> None:  # fmt: skip
    next_backfill = 0.0
    next_summaries = time.monotonic() + SUMMARIES_EVERY_SECONDS
    ready = bool(embedder.dim)
    if not ready:
        log.warning("no embedder configured (CHUNK_EMBEDDER): chunks wait, search runs on words")
    while not stop.is_set():
        busy = False
        try:
            if time.monotonic() >= next_summaries:
                next_summaries = time.monotonic() + SUMMARIES_EVERY_SECONDS
                await rebuild_summaries(maker)
            if ready and embedder_available(embedder):
                if time.monotonic() >= next_backfill:
                    next_backfill = time.monotonic() + BACKFILL_EVERY_SECONDS
                    await backfill_once(maker, embedder)
                busy = await run_one(maker, embedder)
        except Exception:
            log.exception("embed worker loop error")
        if not busy:
            try:
                await asyncio.wait_for(stop.wait(), timeout=poll)
            except TimeoutError:
                pass
