from datetime import UTC, date, datetime

from sqlalchemy.dialects import postgresql

from assistant.db.models import Trip
from assistant.scheduler.service import (
    bookings_on_day_stmt,
    claim_stmt,
    due_ids_stmt,
    lock_stmt,
    scheduled_for_booking_stmt,
    scheduled_for_trip_stmt,
    trip_items_stmt,
)


def sql(stmt):
    c = stmt.compile(dialect=postgresql.dialect())
    return " ".join(str(c).split()), c.params


def test_due_ids_stmt_does_not_lock():
    text, params = sql(due_ids_stmt(datetime(2026, 12, 1, tzinfo=UTC)))
    assert text.startswith("SELECT reminders.id FROM reminders")
    assert "FOR UPDATE" not in text
    assert "reminders.due_at <=" in text and "ORDER BY reminders.due_at" in text
    assert 100 in params.values() and "scheduled" in params.values()


def test_claim_locks_one_reminder_skip_locked():
    text, params = sql(claim_stmt(42, datetime(2026, 12, 1, tzinfo=UTC)))
    assert "FOR UPDATE OF reminders SKIP LOCKED" in text
    assert "reminders.id =" in text and "reminders.due_at <=" in text
    assert {42, "scheduled"} <= set(params.values())
    text, params = sql(lock_stmt(42))
    assert text.endswith("FOR UPDATE") and 42 in params.values()


def test_replacement_selects_only_scheduled_rows():
    text, params = sql(scheduled_for_booking_stmt(7))
    assert "reminders.booking_id =" in text and "FOR UPDATE" in text
    assert set(params.values()) >= {7, "scheduled"}
    text, params = sql(scheduled_for_trip_stmt(5))
    assert "reminders.booking_id IS NULL" in text
    assert "reminders.kind IN" in text


def test_bookings_on_day_uses_local_midnight():
    text, params = sql(bookings_on_day_stmt(1, date(2026, 12, 11), "Asia/Ho_Chi_Minh"))
    assert "bookings.confirmed_at IS NOT NULL" in text
    starts = sorted(v for v in params.values() if isinstance(v, datetime))
    assert starts[0] == datetime(2026, 12, 10, 17, 0, tzinfo=UTC)
    assert (starts[1] - starts[0]).days == 1


def test_trip_items_only_done_items_of_trip():
    text, params = sql(trip_items_stmt(Trip(id=5, user_id=1, title="t")))
    assert "items.trip_id =" in text and "items.status =" in text
    assert "done" in params.values()
