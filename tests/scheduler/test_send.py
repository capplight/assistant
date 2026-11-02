"""send_due and trip validity with a fake transactional session (no DB)."""

from datetime import UTC, date, datetime, timedelta

import pytest
from sqlalchemy.dialects import postgresql

from assistant.db.models import Reminder, ReminderStatus, Trip
from assistant.notify import FakeNotifier
from assistant.scheduler import service
from assistant.scheduler.rules import CLAIM_LEASE, TRIP_LAST_DAY, TRIP_MORNING

NOW = datetime(2026, 12, 10, 3, 0, tzinfo=UTC)
_FIELDS = ("status", "due_at", "attempts", "text", "payload", "sent_at")


class _Result:
    def __init__(self, rows):
        self._rows = rows

    def all(self):
        return self._rows

    def first(self):
        return self._rows[0] if self._rows else None


class FakeSession:
    """Mimics commit/rollback on Reminder rows: rollback restores the last committed state."""

    def __init__(self, rows, events=None, *, fail_commits=(), locked=(), trips=()):
        self.rows = {r.id: (r, chat, tz) for r, chat, tz in rows}
        self.trips = {t.id: t for t in trips}
        self.events = events if events is not None else []
        self.fail_commits = set(fail_commits)  # 1-based commit numbers that raise
        self.locked = set(locked)  # held by "another instance"
        self.commits = 0
        self._snapshot()

    def _snapshot(self):
        self.saved = {
            rid: {f: getattr(r, f) for f in _FIELDS} for rid, (r, _, _) in self.rows.items()
        }

    def _id(self, stmt):
        params = stmt.compile(dialect=postgresql.dialect()).params
        return next(v for v in params.values() if isinstance(v, int) and v in self.rows)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def scalars(self, stmt):
        sql = str(stmt.compile(dialect=postgresql.dialect()))
        if "FOR UPDATE" in sql:  # lock_stmt
            return _Result([self.rows[self._id(stmt)][0]])
        now = service._now()
        due = sorted((r for r, _, _ in self.rows.values()), key=lambda r: r.due_at)
        return _Result(
            [r.id for r in due if r.status == ReminderStatus.SCHEDULED and r.due_at <= now]
        )

    async def execute(self, stmt):  # claim_stmt
        rid = self._id(stmt)
        r, chat, tz = self.rows[rid]
        if rid in self.locked or r.status != ReminderStatus.SCHEDULED or r.due_at > service._now():
            return _Result([])
        return _Result([(r, chat, tz)])

    async def get(self, model, ident):
        return self.trips.get(ident)

    async def commit(self):
        self.commits += 1
        if self.commits in self.fail_commits:
            self.events.append("commit-failed")
            raise RuntimeError("connection lost")
        self.events.append("commit")
        self._snapshot()

    async def rollback(self):
        self.events.append("rollback")
        for rid, values in self.saved.items():
            for f, v in values.items():
                setattr(self.rows[rid][0], f, v)


class EventNotifier(FakeNotifier):
    def __init__(self, events, exc=None):
        super().__init__()
        self.events, self.exc = events, exc

    async def send(self, message):
        self.events.append("send")
        if self.exc:
            raise self.exc
        await super().send(message)


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    state = {"now": NOW}
    monkeypatch.setattr(service, "_now", lambda: state["now"])
    return state


def _due(id=1, text="Завтра рейс X в 07:40.", minutes_ago=1, **kw):
    return Reminder(
        id=id,
        user_id=1,
        kind=kw.pop("kind", "flight_day_before"),
        due_at=NOW - timedelta(minutes=minutes_ago),
        text=text,
        status=ReminderStatus.SCHEDULED,
        attempts=kw.pop("attempts", 0),
        payload=kw.pop("payload", None),
        trip_id=kw.pop("trip_id", None),
    )


