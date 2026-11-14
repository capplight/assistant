"""Week 20 against a real database: structure after UX review 2 and mocks v2 (Ф-48...Ф-51, Ф-55).

- «Расходы» is a default page; an older account gets it once, lazily (Ф-48);
- the shopping list is hidden: «купить молоко» is a to-do on «Дела», no «Покупки» (Ф-49);
- every save says where it went (`saved_to`) and «Переложить» = move-to-page with «Отменить»;
  «История» = phrases + what they did; search and the line answer with a value; a КП from a
  phrase / «из этого» (Ф-50); «Документы» (Ф-51);
- the monthly budget and the «Сегодня» briefing (mocks v2).
Providers are fakes (no network). Skipped without DATABASE_URL."""

import os
import uuid
from datetime import UTC, datetime
from typing import Any

import pytest
from sqlalchemy import text

from assistant.ai import ToolCall
from assistant.chat import ChatReply
from tests.api.conftest import client
from tests.api.test_week9_db import entries
from tests.api.test_week19_db import _first_launch, _pages, _say, _uid
from tests.chat.test_chat_db import (  # noqa: F401  (env is a fixture)
    FakeAdapter,
    _ref_from_results,
    by_name,
    env,
    fake_router,
    record,
    signed_in,
)
from tests.chat.test_week6_db import Script, last, router_with

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set"),
]


# --- Ф-48: «Расходы» is a default page ---


async def test_expenses_is_made_once_for_an_older_account(env):  # noqa: F811
    async with client(env.make_app()) as c:
        h = await _first_launch(c)
        uid = await _uid(c, env.maker, h)
        pages = await _pages(c, h)
        # an account from before Ф-48: no «Расходы», never made by the server
        async with env.maker() as s:
            await s.execute(text("DELETE FROM screens WHERE public_id = :p"),
                            {"p": uuid.UUID(pages["expenses"]["id"])})  # fmt: skip
            await s.execute(text("UPDATE users SET pages_first_use = '{}' WHERE id = :u"),
                            {"u": uid})  # fmt: skip
            await s.commit()
        r = await c.get("/v1/sync", headers=h)  # /v1/sync makes it (like /pages, /today)
        assert "expenses" in {p["template_key"] for p in r.json()["screens"]}
        pages = await _pages(c, h)
        assert pages["expenses"]["created_by"] == "system"
        # removed by the person: never made again
        r = await c.delete(f"/v1/pages/{pages['expenses']['id']}", headers=h)
        assert r.status_code == 200, r.text
        assert "expenses" not in await _pages(c, h)
        assert (await c.get("/v1/today", headers=h)).status_code == 200
        assert "expenses" not in await _pages(c, h)


async def test_no_lazy_pages_before_the_first_launch(env):  # noqa: F811
    async with client(env.make_app()) as c:
        h = await signed_in(c)
        r = await c.get("/v1/pages", headers=h)
        assert {p["template_key"] for p in r.json()["pages"]} == {"today"}


# --- Ф-49: no shopping list ---


async def test_things_to_buy_are_todos_without_shopping(env):  # noqa: F811
    async with client(env.make_app()) as c:
        h = await _first_launch(c)
        r = await c.post("/v1/tasks", json={"client_id": str(uuid.uuid4()),
                                            "list_key": "shopping", "title": "Молоко",
                                            "qty": "2 л"}, headers=h)  # fmt: skip
        assert r.status_code == 201, r.text
        out = r.json()
        assert out["task"]["list_key"] == "todo" and out["task"]["title"] == "Купить молоко, 2 л"
        pages = await _pages(c, h)
        assert "shopping" not in pages
        assert out["task"]["item_id"] in {e["item"]["id"] for e in
                                          await entries(c, h, pages["tasks"]["id"])}
        assert not [x for x in out["action"]["changes"] if x["kind"] == "create_page"]
        assert out["action"]["saved_to"][0]["page_id"] == pages["tasks"]["id"]
        today = (await c.get("/v1/today", headers=h)).json()
        assert today["today"]["shopping"] is None


