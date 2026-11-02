from datetime import UTC, date, datetime, timedelta

import pytest

from assistant.db.models import Booking, BookingType, Reminder, ReminderStatus
from assistant.scheduler.rules import (
    BOOKING_RULES,
    MAX_ATTEMPTS,
    TRIP_LAST_DAY,
    TRIP_MORNING,
    apply_send_failure,
    apply_send_success,
    booking_reminder_specs,
    cancel_scheduled,
    is_permanent_send_error,
    is_stale,
    trip_reminder_specs,
)
from assistant.scheduler.tz import get_tz

VN = "Asia/Ho_Chi_Minh"  # UTC+7
ALMATY = "Asia/Almaty"  # UTC+5
NOW = datetime(2026, 12, 1, 0, 0, tzinfo=UTC)
CONFIRMED = datetime(2026, 11, 30, tzinfo=UTC)


def local(y, m, d, hh, mm, tz):
    return datetime(y, m, d, hh, mm, tzinfo=get_tz(tz)).astimezone(UTC)


def booking(**kw) -> Booking:
    defaults = dict(
        id=7,
        user_id=1,
        type=BookingType.FLIGHT,
        title="VN 123 Алматы — Фукуок",
        confirmation_code="ABC123",
        tz=VN,
        confirmed_at=CONFIRMED,
    )
    defaults.update(kw)
    return Booking(**defaults)


def by_kind(specs):
    return {s.kind: s for s in specs}


def test_tz_offsets():
    assert datetime(2026, 12, 1, tzinfo=get_tz(ALMATY)).utcoffset() == timedelta(hours=5)
    assert datetime(2026, 12, 1, tzinfo=get_tz(VN)).utcoffset() == timedelta(hours=7)
    assert get_tz("Nowhere/Unknown") is get_tz(ALMATY)


def test_every_booking_type_has_rules():
    assert set(BOOKING_RULES) == set(BookingType)


def test_flight_in_vietnam_local_times():
    b = booking(starts_at=local(2026, 12, 10, 7, 40, VN))
    specs = by_kind(booking_reminder_specs(b, ALMATY, NOW))
    assert set(specs) == {"flight_day_before", "flight_3h_before"}
    day_before = specs["flight_day_before"]
    assert day_before.due_at == datetime(2026, 12, 9, 12, 0, tzinfo=UTC)  # 19:00 +07
    assert day_before.text == "Завтра рейс VN 123 Алматы — Фукуок в 07:40, код брони ABC123."
    assert day_before.payload == {"booking_id": 7}
    three_h = specs["flight_3h_before"]
    assert three_h.due_at == datetime(2026, 12, 9, 21, 40, tzinfo=UTC)
    assert "07:40" in three_h.text and "ABC123" in three_h.text


def test_flight_from_almaty_uses_almaty_clock():
    b = booking(tz=ALMATY, starts_at=local(2026, 12, 10, 2, 15, ALMATY))
    specs = by_kind(booking_reminder_specs(b, VN, NOW))
    # Day before at 19:00 Almaty = 14:00 UTC on Dec 9
    assert specs["flight_day_before"].due_at == datetime(2026, 12, 9, 14, 0, tzinfo=UTC)
    assert "в 02:15" in specs["flight_day_before"].text


def test_booking_without_tz_falls_back_to_user_tz():
    b = booking(tz=None, starts_at=local(2026, 12, 10, 7, 40, VN))
    specs = by_kind(booking_reminder_specs(b, VN, NOW))
    assert specs["flight_day_before"].due_at == datetime(2026, 12, 9, 12, 0, tzinfo=UTC)
    assert "07:40" in specs["flight_day_before"].text


def test_past_reminders_skipped():
    b = booking(starts_at=local(2026, 12, 10, 7, 40, VN))
    now = datetime(2026, 12, 9, 13, 0, tzinfo=UTC)  # after 19:00 the day before (12:00 UTC)
    assert [s.kind for s in booking_reminder_specs(b, None, now)] == ["flight_3h_before"]
    assert booking_reminder_specs(b, None, datetime(2026, 12, 10, tzinfo=UTC)) == []


def test_unconfirmed_booking_gets_nothing():
    b = booking(confirmed_at=None, starts_at=local(2026, 12, 10, 7, 40, VN))
    assert booking_reminder_specs(b, None, NOW) == []


def test_no_code_no_code_text():
    b = booking(confirmation_code=None, starts_at=local(2026, 12, 10, 7, 40, VN))
    text = by_kind(booking_reminder_specs(b, None, NOW))["flight_day_before"].text
    assert "код" not in text
    assert text == "Завтра рейс VN 123 Алматы — Фукуок в 07:40."


def test_hotel_checkin_and_checkout_in_almaty():
    b = booking(
        type=BookingType.HOTEL,
        title="Rixos Borovoe",
        tz=ALMATY,
        starts_at=local(2026, 12, 10, 14, 0, ALMATY),
        ends_at=local(2026, 12, 12, 12, 0, ALMATY),
    )
    specs = by_kind(booking_reminder_specs(b, None, NOW))
    assert specs["hotel_checkin"].due_at == datetime(2026, 12, 10, 5, 0, tzinfo=UTC)
    assert (
        specs["hotel_checkin"].text == "Сегодня заселение: Rixos Borovoe с 14:00, код брони ABC123."
    )
    assert specs["hotel_checkout"].due_at == datetime(2026, 12, 12, 3, 0, tzinfo=UTC)
    assert "до 12:00" in specs["hotel_checkout"].text


