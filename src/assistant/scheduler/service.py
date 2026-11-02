"""DB side of reminders: replace/create rows, pick due ones, render and send.

Sending (send_due) uses short transactions per reminder and never holds one open across the
Telegram call:
  1. claim: lock the row (FOR UPDATE SKIP LOCKED), compose the text, store it and push due_at
     ahead by rules.CLAIM_LEASE; commit.
  2. send, outside any transaction.
  3. mark: lock the row again, set SENT (or count the failure); commit.
If the process dies (or the commit fails) between 2 and 3, only that one reminder comes due
again after the lease and is sent a second time. An SQL error affects only the reminder
being processed; it is counted as a failed attempt so a broken row cannot loop forever.
"""

import logging
from collections import Counter
from collections.abc import AsyncIterator, Callable, Sequence
from contextlib import asynccontextmanager
from datetime import UTC, date, datetime, time, timedelta

from sqlalchemy import Select, delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.db.models import (
    Booking,
    Item,
    ItemStatus,
    ProcessedUpdate,
    Reminder,
    ReminderStatus,
    Trip,
    User,
)
from assistant.logs import error_text
from assistant.notify import Notifier, OutMessage
from assistant.scheduler.rules import (
    DYNAMIC_KINDS,
    TRIP_LAST_DAY,
    ReminderSpec,
    apply_claim,
    apply_send_failure,
    apply_send_success,
    booking_reminder_specs,
    cancel_scheduled,
    is_stale,
    trip_reminder_specs,
)
from assistant.scheduler.texts import compose_trip_last_day, compose_trip_morning
from assistant.scheduler.tz import get_tz

log = logging.getLogger(__name__)

BATCH_SIZE = 100
TRIP_ITEMS_LIMIT = 200


def _now() -> datetime:
    return datetime.now(UTC)


async def _user_tz(session: AsyncSession, user_id: int) -> str | None:
    return await session.scalar(select(User.tz).where(User.id == user_id))


def _to_rows(
    specs: Sequence[ReminderSpec], *, user_id: int, trip_id: int | None, booking_id: int | None
) -> list[Reminder]:
    return [
        Reminder(
            user_id=user_id,
            trip_id=trip_id,
            booking_id=booking_id,
            kind=s.kind,
            due_at=s.due_at,
            text=s.text,
            payload=s.payload,
            status=ReminderStatus.SCHEDULED,
            attempts=0,
        )
        for s in specs
    ]


def scheduled_for_booking_stmt(booking_id: int) -> Select[tuple[Reminder]]:
    return (
        select(Reminder)
        .where(Reminder.booking_id == booking_id, Reminder.status == ReminderStatus.SCHEDULED)
        .with_for_update()
    )


def scheduled_for_trip_stmt(trip_id: int) -> Select[tuple[Reminder]]:
    return (
        select(Reminder)
        .where(
            Reminder.trip_id == trip_id,
            Reminder.booking_id.is_(None),
            Reminder.kind.in_(sorted(DYNAMIC_KINDS)),
            Reminder.status == ReminderStatus.SCHEDULED,
        )
        .with_for_update()
    )


def due_ids_stmt(now: datetime, limit: int = BATCH_SIZE) -> Select[tuple[int]]:
    """Candidates only (no lock); each one is then claimed on its own with claim_stmt."""
    return (
        select(Reminder.id)
        .where(Reminder.status == ReminderStatus.SCHEDULED, Reminder.due_at <= now)
        .order_by(Reminder.due_at)
        .limit(limit)
    )


def claim_stmt(reminder_id: int, now: datetime) -> Select:
    """Lock one still-due reminder; if another instance holds it, nothing is returned."""
    return (
        select(Reminder, User.telegram_id, User.tz)
        .join(User, User.id == Reminder.user_id)
        .where(
            Reminder.id == reminder_id,
            Reminder.status == ReminderStatus.SCHEDULED,
            Reminder.due_at <= now,
        )
        .with_for_update(of=Reminder, skip_locked=True)
        .execution_options(populate_existing=True)
    )


