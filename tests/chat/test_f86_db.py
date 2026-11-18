"""Ф-86 end to end (real Postgres, fake model): the assistant talks like ChatGPT about everything
else and stays strict about the person's own data; capture by code is unchanged; web search
only behind its flag. Skipped unless DATABASE_URL is set."""

import os

import pytest
from sqlalchemy import func, select

from assistant.ai import FakeAdapter, WebSource
from assistant.ai.types import AdapterRequest, AdapterResponse
from assistant.chat import ChatReply
from assistant.chat.service import WEB_OFF_LINE, WEB_ON_LINE
from assistant.db.models import Item
from tests.api.conftest import client
from tests.chat.test_chat_db import ask, by_name, env, fake_router, page, record, signed_in

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set"),
]
__all__ = ["env"]  # the fixture, imported from the main chat test module

PLAN = ("Вот идея на выходные.\nСуббота:\n1. Утром — завтрак и прогулка в парке, часа на 2.\n"
        "2. Днём — музей или выставка, билет обычно 2 000–3 000 ₸.\n3. Вечером — кино в 19:30.\n"
        "Воскресенье:\n— Выезд за город, до Медеу 30 минут.\n— Вечером спокойно: книга и ранний "
        "сон.")


def _reply(answer: str, mode: str = "general") -> ChatReply:
    return ChatReply(mode=mode, answer=answer, citations=[], insufficient=False)


def _text(evs) -> str:  # type: ignore[no-untyped-def]
    return "".join(d["text"] for d in by_name(evs, "token"))


async def _items(maker) -> int:  # type: ignore[no-untyped-def]
    async with maker() as s:
        return int(await s.scalar(select(func.count()).select_from(Item)) or 0)


async def test_small_talk_gets_a_natural_reply(env):
    adapter = FakeAdapter("anthropic", [_reply("Всё хорошо, спасибо! А у вас как день?")])
    app = env.make_app(fake_router(env.maker, adapter))
    async with client(app) as c:
        h = await signed_in(c)
        evs = await ask(c, h, "Как у тебя дела?")
        assert by_name(evs, "banner")[0]["text"] == "Всё хорошо, спасибо! А у вас как день?"
        assert by_name(evs, "checked") == [{"ok": True, "removed": 0}]
        sent = adapter.requests[-1]
        assert "Do not use general knowledge" not in sent.system
        assert "general knowledge" in sent.system and sent.web_search is None


async def test_conversational_answer_is_not_truncated_and_not_saved(env):
    """«Составь план на выходные» is a question (not a note to keep); a long answer with
    general numbers (times, prices, minutes) reaches the person whole."""
    adapter = FakeAdapter("anthropic", [_reply(PLAN)])
    app = env.make_app(fake_router(env.maker, adapter))
    async with client(app) as c:
        h = await signed_in(c)
        before = await _items(env.maker)
        evs = await ask(c, h, "Составь план на выходные")
        assert _text(evs) == PLAN
        assert by_name(evs, "banner")[0]["text"] == PLAN
        assert by_name(evs, "checked") == [{"ok": True, "removed": 0}]
        assert by_name(evs, "done")[0]["answer_kind"] == "text"
        assert await _items(env.maker) == before  # nothing was filed as a note


async def test_personal_numbers_are_still_verified(env):
    """A question about the person's own spending: an amount no record states is removed even
    when the model calls its answer "general"."""
    adapter = FakeAdapter("anthropic", [
        _reply("На кафе у вас 4 500 ₸. Всего за месяц 37 000 ₸.", mode="general")])
    app = env.make_app(fake_router(env.maker, adapter))
    async with client(app) as c:
        h = await signed_in(c)
        p = await page(c, h, "Кафе")
        await record(c, h, env.maker, "Кафе Saya 4 500 ₸", p)
        evs = await ask(c, h, "Сколько я потратил на кафе?")
        assert _text(evs) == "На кафе у вас 4 500 ₸. "
        assert by_name(evs, "checked") == [{"ok": False, "removed": 1}]


async def test_records_first_then_general_advice(env):
    """Istanbul: saved tips go first (checked against the record), general advice follows
    (not checked, not cut)."""
    answer = ("У вас в записях есть кафе Hafız Mustafa на Сиркеджи. Из общего: Айя-София "
              "открыта с 9:00, паром до Кадыкёя идёт 20 минут.")
    adapter = FakeAdapter("anthropic", [_reply(answer)])
    app = env.make_app(fake_router(env.maker, adapter))
    async with client(app) as c:
        h = await signed_in(c)
        await record(c, h, env.maker, "Стамбул: кафе Hafız Mustafa на Сиркеджи, баклава")
        evs = await ask(c, h, "Я лечу в Стамбул, что посмотреть?")
        assert _text(evs) == answer
        assert by_name(evs, "checked") == [{"ok": True, "removed": 0}]
        assert "Hafız Mustafa" in adapter.requests[-1].messages[-1].text  # records were shown


async def test_capture_is_still_saved_by_code(env):
    adapter = FakeAdapter("anthropic", [_reply("не должен отвечать")])
    app = env.make_app(fake_router(env.maker, adapter))
    async with client(app) as c:
        h = await signed_in(c)
        before = await _items(env.maker)
        evs = await ask(c, h, "запиши купить хлеб")
        assert by_name(evs, "done")[0]["answer_kind"] == "action"
        assert await _items(env.maker) == before + 1
        assert adapter.calls == 0  # «ИИ понимает — скрипт делает»: no chat model for a note


class _WebAdapter(FakeAdapter):
    async def generate(self, req: AdapterRequest) -> AdapterResponse:
        resp = await super().generate(req)
        if req.web_search is not None:
            resp.web_sources = [WebSource("https://www.zakon.kz/pogoda/", "Погода"),
                                WebSource("https://tengrinews.kz/weather/", "Tengri")]
        return resp


async def test_web_search_off_by_default_and_answered_from_knowledge(env):
    adapter = _WebAdapter("anthropic", [_reply("Обычно в ноябре в Стамбуле +12…+15°.")])
    app = env.make_app(fake_router(env.maker, adapter))
    async with client(app) as c:
        h = await signed_in(c)
        evs = await ask(c, h, "Какая погода в Стамбуле в ноябре? Поищи в интернете")
        req = adapter.requests[-1]
        assert req.web_search is None and WEB_OFF_LINE in req.messages[-1].text
        assert not by_name(evs, "web_sources")


async def test_web_search_behind_the_flag_keeps_sources(env):
    adapter = _WebAdapter("anthropic", [_reply("Сегодня в Алматы днём около +2°.")])
    app = env.make_app(fake_router(env.maker, adapter), web_search_enabled=True)
    async with client(app) as c:
        h = await signed_in(c)
        evs = await ask(c, h, "Какая сейчас погода в Алматы?")
        req = adapter.requests[-1]
        assert req.web_search is not None and req.web_search.max_uses == 3
        assert req.web_search.timezone == "Asia/Almaty" and WEB_ON_LINE in req.messages[-1].text
        assert by_name(evs, "web_sources")[0]["sources"][0]["url"] == "https://www.zakon.kz/pogoda/"
        banner = by_name(evs, "banner")[0]["text"]
        assert banner == ("Сегодня в Алматы днём около +2°.\n\nИсточники: zakon.kz, "
                          "tengrinews.kz")
        # a phrase that needs nothing fresh gets no web search even with the flag on
        await ask(c, h, "Как у тебя дела?")
        assert adapter.requests[-1].web_search is None