async def test_list_phrase_in_the_line_goes_to_tasks(env):  # noqa: F811
    from assistant.tasks import TasksReply
    from assistant.tasks.parse import TaskLine
    from tests.api.test_week9_db import Script9, router9

    script = Script9(tasks=TasksReply(list="shopping", items=[TaskLine(title="Молоко", qty=None),
                                                              TaskLine(title="Хлеб", qty=None)],
                                      day="none"))  # fmt: skip
    async with client(env.make_app(router9(env.maker, script))) as c:
        h = await _first_launch(c)
        ev = last(await _say(c, h, "купить молоко, хлеб"), "action")
        assert ev["action"]["summary"]["ru"] == "Добавил в дела: купить молоко, купить хлеб."
        assert [t["list_key"] for t in ev["tasks"]] == ["todo", "todo"]
        pages = await _pages(c, h)
        assert "shopping" not in pages
        saved = ev["action"]["saved_to"]
        assert [x["page_id"] for x in saved] == [pages["tasks"]["id"]]
        assert len(saved[0]["item_ids"]) == 2


async def test_bought_with_a_price_is_an_expense(env):  # noqa: F811
    async with client(env.make_app(router_with(env.maker, Script()),
                                   expenses_rules_first=True)) as c:
        h = await _first_launch(c)
        ev = last(await _say(c, h, "купил молоко за 600"), "action")
        assert ev["action"]["kind"] == "create_expense"
        assert ev["expenses"][0]["amount"] == "600.00"
        pages = await _pages(c, h)
        assert ev["action"]["saved_to"][0]["page_id"] == pages["expenses"]["id"]


# --- Ф-50: «Сохранил в «…» · Переложить», «История», value answers, КП from the line ---


async def test_saved_to_and_move_with_undo(env):  # noqa: F811
    async with client(env.make_app(router_with(env.maker, Script()))) as c:
        h = await _first_launch(c)
        pages = await _pages(c, h)
        ev = last(await _say(c, h, "Мастер Ерлан, плитка, позвонить в пятницу"), "action")
        saved = ev["action"]["saved_to"]
        assert saved and saved[0]["title"] == "Заметки" and saved[0]["template_key"] == "notes"
        item = saved[0]["item_ids"][0]
        # «Переложить» = move-to-page (undoable); the action now says where it is
        r = await c.post(f"/v1/items/{item}/move-to-page", json={
            "client_id": str(uuid.uuid4()), "mode": "move", "from_page_id": saved[0]["page_id"],
            "to_page_ids": [pages["tasks"]["id"]]}, headers=h)  # fmt: skip
        assert r.status_code == 200 and r.json()["moved"], r.text
        a = (await c.get(f"/v1/actions/{ev['action']['id']}", headers=h)).json()
        assert [x["page_id"] for x in a["saved_to"]] == [pages["tasks"]["id"]]
        undo = await c.post(f"/v1/actions/{r.json()['action']['id']}/undo", headers=h)
        assert undo.status_code == 200, undo.text
        a = (await c.get(f"/v1/actions/{ev['action']['id']}", headers=h)).json()
        assert [x["page_id"] for x in a["saved_to"]] == [pages["notes"]["id"]]
        # «Отменить» of the save: nowhere any more
        await c.post(f"/v1/actions/{ev['action']['id']}/undo", headers=h)
        a = (await c.get(f"/v1/actions/{ev['action']['id']}", headers=h)).json()
        assert a["saved_to"] == []


