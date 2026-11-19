"""Ф-88 end to end against Postgres (fakes only, no network): the device phrases of 2026-11-19.

A. «Создай страницу стамбул» → the model said «Создаю…» and called nothing: code asks again with
   a tool forced, the page is made; if it still does nothing, the answer says so honestly; «Ну и
   где эта страница?» right after gets the change tools.
B. «Мне завтра надо поехать в сто…, потом я сегодня купил кофе за 1000 тенге» → a to-do for
   tomorrow and the spend «кофе» 1 000 ₸, one group with «Отменить всё».
Skipped without DATABASE_URL."""

import os
import uuid
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import text

from assistant.ai.types import AdapterRequest, ToolCall
from assistant.chat import ChatReply
from assistant.chat.intent import PhrasePart, PhraseParts
from assistant.chat.service import CLAIM_RETRY, TEXT_CLAIM_FAILED
from tests.api.conftest import client, make_settings
from tests.chat.test_chat_db import by_name, env, signed_in  # noqa: F401  (fixture)
from tests.chat.test_week6_db import Script, last, router_with, say

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set"),
]

A = "Создай страницу стамбул"
B = ("Мне завтра надо поехать в сто, ходовку машины посмотреть, потом я сегодня купил кофе "
     "за 1000 тенге")
CLAIM = ChatReply(answer="Создаю страницу «Стамбул».", citations=[], insufficient=False)
MAKE = [ToolCall("c1", "create_page_from_template", {"template": "custom", "title": "Стамбул"})]
DONE = ChatReply(answer="Сделал.", citations=[], insufficient=False)


class Split(Script):
    """Script plus the PHRASE_SPLIT answer."""

    def __init__(self, chat: list[Any] | None = None, parts: PhraseParts | None = None) -> None:
        super().__init__(chat)
        self.parts = parts

    def __call__(self, req: AdapterRequest) -> Any:
        if req.schema_name == "PhraseParts":
            self.calls.setdefault(req.schema_name, []).append(req)
            assert self.parts is not None, "no split expected"
            return self.parts
        return super().__call__(req)


def _text(req: AdapterRequest) -> str:
    return "\n".join(m.text for m in req.messages)


async def _message(c, h, reply_id: str) -> dict:  # type: ignore[no-untyped-def]
    return (await c.get(f"/v1/chat/messages/{reply_id}", headers=h)).json()


async def test_a_claimed_page_is_asked_again_and_made(env):  # noqa: F811
    script = Script([CLAIM, MAKE, DONE])
    async with client(env.make_app(router_with(env.maker, script))) as c:
        h = await signed_in(c)
        evs = await say(c, h, A)
        actions = by_name(evs, "action")
        assert [a["action"]["summary"]["ru"] for a in actions] == ["Сделал страницу «Стамбул»."]
        done = last(evs, "done")
        assert done["answer_kind"] == "action"
        reqs = script.calls["ChatReply"]
        strong = make_settings().model_strong
        assert all(r.model == strong for r in reqs)  # Ф-88: a change turn runs on Sonnet
        assert reqs[0].tool_choice == "required"  # forced where the provider allows it
        assert "create_page_from_template" in {t.name for t in reqs[0].tools}
        assert CLAIM_RETRY not in _text(reqs[0])
        assert CLAIM_RETRY in _text(reqs[1]) and "Создаю страницу" in _text(reqs[1])
        assert reqs[1].tool_choice == "required"
        msg = await _message(c, h, done["reply_id"])
        assert msg["text"] == "Сделал страницу «Стамбул»."  # code's words, not the model's
        async with env.maker() as s:
            tools = await s.scalar(text("SELECT tool_calls FROM conversation_messages "
                                        "WHERE public_id = :p"), {"p": uuid.UUID(msg["id"])})
        assert any(t["name"] == "claim_retry" for t in tools)  # the re-ask is on record
        pages = (await c.get("/v1/pages", headers=h)).json()["pages"]
        assert "Стамбул" in {p["title"] for p in pages}


async def test_a_still_nothing_is_said_honestly_then_the_follow_up_does_it(env):  # noqa: F811
    script = Script([CLAIM, CLAIM])
    async with client(env.make_app(router_with(env.maker, script))) as c:
        h = await signed_in(c)
        evs = await say(c, h, A)
        assert by_name(evs, "action") == []
        done = last(evs, "done")
        msg = await _message(c, h, done["reply_id"])
        assert msg["text"] == TEXT_CLAIM_FAILED["ru"]  # no made-up «Создаю»
        assert len(script.calls["ChatReply"]) == 2  # one re-ask, no more

        # «Ну и где эта страница?» is a question by its words; it points back at the failed
        # change, so the change tools are offered and code's page check reads «страницу»
        script.chat = [MAKE, DONE]
        evs = await say(c, h, "Ну и где эта страница?")
        actions = by_name(evs, "action")
        assert [a["action"]["summary"]["ru"] for a in actions] == ["Сделал страницу «Стамбул»."]
        first = script.calls["ChatReply"][2]
        assert first.model == make_settings().model_strong
        assert "create_page_from_template" in {t.name for t in first.tools}
        assert "«Создай страницу стамбул»" in _text(first)


