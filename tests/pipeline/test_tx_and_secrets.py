"""Transaction shape, send-after-commit, token redaction, booking edge cases."""

import httpx

from assistant import scheduler
from assistant.db.models import Booking, Item, ItemKind, ItemStatus
from assistant.notify import FakeNotifier
from assistant.pipeline import service
from assistant.pipeline.errors import PermanentError
from tests.pipeline.conftest import NOW, FakeExtractor, make_booking, make_extraction, make_gatherer
from tests.pipeline.test_service import (
    FakePlaces,
    FakeSession,
    deps,
    make_booking_row,
    make_item,
    make_user,
)

TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ"


class CommitAwareNotifier(FakeNotifier):
    """Records how many commits the session had when each message was sent."""

    def __init__(self, session, fail_with: Exception | None = None):
        super().__init__()
        self.session, self.fail_with = session, fail_with
        self.commits_at_send: list[int] = []

    async def send(self, message):
        self.commits_at_send.append(self.session.commits)
        if self.fail_with is not None:
            raise self.fail_with
        await super().send(message)


class Blocked(Exception):
    """Stands in for aiogram's TelegramForbiddenError / TelegramRetryAfter."""


def bookings(session):
    return [o for (cls, _), o in session.objs.items() if cls is Booking]


# ---------------------------------------------------------------- token leak


async def test_token_in_http_error_never_stored_in_item():
    class LeakyFiles:
        async def download(self, file_id):
            req = httpx.Request("POST", f"https://api.telegram.org/bot{TOKEN}/getFile")
            raise httpx.HTTPStatusError(
                f"Client error '404 Not Found' for url '{req.url}'", request=req,
                response=httpx.Response(404, request=req),
            )  # fmt: skip

    it = make_item(kind=ItemKind.PHOTO, telegram_file_id="F", raw_text=None)
    d = deps(FakeExtractor(make_extraction()))
    d.gatherer = make_gatherer(files=LeakyFiles())
    await service.process_item(FakeSession(it, make_user()), 1, FakeNotifier(), d)
    assert it.status is ItemStatus.FAILED and it.processed_at == NOW
    assert TOKEN not in it.error and "bot<redacted>" in it.error


async def test_fail_item_redacts_error():
    it = make_item(status=ItemStatus.PROCESSING)
    await service.fail_item(FakeSession(it), 1, f"x https://h/bot{TOKEN}/getFile", FakeNotifier())
    assert TOKEN not in it.error


# ---------------------------------------------------------------- commit, then send


async def test_result_committed_before_send_and_send_failure_swallowed():
    it = make_item()
    session = FakeSession(it, make_user())
    notifier = CommitAwareNotifier(session, fail_with=Blocked("bot was blocked by the user"))
    await service.process_item(session, 1, notifier, deps(FakeExtractor(make_extraction())))
    assert it.status is ItemStatus.DONE
    assert notifier.commits_at_send == [session.commits] and session.commits >= 2


async def test_no_transaction_open_during_network_work():
    """The claim (status PROCESSING) is committed before the model is called."""
    it = make_item()
    session = FakeSession(it, make_user())
    seen = []

    class Spy(FakeExtractor):
        async def extract(self, inputs, *, strong):
            seen.append((session.commits, it.status))
            return await super().extract(inputs, strong=strong)

    await service.process_item(session, 1, FakeNotifier(), deps(Spy(make_extraction())))
    assert seen == [(1, ItemStatus.PROCESSING)]


async def test_processing_item_from_a_retried_job_is_processed():
    it = make_item(status=ItemStatus.PROCESSING)
    fx = FakeExtractor(make_extraction())
    notifier = FakeNotifier()
    await service.process_item(FakeSession(it, make_user()), 1, notifier, deps(fx))
    assert it.status is ItemStatus.DONE and len(fx.calls) == 1 and len(notifier.sent) == 1


async def test_needs_input_item_is_skipped():
    it = make_item(status=ItemStatus.NEEDS_INPUT)
    fx = FakeExtractor(make_extraction())
    await service.process_item(FakeSession(it, make_user()), 1, FakeNotifier(), deps(fx))
    assert fx.calls == []


async def test_result_dropped_when_user_deleted_data_meanwhile():
    it = make_item(kind=ItemKind.PHOTO, telegram_file_id="F", raw_text=None)
    session = FakeSession(it, make_user())

    class DeletingExtractor(FakeExtractor):
        async def extract(self, inputs, *, strong):
            session.objs.pop((Item, 1), None)  # /delete ran while the model was thinking
            return await super().extract(inputs, strong=strong)

    ex = make_extraction(kind="booking", booking=make_booking(), place_query=None)
    notifier = FakeNotifier()
    await service.process_item(session, 1, notifier, deps(DeletingExtractor(ex)))
    assert notifier.sent == [] and bookings(session) == []