async def test_history_merges_phrases_and_actions(env):  # noqa: F811
    async with client(env.make_app(router_with(env.maker, Script()))) as c:
        h = await _first_launch(c)
        note = last(await _say(c, h, "Мастер Ерлан, плитка, позвонить в пятницу"), "action")
        await _say(c, h, "где ключи?")  # a question: answered by the fake «Готово.»
        r = await c.post("/v1/expenses", json={"client_id": str(uuid.uuid4()), "amount": "1200",
                                               "note": "Кофе"}, headers=h)  # fmt: skip
        by_hand = r.json()["action"]
        r = await c.get("/v1/history", headers=h)
        assert r.status_code == 200, r.text
        rows = r.json()["entries"]
        # (the test runs in one transaction, so every row has the same time: no order checks)
        turns = {e["said"]["text"]: e for e in rows if e["kind"] == "turn"}
        assert turns["где ключи?"]["status"] == "answered" and turns["где ключи?"]["answer"]
        mine = turns["Мастер Ерлан, плитка, позвонить в пятницу"]
        assert mine["status"] == "done" and mine["action"]["id"] == note["action"]["id"]
        alone = [e for e in rows if e["kind"] == "action"]
        assert by_hand["id"] in {e["action"]["id"] for e in alone}
        assert all(e["said"] is None for e in alone)
        # no action of a phrase is listed twice
        ids = [e["action"]["id"] for e in rows if e["action"]]
        assert len(ids) == len(set(ids)) and note["action"]["id"] not in {
            e["action"]["id"] for e in alone}
        changes = (await c.get("/v1/history?only=changes", headers=h)).json()["entries"]
        assert changes and all(e["action"] for e in changes)
        questions = (await c.get("/v1/history?only=questions", headers=h)).json()["entries"]
        assert [e["said"]["text"] for e in questions] == ["где ключи?"]
        # paging: `before` = the last entry's id; pages do not overlap and cover everything
        p1 = (await c.get("/v1/history?limit=2", headers=h)).json()
        assert p1["has_more"] and len(p1["entries"]) == 2
        p2 = (await c.get(f"/v1/history?limit=50&before={p1['entries'][-1]['id']}",
                          headers=h)).json()  # fmt: skip
        assert [e["id"] for e in p1["entries"] + p2["entries"]] == [e["id"] for e in rows]
        # undone shows as undone
        await c.post(f"/v1/actions/{by_hand['id']}/undo", headers=h)
        rows = (await c.get("/v1/history", headers=h)).json()["entries"]
        assert ("action", "undone") in [(e["kind"], e["status"]) for e in rows]
        assert (await c.get(f"/v1/history?before={uuid.uuid4()}", headers=h)).status_code == 404


async def test_search_answers_with_a_value(env):  # noqa: F811
    async with client(env.make_app()) as c:
        h = await _first_launch(c)
        item = await record(c, h, env.maker, "Код домофона 4512, подъезд 3")
        await record(c, h, env.maker, "Код от калитки на даче 0909")
        r = await c.get("/v1/search", params={"q": "код от домофона"}, headers=h)
        assert r.status_code == 200, r.text
        ans = r.json()["answer"]
        assert ans["value"] == "4512" and ans["item_id"] == item
        assert ans["context"] == "Код домофона 4512, подъезд 3"
        r = await c.get("/v1/search", params={"q": "домофон"}, headers=h)
        assert r.json()["answer"] is None  # not a value question: the list only


async def test_line_answer_with_a_value(env):  # noqa: F811
    adapter = FakeAdapter("anthropic", [
        [ToolCall("c1", "search", {"query": "домофон", "page": None, "kind": None,
                                   "date_from": None, "date_to": None})],
        lambda req: ChatReply(answer="Код домофона — 4512.",
                              citations=[_ref_from_results(req)], insufficient=False),
    ])  # fmt: skip
    async with client(env.make_app(fake_router(env.maker, adapter))) as c:
        h = await signed_in(c)
        item = await record(c, h, env.maker, "Код домофона 4512, подъезд 3")
        r = await c.post("/v1/chat/messages", json={"client_id": str(uuid.uuid4()),
                                                     "text": "какой код от домофона?"},
                         headers=h)  # fmt: skip
        from tests.chat.test_chat_db import events

        evs = events(r.text)
        banner = by_name(evs, "banner")[0]
        assert banner["value"]["text"] == "4512"
        assert banner["value"]["source"]["item_id"] == item
        reply = by_name(evs, "done")[0]["reply_id"]
        msg = (await c.get(f"/v1/chat/messages/{reply}", headers=h)).json()
        assert msg["value"]["text"] == "4512"


async def _docs(e, uid: int) -> list[Any]:  # type: ignore[no-untyped-def]
    async with e.maker() as s:
        return list((await s.execute(text(
            "SELECT d.public_id, d.status, d.request_text, d.source_item_ids FROM documents d "
            "WHERE d.user_id = :u ORDER BY d.id"), {"u": uid})).all())  # fmt: skip


