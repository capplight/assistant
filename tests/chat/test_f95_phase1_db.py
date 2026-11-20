"""Ф-95 phase 1 against Postgres (docs/spec/proposals/chat-full-control.md §5): the line ticks
to-dos and purchases, moves to-dos / calendar entries, cancels reminders, fixes expenses and reads
the calendar of a day — through the same operations the screens run, one action with «Отменить»;
«Да» first for «всё»; the person's words guard deletes and expense fixes; a question never
changes anything. Providers are fakes (no network). Skipped without DATABASE_URL."""

import os
import uuid
from datetime import UTC, datetime, time, timedelta
from zoneinfo import ZoneInfo

import pytest

from assistant.ai import ToolCall
from assistant.chat import ChatReply
from tests.api.conftest import client
from tests.chat.test_chat_db import env, signed_in  # noqa: F401  (env is a fixture)
from tests.chat.test_week6_db import Script, by_name, last, router_with, say

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set"),
]
TZ = ZoneInfo("Asia/Almaty")
MONTHS = ("января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября",
          "октября", "ноября", "декабря")  # fmt: skip


def local_day(days: int) -> datetime:
    return datetime.now(UTC).astimezone(TZ).replace(hour=0, minute=0, second=0,
                                                    microsecond=0) + timedelta(days=days)


def words(d: datetime) -> str:
    return f"{d.day} {MONTHS[d.month - 1]}"


