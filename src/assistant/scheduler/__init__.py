"""Reminders: created from confirmed bookings and active trips, sent when due."""

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

    Re-running (dates changed) replaces the trip's still-scheduled reminders.
    The digest text is composed at send time from the trip's saved items.
    """
    return await _service.schedule_for_trip(session, trip)


async def send_due(session: AsyncSession, notifier: Notifier) -> int:
    """Send every reminder whose due_at has passed. Returns how many were sent."""
    return await _service.send_due(session, notifier)


__all__ = ["schedule_for_booking", "schedule_for_trip", "send_due"]
