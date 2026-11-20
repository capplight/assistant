"""Ф-95 phase 0 against Postgres (docs/spec/proposals/chat-full-control.md): «удали это» in the
line on a to-do does what the screen's delete does (the to-do and its reminder too, one undo);
the screens' deletes run the same registered operations; «переведи…», «посчитай…» reach the model
and are answered, never saved as notes or spends; a bare «нет» to «Поставить так?» asks again.

Providers are fakes (no network). Skipped without DATABASE_URL."""

import os
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from assistant.chat import ChatReply
from assistant.db.models import Item, Reminder
from assistant.db.models_tasks import Task
from tests.api.conftest import client
from tests.chat.test_chat_db import env, record, signed_in  # noqa: F401  (env is a fixture)
from tests.chat.test_plan_calendar_db import TIPS, today
from tests.chat.test_plans_db import PlanScript, make_plan_call, trip_reply
from tests.chat.test_week6_db import Script, last, router_with, say

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set"),
]


async def state(maker, task_id: str) -> tuple:  # type: ignore[no-untyped-def]
    async with maker() as s:
        task = await s.scalar(select(Task).where(Task.public_id == uuid.UUID(task_id)))
        item = await s.get(Item, task.item_id)
        rem = await s.scalar(select(Reminder).where(Reminder.item_id == task.item_id))
        await s.commit()
    return task.deleted_at, item.deleted_at, rem.deleted_at if rem else "none"


async def test_line_trash_of_a_todo_is_the_screen_delete(env):  # noqa: F811
    async with client(env.make_app(router_with(env.maker, Script([])))) as c:
        h = await signed_in(c)
        start = (datetime.now(UTC) + timedelta(days=2)).replace(microsecond=0)
        made = (await c.post("/v1/tasks", json={
            "client_id": str(uuid.uuid4()), "list_key": "todo", "title": "Врач",
            "start_at": start.isoformat(), "duration_min": 30, "reminder_offset_min": 10},
            headers=h)).json()  # fmt: skip
        tid, iid = made["task"]["id"], made["task"]["item_id"]
        assert await state(env.maker, tid) == (None, None, None)

        evs = await say(c, h, "удали это", selected_item_id=iid)
        action = last(evs, "action")["action"]
        assert action["kind"] == "delete_item"
        gone = await state(env.maker, tid)
        assert all(x is not None for x in gone)  # the to-do, its record and its alert
        assert action["changes"][0]["task_id"] == tid
        r = await c.post(f"/v1/actions/{action['id']}/undo", headers=h)
        assert r.status_code == 200, r.text
        assert await state(env.maker, tid) == (None, None, None)

        # the screen's delete: the same operation, the same result
        r = await c.delete(f"/v1/tasks/{tid}", headers=h)
        assert r.status_code == 200, r.text
        assert all(x is not None for x in await state(env.maker, tid))
        assert r.json()["action"]["summary"]["ru"] == "Убрал в корзину: врач"


async def test_a_note_is_trashed_alone(env):  # noqa: F811
    async with client(env.make_app(router_with(env.maker, Script([])))) as c:
        h = await signed_in(c)
        rid = await record(c, h, env.maker, "Пароль от вайфая на даче")
        evs = await say(c, h, "удали это", selected_item_id=rid)
        assert last(evs, "action")["action"]["notice"]["undo_label_ru"] == "Восстановить"
        assert (await c.get(f"/v1/items/{rid}", headers=h)).json()["deleted_at"] is not None


@pytest.mark.parametrize("phrase", [
    "Переведи на английский: завтра в 9:00 встреча с поставщиком, номер заказа 4512 3367 81",
    "посчитай 1 250 000 × 12 %",
    "напиши поздравление маме с днём рождения, ей 60 лет",
    "исправь ошибки: превет, я сегодня опаздаю на 15 минут",
])  # fmt: skip
async def test_requests_to_the_assistant_are_answered_not_saved(env, phrase):  # noqa: F811
    answer = ChatReply(answer="Вот ответ.", citations=[], insufficient=False)
    script = Script([answer])
    async with client(env.make_app(router_with(env.maker, script))) as c:
        h = await signed_in(c)
        evs = await say(c, h, phrase)
        names = [n for _, n, _ in evs]
        assert "action" not in names  # no note, no spend, no to-do
        assert script.n("ChatReply") == 1 and script.n("IntentReply") == 0
        status = next(d for _, n, d in evs if n == "status")
        assert status["text"] == "Думаю…"
        items = (await c.get("/v1/items", headers=h)).json()
        assert not [i for i in items.get("items", []) if i.get("deleted_at") is None]


async def test_bare_no_to_the_times_question_asks_again(env):  # noqa: F811
    script = PlanScript([make_plan_call(days=2)], [trip_reply])
    async with client(env.make_app(router_with(env.maker, script))) as c:
        h = await signed_in(c)
        for t in TIPS:
            await record(c, h, env.maker, t)
        await say(c, h, "составь план поездки в Стамбул на 2 дня")
        start = today() + timedelta(days=4)
        months = ("января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа",
                  "сентября", "октября", "ноября", "декабря")  # fmt: skip
        ask = last(await say(c, h, f"добавь каждый пункт отдельно в календарь с {start.day} "
                                   f"{months[start.month - 1]}"), "needs_choice")
        assert ask["question"].startswith("Предлагаю так:")
        again = last(await say(c, h, "нет"), "needs_choice")
        assert again["question"].startswith("Что поменять?")
        assert [o["id"] for o in again["options"]] == ["t_ok", "m_days", "cancel"]
        evs = await say(c, h, "да")
        assert last(evs, "action")["action"]["kind"] == "save_item"
