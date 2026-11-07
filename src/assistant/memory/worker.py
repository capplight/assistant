"""worker-embed: `python -m assistant.memory` (spec 1). Claims `embed:item` jobs, picks up records
with no chunks yet, and once a night rebuilds page summaries.

No embedder configured: no job is claimed, they wait; search runs on words and typos (spec 8.1).
"""

import asyncio
import logging
import time

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from assistant.db import queue
from assistant.db.models import Job
from assistant.embeddings import ChunkEmbedder
from assistant.logs import error_text
from assistant.memory.embed_jobs import JOB_EMBED, enqueue_missing, run_embed
from assistant.memory.summaries import rebuild_summaries

log = logging.getLogger("assistant.memory.worker")
BACKFILL_EVERY_SECONDS = 60.0
SUMMARIES_EVERY_SECONDS = 24 * 3600.0


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


async def backfill_once(maker: async_sessionmaker[AsyncSession], model: str) -> int:
    async with maker() as s:
        n = await enqueue_missing(s, model)
        await s.commit()
    return n


async def worker_loop(maker: async_sessionmaker[AsyncSession], embedder: ChunkEmbedder,
                      stop: asyncio.Event, poll: float) -> None:  # fmt: skip
    next_backfill = 0.0
    next_summaries = time.monotonic() + SUMMARIES_EVERY_SECONDS
    ready = bool(embedder.dim)
    if not ready:
        log.warning("no embedder configured (TEI_URL): chunks wait, search runs without meaning")
    while not stop.is_set():
        busy = False
        try:
            if time.monotonic() >= next_summaries:
                next_summaries = time.monotonic() + SUMMARIES_EVERY_SECONDS
                await rebuild_summaries(maker)
            if ready:
                if time.monotonic() >= next_backfill:
                    next_backfill = time.monotonic() + BACKFILL_EVERY_SECONDS
                    await backfill_once(maker, embedder.model)
                busy = await run_one(maker, embedder)
        except Exception:
            log.exception("embed worker loop error")
        if not busy:
            try:
                await asyncio.wait_for(stop.wait(), timeout=poll)
            except TimeoutError:
                pass
