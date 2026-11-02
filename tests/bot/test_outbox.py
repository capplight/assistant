"""Outbox and trip-scheduling seam, without a database."""

from datetime import date
from types import SimpleNamespace

from assistant.bot import service
from assistant.bot.outbox import Outbox
from assistant.notify import FakeNotifier, OutMessage


async def test_outbox_runs_in_order_and_swallows_failures():
    done = []

    async def ok(tag):
        done.append(tag)

    async def boom():
        raise RuntimeError("blocked")

    box = Outbox()
    box.add(lambda: ok(1))
    box.add(boom)
    box.add(lambda: ok(2))
    assert done == []  # nothing is sent until flush
    await box.flush()
    assert done == [1, 2]
    assert len(box) == 0


async def test_deferred_notifier_waits_for_flush():
    real = FakeNotifier()
    box = Outbox()
    await box.notifier(real).send(OutMessage(chat_id=1, text="hi"))
    assert real.sent == []
    await box.flush()
    assert [m.text for m in real.sent] == ["hi"]


class _FakeSession:
    def __init__(self, trip):
        self.trip = trip

    async def get(self, model, pk):
        return self.trip

    async def execute(self, stmt):
        return None

    async def flush(self):
        pass


async def test_switch_trip_schedules_new_active_trip(monkeypatch):
    calls = []

    async def schedule_for_trip(session, trip):
        calls.append(trip.id)
        raise NotImplementedError  # tolerated like before

    monkeypatch.setattr(service.scheduler, "schedule_for_trip", schedule_for_trip)
    trip = SimpleNamespace(
        id=3, user_id=1, is_active=False, starts_on=date(2027, 1, 1), ends_on=date(2027, 1, 5)
    )
    assert await service.switch_trip(_FakeSession(trip), 1, 3) is trip
    assert trip.is_active and calls == [3]

    undated = SimpleNamespace(id=4, user_id=1, is_active=False, starts_on=None, ends_on=None)
    await service.switch_trip(_FakeSession(undated), 1, 4)
    assert calls == [3]
