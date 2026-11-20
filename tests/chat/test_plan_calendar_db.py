"""A plan on the calendar against Postgres (plans.md «A plan on the calendar»): «добавь план в
календарь» on a trip plan without dates asks ONE question, the tap puts every day on the calendar
in one action (a point with its own time is a timed to-do), the same phrase again adds nothing;
«перенеси поездку на неделю позже» moves exactly those to-dos; «убери поездку из календаря»
trashes exactly them (other to-dos stay, the plan stays); every step undoes with one «Отменить».
An action plan goes the «Сделать делами» way. A to-do phrase for the calendar is not taken.

Providers are fakes (no network). Skipped without DATABASE_URL."""

import os
import uuid
from datetime import UTC, date, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import select

from assistant.db.models import Item
from assistant.db.models_tasks import Task
from tests.api.conftest import client
from tests.chat.test_chat_db import env, record, signed_in  # noqa: F401  (env is a fixture)
from tests.chat.test_plans_db import TIPS, PlanScript, kitchen_reply, make_plan_call, trip_reply
from tests.chat.test_week6_db import last, router_with, say

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set"),
]

TZ = ZoneInfo("Asia/Almaty")
MONTHS = ("января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября",
          "октября", "ноября", "декабря")  # fmt: skip


def today() -> date:
    return datetime.now(UTC).astimezone(TZ).date()


def said(d: date) -> str:
    return f"{d.day} {MONTHS[d.month - 1]}"


async def plan_tasks(maker, pid: str) -> list[Task]:  # type: ignore[no-untyped-def]
    async with maker() as s:
        pk = await s.scalar(select(Item.id).where(Item.public_id == uuid.UUID(pid)))
        rows = list(await s.scalars(
            select(Task).join(Item, Item.id == Task.item_id)
            .where(Task.source_item_id == pk, Task.deleted_at.is_(None),
                   Item.deleted_at.is_(None)).order_by(Task.id)))  # fmt: skip
        await s.commit()
    return rows


def tools_of(evs) -> list[str]:  # type: ignore[no-untyped-def]
    return [d.get("tool") for _, n, d in evs if n == "tool_activity"]


async def test_trip_plan_to_calendar_ask_date_shift_remove_and_undo(env):  # noqa: F811
    script = PlanScript([make_plan_call(days=2)], [trip_reply])
    async with client(env.make_app(router_with(env.maker, script))) as c:
        h = await signed_in(c)
        for t in TIPS:
            await record(c, h, env.maker, t)
        other = (await c.post("/v1/tasks", json={"client_id": str(uuid.uuid4()),
                                                 "list_key": "todo", "title": "Оплатить свет",
                                                 "due_date": today().isoformat()},
                              headers=h)).json()  # fmt: skip
        evs = await say(c, h, "составь план поездки в Стамбул на 2 дня")
        pid = last(evs, "plan")["plan"]["item_id"]
        n_chat = script.n("ChatReply")

        # no dates in the plan and none said: ONE question, nothing written
        evs = await say(c, h, "добавь план в календарь")
        ask = last(evs, "needs_choice")
        assert ask["question"] == ("В плане «Стамбул» нет дат. С какого дня поставить его в "
                                   "календарь (2 дня)?")  # fmt: skip
        assert {o["kind"] for o in ask["options"]} == {"date", "cancel"}
        assert script.n("ChatReply") == n_chat  # code only, no model step
        assert await plan_tasks(env.maker, pid) == []

        evs = await say(c, h, ask["options"][0]["label"],
                        choice={"reply_id": ask["reply_id"], "option": "d1"})
        start = today() + timedelta(days=1)
        action = last(evs, "action")["action"]
        assert action["kind"] == "save_item" and action["undoable"]
        tasks = await plan_tasks(env.maker, pid)
        days = [t for t in tasks if t.start_at is None]
        timed = [t for t in tasks if t.start_at is not None]
        assert [(t.title, t.due_date) for t in days] == [
            ("Стамбул: Балат и Фенер", start), ("Стамбул: Кадыкёй", start + timedelta(days=1))]
        # «Цветные дома Балата — утром» → 9:00 (Ф-91); «Кафе на крыше — до 23:00» stays untimed
        assert [(t.title, t.start_at.astimezone(TZ).hour, t.duration_min) for t in timed] == [
            ("Цветные дома Балата", 9, 60)]
        assert {t.created_by for t in tasks} == {"assistant"}
        answer = last(evs, "done")
        assert answer["answer_kind"] == "action"
        said_ = (await c.get("/v1/chat/messages", headers=h)).json()["messages"][-1]["text"]
        assert said_.startswith("Добавил в календарь «Стамбул»: 2 дня, ")
        assert "Со временем — 1 дело." in said_
        assert action["notice"]["text_ru"] == "Добавил в календарь: 3 дела"
        plan = (await c.get(f"/v1/plans/{pid}", headers=h)).json()
        assert plan["start_date"] == start.isoformat()
        assert [d["date"] for d in plan["days"]] == [start.isoformat(),
                                                     (start + timedelta(days=1)).isoformat()]
        assert plan["calendar"]["tasks"] == 3
        cal = (await c.get(f"/v1/calendar?from={start}&to={start + timedelta(days=1)}",
                           headers=h)).json()  # fmt: skip
        mine = [e for e in cal["entries"] if e["plan"] and e["plan"]["id"] == pid]
        assert len(mine) == 3 and {e["source"] for e in mine} == {"assistant"}

        # the same again: nothing new, said so
        evs = await say(c, h, "поставь поездку в Стамбул в календарь")
        assert "action" not in [n for _, n, _ in evs]
        assert len(await plan_tasks(env.maker, pid)) == 3

        # shift by a week: exactly the plan's to-dos, and the plan's dates
        evs = await say(c, h, "перенеси поездку на неделю позже")
        shift = last(evs, "action")["action"]
        moved = await plan_tasks(env.maker, pid)
        assert [t.due_date for t in moved] == [t.due_date + timedelta(days=7) for t in tasks]
        timed_now = next(t for t in moved if t.start_at is not None)
        assert timed_now.start_at.astimezone(TZ).hour == 9
        plan = (await c.get(f"/v1/plans/{pid}", headers=h)).json()
        assert plan["start_date"] == (start + timedelta(days=7)).isoformat()
        r = await c.post(f"/v1/actions/{shift['id']}/undo", headers=h)
        assert r.status_code == 200 and not r.json()["partial"], r.text
        assert [t.due_date for t in await plan_tasks(env.maker, pid)] == [t.due_date
                                                                           for t in tasks]
        plan = (await c.get(f"/v1/plans/{pid}", headers=h)).json()
        assert plan["start_date"] == start.isoformat()

        # remove: exactly those, the plan and the other to-do stay
        evs = await say(c, h, "убери поездку из календаря")
        gone = last(evs, "action")["action"]
        assert gone["kind"] == "delete_item"
        assert gone["notice"]["undo_label_ru"] == "Восстановить"
        assert await plan_tasks(env.maker, pid) == []
        assert (await c.get(f"/v1/plans/{pid}", headers=h)).json()["deleted_at"] is None
        async with env.maker() as s:
            light = await s.scalar(select(Task).where(Task.public_id == uuid.UUID(
                other["task"]["id"])))  # fmt: skip
            await s.commit()
        assert light.deleted_at is None
        evs = await say(c, h, "убери поездку из календаря")
        assert "action" not in [n for _, n, _ in evs]  # nothing left to remove: said so
        r = await c.post(f"/v1/actions/{gone['id']}/undo", headers=h)
        assert r.status_code == 200, r.text
        assert len(await plan_tasks(env.maker, pid)) == 3

        # undo of the add: the to-dos go, the plan has no dates again
        r = await c.post(f"/v1/actions/{action['id']}/undo", headers=h)
        assert r.status_code == 200, r.text
        assert await plan_tasks(env.maker, pid) == []
        plan = (await c.get(f"/v1/plans/{pid}", headers=h)).json()
        assert plan["start_date"] is None and plan["calendar"] is None