def test_hotel_without_end_has_only_checkin():
    b = booking(type=BookingType.HOTEL, starts_at=local(2026, 12, 10, 14, 0, VN))
    assert [s.kind for s in booking_reminder_specs(b, None, NOW)] == ["hotel_checkin"]


def test_hotel_date_only_keeps_checkin_without_time():
    b = booking(type=BookingType.HOTEL, title="Sol Beach", starts_at=local(2026, 12, 10, 0, 0, VN))
    spec = booking_reminder_specs(b, None, NOW)[0]
    assert spec.due_at == datetime(2026, 12, 10, 3, 0, tzinfo=UTC)  # 10:00 +07
    assert spec.text == "Сегодня заселение: Sol Beach, код брони ABC123."


def test_early_checkout_reminder_that_would_be_late_is_skipped():
    b = booking(
        type=BookingType.HOTEL,
        starts_at=local(2026, 12, 10, 14, 0, VN),
        ends_at=local(2026, 12, 12, 6, 0, VN),  # before the 08:00 reminder
    )
    assert [s.kind for s in booking_reminder_specs(b, None, NOW)] == ["hotel_checkin"]


@pytest.mark.parametrize("btype", [BookingType.TRANSFER, BookingType.TOUR, BookingType.OTHER])
def test_two_hours_before(btype):
    b = booking(type=btype, title="Трансфер в отель", starts_at=local(2026, 12, 10, 9, 30, VN))
    (spec,) = booking_reminder_specs(b, None, NOW)
    assert spec.due_at == local(2026, 12, 10, 7, 30, VN)
    assert "в 09:30" in spec.text and "ABC123" in spec.text


def test_trip_morning_per_day_and_last_day():
    specs = trip_reminder_specs(5, date(2026, 12, 10), date(2026, 12, 12), VN, NOW)
    mornings = [s for s in specs if s.kind == TRIP_MORNING]
    assert [s.due_at for s in mornings] == [
        datetime(2026, 12, d, 1, 30, tzinfo=UTC)
        for d in (10, 11, 12)  # 08:30 +07
    ]
    assert mornings[1].payload == {"trip_id": 5, "date": "2026-12-11", "day_index": 1}
    (last,) = [s for s in specs if s.kind == TRIP_LAST_DAY]
    assert last.payload["date"] == "2026-12-12"
    assert last.due_at == datetime(2026, 12, 12, 3, 0, tzinfo=UTC)


def test_trip_in_almaty_tz():
    (first, *_) = trip_reminder_specs(5, date(2026, 12, 10), date(2026, 12, 10), ALMATY, NOW)
    assert first.due_at == datetime(2026, 12, 10, 3, 30, tzinfo=UTC)


def test_trip_past_days_skipped_and_bad_dates():
    now = datetime(2026, 12, 11, 2, 0, tzinfo=UTC)  # Dec 11 09:00 in Vietnam
    specs = trip_reminder_specs(5, date(2026, 12, 10), date(2026, 12, 12), VN, now)
    assert [(s.kind, s.payload["date"]) for s in specs] == [
        (TRIP_MORNING, "2026-12-12"),
        (TRIP_LAST_DAY, "2026-12-12"),
    ]
    assert trip_reminder_specs(5, date(2026, 12, 12), date(2026, 12, 10), VN, NOW) == []
    assert trip_reminder_specs(5, None, date(2026, 12, 10), VN, NOW) == []


def _reminder(status, **kw):
    return Reminder(
        user_id=1, kind="x", due_at=NOW, text="t", status=status, attempts=kw.pop("attempts", 0)
    )


def test_replacement_cancels_only_scheduled():
    rs = [
        _reminder(ReminderStatus.SCHEDULED),
        _reminder(ReminderStatus.SENT),
        _reminder(ReminderStatus.SCHEDULED),
        _reminder(ReminderStatus.FAILED),
    ]
    cancelled = cancel_scheduled(rs)
    assert cancelled == [rs[0], rs[2]]
    assert [r.status for r in rs] == [
        ReminderStatus.CANCELLED,
        ReminderStatus.SENT,
        ReminderStatus.CANCELLED,
        ReminderStatus.FAILED,
    ]


class TelegramForbiddenError(Exception):
    pass


def test_send_failure_retries_then_fails():
    r = _reminder(ReminderStatus.SCHEDULED)
    for n in range(1, MAX_ATTEMPTS):
        apply_send_failure(r, TimeoutError("network"))
        assert (r.attempts, r.status) == (n, ReminderStatus.SCHEDULED)
    apply_send_failure(r, TimeoutError("network"))
    assert (r.attempts, r.status) == (MAX_ATTEMPTS, ReminderStatus.FAILED)


@pytest.mark.parametrize(
    "exc",
    [
        TelegramForbiddenError("whatever"),
        RuntimeError("Telegram server says - Forbidden: bot was blocked by the user"),
    ],
)
def test_blocked_bot_cancels(exc):
    r = _reminder(ReminderStatus.SCHEDULED)
    assert is_permanent_send_error(exc)
    apply_send_failure(r, exc)
    assert (r.attempts, r.status) == (1, ReminderStatus.CANCELLED)


def test_success_and_staleness():
    r = _reminder(ReminderStatus.SCHEDULED)
    apply_send_success(r, NOW)
    assert (r.status, r.sent_at) == (ReminderStatus.SENT, NOW)
    assert not is_stale(r, NOW + timedelta(minutes=5))
    assert is_stale(r, NOW + timedelta(hours=3))