@pytest.mark.parametrize("use_maker", [False, True])
async def test_send_due_sends_and_marks_sent(use_maker):
    r1, r2 = _due(id=1), _due(id=2, text="Через 2 часа: тур.")
    events = []
    session = FakeSession([(r1, 111, "Asia/Almaty"), (r2, 222, "Asia/Almaty")], events)
    notifier = EventNotifier(events)
    if use_maker:
        sent = await service.send_due(None, notifier, sessionmaker=lambda: session)
    else:
        sent = await service.send_due(session, notifier)
    assert sent == 2
    assert [(m.chat_id, m.text) for m in notifier.sent] == [
        (111, "Завтра рейс X в 07:40."),
        (222, "Через 2 часа: тур."),
    ]
    assert r1.status == ReminderStatus.SENT and r1.sent_at is not None
    assert r1.due_at == NOW - timedelta(minutes=1)  # lease undone on success
    # discover, then per reminder: claim committed BEFORE the send, mark committed after
    assert events == ["commit"] + ["commit", "send", "commit"] * 2


async def test_public_send_due_accepts_sessionmaker():
    from assistant.scheduler import send_due

    session = FakeSession([(_due(), 1, None)])
    assert await send_due(None, FakeNotifier(), sessionmaker=lambda: session) == 1


async def test_send_due_needs_session_or_maker():
    with pytest.raises(ValueError):
        await service.send_due(None, FakeNotifier())


async def test_send_errors_are_counted_per_reminder():
    blocked = _due(id=1)
    flaky = _due(id=2, attempts=2)
    retry = _due(id=3)
    err = RuntimeError("Telegram server says - Forbidden: bot was blocked by the user")
    session = FakeSession([(blocked, 1, None)])
    assert await service.send_due(session, EventNotifier([], err)) == 0
    assert blocked.status == ReminderStatus.CANCELLED

    session = FakeSession([(flaky, 1, None), (retry, 2, None)])
    assert await service.send_due(session, EventNotifier([], TimeoutError())) == 0
    assert (flaky.status, flaky.attempts) == (ReminderStatus.FAILED, 3)
    # retryable: comes due again on the next tick (lease ended)
    assert (retry.status, retry.attempts, retry.due_at) == (ReminderStatus.SCHEDULED, 1, NOW)


async def test_send_due_drops_stale():
    old = _due(minutes_ago=24 * 60)
    notifier = FakeNotifier()
    assert await service.send_due(FakeSession([(old, 1, None)]), notifier) == 0
    assert old.status == ReminderStatus.CANCELLED and notifier.sent == []


async def test_reminder_locked_elsewhere_is_skipped():
    r1, r2 = _due(id=1), _due(id=2)
    notifier = FakeNotifier()
    assert (
        await service.send_due(FakeSession([(r1, 1, None), (r2, 2, None)], locked={1}), notifier)
        == 1
    )
    assert r1.status == ReminderStatus.SCHEDULED and [m.chat_id for m in notifier.sent] == [2]


async def test_failed_mark_resends_only_that_reminder_once_after_lease(clock):
    r1, r2 = _due(id=1), _due(id=2)
    events = []
    # commits: 1 discover, 2 claim r1, 3 mark r1 (fails), 4 claim r2, 5 mark r2
    session = FakeSession([(r1, 1, None), (r2, 2, None)], events, fail_commits={3})
    notifier = EventNotifier(events)
    assert await service.send_due(session, notifier) == 1  # r1 delivered but not marked
    assert [m.chat_id for m in notifier.sent] == [1, 2]
    assert r2.status == ReminderStatus.SENT
    assert r1.status == ReminderStatus.SCHEDULED and r1.due_at == NOW + CLAIM_LEASE

    # next tick: still leased, nothing is re-sent
    clock["now"] = NOW + timedelta(minutes=1)
    assert await service.send_due(session, notifier) == 0
    # after the lease: exactly one resend of r1, then it is SENT
    clock["now"] = NOW + CLAIM_LEASE + timedelta(minutes=1)
    assert await service.send_due(session, notifier) == 1
    assert [m.chat_id for m in notifier.sent] == [1, 2, 1]
    assert r1.status == ReminderStatus.SENT


