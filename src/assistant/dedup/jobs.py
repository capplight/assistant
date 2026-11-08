"""The `dedup:scan` job: one row per person, put back in the queue (a little later) whenever their
records change, so ten notes in a minute make one scan. Run by `python -m assistant.dedup`."""

import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from assistant.ai import Router
from assistant.config import get_settings
from assistant.db.models import Job, JobStatus
from assistant.db.models_dedup import DupOrigin
from assistant.dedup.scan import ScanResult, scan_user

log = logging.getLogger(__name__)
JOB_SCAN = "dedup:scan"


def scan_key(user_id: int) -> str:
    return f"user:{user_id}:dedup:scan"


async def schedule_scan(s: AsyncSession, user_id: int, *, origin: str = DupOrigin.ON_SAVE,
                        import_id: int | None = None,
                        delay_s: float | None = None) -> None:  # fmt: skip
    """In the caller's transaction. A queued scan moves to `now + delay`; a done, failed or running
    one is queued again (a running one then runs once more: it may have missed this record)."""
    delay = get_settings().dedup_scan_delay_seconds if delay_s is None else delay_s
    when = datetime.now(UTC) + timedelta(seconds=delay)
    payload = {"user_id": user_id, "origin": str(origin), "import_id": import_id}
    stmt = pg_insert(Job).values(kind=JOB_SCAN, payload=payload, run_after=when,
                                 status=JobStatus.QUEUED, attempts=0, max_attempts=5,
                                 idempotency_key=scan_key(user_id))  # fmt: skip
    await s.execute(stmt.on_conflict_do_update(
        index_elements=["idempotency_key"], index_where=Job.idempotency_key.is_not(None),
        set_={"status": JobStatus.QUEUED, "run_after": when, "attempts": 0, "locked_at": None,
              "last_error": None, "payload": payload},
    ))  # fmt: skip


async def run_scan_job(maker: async_sessionmaker[AsyncSession], router: Router | None,
                       payload: dict, job_id: int | None = None) -> ScanResult:  # fmt: skip
    imp = payload.get("import_id")
    res = await scan_user(maker, router, int(payload["user_id"]),
                          origin=str(payload.get("origin") or DupOrigin.ON_SAVE),
                          import_id=int(imp) if imp is not None else None,
                          job_id=job_id)  # fmt: skip
    log.info("dedup scan user %s: %s records, %s pairs, %s sure, %s judged, %s groups",
             payload.get("user_id"), res.records, res.pairs_checked, res.sure, res.judged,
             res.groups)  # fmt: skip
    return res
