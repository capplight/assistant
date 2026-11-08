"""Pure parts of the reminder service: RRULE whitelist, offsets, occurrences on the local clock,
fire keys."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest

from assistant.db.models import Reminder
from assistant.reminders import service


def test_rrule_whitelist() -> None:
    assert service.check_rrule("RRULE:freq=weekly;byday=MO,TH") == "FREQ=WEEKLY;BYDAY=MO,TH"
    assert service.check_rrule("FREQ=MONTHLY;BYMONTHDAY=31") == "FREQ=MONTHLY;BYMONTHDAY=31"
    assert service.check_rrule("FREQ=DAILY;INTERVAL=2") == "FREQ=DAILY;INTERVAL=2"
    assert service.check_rrule(None) is None


@pytest.mark.parametrize(
    "bad",
    [
        "FREQ=HOURLY",
        "FREQ=DAILY;COUNT=3",
        "FREQ=WEEKLY;BYDAY=XX",
        "FREQ=DAILY;BYDAY=MO",
        "FREQ=MONTHLY;BYMONTHDAY=32",
        "FREQ=DAILY;INTERVAL=0",
        "garbage",
    ],
)
def test_rrule_rejects(bad: str) -> None:
    with pytest.raises(service.ReminderError):
        service.check_rrule(bad)


def test_offsets_closed_list() -> None:
    assert service.check_offsets([60, 15]) == [15, 60]
    for bad in ([30], [15, 15], [15, 60, 1440, 1440]):
        with pytest.raises(service.ReminderError):
            service.check_offsets(bad)


def test_weekly_occurrences_follow_the_local_clock() -> None:
    # Monday 09:00 Almaty = 04:00 UTC
    r = Reminder(
        due_at=datetime(2026, 11, 9, 4, 0, tzinfo=UTC),
        tz="Asia/Almaty",
        rrule="FREQ=WEEKLY;BYDAY=MO,TH",
    )
    start = datetime(2026, 11, 8, tzinfo=UTC)
    occ = service.occurrences(r, start, start + timedelta(days=14))
    assert [o.isoformat() for o in occ] == [
        "2026-11-09T04:00:00+00:00",
        "2026-11-12T04:00:00+00:00",
        "2026-11-16T04:00:00+00:00",
        "2026-11-19T04:00:00+00:00",
    ]


def test_one_off_occurrence_only_in_window() -> None:
    r = Reminder(due_at=datetime(2026, 11, 9, 4, 0, tzinfo=UTC), tz="Asia/Almaty", rrule=None)
    start, end = datetime(2026, 11, 10, tzinfo=UTC), datetime(2026, 11, 20, tzinfo=UTC)
    assert service.occurrences(r, start, end) == []


def test_fire_key_is_stable() -> None:
    rid = uuid.UUID("01940000-0000-7000-8000-000000000001")
    k = service.fire_key(rid, datetime(2026, 11, 9, 9, 0, tzinfo=UTC).astimezone(), 60, 1)
    assert k == "01940000-0000-7000-8000-000000000001:2026-11-09T09:00:00Z:60:1"


def _ev(meta: dict | None) -> service.EventIn:
    at = datetime(2026, 11, 9, 4, 0, 30, tzinfo=UTC)
    return service.EventIn(client_id=uuid.uuid4(), event="snoozed", at=at, meta=meta)


def test_snooze_until_default_and_chosen_time() -> None:
    at = datetime(2026, 11, 9, 4, 0, 30, tzinfo=UTC)
    assert service.snooze_until(_ev(None)) == at + timedelta(minutes=10)
    assert service.snooze_until(_ev({})) == at + timedelta(minutes=10)
    chosen = "2026-11-09T10:00:00+05:00"  # 60 min later on the Almaty clock
    assert service.snooze_until(_ev({"until": chosen})) == datetime(2026, 11, 9, 5, 0, tzinfo=UTC)
    tomorrow = (at + timedelta(hours=26)).isoformat()
    assert service.snooze_until(_ev({"until": tomorrow})) == at + timedelta(hours=26)


@pytest.mark.parametrize(
    "until",
    [
        "2026-11-09T04:00:00+00:00",  # before at
        "2026-11-09T04:01:00+00:00",  # under a minute after
        "2026-11-11T05:00:00+00:00",  # over 48 h
        "2026-11-09T10:00:00",  # no offset
        "завтра",
        60,
    ],
)
def test_snooze_until_rejects(until: object) -> None:
    assert service.snooze_until(_ev({"until": until})) is None
