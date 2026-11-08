"""Server side of the alarm rule (spec 6.6 p. 3–5, R-09): every 30 s.

1. Backup push: a `planned` fire (no phone said `fired_local`/`shown`/…) at `fire_at + 3 min`
   → one push «Напоминание на 7:00 — откройте. Если будильник уже звенел — всё в порядке».
2. Missed: a `planned`/`fired` fire not acked or snoozed at `fire_at + 30 min` → `missed`, push
   «Вы пропустили …» (main fire only; an early «за час» alert just becomes `missed`).
3. Top-up: repeating reminders get fires up to 14 days ahead.

Same mechanics as assistant.scheduler.service: claim one row (FOR UPDATE SKIP LOCKED) and mark
it in a short transaction, commit, then send outside any transaction. The mark is the claim, so a
push is never sent twice; a failed send is journaled (`push_failed`), not retried. Reminder
pushes go out inside quiet hours too (R-13: alarms and reminders always ring).

The push text has no reminder text unless the person gave `push_content`, never for
`sensitivity=health` (R-14).
"""

import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from assistant.chat.push import PushSender, PushTarget
from assistant.db.models import Reminder
from assistant.db.models_reminders import (
    APP_KINDS,
    AppReminderStatus,
    FireEvent,
    FireState,
    ReminderEvent,
    ReminderFire,
)
from assistant.db.models_v2 import Consent, ConsentKind, Device
from assistant.logs import error_text
from assistant.reminders import service, texts

log = logging.getLogger(__name__)

BATCH = 100
TOPUP_BATCH = 50


@dataclass
class TickResult:
    backup: int = 0
    missed: int = 0
    topped_up: int = 0


@dataclass(frozen=True)
class _Push:
    fire_id: int
    user_id: int
    title: str
    data: dict[str, str]
    send: bool = True  # False: marked only (an early «за час» alert that was missed)


def _now() -> datetime:
    return datetime.now(UTC)


async def _push_content(session: AsyncSession, user_id: int) -> bool:
    return bool(
        await session.scalar(
            select(Consent.id)
            .where(
                Consent.user_id == user_id,
                Consent.kind == ConsentKind.PUSH_CONTENT,
                Consent.revoked_at.is_(None),
            )
            .limit(1)
        )
    )


async def _targets(session: AsyncSession, user_id: int) -> list[PushTarget]:
    rows = (
        await session.execute(
            select(Device.push_provider, Device.push_token)
            .where(
                Device.user_id == user_id,
                Device.revoked_at.is_(None),
                Device.push_token.is_not(None),
            )
            .order_by(Device.last_active_at.desc().nulls_last(), Device.id.desc())
        )
    ).all()
    return [PushTarget(p or "unknown", t) for p, t in rows]


def _local_clock(r: Reminder, fire: ReminderFire) -> str:
    zone = ZoneInfo(r.tz or "Asia/Almaty")
    return texts.clock(fire.occurrence_at.astimezone(zone).time())


async def _claim(
    sessionmaker: async_sessionmaker[AsyncSession], fire_id: int, now: datetime, kind: str
) -> _Push | None:
    """Mark one fire (backup push sent / missed) and say what to send. None: nothing to do."""
    async with sessionmaker() as session:
        user_id = await session.scalar(
            select(ReminderFire.user_id).where(ReminderFire.id == fire_id)
        )
        if user_id is None:
            return None
        await service.lock_user(session, user_id)
        cond = (
            [
                ReminderFire.state == FireState.PLANNED,
                ReminderFire.push_sent_at.is_(None),
                ReminderFire.push_fallback_at <= now,
                ReminderFire.missed_at > now,
            ]
            if kind == "backup"
            else [
                ReminderFire.state.in_((FireState.PLANNED, FireState.FIRED)),
                ReminderFire.missed_at <= now,
            ]
        )
        row = (
            await session.execute(
                select(ReminderFire, Reminder)
                .join(Reminder, Reminder.id == ReminderFire.reminder_id)
                .where(
                    ReminderFire.id == fire_id,
                    *cond,
                    Reminder.deleted_at.is_(None),
                    Reminder.kind.in_(APP_KINDS),
                )
                .with_for_update(of=ReminderFire, skip_locked=True)
                .execution_options(populate_existing=True)
            )
        ).first()
        if row is None:
            await session.rollback()
            return None
        fire, r = row.tuple()
        show_text = r.sensitivity != "health" and await _push_content(session, r.user_id)
        at = _local_clock(r, fire)
        data = {"fire_id": str(fire.public_id), "reminder_id": str(r.public_id)}
        if kind == "backup":
            fire.push_sent_at = now
            title = texts.PUSH_BACKUP.format(time=at)
            data["type"] = "reminder_backup"
        else:
            fire.state = FireState.MISSED
            session.add(
                ReminderEvent(
                    fire_id=fire.id, user_id=r.user_id, event=FireEvent.MISSED, at=now, meta={}
                )
            )
            if (
                fire.offset_min == 0
                and not r.rrule
                and r.status
                in (AppReminderStatus.SCHEDULED, AppReminderStatus.FIRED, AppReminderStatus.SNOOZED)
            ):
                r.status = AppReminderStatus.MISSED
            title = (
                texts.PUSH_MISSED_TEXT.format(title=r.title)
                if show_text
                else texts.PUSH_MISSED.format(time=at)
            )
            data["type"] = "reminder_missed"
        if show_text and r.title:
            data["text"] = r.title
        await session.commit()
        # An early alert («за час») that was missed is only marked: no «Вы пропустили».
        return _Push(fire.id, r.user_id, title, data, send=kind == "backup" or fire.offset_min == 0)


