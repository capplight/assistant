"""Reminders: created from confirmed bookings and active trips, sent when due."""

from sqlalchemy.ext.asyncio import AsyncSession

from assistant.db.models import Booking, Reminder
from assistant.notify import Notifier


async def schedule_for_booking(session: AsyncSession, booking: Booking) -> list[Reminder]:
    """Create reminders for a booking the user has confirmed (booking.confirmed_at set).

    Re-running for the same booking replaces its still-scheduled reminders (no duplicates).
    """
    raise NotImplementedError


async def send_due(session: AsyncSession, notifier: Notifier) -> int:
    """Send every reminder whose due_at has passed. Returns how many were sent."""
    raise NotImplementedError
