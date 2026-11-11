"""worker-account: `python -m assistant.account`. Claims `account:export` and `account:purge`;
once an hour deletes archives whose 24 h are over.

The push «Архив готов» carries no data (only the export id) and is never sent in quiet hours;
it goes after the export is committed, and a failed push is not retried.
"""

import asyncio
import logging
import time
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from assistant.account.export import JOB_EXPORT, ObjectStore, build_export, expire_exports
from assistant.account.export import mark_failed as mark_export_failed
from assistant.account.service import JOB_PURGE, run_purge
from assistant.config import Settings
from assistant.db import queue
from assistant.db.models import Job, JobStatus
from assistant.logs import error_text

log = logging.getLogger("assistant.account.worker")
EXPIRE_EVERY_SECONDS = 3600.0
NOT_DUE_RETRY = timedelta(hours=1)
PUSH_TITLE = "Архив готов"


async def _push_ready(maker: async_sessionmaker[AsyncSession], push: Any, export_id: int,
                      now: datetime) -> None:  # fmt: skip
    from assistant.chat.push import PushTarget, in_quiet_hours

    async with maker() as s:
        row = (await s.execute(text("""
            SELECT e.public_id, u.id AS uid, u.tz, u.quiet_from, u.quiet_to
            FROM data_exports e JOIN users u ON u.id = e.user_id WHERE e.id = :e"""),
            {"e": export_id})).first()  # fmt: skip
        devices: list[Any] = []
        quiet = row is None or in_quiet_hours(now, row.tz or "Asia/Almaty", row.quiet_from,
                                              row.quiet_to)  # fmt: skip
        if not quiet:
            devices = list((await s.execute(text("""
                SELECT push_provider, push_token FROM devices
                WHERE user_id = :u AND revoked_at IS NULL AND push_token IS NOT NULL"""),
                {"u": row.uid})).all())  # fmt: skip
        await s.commit()
    if not devices or row is None:
        return
    try:
        await push.send([PushTarget(d.push_provider or "unknown", d.push_token) for d in devices],
                        PUSH_TITLE, {"type": "export_ready", "export_id": str(row.public_id)})
    except Exception as exc:
        log.warning("push «Архив готов» failed: %s", error_text(exc))


async def run_one(maker: async_sessionmaker[AsyncSession], storage: ObjectStore, cipher: Any,
                  settings: Settings, push: Any = None) -> bool:  # fmt: skip
    """Claim and run one job. Returns False when there was none."""
    async with maker() as s:
        job = await queue.claim(s, [JOB_EXPORT, JOB_PURGE])
        await s.commit()
        if job is None:
            return False
        job_id, kind, payload, locked_at = job.id, job.kind, dict(job.payload or {}), job.locked_at
    now = datetime.now(UTC)
    error: str | None = None
    retry_at: datetime | None = None
    ready = False
    try:
        if kind == JOB_EXPORT:
            ready = await build_export(maker, storage, cipher, int(payload["export_id"]),
                                       link_hours=settings.export_link_hours, now=now)
        else:
            result = await run_purge(maker, storage, int(payload["deletion_id"]), now=now)
            if not result.done:
                retry_at = now + NOT_DUE_RETRY
    except Exception as exc:
        error = error_text(exc)
        log.warning("%s job %s failed: %s", kind, job_id, error)
    gave_up = False
    async with maker() as s:
        row = await s.get(Job, job_id, with_for_update=True)
        if row is not None and queue.still_mine(row, locked_at):
            if error is not None:
                gave_up = await queue.fail(s, row, error)
            elif retry_at is not None:  # a purge picked up early: check again later
                row.status, row.run_after, row.locked_at = JobStatus.QUEUED, retry_at, None
                row.attempts = 0
            else:
                await queue.complete(s, row)
        await s.commit()
    if gave_up and kind == JOB_EXPORT:
        await mark_export_failed(maker, int(payload["export_id"]), error or "")
    if ready and push is not None:
        await _push_ready(maker, push, int(payload["export_id"]), now)
    return True


async def worker_loop(maker: async_sessionmaker[AsyncSession], storage: ObjectStore,
                      cipher: Any, settings: Settings, stop: asyncio.Event, poll: float,
                      push: Any = None) -> None:  # fmt: skip
    next_expire = 0.0
    while not stop.is_set():
        busy = False
        try:
            if time.monotonic() >= next_expire:
                next_expire = time.monotonic() + EXPIRE_EVERY_SECONDS
                await expire_exports(maker, storage)
            busy = await run_one(maker, storage, cipher, settings, push)
        except Exception:
            log.exception("account worker loop error")
        if not busy:
            try:
                await asyncio.wait_for(stop.wait(), timeout=poll)
            except TimeoutError:
                pass
