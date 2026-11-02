"""Round trip against a real Postgres (schema from `alembic upgrade head`). Rolled back after."""

import os
from datetime import UTC, datetime, timedelta

import pytest

from assistant.db.models import Booking, BookingType, Reminder, ReminderStatus, User
from assistant.notify import FakeNotifier

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="needs DATABASE_URL"),
]


@pytest.fixture
async def session():
    from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

    engine = create_async_engine(os.environ["DATABASE_URL"])
    async with engine.connect() as conn:
        trans = await conn.begin()
        async with AsyncSession(bind=conn, expire_on_commit=False) as s:
            yield s
        await trans.rollback()
    await engine.dispose()


async def test_booking_reminders_replace_and_send(session):
    from assistant.scheduler import schedule_for_booking, send_due

    user = User(telegram_id=990000001, tz="Asia/Almaty")
    session.add(user)
    await session.flush()
    starts = datetime.now(UTC) + timedelta(days=3)
    booking = Booking(
        user_id=user.id,
        type=BookingType.FLIGHT,
        title="KC 901",
        confirmation_code="Q1W2E3",
        starts_at=starts,
        tz="Asia/Ho_Chi_Minh",
        confirmed_at=datetime.now(UTC),
    )
    session.add(booking)
    await session.flush()

    first = await schedule_for_booking(session, booking)
    second = await schedule_for_booking(session, booking)
    assert len(first) == len(second) == 2
    assert all(r.status == ReminderStatus.CANCELLED for r in first)

    second[0].due_at = datetime.now(UTC) - timedelta(minutes=1)
    await session.flush()
    notifier = FakeNotifier()
    assert await send_due(session, notifier) == 1
    assert notifier.sent[0].chat_id == 990000001
    await session.refresh(second[0])
    assert second[0].status == ReminderStatus.SENT
    assert isinstance(second[0], Reminder)
