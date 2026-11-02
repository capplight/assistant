"""process_item / handle_choice / confirm_booking against an in-memory fake session."""

from datetime import UTC, datetime

import httpx
import pytest
from sqlalchemy.sql.dml import Insert

from assistant import scheduler
from assistant.db.models import (
    Booking,
    BookingType,
    Category,
    Item,
    ItemKind,
    ItemPlace,
    ItemSource,
    ItemStatus,
    Trip,
    User,
)
from assistant.notify import FakeNotifier
from assistant.pipeline import service
from assistant.pipeline.deps import Deps
from assistant.pipeline.errors import PermanentError
from assistant.pipeline.logic import FAILED_TEXT
from assistant.pipeline.places import ResolvedPlace
from tests.pipeline.conftest import (
    NOW,
    FakeExtractor,
    make_booking,
    make_extraction,
    make_gatherer,
    zone_loader,
)


class _Result:
    def __init__(self, rows):
        self._rows = rows

    def scalar_one_or_none(self):
        return self._rows[0] if self._rows else None

    def scalars(self):
        return iter(self._rows)


class FakeSession:
    def __init__(self, *objs):
        self.objs: dict[tuple[type, int], object] = {}
        self.inserts: list[Insert] = []
        self.deleted: list[object] = []
        self.flushes = 0
        self._next_id = 100
        for o in objs:
            self.objs[(type(o), o.id)] = o

    async def get(self, cls, pk, **_):
        return self.objs.get((cls, pk))

    async def execute(self, stmt):
        if isinstance(stmt, Insert):
            self.inserts.append(stmt)
            return _Result([])
        entity = stmt.column_descriptions[0]["entity"]
        return _Result([o for (cls, _), o in self.objs.items() if cls is entity])

    def add(self, obj):
        if getattr(obj, "id", None) is None:
            obj.id = self._next_id
            self._next_id += 1
        self.objs[(type(obj), obj.id)] = obj

    async def delete(self, obj):
        self.deleted.append(obj)
        self.objs.pop((type(obj), obj.id), None)

    async def flush(self):
        self.flushes += 1

    def inserted(self, table):
        return [s for s in self.inserts if s.table.name == table.__tablename__]


class FakePlaces:
    def __init__(self, result=None):
        self.result = result or ResolvedPlace(
            place_id=10, name="Bánh Mì Phượng", city="Хойан", country="VN", tz="Asia/Ho_Chi_Minh"
        )
        self.queries = []

    async def resolve(self, session, query, country=None):
        self.queries.append(query)
        return self.result


class FakeEmbedder:
    dim = 3

    def __init__(self):
        self.calls = []

    async def embed(self, texts, input_type):
        self.calls.append((texts, input_type))
        return [[0.1, 0.2, 0.3]]


def make_user(consent=True):
    return User(id=7, telegram_id=7000, tz="Asia/Almaty",
                consent_at=NOW if consent else None)  # fmt: skip


def make_item(**kw):
    base = dict(
        id=1, user_id=7, trip_id=None, kind=ItemKind.TEXT, source=ItemSource.USER,
        status=ItemStatus.PENDING, raw_text="Bánh Mì Phượng в Хойане", url=None,
        telegram_file_id=None, telegram_chat_id=7000, telegram_message_id=55,
    )  # fmt: skip
    base.update(kw)
    return Item(**base)


def deps(extractor, places=None, embedder=None):
    return Deps(
        gatherer=make_gatherer(), extractor=extractor, places=places or FakePlaces(),
        embedder=embedder or FakeEmbedder(), threshold=0.6, clock=lambda: NOW,
        zone_loader=zone_loader,
    )  # fmt: skip


async def test_done_item_is_untouched():
    it = make_item(status=ItemStatus.DONE, title="old")
    fx = FakeExtractor(make_extraction())
    notifier = FakeNotifier()
    await service.process_item(FakeSession(it, make_user()), 1, notifier, deps(fx))
    assert fx.calls == [] and notifier.sent == [] and it.title == "old"


