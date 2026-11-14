"""Week 9 against a real database: tasks and shopping by voice/text from the line on any page
(the finish criterion), tasks by hand with «Отменить», reminders from the line (`reminder_draft`)
and reminder actions, page actions, screen exclusions in S30, «Сегодня», suggestion limits.
Providers are fakes (no network). Skipped without DATABASE_URL."""

import json
import os
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from assistant.ai import FakeAdapter
from assistant.ai.types import AdapterRequest
from assistant.api.app import create_app
from assistant.api.sms import FakeSmsSender
from assistant.reminders.parse import ReminderParseOut
from assistant.tasks import TasksReply
from assistant.tasks.parse import TaskLine
from tests.api.conftest import client, make_settings, make_storage
from tests.chat.test_chat_db import _all_text, fake_router, signed_in
from tests.chat.test_week6_db import Script, last

pytestmark = [
    pytest.mark.db,
    pytest.mark.usefixtures("shopping_on"),  # «Покупки» itself (hidden by default, Ф-49)
    pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set"),
]


@dataclass
class Env9:
    maker: Any
    make_app: Any  # (router, **settings) -> FastAPI


@pytest.fixture
async def env9(tmp_path: Path):
    engine = create_async_engine(os.environ["DATABASE_URL"])
    async with engine.connect() as conn:
        trans = await conn.begin()
        maker = async_sessionmaker(bind=conn, expire_on_commit=False,
                                   join_transaction_mode="create_savepoint")  # fmt: skip
        async with maker() as s:
            await s.execute(text("DELETE FROM jobs"))
            await s.commit()
        apps = []

        def make_app(ai_router: Any = None, **kw: Any):  # type: ignore[no-untyped-def]
            app = create_app(make_settings(**kw), sessionmaker=maker, sms=FakeSmsSender(),
                             storage=make_storage(tmp_path), ai_router=ai_router)  # fmt: skip
            apps.append(app)
            return app

        try:
            yield Env9(maker, make_app)
        finally:
            for app in apps:
                await app.state.ctx.chat.drain()
            await trans.rollback()
    await engine.dispose()


class Script9(Script):
    """+ the week 9 readers."""

    def __init__(self, tasks: TasksReply | None = None,
                 reminder: ReminderParseOut | None = None) -> None:  # fmt: skip
        super().__init__()
        self.tasks, self.reminder = tasks, reminder

    def __call__(self, req: AdapterRequest) -> Any:
        if req.schema_name == "TasksReply":
            self.calls.setdefault("TasksReply", []).append(req)
            return self.tasks or TasksReply(list="none", items=[], day="none")
        if req.schema_name == "ReminderParseOut":
            self.calls.setdefault("ReminderParseOut", []).append(req)
            assert self.reminder is not None
            return self.reminder
        return super().__call__(req)


def router9(maker, script: Script9):  # type: ignore[no-untyped-def]
    return fake_router(maker, FakeAdapter("anthropic", [script]))


async def say(c, h, text_: str, **kw):  # type: ignore[no-untyped-def]
    from tests.chat.test_chat_db import events

    r = await c.post("/v1/chat/messages", json={"client_id": str(uuid.uuid4()), "text": text_,
                                                 **kw}, headers=h)  # fmt: skip
    assert r.status_code == 200, r.text
    return events(r.text)