async def test_kp_from_a_phrase_and_from_this(env):  # noqa: F811
    async with client(env.make_app(router_with(env.maker, Script()), kp_per_day=2)) as c:
        h = await _first_launch(c)
        uid = await _uid(c, env.maker, h)
        evs = await _say(c, h, "сделай КП для ТОО Ромашка: 20 светильников, монтаж")
        started = by_name(evs, "kp_started")
        assert len(started) == 1 and not started[0]["from_this"]
        assert by_name(evs, "banner")[0]["text"].startswith("Готовлю КП")
        docs = await _docs(env, uid)
        assert len(docs) == 1 and docs[0][1] == "extracting"
        assert str(docs[0][0]) == started[0]["document_id"]
        async with env.maker() as s:
            body = await s.scalar(text("SELECT text FROM items WHERE id = :i"),
                                  {"i": docs[0][3][0]})  # fmt: skip
            jobs = await s.scalar(text("SELECT count(*) FROM jobs WHERE kind = 'kp:extract'"))
        assert body == "для ТОО Ромашка: 20 светильников, монтаж" and jobs == 1
        # the КП page is «Документы» (Ф-51)
        assert (await _pages(c, h))["documents"]["title"] == "Документы"
        # «сделать документ из этого» on a selected record
        item = await record(c, h, env.maker, "Заявка: кабель ВВГ 3х2.5 — 100 м, розетки 10 шт")
        evs = await _say(c, h, "сделать документ из этого", selected_item_id=item)
        assert by_name(evs, "kp_started")[0]["from_this"]
        docs = await _docs(env, uid)
        async with env.maker() as s:
            pk = await s.scalar(text("SELECT id FROM items WHERE public_id = :p"),
                                {"p": uuid.UUID(item)})  # fmt: skip
        assert docs[-1][3] == [pk]
        # the daily limit, and «из этого» with nothing selected
        evs = await _say(c, h, "сделай КП для Арман: кабель 50 м")
        assert not by_name(evs, "kp_started")
        assert by_name(evs, "banner")[0]["text"] == "На сегодня КП достаточно — продолжу завтра."
        evs = await _say(c, h, "сделай КП из этого")
        assert by_name(evs, "banner")[0]["text"].startswith("Из какой записи?")


async def test_new_kp_from_text(env):  # noqa: F811
    async with client(env.make_app(router_with(env.maker, Script()))) as c:
        h = await _first_launch(c)
        r = await c.post("/v1/documents/kp", json={"client_id": str(uuid.uuid4()),
                                                   "text": "Светильники LED 20 шт, монтаж"},
                         headers=h)  # fmt: skip
        assert r.status_code == 202, r.text
        assert r.json()["document"]["status"] == "extracting"
        r = await c.post("/v1/documents/kp", json={"client_id": str(uuid.uuid4())}, headers=h)
        assert r.status_code == 422


async def test_documents_page_is_renamed_unless_the_person_named_it(env):  # noqa: F811
    """0026: pages called by the old default name follow the new one (the migration's SQL, run
    again here on rows made with the old name)."""
    import importlib.util
    import pathlib

    path = pathlib.Path(__file__).parents[2] / "migrations" / "versions" / "0026_structure.py"
    spec = importlib.util.spec_from_file_location("m0026", path)
    assert spec and spec.loader
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    rename = next(x for x in m.UPGRADE if "UPDATE screens" in x)
    async with client(env.make_app()) as c:
        h = await _first_launch(c)
        uid = await _uid(c, env.maker, h)
        from assistant.kp import service as kp

        async with env.maker() as s:
            await kp.create(s, uid, sources=[], wishes=None, client_id=uuid.uuid4(),
                            now=datetime.now(UTC))  # fmt: skip
            await s.execute(text("UPDATE screens SET title = 'Документы и КП', title_kk = NULL "
                                 "WHERE user_id = :u AND template_key = 'documents'"),
                            {"u": uid})  # fmt: skip
            await s.execute(text(rename))
            await s.commit()
        docs = (await _pages(c, h))["documents"]
        assert docs["title"] == "Документы"
        async with env.maker() as s:
            await s.execute(text("UPDATE screens SET title = 'Мои бумаги' WHERE user_id = :u "
                                 "AND template_key = 'documents'"), {"u": uid})  # fmt: skip
            await s.execute(text(rename))
            await s.commit()
        assert (await _pages(c, h))["documents"]["title"] == "Мои бумаги"


