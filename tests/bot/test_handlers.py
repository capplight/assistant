"""Handlers wired through the real Dispatcher, with a fake bot session and fake DB service."""

from contextlib import asynccontextmanager
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any

import pytest
from aiogram import Bot
from aiogram.client.session.base import BaseSession
from aiogram.methods import AnswerCallbackQuery, SendMessage, TelegramMethod
from aiogram.types import Message, Update

from assistant import qa
from assistant.bot import service, texts
from assistant.bot.app import create_dispatcher


class FakeBotSession(BaseSession):
    def __init__(self) -> None:
        super().__init__()
        self.calls: list[TelegramMethod] = []

    async def make_request(self, bot, method, timeout=None) -> Any:  # noqa: ASYNC109
        self.calls.append(method)
        if isinstance(method, SendMessage):
            return Message.model_validate(
                {
                    "message_id": 1000 + len(self.calls),
                    "date": int(datetime.now(UTC).timestamp()),
                    "chat": {"id": method.chat_id, "type": "private"},
                    "text": method.text,
                }
            )
        return True

    async def stream_content(self, *a, **kw):  # pragma: no cover
        yield b""

    async def close(self) -> None:
        pass

    def texts(self) -> list[str]:
        return [c.text for c in self.calls if isinstance(c, SendMessage)]


@asynccontextmanager
async def fake_scope():
    yield SimpleNamespace()


@pytest.fixture
def env(monkeypatch):
    user = SimpleNamespace(id=1, telegram_id=555, tz="Asia/Almaty", consent_at=datetime.now(UTC))
    saved: list = []
    state = {"existing": set(), "allowed": True}

    async def mark(session, update_id):
        return True

    async def ensure_user(session, telegram_id, first_name):
        return user

    async def existing(session, user_id, hashes):
        return state["existing"] & set(hashes)

    async def can_save_more(session, u, limit):
        return state["allowed"]

    async def save_items(session, u, drafts, *, chat_id, message_id):
        saved.extend(drafts)
        return drafts

    async def owns_item(session, user_id, item_id):
        return False

    for name, fn in [
        ("mark_update_processed", mark),
        ("ensure_user", ensure_user),
        ("existing_url_hashes", existing),
        ("can_save_more", can_save_more),
        ("save_items", save_items),
        ("owns_item", owns_item),
    ]:
        monkeypatch.setattr(service, name, fn)

    fake = FakeBotSession()
    bot = Bot("123456:TEST", session=fake)
    dp = create_dispatcher(fake_scope)

    async def feed(**message_fields) -> list[str]:
        base = {
            "message_id": 10,
            "date": 1700000000,
            "chat": {"id": 555, "type": "private"},
            "from": {"id": 555, "is_bot": False, "first_name": "A"},
        }
        upd = Update.model_validate({"update_id": 1, "message": {**base, **message_fields}})
        await dp.feed_update(bot, upd)
        return fake.texts()

    return SimpleNamespace(
        user=user, saved=saved, state=state, feed=feed, fake=fake, bot=bot, dp=dp
    )


async def test_note_is_saved_and_acknowledged(env):
    assert await env.feed(text="Взять адаптер") == [texts.ACCEPTED]
    assert len(env.saved) == 1


async def test_without_consent_asks_for_it(env):
    env.user.consent_at = None
    assert await env.feed(text="Взять адаптер") == [texts.SAVED_WAITING_CONSENT]
    assert env.fake.calls[0].reply_markup.inline_keyboard[0][0].callback_data == "consent:yes"


async def test_duplicate_link(env):
    from assistant.links import url_hash

    env.state["existing"] = {url_hash("https://instagram.com/reel/x")}
    assert await env.feed(text="https://instagram.com/reel/x/") == [texts.ALREADY_SAVED]
    assert env.saved == []


async def test_free_limit(env):
    env.state["allowed"] = False
    (reply,) = await env.feed(text="Взять адаптер")
    assert "лимит" in reply
    assert env.saved == []


async def test_question_answered(env, monkeypatch):
    asked = []

    async def answer(session, user_id, question, *, location=None):
        asked.append((user_id, question))
        return qa.Answer(text="Вот что нашёл: кафе Бамбук", item_ids=[5])

    monkeypatch.setattr(qa, "answer", answer)
    assert await env.feed(text="где поесть?") == ["Вот что нашёл: кафе Бамбук"]
    assert asked == [(1, "где поесть?")]
    assert env.saved == []


async def test_question_while_qa_not_ready(env, monkeypatch):
    async def answer(*a, **kw):
        raise NotImplementedError

    monkeypatch.setattr(qa, "answer", answer)
    assert await env.feed(text="где поесть?") == [texts.QA_NOT_READY]


async def test_location_goes_to_nearby(env, monkeypatch):
    async def nearby(session, user_id, location, *, radius_m=1500):
        assert (location.lat, location.lon) == (1.0, 2.0)
        raise NotImplementedError

    monkeypatch.setattr(qa, "nearby", nearby)
    assert await env.feed(location={"latitude": 1.0, "longitude": 2.0}) == [texts.QA_NOT_READY]


async def test_trip_bad_dates(env):
    assert await env.feed(text="/trip Фукуок 10.12") == [texts.TRIP_BAD_DATES]


async def test_start_shows_consent_for_new_user(env):
    env.user.consent_at = None
    replies = await env.feed(text="/start")
    assert replies == [texts.START, texts.CONSENT]
    assert not any("ИИ" in t or "AI" in t for t in replies)


async def test_callback_for_foreign_item_is_refused(env):
    upd = Update.model_validate(
        {
            "update_id": 2,
            "callback_query": {
                "id": "q1",
                "chat_instance": "c",
                "from": {"id": 555, "is_bot": False, "first_name": "A"},
                "data": "pick:99:0",
            },
        }
    )
    await env.dp.feed_update(env.bot, upd)
    (call,) = env.fake.calls
    assert isinstance(call, AnswerCallbackQuery)
    assert call.text == texts.CALLBACK_NOT_FOUND