async def test_no_consent_nothing_leaves_the_country():
    it = make_item()
    fx = FakeExtractor(make_extraction())
    notifier = FakeNotifier()
    await service.process_item(FakeSession(it, make_user(consent=False)), 1, notifier, deps(fx))
    assert fx.calls == [] and notifier.sent == [] and it.status is ItemStatus.PENDING


async def test_place_saved_linked_embedded_and_reported():
    it = make_item()
    trip = Trip(id=3, user_id=7, title="Вьетнам", destination="Вьетнам", is_active=True)
    session = FakeSession(it, make_user(), trip)
    emb = FakeEmbedder()
    notifier = FakeNotifier()
    await service.process_item(session, 1, notifier,
                               deps(FakeExtractor(make_extraction()), embedder=emb))  # fmt: skip
    assert it.status is ItemStatus.DONE
    assert (it.title, it.category, it.city, it.country) == (
        "Bánh Mì Phượng", Category.FOOD, "Хойан", "VN"
    )
    assert it.trip_id == 3 and it.processed_at == NOW and it.confidence == 0.9
    assert it.extracted["place_query"] == "Bánh Mì Phượng, Hội An"
    assert it.embedding == [0.1, 0.2, 0.3] and emb.calls[0][1] == "document"
    assert len(session.inserted(ItemPlace)) == 1
    [msg] = notifier.sent
    assert msg.text == "Сохранил: Bánh Mì Phượng — Хойан, еда\nПоездка: Вьетнам"
    assert (msg.chat_id, msg.reply_to_message_id) == (7000, 55)


async def test_ambiguous_place_asks_with_buttons():
    it = make_item()
    amb = make_extraction(confidence=0.3, place_candidates=["Madam Khanh"])
    notifier = FakeNotifier()
    await service.process_item(FakeSession(it, make_user()), 1, notifier, deps(FakeExtractor(amb)))
    assert it.status is ItemStatus.NEEDS_INPUT
    assert it.extracted["options"] == ["Bánh Mì Phượng, Hội An", "Madam Khanh"]
    [msg] = notifier.sent
    assert [b.callback_data for row in msg.buttons for b in row] == [
        "pick:1:0", "pick:1:1", "pick:1:-1"
    ]


async def test_booking_created_unconfirmed_with_buttons():
    it = make_item(kind=ItemKind.PHOTO, telegram_file_id="F", raw_text=None)
    ex = make_extraction(kind="booking", booking=make_booking(), place_query=None)
    session = FakeSession(it, make_user())
    notifier = FakeNotifier()
    await service.process_item(session, 1, notifier, deps(FakeExtractor(ex)))
    [booking] = [o for (cls, _), o in session.objs.items() if cls is Booking]
    assert booking.confirmed_at is None
    assert booking.starts_at == datetime(2026, 12, 20, 2, 40, tzinfo=UTC)
    assert booking.tz == "Asia/Almaty" and booking.type is BookingType.FLIGHT
    assert it.category is Category.BOOKING and it.status is ItemStatus.DONE
    [msg] = notifier.sent
    assert [b.callback_data for b in msg.buttons[0]] == [f"bk:{booking.id}:ok",
                                                         f"bk:{booking.id}:no"]  # fmt: skip


async def test_permanent_error_marks_failed_and_tells_user():
    class Broken:
        async def extract(self, inputs, *, strong):
            raise PermanentError("refused")

    it = make_item()
    notifier = FakeNotifier()
    await service.process_item(FakeSession(it, make_user()), 1, notifier, deps(Broken()))
    assert it.status is ItemStatus.FAILED and "refused" in it.error
    assert notifier.sent[0].text == FAILED_TEXT


async def test_transient_error_is_raised_for_retry():
    class Flaky:
        async def extract(self, inputs, *, strong):
            raise httpx.ConnectTimeout("slow")

    notifier = FakeNotifier()
    with pytest.raises(httpx.ConnectTimeout):
        await service.process_item(FakeSession(make_item(), make_user()), 1, notifier,
                                   deps(Flaky()))  # fmt: skip
    assert notifier.sent == []


