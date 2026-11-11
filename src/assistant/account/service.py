"""Account deletion (spec 7.2, F-27, US-20; contract docs/api/account.md).

Request → sign-in closed at once (sessions revoked, push tokens dropped, Telegram session gone),
`users.status = deletion_pending`, `account:purge` queued for `delete_after`. Within the grace
days a sign-in gets a short «Восстановить» token; `cancel` brings the account back untouched.
The purge first marks the account `deleted` (no way back from here, so a late «Восстановить»
cannot meet half-deleted data), deletes the objects in storage with no transaction open, then
removes every row in one transaction (`assistant.api.account_data.purge_user`).
"""

import logging
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

from sqlalchemy import delete, func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from assistant.db import queue
from assistant.db.models import Job, User
from assistant.db.models_account import AccountDeletion, DeletionVia
from assistant.db.models_v2 import AuthSession, Device, UserStatus
from assistant.logs import error_text

log = logging.getLogger(__name__)

JOB_PURGE = "account:purge"


def purge_job_key(deletion_id: int) -> str:
    return f"account:purge:{deletion_id}"


class ObjectStore(Protocol):
    async def delete(self, key: str) -> None: ...


async def pending_deletion(session: AsyncSession, user_id: int) -> AccountDeletion | None:
    """The open request of this account (not cancelled, not executed)."""
    return await session.scalar(
        select(AccountDeletion)
        .where(AccountDeletion.user_id == user_id, AccountDeletion.cancelled_at.is_(None),
               AccountDeletion.executed_at.is_(None))
        .order_by(AccountDeletion.id.desc()).limit(1))  # fmt: skip


async def request_deletion(session: AsyncSession, user: User, *, via: DeletionVia,
                           grace_days: int, now: datetime) -> AccountDeletion:  # fmt: skip
    """Close the account now and schedule its purge. Safe to repeat: an open request is kept."""
    existing = await pending_deletion(session, user.id)
    if existing is not None and user.status == UserStatus.DELETION_PENDING:
        return existing
    delete_after = now + timedelta(days=max(grace_days, 0))
    deletion = AccountDeletion(user_id=user.id, via=str(via), requested_at=now,
                               cancel_until=delete_after, report={})  # fmt: skip
    session.add(deletion)
    user.status = UserStatus.DELETION_PENDING
    user.delete_requested_at, user.delete_after = now, delete_after
    await session.execute(update(AuthSession)
                          .where(AuthSession.user_id == user.id, AuthSession.revoked_at.is_(None))
                          .values(revoked_at=now))  # fmt: skip
    await session.execute(update(Device).where(Device.user_id == user.id)
                          .values(push_token=None,
                                  revoked_at=func.coalesce(Device.revoked_at, now)))
    # A Telegram sign-in session (Full, Ф-4) must not outlive the request (spec 7.2).
    await session.execute(text("UPDATE imports SET session_enc = NULL, session_expires_at = NULL "
                               "WHERE user_id = :u AND session_enc IS NOT NULL"), {"u": user.id})
    await session.flush()
    await queue.enqueue(session, JOB_PURGE, {"deletion_id": deletion.id}, run_after=delete_after,
                        idempotency_key=purge_job_key(deletion.id))  # fmt: skip
    return deletion


def new_restore_token() -> str:
    return secrets.token_urlsafe(32)


async def issue_restore(session: AsyncSession, deletion: AccountDeletion, token_hash: str, *,
                        minutes: int, now: datetime) -> datetime:  # fmt: skip
    """A sign-in during the grace days: the hash of a fresh «Восстановить» token goes on the row
    (the newest one replaces the older)."""
    deletion.restore_hash = token_hash
    deletion.restore_expires_at = now + timedelta(minutes=minutes)
    await session.flush()
    return deletion.restore_expires_at


class RestoreInvalid(Exception):
    """Unknown or stale token."""


class DeletionDone(Exception):
    """The grace days are over: the purge has started or finished."""