def lock_stmt(reminder_id: int) -> Select[tuple[Reminder]]:
    return (
        select(Reminder)
        .where(Reminder.id == reminder_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )


async def schedule_for_booking(session: AsyncSession, booking: Booking) -> list[Reminder]:
    if booking.id is None:
        await session.flush()
    existing = (await session.scalars(scheduled_for_booking_stmt(booking.id))).all()
    cancel_scheduled(existing)
    if booking.confirmed_at is None:
        await session.flush()
        return []
    specs = booking_reminder_specs(booking, await _user_tz(session, booking.user_id), _now())
    rows = _to_rows(specs, user_id=booking.user_id, trip_id=booking.trip_id, booking_id=booking.id)
    session.add_all(rows)
    await session.flush()
    return rows


async def schedule_for_trip(session: AsyncSession, trip: Trip) -> list[Reminder]:
    if trip.id is None:
        await session.flush()
    existing = (await session.scalars(scheduled_for_trip_stmt(trip.id))).all()
    cancel_scheduled(existing)
    # Trip.is_active only means "where new items are filed": inactive trips keep reminders.
    tz_name = trip.tz or await _user_tz(session, trip.user_id)
    specs = trip_reminder_specs(trip.id, trip.starts_on, trip.ends_on, tz_name, _now())
    rows = _to_rows(specs, user_id=trip.user_id, trip_id=trip.id, booking_id=None)
    session.add_all(rows)
    await session.flush()
    return rows


# Rendering -----------------------------------------------------------------------------------


def trip_items_stmt(trip: Trip) -> Select[tuple[Item]]:
    return (
        select(Item)
        .where(
            Item.user_id == trip.user_id,
            Item.trip_id == trip.id,
            Item.status == ItemStatus.DONE,
        )
        .order_by(Item.created_at.desc())
        .limit(TRIP_ITEMS_LIMIT)
    )


def bookings_on_day_stmt(user_id: int, day: date, tz_name: str | None) -> Select[tuple[Booking]]:
    start = datetime.combine(day, time(0, 0), tzinfo=get_tz(tz_name)).astimezone(UTC)
    return (
        select(Booking)
        .where(
            Booking.user_id == user_id,
            Booking.confirmed_at.is_not(None),
            Booking.starts_at >= start,
            Booking.starts_at < start + timedelta(days=1),
        )
        .order_by(Booking.starts_at)
    )


def main_city(items: Sequence[Item], fallback: str | None) -> str | None:
    """Most frequent city among the trip's items; the trip destination otherwise."""
    counts = Counter(i.city.strip() for i in items if i.city and i.city.strip())
    return counts.most_common(1)[0][0] if counts else fallback


def trip_day(reminder: Reminder, trip: Trip | None) -> date | None:
    """The reminder's day if the trip still exists and the day is within its dates.

    Trip.is_active is deliberately ignored: it only marks where new items are filed.
    """
    if trip is None or trip.starts_on is None or trip.ends_on is None:
        return None
    raw = (reminder.payload or {}).get("date")
    if not raw:
        return None
    day = date.fromisoformat(raw)
    if not trip.starts_on <= day <= trip.ends_on:
        return None
    if reminder.kind == TRIP_LAST_DAY and day != trip.ends_on:
        return None  # dates changed: the last day moved
    return day


async def render_text(session: AsyncSession, reminder: Reminder, user_tz: str | None) -> str | None:
    """Final text to send. None: no longer relevant (trip deleted or day outside its dates)."""
    if reminder.kind not in DYNAMIC_KINDS:
        return reminder.text
    payload = reminder.payload or {}
    trip_id = payload.get("trip_id") or reminder.trip_id
    trip = await session.get(Trip, trip_id) if trip_id else None
    day = trip_day(reminder, trip)
    if trip is None or day is None:
        return None
    items = list((await session.scalars(trip_items_stmt(trip))).all())
    city = main_city(items, trip.destination)
    if reminder.kind == TRIP_LAST_DAY:
        return compose_trip_last_day(trip.title, city, items)
    tz_name = trip.tz or user_tz
    bookings = (await session.scalars(bookings_on_day_stmt(trip.user_id, day, tz_name))).all()
    return compose_trip_morning(
        city, items, bookings, tz_name, day_index=int(payload.get("day_index", 0))
    )


# Sending -------------------------------------------------------------------------------------

SessionFactory = Callable[[], AsyncSession]


@asynccontextmanager
async def _tx(
    session: AsyncSession | None, sessionmaker: SessionFactory | None
) -> AsyncIterator[AsyncSession]:
    """One short transaction: in a fresh session from `sessionmaker`, else in `session`."""
    if sessionmaker is not None:
        async with sessionmaker() as s:
            try:
                yield s
                await s.commit()
            except BaseException:
                await s.rollback()
                raise
        return
    assert session is not None
    try:
        yield session
        await session.commit()
    except BaseException:
        await session.rollback()
        raise


async def _claim(s: AsyncSession, reminder_id: int, now: datetime) -> tuple[int, str] | None:
    """Phase 1. (chat_id, text) to send, or None when there is nothing to send."""
    row = (await s.execute(claim_stmt(reminder_id, now))).first()
    if row is None:  # sent/cancelled meanwhile, lease active, or locked by another instance
        return None
    reminder, chat_id, user_tz = row
    if is_stale(reminder, now):
        reminder.status = ReminderStatus.CANCELLED
        log.info("reminder %s dropped: %s late", reminder.id, now - reminder.due_at)
        return None
    text = await render_text(s, reminder, user_tz)
    if text is None:
        reminder.status = ReminderStatus.CANCELLED
        return None
    apply_claim(reminder, text, now)
    return chat_id, text


async def _mark(
    session: AsyncSession | None,
    sessionmaker: SessionFactory | None,
    reminder_id: int,
    exc: BaseException | None,
) -> None:
    """Phase 3 (also records a failed claim): SENT on success, else count the failure."""
    async with _tx(session, sessionmaker) as s:
        reminder = (await s.scalars(lock_stmt(reminder_id))).first()
        if reminder is None:
            return
        if exc is None:
            # Even if it was cancelled meanwhile (dates edited): it was delivered.
            apply_send_success(reminder, _now())
        elif reminder.status == ReminderStatus.SCHEDULED:
            apply_send_failure(reminder, exc, _now())


async def send_one(
    session: AsyncSession | None,
    sessionmaker: SessionFactory | None,
    notifier: Notifier,
    reminder_id: int,
    now: datetime,
) -> bool:
    """Claim, send and mark one reminder. True if it was delivered."""
    try:
        async with _tx(session, sessionmaker) as s:
            claimed = await _claim(s, reminder_id, now)
    except Exception as exc:
        log.warning("reminder %s claim failed: %s", reminder_id, error_text(exc))
        await _mark(session, sessionmaker, reminder_id, exc)
        return False
    if claimed is None:
        return False
    chat_id, text = claimed
    try:
        await notifier.send(OutMessage(chat_id=chat_id, text=text))
    except Exception as exc:
        log.warning("reminder %s send failed: %s", reminder_id, error_text(exc))
        await _mark(session, sessionmaker, reminder_id, exc)
        return False
    await _mark(session, sessionmaker, reminder_id, None)
    return True


async def send_due(
    session: AsyncSession | None,
    notifier: Notifier,
    *,
    sessionmaker: SessionFactory | None = None,
    limit: int = BATCH_SIZE,
) -> int:
    """Send due reminders one by one, each in its own short transactions (see module doc).

    With `sessionmaker` every transaction gets a fresh session from it (`session` may be
    None). Without it, `session` is committed after every step, so the caller must not
    expect its own transaction to wrap this call.
    """
    if session is None and sessionmaker is None:
        raise ValueError("send_due needs a session or a sessionmaker")
    now = _now()
    async with _tx(session, sessionmaker) as s:
        ids = list((await s.scalars(due_ids_stmt(now, limit))).all())
    sent = 0
    for reminder_id in ids:
        try:
            if await send_one(session, sessionmaker, notifier, reminder_id, now):
                sent += 1
        except Exception as exc:  # e.g. the final commit failed; the lease limits the damage
            log.warning("reminder %s: %s", reminder_id, error_text(exc))
    return sent


# Housekeeping --------------------------------------------------------------------------------

PROCESSED_UPDATES_TTL = timedelta(days=7)


async def cleanup_processed_updates(session: AsyncSession, now: datetime | None = None) -> int:
    """Delete processed_updates rows older than PROCESSED_UPDATES_TTL. Returns rows deleted."""
    cutoff = (now or _now()) - PROCESSED_UPDATES_TTL
    result = await session.execute(
        delete(ProcessedUpdate).where(ProcessedUpdate.created_at < cutoff)
    )
    return result.rowcount or 0