async def test_typed_date_answer_and_date_in_phrase(env):  # noqa: F811
    script = PlanScript([make_plan_call(days=2)], [trip_reply])
    async with client(env.make_app(router_with(env.maker, script))) as c:
        h = await signed_in(c)
        for t in TIPS:
            await record(c, h, env.maker, t)
        evs = await say(c, h, "составь план поездки в Стамбул на 2 дня")
        pid = last(evs, "plan")["plan"]["item_id"]
        last(await say(c, h, "внеси Стамбул в календарь"), "needs_choice")
        start = today() + timedelta(days=12)
        evs = await say(c, h, f"с {said(start)}")  # typed instead of a tap
        assert last(evs, "action")["action"]["kind"] == "save_item"
        tasks = await plan_tasks(env.maker, pid)
        assert min(t.due_date for t in tasks) == start

        # a different start said while the plan is on the calendar: not doubled, told how to move
        evs = await say(c, h, f"добавь план в календарь с {said(start + timedelta(days=3))}")
        assert "action" not in [n for _, n, _ in evs]
        assert len(await plan_tasks(env.maker, pid)) == len(tasks)


async def test_a_to_do_for_the_calendar_is_not_a_plan(env):  # noqa: F811
    async with client(env.make_app(router_with(env.maker, PlanScript([], [])))) as c:
        h = await signed_in(c)
        evs = await say(c, h, "добавь встречу с Ерланом в календарь завтра в 15:00")
        assert "plan_calendar" not in tools_of(evs)
        # «план» said, but there is no plan: an honest note, nothing written
        evs = await say(c, h, "добавь план в календарь")
        assert "action" not in [n for _, n, _ in evs]
        assert "plan_calendar" not in tools_of(evs)


async def test_action_plan_to_calendar_is_one_group(env):  # noqa: F811
    script = PlanScript([make_plan_call(kind="actions", topic="ремонт кухни",
                                        title="Ремонт кухни")], [kitchen_reply])  # fmt: skip
    async with client(env.make_app(router_with(env.maker, script))) as c:
        h = await signed_in(c)
        await record(c, h, env.maker, "Ремонт кухни: замерщик Алибек, позвонить в 10:30")
        evs = await say(c, h, "разложи мои дела по ремонту кухни")
        pid = last(evs, "plan")["plan"]["item_id"]
        evs = await say(c, h, "добавь план в календарь")
        done = last(evs, "done")
        assert done["group"]["size"] == 4 and done["group"]["id"] == done["reply_id"]
        assert len(await plan_tasks(env.maker, pid)) == 4
        msgs = (await c.get("/v1/chat/messages", headers=h)).json()["messages"]
        assert "3 с датой — в календаре" in msgs[-1]["text"]
        assert "1 без даты — только в «Делах»" in msgs[-1]["text"]
        evs = await say(c, h, "убери план из календаря")
        assert last(evs, "action")["action"]["kind"] == "delete_item"
        assert await plan_tasks(env.maker, pid) == []