async def cancel_deletion(session: AsyncSession, token_hash: str, *, now: datetime) -> User:
    deletion = await session.scalar(select(AccountDeletion).where(
        AccountDeletion.restore_hash == token_hash).with_for_update())  # fmt: skip
    if deletion is None or deletion.restore_expires_at is None \
            or deletion.restore_expires_at <= now:  # fmt: skip
        raise RestoreInvalid
    user = await session.get(User, deletion.user_id, with_for_update=True) \
        if deletion.user_id is not None else None  # fmt: skip
    if (user is None or deletion.executed_at is not None or deletion.cancelled_at is not None
            or user.status != UserStatus.DELETION_PENDING):  # fmt: skip
        raise DeletionDone
    deletion.cancelled_at = now
    deletion.restore_hash = deletion.restore_expires_at = None
    user.status = UserStatus.ACTIVE
    user.delete_requested_at = user.delete_after = None
    await session.execute(delete(Job).where(Job.idempotency_key == purge_job_key(deletion.id),
                                            Job.status != "running"))  # fmt: skip
    await session.flush()
    return user


@dataclass(frozen=True)
class PurgeResult:
    done: bool
    report: dict[str, Any]


async def _object_keys(session: AsyncSession, user_id: int) -> list[str]:
    keys: set[str] = set()
    for sql in ("SELECT storage_key FROM files WHERE user_id = :u",
                "SELECT storage_key FROM uploads WHERE user_id = :u",
                "SELECT storage_key FROM data_exports WHERE user_id = :u "
                "AND storage_key IS NOT NULL",
                "SELECT storage_key FROM doc_templates WHERE user_id = :u "
                "AND storage_key IS NOT NULL"):  # fmt: skip
        keys.update(k for k in await session.scalars(text(sql), {"u": user_id}) if k)
    return sorted(keys)


async def run_purge(maker: async_sessionmaker[AsyncSession], storage: ObjectStore,
                    deletion_id: int, *, now: datetime | None = None) -> PurgeResult:  # fmt: skip
    """`account:purge`. Repeatable: a crash anywhere is picked up by the next run."""
    from assistant.api.account_data import purge_user  # api imports this package

    now = now or datetime.now(UTC)
    async with maker() as s:
        deletion = await s.get(AccountDeletion, deletion_id, with_for_update=True)
        if deletion is None or deletion.cancelled_at is not None \
                or deletion.executed_at is not None:  # fmt: skip
            await s.commit()
            return PurgeResult(True, {})
        user = await s.get(User, deletion.user_id, with_for_update=True) \
            if deletion.user_id is not None else None  # fmt: skip
        if user is None:  # gone already (another path): nothing left to do
            deletion.executed_at, deletion.user_id = now, None
            await s.commit()
            return PurgeResult(True, dict(deletion.report or {}))
        if user.status == UserStatus.ACTIVE or deletion.cancel_until > now:
            await s.commit()
            return PurgeResult(False, {})  # not due (or brought back): the caller re-queues
        user.status = UserStatus.DELETED  # from here on «Восстановить» is refused
        deletion.restore_hash = deletion.restore_expires_at = None
        user_id, prefix = user.id, f"u/{user.public_id}/"
        keys = await _object_keys(s, user_id)
        await s.commit()
    failed = 0
    for key in keys:  # no transaction open across the storage calls (CLAUDE.md)
        try:
            await storage.delete(key)
        except Exception as exc:
            failed += 1
            log.warning("purge %s: object delete failed: %s", deletion_id, error_text(exc))
    sweep = getattr(storage, "delete_prefix", None)
    if sweep is not None:  # anything left under the person's prefix (half-done uploads)
        try:
            await sweep(prefix)
        except Exception as exc:
            failed += 1
            log.warning("purge %s: prefix sweep failed: %s", deletion_id, error_text(exc))
    if failed:
        raise RuntimeError(f"{failed} object(s) not deleted; will retry")
    async with maker() as s:
        deletion = await s.get(AccountDeletion, deletion_id, with_for_update=True)
        assert deletion is not None
        report: dict[str, Any] = dict(await purge_user(s, user_id))
        report["storage.objects"] = len(keys)
        deletion.report, deletion.executed_at, deletion.user_id = report, now, None
        await s.commit()
    log.info("account deletion %s done: %d objects", deletion_id, len(keys))
    return PurgeResult(True, report)