# --- the budget and the briefing (mocks v2) ---


async def test_budget_set_left_and_clear(env):  # noqa: F811
    async with client(env.make_app()) as c:
        h = await _first_launch(c)
        assert (await c.get("/v1/expenses/budget", headers=h)).json() == {"budget": None}
        r = await c.put("/v1/expenses/budget", json={"amount": "120 000"}, headers=h)
        assert r.status_code == 200, r.text
        b = r.json()["budget"]
        assert b["amount"] == "120000.00" and b["spent"] == "0.00" and b["left"] == "120000.00"
        await c.post("/v1/expenses", json={"client_id": str(uuid.uuid4()), "amount": "86400",
                                           "note": "Продукты"}, headers=h)  # fmt: skip
        b = (await c.get("/v1/expenses/budget", headers=h)).json()["budget"]
        assert (b["spent"], b["left"], b["over"], b["percent"]) == ("86400.00", "33600.00",
                                                                    False, 72)
        agg = (await c.get("/v1/expenses/aggregate", headers=h)).json()
        assert agg["budget"]["left"] == "33600.00"
        for bad in ("0", "-5", "abc"):
            r = await c.put("/v1/expenses/budget", json={"amount": bad}, headers=h)
            assert r.status_code == 422, bad
        r = await c.delete("/v1/expenses/budget", headers=h)
        assert r.json() == {"budget": None}
        assert (await c.get("/v1/expenses/aggregate", headers=h)).json()["budget"] is None


async def test_today_brief(env):  # noqa: F811
    async with client(env.make_app()) as c:
        h = await _first_launch(c)
        today = (await c.get("/v1/today", headers=h)).json()["date"]
        await c.put("/v1/expenses/budget", json={"amount": "60000"}, headers=h)
        await c.post("/v1/expenses", json={"client_id": str(uuid.uuid4()), "amount": "18400",
                                           "note": "Продукты"}, headers=h)  # fmt: skip
        for title in ("Оплатить интернет", "Отправить КП"):
            r = await c.post("/v1/tasks", json={"client_id": str(uuid.uuid4()), "list_key": "todo",
                                                "title": title, "due_date": today}, headers=h)
            assert r.status_code == 201, r.text
        done = r.json()["task"]["id"]
        await c.post(f"/v1/tasks/{done}/done", json={"client_id": str(uuid.uuid4()),
                                                     "done": True}, headers=h)  # fmt: skip
        await c.post("/v1/tasks", json={"client_id": str(uuid.uuid4()), "list_key": "todo",
                                        "title": "Позвонить в банк", "due_date": "2020-01-01"},
                     headers=h)  # fmt: skip
        await c.post("/v1/items", json={"client_id": str(uuid.uuid4()), "text": "Идея: полка"},
                     headers=h)  # fmt: skip
        b = (await c.get("/v1/today", headers=h)).json()["brief"]
        assert b["part"] in ("morning", "day", "evening")
        assert b["headline"]["ru"] and 1 <= len(b["lines"]["ru"]) <= 3
        m = b["metrics"]
        assert (m["tasks"]["done"], m["tasks"]["total"]) == (1, 2)
        assert m["spent"]["today"] == "18400.00" and m["spent"]["count_today"] == 1
        assert m["spent"]["month"] == "18400.00" and m["spent"]["budget"]["left"] == "41600.00"
        assert m["new_records"]["count"] == 1
        assert [p["title"] for p in b["plan"]] == ["Оплатить интернет", "Отправить КП"]
        assert [p["done"] for p in b["plan"]] == [False, True]
        assert [(w["kind"], w["title"]) for w in b["waiting"]] == [("overdue", "Позвонить в банк")]
        assert b["lines"]["ru"][0] == "Есть что проверить — ниже."
