"""Ф-97 (chat-full-control.md phases 2–3) against Postgres: the line clears the bought ones, brings
records and pages back from the trash, removes a page, sets / clears the month's budget, quiet
hours and the name, cleans exact repeats after «Да», ticks «молоко и хлеб купил» in one action,
fixes a purchase's quantity — each through a registered operation, one action with «Отменить»;
an object changed on the phone since the line saw it is not overwritten; a reminder finished in
the background is set at once (Ф-97 (1)); notices point to the calendar / the budget; «когда я
свободен завтра» gets code's free windows. Providers are fakes. Skipped without DATABASE_URL."""

import os
import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import text

from assistant.chat import ChatReply, jobs
from tests.api.conftest import client
from tests.chat.test_chat_db import env, record, signed_in  # noqa: F401  (env is a fixture)
from tests.chat.test_f95_phase1_db import local_day, no_model, one_task, sent, task
from tests.chat.test_week6_db import Script, by_name, last, router_with, say

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set"),
]


async def undo(c, h, action_id: str) -> None:  # type: ignore[no-untyped-def]
    r = await c.post(f"/v1/actions/{action_id}/undo", headers=h)
    assert r.status_code == 200, r.text


async def done_task(c, h, title: str, list_key: str = "shopping") -> str:  # type: ignore[no-untyped-def]
    tid = (await task(c, h, title, list_key=list_key))["task"]["id"]
    r = await c.post(f"/v1/tasks/{tid}/done", json={"client_id": str(uuid.uuid4()), "done": True},
                     headers=h)  # fmt: skip
    assert r.status_code == 200, r.text
    return tid


async def shopping_page(c, h) -> None:  # type: ignore[no-untyped-def]
    r = await c.post("/v1/pages", json={"client_id": str(uuid.uuid4()),
                                        "template_key": "shopping"}, headers=h)  # fmt: skip
    assert r.status_code in (200, 201), r.text


async def live_tasks(c, h) -> set[str]:  # type: ignore[no-untyped-def]
    got = (await c.get("/v1/tasks?include_done=true", headers=h)).json()["tasks"]
    return {t["title"] for t in got}


async def live_ids(c, h) -> set[str]:  # type: ignore[no-untyped-def]
    got = (await c.get("/v1/tasks?include_done=true", headers=h)).json()["tasks"]
    return {t["id"] for t in got}


async def test_clear_the_bought_ones_by_code_and_undo(env):  # noqa: F811
    script = Script([])
    async with client(env.make_app(router_with(env.maker, script))) as c:
        h = await signed_in(c)
        bread = await done_task(c, h, "Хлеб")
        milk = await done_task(c, h, "Молоко")
        cheese = (await task(c, h, "Сыр", list_key="shopping"))["task"]["id"]
        evs = await say(c, h, "убери купленное")
        action = last(evs, "action")["action"]
        assert no_model(script) and action["kind"] == "delete_item"
        assert action["initiated_by"] == "agent" and "tasks" in action["touched"]
        assert await live_ids(c, h) == {cheese}
        await undo(c, h, action["id"])
        assert await live_ids(c, h) == {cheese, bread, milk}
        # nothing bought: said honestly, nothing changes
        await say(c, h, "убери купленное")
        evs = await say(c, h, "убери купленное")
        assert "action" not in [n for _, n, _ in evs]
        assert "Купленного нет" in last(evs, "banner")["text"]


async def test_trash_restore_by_code_and_undo(env):  # noqa: F811
    async with client(env.make_app(router_with(env.maker, Script([])))) as c:
        h = await signed_in(c)
        rid = await record(c, h, env.maker, "Зимние шины лежат на складе у Ерлана")
        await c.delete(f"/v1/items/{rid}", headers=h)
        evs = await say(c, h, "верни из корзины заметку про шины")
        action = last(evs, "action")["action"]
        assert action["kind"] == "restore_item"
        assert action["summary"]["ru"].startswith("Вернул из корзины")
        assert (await c.get(f"/v1/items/{rid}", headers=h)).json()["deleted_at"] is None
        await undo(c, h, action["id"])
        assert (await c.get(f"/v1/items/{rid}", headers=h)).json()["deleted_at"] is not None


async def test_a_todo_comes_back_from_the_trash_with_its_task(env):  # noqa: F811
    async with client(env.make_app(router_with(env.maker, Script([])))) as c:
        h = await signed_in(c)
        tid = (await task(c, h, "Купить шины"))["task"]["id"]
        assert (await c.delete(f"/v1/tasks/{tid}", headers=h)).status_code == 200
        evs = await say(c, h, "восстанови удалённое дело купить шины")
        action = last(evs, "action")["action"]
        assert action["changes"][0]["task_id"] == tid
        assert tid in await live_ids(c, h)