async def add_page(c, h, key: str, title: str | None = None) -> dict:  # type: ignore[no-untyped-def]
    body: dict[str, Any] = {"client_id": str(uuid.uuid4()), "template_key": key}
    if title:
        body["title"] = title
    r = await c.post("/v1/pages", json=body, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


async def entries(c, h, pid: str) -> list[dict]:  # type: ignore[no-untyped-def]
    r = await c.get(f"/v1/pages/{pid}/items?limit=200", headers=h)
    assert r.status_code == 200, r.text
    return r.json()["entries"]


SHOPPING = TasksReply(list="shopping", items=[TaskLine(title="Хлеб", qty=None),
                                              TaskLine(title="Молоко", qty=None),
                                              TaskLine(title="Лекарства маме", qty=None),
                                              TaskLine(title="Икра", qty="3 банки")],
                      day="none")  # fmt: skip


# --- the finish criterion: tasks and shopping from the line on any page ---


async def test_shopping_by_voice_from_another_page_one_undo(env9):
    script = Script9(tasks=SHOPPING)
    async with client(env9.make_app(router9(env9.maker, script))) as c:
        h = await signed_in(c)
        shop = (await add_page(c, h, "shopping"))["page"]["id"]
        other = (await add_page(c, h, "custom", "Дача"))["page"]["id"]
        evs = await say(c, h, "купить хлеб, молоко и лекарства маме", page_id=other,
                        input_kind="voice")
        ev = last(evs, "action")
        action = ev["action"]
        # «Икра» is not in the phrase: dropped by code, never invented.
        assert action["summary"]["ru"] == "Добавил в Покупки: хлеб, молоко, лекарства маме."
        assert action["kind"] == "save_item" and action["page"]["id"] == shop
        assert [t["title"] for t in ev["tasks"]] == ["Хлеб", "Молоко", "Лекарства маме"]
        assert all(t["list_key"] == "shopping" for t in ev["tasks"])
        assert any(p["page_id"] == shop for _, n, p in evs if n == "page_patch")
        assert last(evs, "done")["answer_kind"] == "action"
        rows = await entries(c, h, shop)
        assert {e["task"]["title"] for e in rows} == {"Хлеб", "Молоко", "Лекарства маме"}
        assert rows[0]["fields"]["bought"] is False and "what" in rows[0]["fields"]
        req = script.calls["TasksReply"][0]
        assert "купить хлеб" in _all_text(req)  # the phrase alone, as data
        # One «Отменить» takes all three back.
        r = await c.post(f"/v1/actions/{action['id']}/undo", headers=h)
        assert r.status_code == 200, r.text
        assert await entries(c, h, shop) == []
        r = await c.get("/v1/tasks", headers=h)
        assert r.json()["tasks"] == []


async def test_todo_with_a_day_and_no_list_page(env9):
    script = Script9(tasks=TasksReply(list="todo", items=[TaskLine(title="Позвонить маме",
                                                                   qty=None)], day="tomorrow"))
    async with client(env9.make_app(router9(env9.maker, script))) as c:
        h = await signed_in(c)
        evs = await say(c, h, "надо позвонить маме завтра")
        ev = last(evs, "action")
        assert ev["action"]["summary"]["ru"] == "Записал: позвонить маме."
        task = ev["tasks"][0]
        assert task["list_key"] == "todo" and task["due_date"] is not None
        # A «Дела» page made later shows it at once.
        tasks_page = (await add_page(c, h, "tasks"))["page"]["id"]
        rows = await entries(c, h, tasks_page)
        assert rows[0]["task"]["id"] == task["id"] and rows[0]["fields"]["done"] is False


async def test_rules_first_reads_lists_without_the_model(env9):
    script = Script9()
    app = env9.make_app(router9(env9.maker, script), tasks_rules_first=True)
    async with client(app) as c:
        h = await signed_in(c)
        shop = (await add_page(c, h, "shopping"))["page"]["id"]
        evs = await say(c, h, "добавь в покупки 2 кг яблок и сыр")
        ev = last(evs, "action")
        assert [(t["title"], t["qty"]) for t in ev["tasks"]] == [("Яблок", "2 кг"), ("Сыр", None)]
        evs = await say(c, h, "хлеб", page_id=shop)  # one word on «Покупки»: a thing to buy
        assert [t["title"] for t in last(evs, "action")["tasks"]] == ["Хлеб"]
        assert script.n("TasksReply") == 0 and script.n("ChatReply") == 0


async def test_not_a_list_stays_a_note(env9):
    script = Script9()  # the reader says «none»
    async with client(env9.make_app(router9(env9.maker, script))) as c:
        h = await signed_in(c)
        evs = await say(c, h, "надо позвонить мастеру Ерлану")
        action = last(evs, "action")["action"]
        assert action["summary"]["ru"] == "Записал." and "tasks" not in last(evs, "action")


# --- tasks by hand ---


async def test_tasks_by_hand_tick_edit_delete_undo(env9):
    async with client(env9.make_app()) as c:
        h = await signed_in(c, kinds=("pd_processing", "terms"))
        shop = (await add_page(c, h, "shopping"))["page"]["id"]
        cid = str(uuid.uuid4())
        r = await c.post("/v1/tasks", json={"client_id": cid, "list_key": "shopping",
                                            "title": "Хлеб", "qty": "2"}, headers=h)
        assert r.status_code == 201, r.text
        body = r.json()
        task = body["task"]
        assert body["action"]["summary"]["ru"] == "Добавил в Покупки: хлеб."
        again = await c.post("/v1/tasks", json={"client_id": cid, "list_key": "shopping",
                                                "title": "Хлеб"}, headers=h)
        assert again.status_code == 200 and again.json()["action"]["id"] == body["action"]["id"]
        tick = await c.post(f"/v1/tasks/{task['id']}/done",
                            json={"client_id": str(uuid.uuid4()), "done": True}, headers=h)
        assert tick.json()["task"]["done"] is True
        assert tick.json()["action"]["summary"]["ru"] == "Купил: хлеб"
        r = await c.post(f"/v1/actions/{tick.json()['action']['id']}/undo", headers=h)
        assert r.status_code == 200
        t = (await c.get("/v1/tasks", headers=h)).json()["tasks"][0]
        assert t["done"] is False
        r = await c.patch(f"/v1/tasks/{task['id']}", json={"version": t["version"],
                                                           "list_key": "todo"}, headers=h)
        assert r.status_code == 200, r.text
        assert await entries(c, h, shop) == []  # moved off «Покупки»
        r = await c.post(f"/v1/actions/{r.json()['action']['id']}/undo", headers=h)
        assert [e["task"]["list_key"] for e in await entries(c, h, shop)] == ["shopping"]
        stale = await c.patch(f"/v1/tasks/{task['id']}", json={"version": 1, "title": "x"},
                              headers=h)
        assert stale.status_code == 409
        d = await c.delete(f"/v1/tasks/{task['id']}", headers=h)
        assert d.json()["task"]["deleted_at"] is not None
        await c.post(f"/v1/actions/{d.json()['action']['id']}/undo", headers=h)
        assert len((await c.get("/v1/tasks", headers=h)).json()["tasks"]) == 1
        s = (await c.get("/v1/sync?since=0&limit=500", headers=h)).json()
        assert any(x["id"] == task["id"] for x in s["tasks"])


# --- reminders from the line, reminder actions ---


async def test_reminder_phrase_gives_a_draft_and_saves_nothing(env9):
    script = Script9()
    app = env9.make_app(router9(env9.maker, script), reminders_rules_first=True)
    async with client(app) as c:
        h = await signed_in(c)
        evs = await say(c, h, "Напомни завтра в 7:30 выпить таблетку", input_kind="voice")
        d = last(evs, "reminder_draft")
        assert d["status"] == "ok" and d["source"] == "rules" and d["created_via"] == "voice"
        assert d["draft"]["local"]["time"] == "07:30" and d["draft"]["level"] == "alarm"
        assert last(evs, "banner")["text"].startswith("Понял так:")
        assert (await c.get("/v1/reminders", headers=h)).json()["reminders"] == []
        # [Сохранить] → the action with «Отменить», linked to the line's answer.
        body = {"client_id": str(uuid.uuid4()), **{k: d["draft"][k] for k in
                                                    ("title", "due_at", "tz", "rrule", "offsets",
                                                     "level")},
                "created_via": "voice", "parse_source": "rules", "message_id": d["reply_id"]}
        r = await c.post("/v1/reminders", json=body, headers=h)
        assert r.status_code == 201, r.text
        action = r.json()["action"]
        assert action["kind"] == "create_reminder" and action["message_id"] == d["reply_id"]
        assert action["summary"]["ru"].startswith("Напомню")
        rid = r.json()["reminder"]["id"]
        p = await c.patch(f"/v1/reminders/{rid}", json={"version": 1, "title": "Таблетка"},
                          headers=h)
        assert p.json()["action"]["kind"] == "edit_reminder"
        await c.post(f"/v1/actions/{p.json()['action']['id']}/undo", headers=h)
        got = (await c.get(f"/v1/reminders/{rid}", headers=h)).json()["reminder"]
        assert got["title"] == "Выпить таблетку"
        dl = await c.delete(f"/v1/reminders/{rid}", headers=h)
        assert dl.status_code == 200 and dl.json()["reminder"]["deleted_at"]
        u = await c.post(f"/v1/actions/{dl.json()['action']['id']}/undo", headers=h)
        assert u.status_code == 200 and u.json()["partial"] is False
        back = (await c.get(f"/v1/reminders/{rid}", headers=h)).json()
        assert back["reminder"]["deleted_at"] is None
        assert any(f["state"] == "planned" for f in back["fires"])
        # «Отменить» of the first save after the person's later changes: theirs stays.
        late = await c.post(f"/v1/actions/{action['id']}/undo", headers=h)
        assert late.json()["partial"] is True
        assert len((await c.get("/v1/reminders", headers=h)).json()["reminders"]) == 1


async def test_reminder_question_is_not_a_reminder(env9):
    from tests.chat.test_chat_db import ChatReply

    script = Script9()
    script.chat = [ChatReply(answer="Не нашёл в записях.", citations=[], insufficient=True)]
    async with client(env9.make_app(router9(env9.maker, script))) as c:
        h = await signed_in(c)
        evs = await say(c, h, "напомни, как зовут мастера?")
        assert "reminder_draft" not in [n for _, n, _ in evs]


# --- pages: actions; S30 exclusions ---


async def test_page_remove_rename_add_are_undoable(env9):
    async with client(env9.make_app()) as c:
        h = await signed_in(c, kinds=("pd_processing", "terms"))
        made = await add_page(c, h, "custom", "Ремонт")
        pid = made["page"]["id"]
        assert made["action"]["kind"] == "create_screen"
        r = await c.patch(f"/v1/pages/{pid}", json={"title": "Дача"}, headers=h)
        assert r.json()["action"]["summary"]["ru"] == "Переименовал страницу в «Дача»"
        await c.post(f"/v1/actions/{r.json()['action']['id']}/undo", headers=h)
        assert (await c.get(f"/v1/pages/{pid}", headers=h)).json()["title"] == "Ремонт"
        item = (await c.post("/v1/items", json={"client_id": str(uuid.uuid4()),
                                                "text": "Плитка"}, headers=h)).json()["item"]
        a = await c.post(f"/v1/pages/{pid}/items", json={"item_id": item["id"]}, headers=h)
        assert a.status_code == 201 and a.json()["action"]["kind"] == "screen_add_item"
        r = await c.delete(f"/v1/pages/{pid}", headers=h)
        assert r.json()["deleted_at"] and r.json()["action"]["kind"] == "delete_screen"
        await c.post(f"/v1/actions/{r.json()['action']['id']}/undo", headers=h)
        assert [e["item"]["id"] for e in await entries(c, h, pid)] == [item["id"]]
        # «Убрать с этой страницы» shows in S30; «Убрать» there shows it again.
        await c.delete(f"/v1/pages/{pid}/items/{item['id']}", headers=h)
        hab = [x for x in (await c.get("/v1/habits", headers=h)).json()["habits"]
               if x["kind"] == "screen_exclusion"]
        assert hab and hab[0]["item_id"] == item["id"] and "Плитка" in hab[0]["text_ru"]
        r = await c.delete(f"/v1/habits/{hab[0]['id']}", headers=h)
        assert r.json()["removed"] is True and r.json()["action"]
        assert [e["item"]["id"] for e in await entries(c, h, pid)] == [item["id"]]


# --- «Сегодня» and suggestions ---


async def _age(maker, h_user_days: int, c, h) -> int:  # type: ignore[no-untyped-def]
    me = (await c.get("/v1/me", headers=h)).json()
    async with maker() as s:
        uid = await s.scalar(text("SELECT id FROM users WHERE public_id = :p"),
                             {"p": uuid.UUID(me["id"])})
        await s.execute(text("UPDATE users SET created_at = now() - make_interval(days => :d) "
                             "WHERE id = :u"), {"d": h_user_days, "u": uid})
        await s.commit()
    return int(uid)


async def test_today_empty_tip_and_not_now_pause(env9):
    async with client(env9.make_app()) as c:
        h = await signed_in(c, kinds=("pd_processing", "terms"))
        t = (await c.get("/v1/today", headers=h)).json()
        assert t["empty"] is True and t["tip"]["key"] == "first_reminder"
        assert t["greeting"].startswith("Добрый день") and "tip" in t["sections"]
        again = (await c.get("/v1/today", headers=h)).json()
        assert again["tip"]["id"] == t["tip"]["id"]  # one on screen, stable
        r = await c.post(f"/v1/suggestions/{t['tip']['id']}/dismiss", headers=h)
        assert r.json()["suggestion"]["status"] == "dismissed"
        # New account: ≤2 a day; first_reminder itself waits (gap), nothing else holds.
        assert (await c.get("/v1/today", headers=h)).json()["tip"] is None


async def test_today_sections_tasks_reminders_proposals(env9):
    # week 19 (Ф-42): proposals and later tips are off for the beta; this checks R-35 itself
    async with client(env9.make_app(feature_today_proposals=True, today_tips_days=0,
                                    today_tips_per_day=2)) as c:
        h = await signed_in(c, kinds=("pd_processing", "terms"))
        uid = await _age(env9.maker, 1, c, h)
        today = datetime.now(UTC).date().isoformat()
        await c.post("/v1/tasks", json={"client_id": str(uuid.uuid4()), "list_key": "todo",
                                        "title": "Позвонить маме", "due_date": today}, headers=h)
        await c.post("/v1/tasks", json={"client_id": str(uuid.uuid4()), "list_key": "shopping",
                                        "title": "Хлеб"}, headers=h)
        due = (datetime.now(UTC) + timedelta(minutes=30)).replace(microsecond=0)
        await c.post("/v1/reminders", json={"client_id": str(uuid.uuid4()), "title": "Ерлан",
                                            "due_at": due.isoformat(), "tz": "UTC"}, headers=h)
        # A record whose envelope proposes a to-do → a data proposal (≤2, needs «Да»).
        r = await c.post("/v1/items", json={"client_id": str(uuid.uuid4()),
                                            "text": "Счёт за свет"}, headers=h)
        iid = r.json()["item"]["id"]
        async with env9.maker() as s:
            await s.execute(text("UPDATE users SET tz = 'UTC' WHERE id = :u"), {"u": uid})
            await s.execute(text("""UPDATE items SET envelope = '{"type": "note",
                "proposed": {"tasks": [{"title": "Оплатить свет"}], "reminders": [], "kp": false}}'
                WHERE public_id = :p"""), {"p": uuid.UUID(iid)})
            await s.commit()
        t = (await c.get("/v1/today", headers=h)).json()
        assert [x["task"] if False else x["title"] for x in t["today"]["tasks"]] == [
            "Позвонить маме"]
        assert t["today"]["shopping"]["titles"] == ["Хлеб"]
        assert [x["reminder"]["title"] for x in t["today"]["reminders"]] == ["Ерлан"]
        assert t["sections"][:1] == ["today"]
        prop = t["proposals"][0]
        assert prop["key"] == "task_from_item" and prop["text_ru"].startswith("Добавить в дела")
        assert len((await c.get("/v1/tasks?list_key=todo", headers=h)).json()["tasks"]) == 1
        acc = await c.post(f"/v1/suggestions/{prop['id']}/accept", json={}, headers=h)
        assert acc.status_code == 200, acc.text
        assert acc.json()["task"]["title"] == "Оплатить свет" and acc.json()["action"]
        assert len((await c.get("/v1/tasks?list_key=todo", headers=h)).json()["tasks"]) == 2
        again = await c.post(f"/v1/suggestions/{prop['id']}/accept", json={}, headers=h)
        assert again.json()["task"]["id"] == acc.json()["task"]["id"]  # no second task
        assert (await c.get("/v1/today", headers=h)).json()["proposals"] == []


# --- gaps the phone found: S30 «Изменить», undo of a late «Сделано» ---


async def test_s30_change_moves_a_learned_rule_and_undo_moves_it_back(env9):
    async with client(env9.make_app()) as c:
        h = await signed_in(c, kinds=("pd_processing", "terms"))
        home = (await add_page(c, h, "custom", "Ремонт"))["page"]
        money = (await add_page(c, h, "expenses"))["page"]
        uid = await _age(env9.maker, 0, c, h)
        async with env9.maker() as s:
            await s.execute(text("""INSERT INTO user_habits (user_id, kind, key, value, source,
                evidence_count, status) VALUES (:u, 'placement_rule', :k, CAST(:v AS jsonb),
                'learned_edit', 2, 'active')"""), {
                "u": uid, "k": f"{home['id']}:envelope_type:receipt",
                "v": json.dumps({"page_id": home["id"], "envelope_type": "receipt",
                                 "item_ids": []})})
            await s.commit()
        rule = (await c.get("/v1/habits", headers=h)).json()["habits"][0]
        r = await c.patch(f"/v1/habits/{rule['id']}", json={"page_id": money["id"]}, headers=h)
        assert r.status_code == 200, r.text
        assert r.json()["habit"]["page"]["id"] == money["id"]
        assert r.json()["action"]["kind"] == "habit_change"
        listed = (await c.get("/v1/habits", headers=h)).json()["habits"]
        assert listed[0]["page"]["id"] == money["id"] and "Расходы" in listed[0]["text_ru"]
        await c.post(f"/v1/actions/{r.json()['action']['id']}/undo", headers=h)
        listed = (await c.get("/v1/habits", headers=h)).json()["habits"]
        assert listed[0]["page"]["id"] == home["id"]


async def test_late_done_on_a_missed_reminder_can_be_taken_back(env9):
    async with client(env9.make_app()) as c:
        h = await signed_in(c, kinds=("pd_processing", "terms"))
        due = (datetime.now(UTC) + timedelta(hours=2)).replace(microsecond=0)
        r = await c.post("/v1/reminders", json={"client_id": str(uuid.uuid4()), "title": "Свет",
                                                "due_at": due.isoformat(), "tz": "UTC"},
                         headers=h)  # fmt: skip
        rid, fire = r.json()["reminder"]["id"], r.json()["fires"][0]
        async with env9.maker() as s:  # it rang nobody answered: missed
            await s.execute(text("UPDATE reminder_fires SET state = 'missed' WHERE public_id = :f"),
                            {"f": uuid.UUID(fire["id"])})
            await s.execute(text("UPDATE reminders SET status = 'missed' WHERE public_id = :r"),
                            {"r": uuid.UUID(rid)})
            await s.commit()
        ev = {"client_id": str(uuid.uuid4()), "fire_id": fire["id"], "event": "acked",
              "at": datetime.now(UTC).isoformat()}
        out = (await c.post("/v1/reminders/events", json={"events": [ev]}, headers=h)).json()
        assert out["results"][0]["status"] == "applied"
        action = out["actions"][0]
        assert action["summary"]["ru"] == "Сделано: свет" and action["undoable"] is True
        assert action["event_client_id"] == ev["client_id"]
        assert action["changes"][0]["reminder_id"] == rid
        row = action["changes"][0]
        assert row["kind"] == "reminder" and row["item_id"] is None
        again = (await c.post("/v1/reminders/events", json={"events": [ev]}, headers=h)).json()
        assert again["results"][0]["status"] == "duplicate" and again["actions"] == []
        u = await c.post(f"/v1/actions/{action['id']}/undo", headers=h)
        assert u.status_code == 200 and u.json()["partial"] is False
        got = (await c.get(f"/v1/reminders/{rid}", headers=h)).json()
        assert got["reminder"]["status"] == "missed"
        assert {f["id"]: f["state"] for f in got["fires"]}[fire["id"]] == "missed"