async def test_needs_input_from_inputs():
    it = make_item(kind=ItemKind.LINK, source=ItemSource.INSTAGRAM, raw_text=None,
                   url="https://instagram.com/reel/x")  # fmt: skip
    fx = FakeExtractor(make_extraction())
    notifier = FakeNotifier()
    await service.process_item(FakeSession(it, make_user()), 1, notifier, deps(fx))
    assert it.status is ItemStatus.NEEDS_INPUT and fx.calls == []
    assert "скриншот" in notifier.sent[0].text


async def test_worker_final_failure_message():
    it = make_item()
    notifier = FakeNotifier()
    await service.fail_item(FakeSession(it), 1, "boom", notifier)
    assert it.status is ItemStatus.FAILED
    assert notifier.sent[0].text == "Не получилось разобрать это сообщение, пришли скриншот?"


# ---------------------------------------------------------------- handle_choice


async def test_handle_choice_resolves_selected_option():
    it = make_item(status=ItemStatus.NEEDS_INPUT, city="Hội An", category=Category.FOOD,
                   extracted={"options": ["Bánh Mì Phượng", "Madam Khanh"]})  # fmt: skip
    places = FakePlaces()
    session = FakeSession(it)
    notifier = FakeNotifier()
    await service.handle_choice(session, 1, 1, notifier, deps(FakeExtractor(make_extraction()),
                                                              places=places))  # fmt: skip
    assert places.queries == ["Madam Khanh, Hội An"]
    assert it.status is ItemStatus.DONE and len(session.inserted(ItemPlace)) == 1
    assert notifier.sent[0].text.startswith("Сохранил: Bánh Mì Phượng — Хойан")


async def test_handle_choice_other_and_stale_press():
    it = make_item(status=ItemStatus.NEEDS_INPUT, extracted={"options": ["A"]})
    notifier = FakeNotifier()
    d = deps(FakeExtractor(make_extraction()))
    await service.handle_choice(FakeSession(it), 1, -1, notifier, d)
    assert it.status is ItemStatus.DONE and "без точного места" in notifier.sent[0].text
    await service.handle_choice(FakeSession(it), 1, 0, notifier, d)  # already DONE: ignored
    assert len(notifier.sent) == 1


# ---------------------------------------------------------------- confirm_booking


def make_booking_row():
    return Booking(id=9, user_id=7, item_id=1, type=BookingType.FLIGHT, title="Рейс",
                   starts_at=datetime(2026, 12, 20, 2, 40, tzinfo=UTC))  # fmt: skip


async def test_confirm_keeps_confirmation_when_scheduler_missing(monkeypatch):
    async def not_ready(session, booking):
        raise NotImplementedError

    monkeypatch.setattr(scheduler, "schedule_for_booking", not_ready)
    b = make_booking_row()
    notifier = FakeNotifier()
    await service.confirm_booking(FakeSession(b, make_item()), 9, True, notifier)
    assert b.confirmed_at is not None
    assert notifier.sent[0].text == "Готово, бронь сохранена."
    assert notifier.sent[0].chat_id == 7000


async def test_confirm_calls_scheduler(monkeypatch):
    seen = []

    async def schedule(session, booking):
        seen.append(booking.id)
        return ["r1"]

    monkeypatch.setattr(scheduler, "schedule_for_booking", schedule)
    notifier = FakeNotifier()
    await service.confirm_booking(FakeSession(make_booking_row(), make_item()), 9, True, notifier)
    assert seen == [9] and "Напомню заранее" in notifier.sent[0].text


async def test_reject_deletes_unconfirmed_booking():
    b = make_booking_row()
    session = FakeSession(b, make_item())
    notifier = FakeNotifier()
    await service.confirm_booking(session, 9, False, notifier)
    assert session.deleted == [b] and "не сохраняю" in notifier.sent[0].text
