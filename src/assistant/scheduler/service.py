"""DB side of reminders: replace/create rows, pick due ones, render and send."""

import logging
from collections import Counter
from collections.abc import Sequence
from datetime import UTC, date, datetime, time, timedelta

from sqlalchemy import Select, select
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.db.models import (
    Booking,
    Item,
    ItemStatus,
    Reminder,
    ReminderStatus,
    Trip,
    User,
)
from assistant.notify import Notifier, OutMessage
from assistant.scheduler.rules import (
    DYNAMIC_KINDS,
    TRIP_LAST_DAY,
    ReminderSpec,
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


def due_stmt(now: datetime, limit: int = BATCH_SIZE) -> Select:
    return (
        select(Reminder, User.telegram_id, User.tz)
        .join(User, User.id == Reminder.user_id)
        .where(Reminder.status == ReminderStatus.SCHEDULED, Reminder.due_at <= now)
        .order_by(Reminder.due_at)
        .limit(limit)
        .with_for_update(of=Reminder, skip_locked=True)
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
    if not trip.is_active:
        await session.flush()
        return []
    tz_name = trip.tz or await _user_tz(session, trip.user_id)
    specs = trip_reminder_specs(trip.id, trip.starts_on, trip.ends_on, tz_name, _now())
    rows = _to_rows(specs, user_id=trip.user_id, trip_id=trip.id, booking_id=None)
    session.add_all(rows)
    await session.flush()
    return rows


# Sending -------------------------------------------------------------------------------------


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


async def render_text(session: AsyncSession, reminder: Reminder, user_tz: str | None) -> str | None:
    """Final text to send. None means the reminder is no longer relevant (trip gone/inactive)."""
    if reminder.kind not in DYNAMIC_KINDS:
        return reminder.text
    payload = reminder.payload or {}
    trip_id = payload.get("trip_id") or reminder.trip_id
    trip = await session.get(Trip, trip_id) if trip_id else None
    if trip is None or not trip.is_active:
        return None
    items = list((await session.scalars(trip_items_stmt(trip))).all())
    city = main_city(items, trip.destination)
    if reminder.kind == TRIP_LAST_DAY:
        return compose_trip_last_day(trip.title, city, items)
    tz_name = trip.tz or user_tz
    day = date.fromisoformat(payload["date"])
    bookings = (await session.scalars(bookings_on_day_stmt(trip.user_id, day, tz_name))).all()
    return compose_trip_morning(
        city, items, bookings, tz_name, day_index=int(payload.get("day_index", 0))
    )


async def send_due(session: AsyncSession, notifier: Notifier) -> int:
    now = _now()
    rows = (await session.execute(due_stmt(now))).all()
    sent = 0
    for reminder, chat_id, user_tz in rows:
        if is_stale(reminder, now):
            reminder.status = ReminderStatus.CANCELLED
            log.info("reminder %s dropped: %s late", reminder.id, now - reminder.due_at)
            continue
        try:
            text = await render_text(session, reminder, user_tz)
            if text is None:
                reminder.status = ReminderStatus.CANCELLED
                continue
            await notifier.send(OutMessage(chat_id=chat_id, text=text))
        except Exception as exc:  # one bad reminder must not stop the batch
            log.warning("reminder %s failed: %r", reminder.id, exc)
            apply_send_failure(reminder, exc)
            continue
        reminder.text = text
        apply_send_success(reminder, _now())
        sent += 1
    await session.flush()
    return sent