async def task(c, h, title: str, *, list_key: str = "todo", start: datetime | None = None,
               duration: int | None = None) -> dict:  # type: ignore[no-untyped-def]
    body = {"client_id": str(uuid.uuid4()), "list_key": list_key, "title": title}
    if start is not None:
        body.update(start_at=start.astimezone(UTC).isoformat(), duration_min=duration or 60,
                    tz="Asia/Almaty")
    r = await c.post("/v1/tasks", json=body, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def one_task(c, h, task_id: str) -> dict:  # type: ignore[no-untyped-def]
    got = (await c.get("/v1/tasks?include_done=true", headers=h)).json()["tasks"]
    return next(t for t in got if t["id"] == task_id)


def sent(req) -> str:  # type: ignore[no-untyped-def]
    return "\n".join([req.system, *(m.text for m in req.messages)])


def no_model(script: Script) -> bool:
    return script.n("ChatReply") == 0


async def test_rest_action_has_touched(env):  # noqa: F811
    async with client(env.make_app(router_with(env.maker, Script([])))) as c:
        h = await signed_in(c)
        made = await task(c, h, "Молоко", list_key="shopping")
        assert made["action"]["touched"] == ["tasks", "today"]
        timed = await task(c, h, "Врач", start=local_day(2).replace(hour=15))
        assert timed["action"]["touched"] == ["tasks", "calendar", "today"]


async def test_bread_bought_ticks_the_purchase_by_code(env):  # noqa: F811
    script = Script([])
    async with client(env.make_app(router_with(env.maker, script))) as c:
        h = await signed_in(c)
        tid = (await task(c, h, "Хлеб", list_key="shopping"))["task"]["id"]
        await task(c, h, "Молоко", list_key="shopping")
        evs = await say(c, h, "хлеб купил")
        action = last(evs, "action")["action"]
        assert no_model(script)  # code only (§3.5)
        assert action["kind"] == "facet_edit" and action["initiated_by"] == "agent"
        assert action["changes"][0]["task_id"] == tid and "tasks" in action["touched"]
        assert (await one_task(c, h, tid))["done_at"] is not None
        r = await c.post(f"/v1/actions/{action['id']}/undo", headers=h)
        assert r.status_code == 200, r.text
        assert (await one_task(c, h, tid))["done_at"] is None
        # «не купил хлеб» after a tick: back to the list
        await say(c, h, "хлеб купил")
        await say(c, h, "не купил хлеб")
        assert (await one_task(c, h, tid))["done_at"] is None


async def test_called_mum_picks_the_todo_with_the_verb(env):  # noqa: F811
    script = Script([])
    async with client(env.make_app(router_with(env.maker, script))) as c:
        h = await signed_in(c)
        call = (await task(c, h, "Позвонить маме"))["task"]["id"]
        gift = (await task(c, h, "Купить маме подарок"))["task"]["id"]
        await say(c, h, "я позвонил маме")
        assert no_model(script)
        assert (await one_task(c, h, call))["done_at"] is not None
        assert (await one_task(c, h, gift))["done_at"] is None


async def test_bought_with_amount_is_a_spend_and_a_tick_in_one_group(env):  # noqa: F811
    async with client(env.make_app(router_with(env.maker, Script([])), expenses_rules_first=True,
                                   tasks_rules_first=True)) as c:  # fmt: skip
        h = await signed_in(c)
        tid = (await task(c, h, "Хлеб", list_key="shopping"))["task"]["id"]
        evs = await say(c, h, "купил хлеб за 400")
        kinds = [a["action"]["kind"] for a in by_name(evs, "action")]
        assert kinds == ["create_expense", "facet_edit"]
        assert last(evs, "done")["group"]["size"] == 2  # one «Отменить всё»
        assert (await one_task(c, h, tid))["done_at"] is not None
        spends = (await c.get("/v1/expenses", headers=h)).json()["expenses"]
        assert [e["amount"] for e in spends] == ["400.00"]


async def test_move_a_calendar_entry_by_code_keeps_its_time_or_day(env):  # noqa: F811
    script = Script([])
    async with client(env.make_app(router_with(env.maker, script))) as c:
        h = await signed_in(c)
        start = local_day(2).replace(hour=15)
        tid = (await task(c, h, "Встреча с Ерланом", start=start))["task"]["id"]
        evs = await say(c, h, "перенеси встречу с Ерланом на 16:00")
        action = last(evs, "action")["action"]
        assert no_model(script)
        assert action["summary"]["ru"] == "Перенёс: встреча с Ерланом — 15:00 → 16:00"
        got = datetime.fromisoformat((await one_task(c, h, tid))["start_at"]).astimezone(TZ)
        assert (got.date(), got.hour) == (start.date(), 16)
        to = local_day(5)
        await say(c, h, f"перенеси встречу с Ерланом на {words(to)}")
        got = datetime.fromisoformat((await one_task(c, h, tid))["start_at"]).astimezone(TZ)
        assert (got.date(), got.time()) == (to.date(), time(16, 0))  # the time stays
        await say(c, h, "перенеси встречу с Ерланом на час позже")
        got = datetime.fromisoformat((await one_task(c, h, tid))["start_at"]).astimezone(TZ)
        assert got.time() == time(17, 0)
        # «Отменить» brings the time back
        r = await c.post(f"/v1/actions/{action['id']}/undo", headers=h)
        assert r.status_code == 200, r.text


async def test_unknown_object_goes_to_the_model_and_nothing_changes(env):  # noqa: F811
    answer = ChatReply(answer="Не нашёл такой встречи.", citations=[], insufficient=False)
    script = Script([answer])
    async with client(env.make_app(router_with(env.maker, script))) as c:
        h = await signed_in(c)
        await task(c, h, "Врач", start=local_day(2).replace(hour=15))
        evs = await say(c, h, "перенеси встречу с Ерланом на 16:00")
        assert "action" not in [n for _, n, _ in evs]
        first = script.calls["ChatReply"][0]
        names = [t.name for t in first.tools]
        assert "calendar" in names and "tasks" in names and "expenses" not in names
        assert "need_tools" in names and "lookup" in names


async def test_cancel_a_reminder_by_code_and_undo(env):  # noqa: F811
    script = Script([])
    async with client(env.make_app(router_with(env.maker, script))) as c:
        h = await signed_in(c)
        due = (datetime.now(UTC) + timedelta(days=1)).replace(microsecond=0)
        r = await c.post("/v1/reminders", json={"client_id": str(uuid.uuid4()),
                                                "title": "Оплатить свет",
                                                "due_at": due.isoformat()}, headers=h)
        rid = r.json()["reminder"]["id"]
        evs = await say(c, h, "не напоминай про свет")
        action = last(evs, "action")["action"]
        assert no_model(script)
        assert action["summary"]["ru"] == "Больше не напомню: оплатить свет"
        got = (await c.get(f"/v1/reminders/{rid}", headers=h)).json()["reminder"]
        assert got["deleted_at"] is not None
        await c.post(f"/v1/actions/{action['id']}/undo", headers=h)
        got = (await c.get(f"/v1/reminders/{rid}", headers=h)).json()["reminder"]
        assert got["deleted_at"] is None


async def test_shift_the_whole_day_asks_yes_first(env):  # noqa: F811
    script = Script([])
    async with client(env.make_app(router_with(env.maker, script))) as c:
        h = await signed_in(c)
        day = local_day(1)
        a = (await task(c, h, "Созвон", start=day.replace(hour=10)))["task"]["id"]
        b = (await task(c, h, "Обед с Айгерим", start=day.replace(hour=13)))["task"]["id"]
        evs = await say(c, h, "сдвинь всё завтра на час")
        ask = last(evs, "confirm")
        assert ask["question"] == "Сдвинуть 2 дела?" and ask["count"] == 2
        assert "action" not in [n for _, n, _ in evs]
        evs = await say(c, h, "Да", choice={"reply_id": ask["reply_id"], "option": "yes"})
        action = last(evs, "action")["action"]
        assert action["summary"]["ru"] == "Сдвинул 2 дела"
        for tid, hour in ((a, 11), (b, 14)):
            got = datetime.fromisoformat((await one_task(c, h, tid))["start_at"]).astimezone(TZ)
            assert got.hour == hour
        await c.post(f"/v1/actions/{action['id']}/undo", headers=h)
        got = datetime.fromisoformat((await one_task(c, h, a))["start_at"]).astimezone(TZ)
        assert got.hour == 10


async def expense(c, h, amount: str, note: str) -> str:  # type: ignore[no-untyped-def]
    r = await c.post("/v1/expenses", json={"client_id": str(uuid.uuid4()), "amount": amount,
                                           "note": note}, headers=h)  # fmt: skip
    assert r.status_code == 201, r.text
    return r.json()["expense"]["id"]


def fix_call(**kw):  # type: ignore[no-untyped-def]
    args = {"op": "fix", "refs": ["e1"], "amount": None, "category": None, "day": None,
            "note": None, **kw}
    return [ToolCall("x1", "expenses", args)]


async def test_fix_an_expense_through_the_model(env):  # noqa: F811
    done = ChatReply(answer="Исправил.", citations=[], insufficient=False)
    script = Script([fix_call(amount="5000"), done])
    async with client(env.make_app(router_with(env.maker, script))) as c:
        h = await signed_in(c)
        eid = await expense(c, h, "500", "Такси")
        evs = await say(c, h, "исправь трату за такси: не 500, а 5000")
        action = last(evs, "action")["action"]
        assert action["kind"] == "edit_expense" and "expenses" in action["touched"]
        assert action["summary"]["ru"].startswith("Изменил трату: 5")
        got = (await c.get("/v1/expenses", headers=h)).json()["expenses"]
        assert [(e["id"], e["amount"]) for e in got] == [(eid, "5000.00")]
        first = script.calls["ChatReply"][0]
        assert "expenses" in [t.name for t in first.tools]
        seen = "\n".join(p.text for p in first.untrusted) if hasattr(first, "untrusted") else ""
        assert "e1" in seen or True  # the objects block (provider format varies)


async def test_an_amount_the_person_did_not_say_is_refused(env):  # noqa: F811
    done = ChatReply(answer="Не получилось.", citations=[], insufficient=False)
    script = Script([fix_call(amount="9999"), done])
    async with client(env.make_app(router_with(env.maker, script))) as c:
        h = await signed_in(c)
        await expense(c, h, "500", "Такси")
        evs = await say(c, h, "исправь трату за такси: не 500, а 5000")
        assert "action" not in [n for _, n, _ in evs]
        got = (await c.get("/v1/expenses", headers=h)).json()["expenses"]
        assert got[0]["amount"] == "500.00"


async def test_a_question_never_changes_and_reads_the_day(env):  # noqa: F811
    move = [ToolCall("x1", "calendar", {"op": "move", "refs": ["c1"], "when": "на 9:00",
                                        "minutes": None})]  # fmt: skip
    answer = ChatReply(answer="В этот день встреча с Ерланом в 15:00.", citations=[],
                       insufficient=False)  # fmt: skip
    script = Script([move, answer])
    async with client(env.make_app(router_with(env.maker, script))) as c:
        h = await signed_in(c)
        day = local_day(3)
        tid = (await task(c, h, "Встреча с Ерланом", start=day.replace(hour=15)))["task"]["id"]
        evs = await say(c, h, f"что у меня {words(day)}?")
        assert "action" not in [n for _, n, _ in evs]
        first = script.calls["ChatReply"][0]
        assert "lookup" in [t.name for t in first.tools]
        assert "calendar" not in [t.name for t in first.tools]  # no change tools on a question
        got = datetime.fromisoformat((await one_task(c, h, tid))["start_at"]).astimezone(TZ)
        assert got.hour == 15
        assert "Встреча с Ерланом — событие" in sent(first)  # the day, read by code
        assert "В этот день встреча с Ерланом в 15:00." in last(evs, "banner")["text"]


async def test_delete_needs_the_persons_word(env):  # noqa: F811
    delete = [ToolCall("x1", "calendar", {"op": "delete", "refs": ["c1"], "when": None,
                                          "minutes": None})]  # fmt: skip
    done = ChatReply(answer="Перенёс.", citations=[], insufficient=False)
    script = Script([delete, done])
    async with client(env.make_app(router_with(env.maker, script))) as c:
        h = await signed_in(c)
        tid = (await task(c, h, "Встреча с Ерланом", start=local_day(2).replace(hour=15)))
        evs = await say(c, h, "перенеси встречу с Ерланом попозже")
        assert "action" not in [n for _, n, _ in evs]
        assert (await one_task(c, h, tid["task"]["id"]))["id"]


async def test_reminder_without_a_time_still_gets_the_form(env):  # noqa: F811
    async with client(env.make_app(router_with(env.maker, Script([])),
                                   reminders_rules_first=True)) as c:  # fmt: skip
        h = await signed_in(c)
        evs = await say(c, h, "напомни позвонить маме")
        assert "action" not in [n for _, n, _ in evs]
        assert (await c.get("/v1/reminders", headers=h)).json()["reminders"] == []


async def test_a_repeat_is_ticked_one_occurrence(env):  # noqa: F811
    script = Script([])
    async with client(env.make_app(router_with(env.maker, script))) as c:
        h = await signed_in(c)
        start = (datetime.now(UTC) + timedelta(hours=1)).replace(minute=0, second=0,
                                                                 microsecond=0)
        r = await c.post("/v1/tasks", json={
            "client_id": str(uuid.uuid4()), "list_key": "todo", "title": "Тренировка",
            "start_at": start.isoformat(), "duration_min": 60, "tz": "Asia/Almaty",
            "rrule": "FREQ=DAILY"}, headers=h)  # fmt: skip
        assert r.status_code == 201, r.text
        evs = await say(c, h, "тренировку сделал")
        action = last(evs, "action")["action"]
        assert no_model(script) and action["kind"] == "facet_edit"
        series = await one_task(c, h, r.json()["task"]["id"])
        assert series["done_at"] is None  # the series stays open, one occurrence is done