async def removed(maker, page_id: str) -> bool:  # type: ignore[no-untyped-def]
    async with maker() as s:
        return await s.scalar(text("SELECT deleted_at IS NOT NULL FROM screens "
                                   "WHERE public_id = :p"), {"p": uuid.UUID(page_id)})


async def test_remove_a_page_by_code_restore_it_and_undo(env):  # noqa: F811
    async with client(env.make_app(router_with(env.maker, Script([])))) as c:
        h = await signed_in(c)
        r = await c.post("/v1/pages", json={"client_id": str(uuid.uuid4()),
                                            "template_key": "custom", "title": "Ремонт"},
                         headers=h)  # fmt: skip
        assert r.status_code == 201, r.text
        pid = r.json()["page"]["id"]
        evs = await say(c, h, "удали страницу Ремонт")
        action = last(evs, "action")["action"]
        assert action["kind"] == "delete_screen" and action["undoable"]
        assert await removed(env.maker, pid)
        await undo(c, h, action["id"])
        assert not await removed(env.maker, pid)
        await say(c, h, "удали страницу Ремонт")
        evs = await say(c, h, "восстанови страницу Ремонт")
        assert last(evs, "action")["action"]["summary"]["ru"] == "Вернул страницу «Ремонт»"
        assert not await removed(env.maker, pid)


async def test_budget_quiet_hours_and_name_with_undo(env):  # noqa: F811
    script = Script([])
    async with client(env.make_app(router_with(env.maker, script))) as c:
        h = await signed_in(c)
        evs = await say(c, h, "бюджет 300 000 в месяц")
        action = last(evs, "action")["action"]
        assert no_model(script) and "budget" in action["touched"]
        assert action["notice"]["target"] == {"kind": "budget", "id": None, "page_id": None}
        budget = (await c.get("/v1/expenses/budget", headers=h)).json()["budget"]
        assert budget["amount"] == "300000.00"
        evs = await say(c, h, "убери бюджет")
        assert (await c.get("/v1/expenses/budget", headers=h)).json()["budget"] is None
        await undo(c, h, last(evs, "action")["action"]["id"])  # «Отменить»: the budget is back
        budget = (await c.get("/v1/expenses/budget", headers=h)).json()["budget"]
        assert budget["amount"] == "300000.00"

        evs = await say(c, h, "тихие часы с 23 до 7")
        action = last(evs, "action")["action"]
        assert action["summary"]["ru"] == "Тихие часы: с 23:00 до 7:00"
        got = (await c.get("/v1/reminders/settings", headers=h)).json()
        assert (got["quiet_from"], got["quiet_to"]) == ("23:00", "07:00")
        await undo(c, h, action["id"])
        got = (await c.get("/v1/reminders/settings", headers=h)).json()
        assert got["quiet_from"] != "23:00"

        evs = await say(c, h, "зови меня Али")
        assert last(evs, "action")["action"]["summary"]["ru"] == "Буду обращаться: Али"
        assert (await c.get("/v1/me", headers=h)).json()["display_name"] == "Али"


async def test_cleanup_repeats_asks_yes_then_one_action(env):  # noqa: F811
    async with client(env.make_app(router_with(env.maker, Script([])))) as c:
        h = await signed_in(c)
        for _ in range(3):
            r = await c.post("/v1/items", json={"client_id": str(uuid.uuid4()),
                                                "text": "Пароль от вайфая на даче 12345678"},
                             headers=h)  # fmt: skip
            assert r.status_code == 201
        async with env.maker() as s:  # as if saved apart (no automatic merge on save)
            await s.execute(text("UPDATE items SET hidden_reason = NULL, source_meta = '{}'"))
            await s.commit()
        evs = await say(c, h, "почисти повторы")
        ask = last(evs, "confirm")
        assert "action" not in [n for _, n, _ in evs]
        assert ask["question"].startswith("Убрать 2 повтора")
        evs = await say(c, h, "Да", choice={"reply_id": ask["reply_id"], "option": "yes"})
        action = last(evs, "action")["action"]
        assert action["kind"] == "cleanup_batch" and action["initiated_by"] == "agent"
        await undo(c, h, action["id"])


async def test_milk_and_bread_bought_is_one_action(env):  # noqa: F811
    script = Script([])
    async with client(env.make_app(router_with(env.maker, script))) as c:
        h = await signed_in(c)
        milk = (await task(c, h, "Молоко", list_key="shopping"))["task"]["id"]
        bread = (await task(c, h, "Хлеб", list_key="shopping"))["task"]["id"]
        cheese = (await task(c, h, "Сыр", list_key="shopping"))["task"]["id"]
        evs = await say(c, h, "молоко и хлеб купил")
        assert no_model(script) and len(by_name(evs, "action")) == 1
        assert (await one_task(c, h, milk))["done_at"] and (await one_task(c, h, bread))["done_at"]
        assert (await one_task(c, h, cheese))["done_at"] is None