async def test_permanent_failure_committed_even_if_send_fails():
    class Broken:
        async def extract(self, inputs, *, strong):
            raise PermanentError("refused")

    it = make_item()
    session = FakeSession(it, make_user())
    notifier = CommitAwareNotifier(session, fail_with=Blocked("flood"))
    await service.process_item(session, 1, notifier, deps(Broken()))
    assert it.status is ItemStatus.FAILED and it.processed_at == NOW
    assert notifier.commits_at_send == [session.commits]


async def test_fail_item_commits_failed_before_send_and_swallows_send_error():
    it = make_item(status=ItemStatus.PROCESSING)
    session = FakeSession(it)
    notifier = CommitAwareNotifier(session, fail_with=Blocked("bot was blocked"))
    await service.fail_item(session, 1, "boom", notifier)  # must not raise
    assert it.status is ItemStatus.FAILED and it.processed_at is not None
    assert notifier.commits_at_send == [1]


async def test_handle_choice_send_failure_keeps_choice():
    it = make_item(status=ItemStatus.NEEDS_INPUT, extracted={"options": ["A", "B"]})
    session = FakeSession(it)
    notifier = CommitAwareNotifier(session, fail_with=Blocked("x"))
    await service.handle_choice(session, 1, 0, notifier, deps(FakeExtractor(make_extraction())))
    assert it.status is ItemStatus.DONE and notifier.commits_at_send == [session.commits]


async def test_handle_choice_lookup_runs_after_lock_released_and_item_deleted():
    it = make_item(status=ItemStatus.NEEDS_INPUT, extracted={"options": ["A", "B"]})
    session = FakeSession(it)
    commits_at_lookup = []

    class DeletingPlaces(FakePlaces):
        async def resolve(self, s, query, country=None):
            commits_at_lookup.append(session.commits)
            session.objs.pop((Item, 1), None)
            return await super().resolve(s, query, country)

    notifier = FakeNotifier()
    d = deps(FakeExtractor(make_extraction()), places=DeletingPlaces())
    await service.handle_choice(session, 1, 0, notifier, d)
    assert commits_at_lookup == [1]
    assert notifier.sent == [] and session.inserts == []


# ---------------------------------------------------------------- bookings


async def test_no_after_yes_keeps_confirmed_booking():
    b = make_booking_row()
    b.confirmed_at = NOW
    session = FakeSession(b, make_item())
    notifier = FakeNotifier()
    await service.confirm_booking(session, 9, False, notifier)
    assert session.deleted == [] and b.confirmed_at == NOW
    assert notifier.sent[0].text == "Эта бронь уже сохранена."


async def test_confirm_send_failure_keeps_confirmation(monkeypatch):
    async def schedule(session, booking):
        return ["r1"]

    monkeypatch.setattr(scheduler, "schedule_for_booking", schedule)
    b = make_booking_row()
    session = FakeSession(b, make_item())
    notifier = CommitAwareNotifier(session, fail_with=Blocked("x"))
    await service.confirm_booking(session, 9, True, notifier)
    assert b.confirmed_at is not None and notifier.commits_at_send == [1]


async def test_booking_without_date_does_not_promise_reminders(monkeypatch):
    async def schedule(session, booking):
        return []

    monkeypatch.setattr(scheduler, "schedule_for_booking", schedule)
    it = make_item(kind=ItemKind.PHOTO, telegram_file_id="F", raw_text=None)
    ex = make_extraction(kind="booking", place_query=None,
                         booking=make_booking(start_local=None, end_local=None))  # fmt: skip
    session = FakeSession(it, make_user())
    notifier = FakeNotifier()
    await service.process_item(session, 1, notifier, deps(FakeExtractor(ex)))
    msg = notifier.sent[0]
    assert "не смогу напомнить" in msg.text and "Всё верно?" not in msg.text
    assert msg.buttons[0][0].text == "Сохранить без даты"
    [booking] = bookings(session)
    assert booking.starts_at is None
    await service.confirm_booking(session, booking.id, True, notifier)
    assert "напоминания не будет" in notifier.sent[1].text


async def test_date_only_booking_marked_time_unknown():
    it = make_item(kind=ItemKind.PHOTO, telegram_file_id="F", raw_text=None)
    booking = make_booking(type="hotel", start_local="2026-12-20", end_local=None,
                           flight_number=None, confirmation_code="HX1234")  # fmt: skip
    ex = make_extraction(kind="booking", place_query=None, booking=booking)
    session = FakeSession(it, make_user())
    await service.process_item(session, 1, FakeNotifier(), deps(FakeExtractor(ex)))
    [b] = bookings(session)
    assert b.details["time_unknown"] is True and b.starts_at is not None
