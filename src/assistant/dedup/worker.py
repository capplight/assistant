"""A small job loop for the week-10 workers (`python -m assistant.dedup`,
`python -m assistant.imports`): claim one job of the given kinds, run its handler with no
transaction open, close it. Handlers raise to retry with backoff."""

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from assistant.db import queue
from assistant.db.models import Job
from assistant.logs import error_text

log = logging.getLogger("assistant.dedup.worker")

Handler = Callable[[dict[str, Any], int], Awaitable[Any]]


async def run_one(maker: async_sessionmaker[AsyncSession], handlers: dict[str, Handler]) -> bool:
    async with maker() as s:
        job = await queue.claim(s, list(handlers))
        await s.commit()
    if job is None:
        return False
    job_id, kind, payload, locked_at = job.id, job.kind, job.payload or {}, job.locked_at
    error = None
    try:
        await handlers[kind](payload, job_id)
    except Exception as e:  # every failure is retried by the queue
        error = error_text(e)
        log.warning("job %s %s failed: %s", kind, job_id, error)
    async with maker() as s:
        row = await s.get(Job, job_id, with_for_update=True)
        if row is not None:
            if error is not None:
                await queue.fail(s, row, error)
            elif queue.still_mine(row, locked_at):
                await queue.complete(s, row)
        await s.commit()
    return True


async def drain(maker: async_sessionmaker[AsyncSession], handlers: dict[str, Handler],
                limit: int = 1000) -> int:  # fmt: skip
    """Run ready jobs until none is left (tests, scripts). Returns how many ran."""
    n = 0
    while n < limit and await run_one(maker, handlers):
        n += 1
    return n


async def job_loop(maker: async_sessionmaker[AsyncSession], handlers: dict[str, Handler],
                   stop: asyncio.Event, poll: float) -> None:  # fmt: skip
    while not stop.is_set():
        busy = False
        try:
            busy = await run_one(maker, handlers)
        except Exception:
            log.exception("job loop error")
        if not busy:
            try:
                await asyncio.wait_for(stop.wait(), timeout=poll)
            except TimeoutError:
                pass
