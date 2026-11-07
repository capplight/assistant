"""Ingest worker: `python -m assistant.records`. Claims `ingest:*` jobs from the shared queue.

Separate from the legacy bot worker (`python -m assistant.worker`, process_item) so it needs no
Telegram token. Once an hour it also purges records whose 30 days in the trash are over.
"""

import asyncio
import logging
import signal
import time

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from assistant.db import queue
from assistant.db.models import Job
from assistant.db.models_v2 import RecordKind
from assistant.logs import error_text
from assistant.records import store
from assistant.records.ingest import JOB_PREFIX, IngestDeps, give_up, run_ingest

log = logging.getLogger("assistant.records.worker")
PURGE_EVERY_SECONDS = 3600


INGEST_JOB_KINDS = [f"{JOB_PREFIX}{k}" for k in RecordKind]


async def run_one(maker: async_sessionmaker[AsyncSession], deps: IngestDeps) -> bool:
    """Claim and run one ingest job. Returns False when there was none."""
    async with maker() as s:
        job = await queue.claim(s, INGEST_JOB_KINDS)
        await s.commit()
    if job is None:
        return False
    job_id = job.id
    item_id = (job.payload or {}).get("item_id")
    error: str | None = None
    if not isinstance(item_id, int):
        error = "bad payload: no item_id"
    else:
        try:
            await run_ingest(maker, item_id, deps)
        except Exception as e:
            error = error_text(e)
            log.warning("ingest job %s (item %s) failed: %s", job_id, item_id, error)

    async with maker() as s:
        job = await s.get(Job, job_id, with_for_update=True)
        if job is None:
            return True
        if error is None:
            await queue.complete(s, job)
            await s.commit()
            return True
        gave_up = await queue.fail(s, job, error)
        await s.commit()
    if gave_up and isinstance(item_id, int):
        await give_up(maker, item_id)
    return True


async def purge_once(maker: async_sessionmaker[AsyncSession]) -> int:
    async with maker() as s:
        n = await store.purge_trashed_items(s)
        await s.commit()
    return n


async def worker_loop(maker: async_sessionmaker[AsyncSession], deps: IngestDeps,
                      stop: asyncio.Event, poll: float) -> None:  # fmt: skip
    next_purge = 0.0
    while not stop.is_set():
        busy = False
        try:
            if time.monotonic() >= next_purge:
                next_purge = time.monotonic() + PURGE_EVERY_SECONDS
                purged = await purge_once(maker)
                if purged:
                    log.info("purged %s records from trash", purged)
            busy = await run_one(maker, deps)
        except Exception:
            log.exception("ingest worker loop error")
        if not busy:
            try:
                await asyncio.wait_for(stop.wait(), timeout=poll)
            except TimeoutError:
                pass


def install_signal_handlers(stop: asyncio.Event) -> None:
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except (NotImplementedError, RuntimeError, ValueError):
            # Windows: no loop signal handlers; fall back to the C-level handler.
            signal.signal(sig, lambda *_: loop.call_soon_threadsafe(stop.set))