async def test_claim_error_is_counted_not_looped():
    bad = _due(id=1, kind=TRIP_MORNING, payload={"trip_id": 5, "date": "not-a-date"}, trip_id=5)
    trip = Trip(id=5, user_id=1, title="t", starts_on=date(2026, 12, 9), ends_on=date(2026, 12, 12))
    events = []
    session = FakeSession([(bad, 1, None)], events, trips=[trip])
    assert await service.send_due(session, EventNotifier(events)) == 0
    assert "send" not in events and "rollback" in events
    assert (bad.status, bad.attempts) == (ReminderStatus.SCHEDULED, 1)


# Trip validity: is_active is ignored ---------------------------------------------------------


def _trip(**kw):
    defaults = dict(
        id=5,
        user_id=1,
        title="Вьетнам",
        destination="Hoi An",
        starts_on=date(2026, 12, 9),
        ends_on=date(2026, 12, 12),
        tz="Asia/Ho_Chi_Minh",
        is_active=False,  # the user switched to another trip
    )
    defaults.update(kw)
    return Trip(**defaults)


def _trip_reminder(kind=TRIP_MORNING, day="2026-12-10"):
    return _due(kind=kind, payload={"trip_id": 5, "date": day, "day_index": 1}, trip_id=5)


def test_trip_day_ignores_is_active_and_checks_dates():
    assert service.trip_day(_trip_reminder(), _trip()) == date(2026, 12, 10)
    assert service.trip_day(_trip_reminder(), None) is None  # trip deleted
    assert service.trip_day(_trip_reminder(day="2026-12-20"), _trip()) is None
    assert service.trip_day(_trip_reminder(), _trip(starts_on=None)) is None
    assert service.trip_day(_trip_reminder(TRIP_LAST_DAY, "2026-12-12"), _trip()) == date(
        2026, 12, 12
    )
    # trip extended: the old "last day" is no longer the last
    assert (
        service.trip_day(
            _trip_reminder(TRIP_LAST_DAY, "2026-12-12"), _trip(ends_on=date(2026, 12, 14))
        )
        is None
    )


async def test_inactive_trip_reminder_is_still_sent():
    r = _trip_reminder()
    session = FakeSession([(r, 77, "Asia/Almaty")], trips=[_trip(is_active=False)])

    async def scalars(stmt, _orig=session.scalars):
        sql = str(stmt.compile(dialect=postgresql.dialect()))
        if "FROM items" in sql or "FROM bookings" in sql:
            return _Result([])
        return await _orig(stmt)

    session.scalars = scalars
    notifier = FakeNotifier()
    assert await service.send_due(session, notifier) == 1
    assert notifier.sent[0].text.startswith("Доброе утро! Сегодня в Hoi An:")
    assert r.status == ReminderStatus.SENT


async def test_schedule_for_inactive_trip_creates_reminders(monkeypatch):
    added = []

    class S:
        async def scalars(self, stmt):
            return _Result([])

        async def scalar(self, stmt):
            return "Asia/Almaty"

        def add_all(self, rows):
            added.extend(rows)

        async def flush(self):
            pass

    monkeypatch.setattr(service, "_now", lambda: datetime(2026, 12, 1, tzinfo=UTC))
    rows = await service.schedule_for_trip(S(), _trip(is_active=False))
    assert rows and rows == added
    assert {r.kind for r in rows} == {TRIP_MORNING, TRIP_LAST_DAY}


async def test_cleanup_deletes_old_processed_updates_sql():
    captured = []

    class S:
        async def execute(self, stmt):
            captured.append(stmt)

            class R:
                rowcount = 3

            return R()

    n = await service.cleanup_processed_updates(S(), NOW)
    assert n == 3
    c = captured[0].compile(dialect=postgresql.dialect())
    assert str(c).startswith("DELETE FROM processed_updates WHERE processed_updates.created_at <")
    assert NOW - timedelta(days=7) in c.params.values()


def test_cleanup_timer_runs_at_most_hourly():
    from assistant.scheduler.__main__ import _Every

    t = {"v": 0.0}
    every = _Every(3600, clock=lambda: t["v"])
    assert every.due()
    t["v"] = 1800
    assert not every.due()
    t["v"] = 3600
    assert every.due()
    assert not every.due()
