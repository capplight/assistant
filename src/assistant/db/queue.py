"""Postgres job queue. Producers call enqueue(); workers call claim() / complete() / fail().

claim() uses FOR UPDATE SKIP LOCKED, so any number of worker processes can poll safely.
A job that crashed mid-run (locked_at older than STALE_AFTER) is picked up again.
"""

from datetime import UTC, datetime, timedelta

from sqlalchemy import or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.db.models import Job, JobStatus

# Must exceed the longest item processing (media + STT + two LLM calls).
STALE_AFTER = timedelta(minutes=30)


def backoff(attempts: int) -> timedelta:
    """15s, 1m, 4m, 16m, ... capped at 1h."""
    return min(timedelta(seconds=15 * 4 ** (attempts - 1)), timedelta(hours=1))


async def enqueue(
    session: AsyncSession,
    kind: str,
    payload: dict,
    *,
    run_after: datetime | None = None,
    idempotency_key: str | None = None,
) -> Job:
    """Add a job. With idempotency_key (UNIQUE, e.g. `item:42:ingest:v1`) a repeat call returns
    the existing job instead of adding a second one, whatever its status."""
    run_after = run_after or datetime.now(UTC)
    if idempotency_key is None:
        job = Job(kind=kind, payload=payload, run_after=run_after)
        session.add(job)
        await session.flush()
        return job
    stmt = (
        pg_insert(Job)
        .values(kind=kind, payload=payload, run_after=run_after, status=JobStatus.QUEUED,
                attempts=0, max_attempts=5, idempotency_key=idempotency_key)
        .on_conflict_do_nothing(
            index_elements=["idempotency_key"],
            index_where=Job.idempotency_key.is_not(None),
        )
        .returning(Job.id)
    )  # fmt: skip
    job_id = await session.scalar(stmt)
    if job_id is None:
        job_id = await session.scalar(select(Job.id).where(Job.idempotency_key == idempotency_key))
    job = await session.get(Job, job_id)
    assert job is not None
    return job


async def enqueue_again(
    session: AsyncSession,
    kind: str,
    payload: dict,
    idempotency_key: str,
    *,
    again_if: tuple[JobStatus, ...] = (JobStatus.DONE, JobStatus.FAILED, JobStatus.RUNNING),
) -> None:
    """One row per subject, for work to redo when the subject changes: add the job or put it back
    in the queue. Back from RUNNING means the worker must not close it: see `still_mine`."""
    now = datetime.now(UTC)
    stmt = (
        pg_insert(Job)
        .values(kind=kind, payload=payload, run_after=now, status=JobStatus.QUEUED, attempts=0,
                max_attempts=5, idempotency_key=idempotency_key)
        .on_conflict_do_update(
            index_elements=["idempotency_key"],
            index_where=Job.idempotency_key.is_not(None),
            set_={"status": JobStatus.QUEUED, "run_after": now, "attempts": 0, "locked_at": None,
                  "last_error": None},
            where=Job.status.in_(again_if),
        )
    )  # fmt: skip
    await session.execute(stmt)


def still_mine(job: Job, locked_at: datetime | None) -> bool:
    """False: while this worker ran, `enqueue_again` queued the job anew, so it isn't over."""
    return job.status == JobStatus.RUNNING and job.locked_at == locked_at


async def claim(session: AsyncSession, kinds: list[str] | None = None) -> Job | None:
    """Lock and mark one ready job as running. Commit the session right after to release the row."""
    now = datetime.now(UTC)
    ready = Job.status == JobStatus.QUEUED
    stale = (
        (Job.status == JobStatus.RUNNING)
        & (Job.locked_at < now - STALE_AFTER)
        & (Job.attempts < Job.max_attempts)
    )
    stmt = (
        select(Job)
        .where(or_(ready, stale), Job.run_after <= now)
        .order_by(Job.run_after)
        .limit(1)
        .with_for_update(skip_locked=True)
    )
    if kinds:
        stmt = stmt.where(Job.kind.in_(kinds))
    job = (await session.execute(stmt)).scalar_one_or_none()
    if job is None:
        return None
    job.status = JobStatus.RUNNING
    job.locked_at = now
    job.attempts += 1
    await session.flush()
    return job


async def complete(session: AsyncSession, job: Job) -> None:
    job.status = JobStatus.DONE
    job.locked_at = None
    job.last_error = None


async def fail(session: AsyncSession, job: Job, error: str) -> bool:
    """Record the error and reschedule with backoff. Returns True when the job gave up for good."""
    job.last_error = error[:4000]
    job.locked_at = None
    if job.attempts >= job.max_attempts:
        job.status = JobStatus.FAILED
        return True
    job.status = JobStatus.QUEUED
    job.run_after = datetime.now(UTC) + backoff(job.attempts)
    return False