async def test_follow_up_without_a_pending_change_stays_a_question(env):  # noqa: F811
    script = Script([ChatReply(answer="Ключи в прихожей.", citations=[], insufficient=False)])
    async with client(env.make_app(router_with(env.maker, script))) as c:
        h = await signed_in(c)
        await say(c, h, "Привет")
        evs = await say(c, h, "Ну и где?")
        assert by_name(evs, "action") == []
        req = script.calls["ChatReply"][-1]
        assert req.model == make_settings().model_fast  # questions stay on Haiku
        assert "create_page_from_template" not in {t.name for t in req.tools}
        assert req.tool_choice == "auto"


async def test_b_mixed_phrase_becomes_a_todo_and_a_spend(env):  # noqa: F811
    script = Split()
    async with client(env.make_app(router_with(env.maker, script))) as c:
        h = await signed_in(c)
        evs = await say(c, h, B)
        kinds = [a["action"]["kind"] for a in by_name(evs, "action")]
        assert sorted(kinds) == ["create_expense", "save_item"]
        done = last(evs, "done")
        assert done["answer_kind"] == "action"
        group = done["group"]
        assert group["size"] == 2 and group["notice"]["undo_label_ru"] == "Отменить всё"
        spends = (await c.get("/v1/expenses", headers=h)).json()["expenses"]
        assert len(spends) == 1
        assert spends[0]["amount"] == "1000.00" and spends[0]["note"] == "кофе"  # not the phrase
        today = datetime.now(ZoneInfo("Asia/Almaty")).date()
        assert spends[0]["spent_on"] == today.isoformat()
        tasks = (await c.get("/v1/tasks", headers=h)).json()["tasks"]
        assert [(t["title"], t["due_date"]) for t in tasks] == [
            ("Поехать в сто, ходовку машины посмотреть", (today + timedelta(days=1)).isoformat())]
        assert script.n("PhraseParts") == 0 and script.n("ChatReply") == 0  # all by code
        # «Отменить всё» takes both away
        r = await c.post(f"/v1/actions/groups/{group['id']}/undo", headers=h)
        assert r.status_code == 200, r.text
        assert (await c.get("/v1/expenses", headers=h)).json()["expenses"] == []


async def test_mixed_phrase_code_cannot_split_goes_to_the_strong_model(env):  # noqa: F811
    phrase = "Завтра к стоматологу, сегодня кофе за 1000 тенге"
    parts = PhraseParts(parts=[PhrasePart(text="Завтра к стоматологу", kind="task"),
                               PhrasePart(text="сегодня кофе за 1000 тенге", kind="expense")])
    script = Split(parts=parts)
    async with client(env.make_app(router_with(env.maker, script))) as c:
        h = await signed_in(c)
        evs = await say(c, h, phrase)
        assert sorted(a["action"]["kind"] for a in by_name(evs, "action")) == [
            "create_expense", "save_item"]
        assert [r.model for r in script.calls["PhraseParts"]] == [make_settings().model_strong]
        spends = (await c.get("/v1/expenses", headers=h)).json()["expenses"]
        assert [(s["amount"], s["note"]) for s in spends] == [("1000.00", "кофе")]
        tasks = (await c.get("/v1/tasks", headers=h)).json()["tasks"]
        assert len(tasks) == 1 and tasks[0]["due_date"] is not None


async def test_split_with_a_made_up_word_saves_no_spend_of_the_whole_phrase(env):  # noqa: F811
    phrase = "Завтра к стоматологу, сегодня кофе за 1000 тенге"
    parts = PhraseParts(parts=[PhrasePart(text="Завтра к врачу", kind="task"),
                               PhrasePart(text="кофе за 1000 тенге", kind="expense")])
    script = Split(parts=parts)
    async with client(env.make_app(router_with(env.maker, script))) as c:
        h = await signed_in(c)
        evs = await say(c, h, phrase)
        assert "create_expense" not in {a["action"]["kind"] for a in by_name(evs, "action")}
        assert (await c.get("/v1/expenses", headers=h)).json()["expenses"] == []


async def test_a_plain_spend_still_takes_the_instant_path(env):  # noqa: F811
    script = Split()
    async with client(env.make_app(router_with(env.maker, script))) as c:
        h = await signed_in(c)
        evs = await say(c, h, "я сегодня купил кофе за 1000 тенге")
        assert [a["action"]["kind"] for a in by_name(evs, "action")] == ["create_expense"]
        assert script.n("PhraseParts") == 0 and script.n("ChatReply") == 0
