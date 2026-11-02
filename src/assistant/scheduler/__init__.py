"""Reminders: created from confirmed bookings and active trips, sent when due."""

from collections.abc import Callable

from sqlalchemy.ext.asyncio import AsyncSession

from assistant.db.models import Booking, Reminder, Trip
from assistant.notify import Notifier
from assistant.scheduler import service as _service


async def schedule_for_booking(session: AsyncSession, booking: Booking) -> list[Reminder]:
    """Create reminders for a booking the user has confirmed (booking.confirmed_at set).

    Re-running for the same booking replaces its still-scheduled reminders (no duplicates).
    Times follow the event's local clock (booking.tz, else the user's tz); past ones are
    skipped. Timing and wording: assistant.scheduler.rules.BOOKING_RULES.
    """
    return await _service.schedule_for_booking(session, booking)


async def schedule_for_trip(session: AsyncSession, trip: Trip) -> list[Reminder]:
    """Create per-day reminders for a trip with dates (morning digest in the trip's tz).

    Re-running (dates changed) replaces the trip's still-scheduled reminders. Trip.is_active
    is ignored: inactive trips keep their reminders (validity = trip exists + its dates).
    The digest text is composed at send time from the trip's saved items.
    """
    return await _service.schedule_for_trip(session, trip)


async def send_due(
    session: AsyncSession | None,
    notifier: Notifier,
    *,
    sessionmaker: Callable[[], AsyncSession] | None = None,
) -> int:
    """Send reminders whose due_at has passed. Returns how many were sent.

    Each reminder gets its own short transactions (claim, then send outside any
    transaction, then mark), so a failure repeats at most that one reminder. Pass
    `sessionmaker` (e.g. assistant.db.session.get_sessionmaker()) to get a fresh session per
    transaction; otherwise `session` is committed after every step.
    """
    return await _service.send_due(session, notifier, sessionmaker=sessionmaker)


__all__ = ["schedule_for_booking", "schedule_for_trip", "send_due"]