async def _send(
    sessionmaker: async_sessionmaker[AsyncSession],
    sender: PushSender,
    push: _Push,
    now: datetime,
    kind: str,
) -> None:
    async with sessionmaker() as session:
        targets = await _targets(session, push.user_id)
    event, meta = FireEvent.PUSH_SENT, {"kind": kind, "devices": len(targets)}
    if not targets:
        event, meta = FireEvent.PUSH_FAILED, {"kind": kind, "error": "no_push_token"}
    else:
        try:
            meta["accepted"] = await sender.send(targets, push.title, push.data)
        except Exception as exc:  # the mark is committed: never a second push
            event, meta = FireEvent.PUSH_FAILED, {"kind": kind, "error": error_text(exc)[:300]}
            log.warning("reminder push failed: %s", error_text(exc))
    async with sessionmaker() as session:
        session.add(
            ReminderEvent(
                fire_id=push.fire_id, user_id=push.user_id, event=event, at=now, meta=meta
            )
        )
        await session.commit()


async def _due(
    sessionmaker: async_sessionmaker[AsyncSession], now: datetime, kind: str
) -> list[int]:
    async with sessionmaker() as session:
        if kind == "backup":
            stmt = (
                select(ReminderFire.id)
                .where(
                    ReminderFire.state == FireState.PLANNED,
                    ReminderFire.push_sent_at.is_(None),
                    ReminderFire.push_fallback_at <= now,
                    ReminderFire.missed_at > now,
                )
                .order_by(ReminderFire.push_fallback_at)
            )
        else:
            stmt = (
                select(ReminderFire.id)
                .where(
                    ReminderFire.state.in_((FireState.PLANNED, FireState.FIRED)),
                    ReminderFire.missed_at <= now,
                )
                .order_by(ReminderFire.missed_at)
            )
        return list(await session.scalars(stmt.limit(BATCH)))


async def _topup(sessionmaker: async_sessionmaker[AsyncSession], now: datetime) -> int:
    async with sessionmaker() as session:
        ids = list(
            await session.scalars(
                select(Reminder.id)
                .where(
                    Reminder.kind.in_(APP_KINDS),
                    Reminder.rrule.is_not(None),
                    Reminder.deleted_at.is_(None),
                    Reminder.status.not_in((AppReminderStatus.CANCELLED, AppReminderStatus.DONE)),
                    (Reminder.expanded_until.is_(None))
                    | (Reminder.expanded_until < now + service.HORIZON - service.TOPUP_BEFORE),
                )
                .order_by(Reminder.expanded_until.nulls_first())
                .limit(TOPUP_BATCH)
            )
        )
    done = 0
    for rid in ids:
        async with sessionmaker() as session:
            r = await session.get(Reminder, rid)
            if r is None:
                continue
            await service.lock_user(session, r.user_id)
            await service.plan_fires(session, r, now, cancel_rest=False)
            await session.commit()
            done += 1
    return done


async def tick(
    sessionmaker: async_sessionmaker[AsyncSession],
    sender: PushSender,
    *,
    now: datetime | None = None,
    clock: Callable[[], datetime] = _now,
) -> TickResult:
    """One pass. `now` (tests): a fixed moment for every step."""
    res = TickResult()
    for kind in ("missed", "backup"):  # missed first: a fire past +30 min gets no backup push
        t = now or clock()
        for fire_id in await _due(sessionmaker, t, kind):
            try:
                push = await _claim(sessionmaker, fire_id, t, kind)
                if push is None:
                    continue
                if kind == "backup":
                    res.backup += 1
                else:
                    res.missed += 1
                if push.send:
                    await _send(sessionmaker, sender, push, t, kind)
            except Exception as exc:  # one broken row never stops the others
                log.error("reminder fire %s (%s) failed: %s", fire_id, kind, error_text(exc))
    try:
        res.topped_up = await _topup(sessionmaker, now or clock())
    except Exception as exc:
        log.error("reminder top-up failed: %s", error_text(exc))
    return res


__all__ = ["TickResult", "tick"]