async def test_quantity_fix_by_code(env):  # noqa: F811
    async with client(env.make_app(router_with(env.maker, Script([])))) as c:
        h = await signed_in(c)
        await shopping_page(c, h)
        r = await c.post("/v1/tasks", json={"client_id": str(uuid.uuid4()), "list_key": "shopping",
                                            "title": "Молоко", "qty": "2"}, headers=h)
        tid = r.json()["task"]["id"]
        await say(c, h, "молоко не 2, а 3")
        got = await one_task(c, h, tid)
        # Ф-49 (no «Покупки»): the to-do «Купить молоко, 2» says it in its title
        assert got["qty"] == "3" or got["title"] == "Купить молоко, 3", got


async def test_a_phone_edit_before_yes_is_not_overwritten(env):  # noqa: F811
    async with client(env.make_app(router_with(env.maker, Script([])))) as c:
        h = await signed_in(c)
        day = local_day(1)
        a = await task(c, h, "Созвон", start=day.replace(hour=10))
        await task(c, h, "Обед с Айгерим", start=day.replace(hour=13))
        evs = await say(c, h, "сдвинь всё завтра на час")
        ask = last(evs, "confirm")
        # meanwhile the phone renamed «Созвон» (an outbox edit)
        cur = await one_task(c, h, a["task"]["id"])
        r = await c.patch(f"/v1/tasks/{a['task']['id']}", json={
            "client_id": str(uuid.uuid4()), "version": cur["version"], "title": "Созвон с банком"},
            headers=h)  # fmt: skip
        assert r.status_code == 200, r.text
        evs = await say(c, h, "Да", choice={"reply_id": ask["reply_id"], "option": "yes"})
        assert "action" not in [n for _, n, _ in evs]
        assert "изменили на телефоне" in last(evs, "banner")["text"]
        got = datetime.fromisoformat((await one_task(c, h, a["task"]["id"]))["start_at"])
        assert got.astimezone(local_day(0).tzinfo).hour == 10  # not moved


async def test_a_move_points_the_notice_to_the_calendar(env):  # noqa: F811
    async with client(env.make_app(router_with(env.maker, Script([])))) as c:
        h = await signed_in(c)
        tid = (await task(c, h, "Встреча с Ерланом", start=local_day(2).replace(hour=15)))
        evs = await say(c, h, "перенеси встречу с Ерланом на 16:00")
        target = last(evs, "action")["action"]["notice"]["target"]
        assert target == {"kind": "calendar", "id": tid["task"]["id"], "page_id": None}


async def test_free_windows_of_tomorrow_are_code_facts(env):  # noqa: F811
    answer = ChatReply(answer="Завтра свободно с 8:00 до 10:00 и после 11:00.", citations=[],
                       insufficient=False)  # fmt: skip
    script = Script([answer])
    async with client(env.make_app(router_with(env.maker, script))) as c:
        h = await signed_in(c)
        await task(c, h, "Созвон", start=local_day(1).replace(hour=10), duration=60)
        evs = await say(c, h, "когда я свободен завтра?")
        assert "action" not in [n for _, n, _ in evs]
        assert "8:00–10:00, 11:00–22:00" in sent(script.calls["ChatReply"][0])


async def test_a_reminder_finished_in_the_background_is_set_at_once(env):  # noqa: F811
    app = env.make_app(router_with(env.maker, Script([])), reminders_rules_first=True)
    async with client(app) as c:
        h = await signed_in(c)
        evs = await say(c, h, "напомни завтра в 7:30 позвонить в банк")
        reply = last(evs, "done")["reply_id"]
        async with env.maker() as s:  # as if the server stopped before anything was written
            await s.execute(text("UPDATE reminders SET deleted_at = now()"))
            await s.execute(text("UPDATE conversation_messages SET state = 'pending', "
                                 "action_ids = '{}', updated_at = now() - interval '10 minutes' "
                                 "WHERE public_id = :p"), {"p": uuid.UUID(reply)})
            pk = await s.scalar(text("SELECT id FROM conversation_messages WHERE public_id = :p"),
                                {"p": uuid.UUID(reply)})  # fmt: skip
            await s.commit()
        app.state.ctx.chat.runs.clear()
        assert await jobs.run_complete(app.state.ctx.chat, pk) == "done"
        msg = (await c.get(f"/v1/chat/messages/{reply}", headers=h)).json()
        assert msg["answer_kind"] == "action" and msg["action"]["undoable"] is True
        live = (await c.get("/v1/reminders", headers=h)).json()["reminders"]
        assert [r["title"] for r in live if r["deleted_at"] is None] == ["Позвонить в банк"]
        due = datetime.fromisoformat(live[0]["due_at"]).astimezone(local_day(0).tzinfo)
        assert (due.date(), due.hour, due.minute) == (local_day(1).date(), 7, 30)
        assert datetime.now(UTC) < due
