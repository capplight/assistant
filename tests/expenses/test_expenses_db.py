"""Week 12 «Расходы 1» against a real database: the finish criterion US-31 («потратил 5000 на
бензин» → the month total computed by code), the keypad expression, «Проверьте», «Отменить» of
every change, the person's category order, the model's numbers checked against the words and the
answer's numbers against `aggregate`, sync, and PATCH /tasks idempotency. Providers are fakes (no
network). Skipped without DATABASE_URL."""

import os
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import text

from assistant.ai import ToolCall
from assistant.ai.types import AdapterRequest
from assistant.chat import ChatReply
from assistant.expenses import ExpenseReply
from tests.api.conftest import client
from tests.api.test_week9_db import Script9, add_page, entries, router9, say
from tests.chat.test_chat_db import BASE, by_name, signed_in
from tests.chat.test_week6_db import last

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set"),
]

TODAY = datetime.now(UTC).astimezone(ZoneInfo("Asia/Almaty")).date()
YESTERDAY = TODAY - timedelta(days=1)


class Script12(Script9):
    """+ the week 12 reader (`ExpenseReply`)."""

    def __init__(self, expense: ExpenseReply | None = None, chat: list[Any] | None = None) -> None:
        super().__init__()
        self.chat = list(chat or [])
        self.expense = expense

    def __call__(self, req: AdapterRequest) -> Any:
        if req.schema_name == "ExpenseReply":
            self.calls.setdefault("ExpenseReply", []).append(req)
            return self.expense or ExpenseReply(is_expense=False, amount="", category="none",
                                                note=None, day="none", method="none",
                                                direction="expense")  # fmt: skip
        return super().__call__(req)


def petrol(amount: str = "5000", **kw: Any) -> ExpenseReply:
    base = dict(is_expense=True, amount=amount, category="transport", note="бензин", day="none",
                method="none", direction="expense")  # fmt: skip
    return ExpenseReply(**{**base, **kw})


async def month(c, h, **params) -> dict:  # type: ignore[no-untyped-def]
    r = await c.get("/v1/expenses/aggregate", params={"period": "month", **params}, headers=h)
    assert r.status_code == 200, r.text
    return r.json()


async def undo(c, h, action_id: str) -> dict:  # type: ignore[no-untyped-def]
    r = await c.post(f"/v1/actions/{action_id}/undo", json={}, headers=h)
    assert r.status_code == 200, r.text
    return r.json()


async def categories(c, h) -> dict:  # type: ignore[no-untyped-def]
    r = await c.get("/v1/expense-categories", headers=h)
    assert r.status_code == 200, r.text
    return r.json()


async def cat_id(c, h, key: str) -> str:  # type: ignore[no-untyped-def]
    return next(x["id"] for x in (await categories(c, h))["categories"] if x["key"] == key)


async def add(c, h, **body) -> dict:  # type: ignore[no-untyped-def]
    r = await c.post("/v1/expenses", json={"client_id": str(uuid.uuid4()), **body}, headers=h)
    assert r.status_code == 201, r.text
    return r.json()


# --- the finish criterion ---


async def test_us31_spent_5000_on_petrol_month_total_by_code(env9):
    script = Script12(expense=petrol())
    async with client(env9.make_app(router9(env9.maker, script))) as c:
        h = await signed_in(c)
        page = (await add_page(c, h, "expenses"))["page"]["id"]
        other = (await add_page(c, h, "custom", "Дача"))["page"]["id"]
        evs = await say(c, h, "потратил 5000 на бензин", page_id=other)
        ev = last(evs, "action")
        assert ev["action"]["kind"] == "create_expense"
        assert ev["action"]["summary"]["ru"] == "Записал 5 000 ₸ · Транспорт"
        [exp] = ev["expenses"]
        assert (exp["amount"], exp["currency"], exp["category_key"], exp["note"]) == \
            ("5000.00", "KZT", "transport", "бензин")  # fmt: skip
        assert exp["spent_on"] == TODAY.isoformat() and exp["review_fields"] == []
        assert exp["source"] == "typed" and exp["parse_source"] == "llm"
        assert any(p["page_id"] == page for _, n, p in evs if n == "page_patch")
        # the phrase went to the model alone, as data
        req = script.calls["ExpenseReply"][0]
        assert "потратил 5000 на бензин" in req.messages[-1].text

        agg = await month(c, h)
        assert agg["calc_version"] == "calc.v1"
        assert agg["totals"] == [{"currency": "KZT", "total": "5000.00", "expense": "5000.00",
                                  "refund": "0.00", "income": "0.00", "count": 1}]
        assert agg["basis_ids"] == [exp["id"]]
        assert agg["period"]["from"] == TODAY.replace(day=1).isoformat()

        rows = await entries(c, h, page)
        [row] = [e for e in rows if e["expense"]]
        assert row["expense"]["id"] == exp["id"]
        assert row["fields"]["amount"] == "5000.00" and row["fields"]["category"] == "Транспорт"

        # «Отменить»: the expense and its record go to the trash; the total is code again: 0.
        await undo(c, h, ev["action"]["id"])
        assert (await month(c, h))["totals"] == []


async def test_a_number_the_person_did_not_say_is_never_saved(env9):
    script = Script12(expense=petrol("50000"))  # the model got it wrong
    async with client(env9.make_app(router9(env9.maker, script))) as c:
        h = await signed_in(c)
        await add_page(c, h, "expenses")
        await say(c, h, "потратил 5000 на бензин")
        assert script.n("ExpenseReply") == 1
        assert (await month(c, h))["totals"] == []
        async with env9.maker() as s:
            assert await s.scalar(text("SELECT count(*) FROM expense_entries")) == 0


async def test_voice_amount_is_check_until_correct(env9):
    script = Script12(expense=petrol("2500", category="transport", note="такси", day="yesterday"))
    async with client(env9.make_app(router9(env9.maker, script))) as c:
        h = await signed_in(c)
        await add_page(c, h, "expenses")
        evs = await say(c, h, "вчера потратил 2500 на такси", input_kind="voice")
        [exp] = last(evs, "action")["expenses"]
        assert exp["review_fields"] == ["amount"] and exp["source"] == "voice"
        assert exp["spent_on"] == YESTERDAY.isoformat()
        assert (await month(c, h, date=YESTERDAY.isoformat()))["review_count"] == 1
        r = await c.patch(f"/v1/expenses/{exp['id']}", headers=h,
                          json={"version": exp["version"], "confirm": ["amount"],
                                "client_id": str(uuid.uuid4())})  # fmt: skip
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["expense"]["review_fields"] == [] and body["expense"]["amount"] == "2500.00"
        assert body["action"]["summary"]["ru"] == "Сумма верна: 2 500 ₸"
        await undo(c, h, body["action"]["id"])
        r = await c.get("/v1/expenses", headers=h)
        assert r.json()["expenses"][0]["review_fields"] == ["amount"]


async def test_rules_first_reads_without_the_model(env9):
    script = Script12()
    app = env9.make_app(router9(env9.maker, script), expenses_rules_first=True)
    async with client(app) as c:
        h = await signed_in(c)
        page = (await add_page(c, h, "expenses"))["page"]["id"]
        evs = await say(c, h, "Магнум 12 400 вчера каспи", page_id=page)
        [exp] = last(evs, "action")["expenses"]
        assert (exp["amount"], exp["spent_on"], exp["method"], exp["category_key"]) == \
            ("12400.00", YESTERDAY.isoformat(), "kaspi", "groceries")  # fmt: skip
        assert exp["parse_source"] == "rules" and exp["payee"] == "Магнум"
        assert script.n("ExpenseReply") == 0


async def test_parse_without_ai_consent_is_the_form_unless_rules_first(env9):
    for rules_first, status in ((False, "form"), (True, "ok")):
        app = env9.make_app(router9(env9.maker, Script12(expense=petrol())),
                            expenses_rules_first=rules_first)  # fmt: skip
        async with client(app) as c:
            h = await signed_in(c, kinds=BASE)
            r = await c.post("/v1/expenses/parse", json={"text": "потратил 5000 на бензин"},
                             headers=h)  # fmt: skip
            assert r.status_code == 200, r.text
            body = r.json()
            assert body["status"] == status
            if status == "ok":
                assert body["draft"]["amount"] == "5000.00" and body["source"] == "rules"
                assert body["draft"]["category_key"] == "transport"
            else:
                assert body["draft"] is None and "клавишах" in body["message"]
            async with env9.maker() as s:  # nothing saved
                assert await s.scalar(text("SELECT count(*) FROM expense_entries")) == 0


# --- keys / form ---


async def test_keypad_expression_by_code_idempotent_and_undoable(env9):
    async with client(env9.make_app()) as c:
        h = await signed_in(c)
        page = (await add_page(c, h, "expenses"))["page"]["id"]
        groceries = await cat_id(c, h, "groceries")
        cid = str(uuid.uuid4())
        body = {"client_id": cid, "expression": "1 200 + 350", "category_id": groceries}
        r = await c.post("/v1/expenses", json=body, headers=h)
        assert r.status_code == 201, r.text
        first = r.json()
        exp = first["expense"]
        assert (exp["amount"], exp["expression"], exp["source"]) == ("1550.00", "1200+350", "form")
        assert first["action"]["summary"]["ru"] == "Записал 1 550 ₸ · Продукты"
        assert any(p["page_id"] == page for p in first["page_patches"])
        again = await c.post("/v1/expenses", json=body, headers=h)
        assert again.status_code == 200 and again.json()["repeated"] is True
        assert again.json()["expense"]["id"] == exp["id"]
        assert again.json()["action"]["id"] == first["action"]["id"]

        for bad, code in (({"expression": "5*3"}, "expression_invalid"),
                          ({"expression": "__import__('os')"}, "expression_invalid"),
                          ({"expression": "500-500"}, "amount_not_positive"),
                          ({"expression": "100+50", "amount": "200"}, "amount_mismatch"),
                          ({"amount": "1000000000000"}, "validation_error")):  # fmt: skip
            r = await c.post("/v1/expenses", json={"client_id": str(uuid.uuid4()), **bad},
                             headers=h)  # fmt: skip
            assert r.status_code == 422 and r.json()["code"] == code, (bad, r.text)

        # change it by hand: the amount is the person's, «Отменить» puts it back
        r = await c.patch(f"/v1/expenses/{exp['id']}", headers=h,
                          json={"version": exp["version"], "amount": "1600",
                                "note": "Магнум"})  # fmt: skip
        assert r.status_code == 200, r.text
        edited = r.json()
        assert edited["expense"]["amount"] == "1600.00"
        assert edited["expense"]["parse_source"] == "user_edit"
        assert edited["expense"]["expression"] is None
        stale = await c.patch(f"/v1/expenses/{exp['id']}", headers=h,
                              json={"version": exp["version"], "amount": "1"})  # fmt: skip
        assert stale.status_code == 409
        await undo(c, h, edited["action"]["id"])
        back = (await c.get("/v1/expenses", headers=h)).json()["expenses"][0]
        assert (back["amount"], back["expression"], back["note"]) == ("1550.00", "1200+350", None)

        # trash and back
        d = await c.delete(f"/v1/expenses/{exp['id']}", params={"client_id": str(uuid.uuid4())},
                           headers=h)  # fmt: skip
        assert d.status_code == 200 and d.json()["expense"]["deleted_at"] is not None
        assert (await month(c, h))["totals"] == []
        await undo(c, h, d.json()["action"]["id"])
        assert (await month(c, h))["totals"][0]["total"] == "1550.00"


async def test_totals_per_currency_refunds_income_transfers(env9):
    async with client(env9.make_app()) as c:
        h = await signed_in(c)
        transfers = await cat_id(c, h, "transfers")
        health = await cat_id(c, h, "health")
        await add(c, h, amount="10000", category_id=health)
        await add(c, h, amount="2500.50", category_id=health)
        await add(c, h, amount="500", direction="refund", category_id=health)
        await add(c, h, amount="300000", direction="income")
        await add(c, h, amount="50000", direction="transfer_own")
        await add(c, h, amount="20000", category_id=transfers)
        await add(c, h, amount="50", currency="USD")
        last_month = TODAY.replace(day=1) - timedelta(days=1)
        await add(c, h, amount="7777", spent_on=last_month.isoformat())
        agg = await month(c, h, group_by="category")
        assert agg["totals"] == [
            {"currency": "KZT", "total": "12000.50", "expense": "12500.50", "refund": "500.00",
             "income": "300000.00", "count": 3},
            {"currency": "USD", "total": "50.00", "expense": "50.00", "refund": "0.00",
             "income": "0.00", "count": 1},
        ]  # fmt: skip
        assert agg["groups"][0] == {"key": health, "title": "Здоровье", "currency": "KZT",
                                    "total": "12000.50", "count": 3}  # fmt: skip
        only = await month(c, h, category_id=health)
        assert only["totals"][0]["total"] == "12000.50"
        prev = await month(c, h, date=last_month.isoformat())
        assert prev["totals"][0]["total"] == "7777.00"
        year = await c.get("/v1/expenses/aggregate", params={"period": "custom",
                                                             "from": last_month.isoformat(),
                                                             "to": TODAY.isoformat(),
                                                             "currency": "KZT"}, headers=h)
        assert year.json()["totals"][0]["total"] == "19777.50"
        bad = await c.get("/v1/expenses/aggregate", params={"period": "custom"}, headers=h)
        assert bad.status_code == 422


# --- categories: 8 + the hidden service one, the person's order ---


async def test_categories_frequency_then_the_persons_order(env9):
    async with client(env9.make_app()) as c:
        h = await signed_in(c)
        first = await categories(c, h)
        keys = [x["key"] for x in first["categories"]]
        assert first["order"] == "frequency"
        assert keys == ["groceries", "home", "transport", "health", "family", "cafe_gifts",
                        "utilities", "other", "transfers"]  # fmt: skip
        assert first["categories"][-1]["service"] is True
        transport = await cat_id(c, h, "transport")
        for _ in range(2):
            await add(c, h, amount="1000", category_id=transport)
        assert [x["key"] for x in (await categories(c, h))["categories"]][0] == "transport"

        own = await c.post("/v1/expense-categories", headers=h,
                           json={"client_id": str(uuid.uuid4()), "title": "Одежда"})  # fmt: skip
        assert own.status_code == 201, own.text
        dup = await c.post("/v1/expense-categories", headers=h,
                           json={"client_id": str(uuid.uuid4()), "title": "одежда"})  # fmt: skip
        assert dup.status_code == 409 and dup.json()["code"] == "category_exists"
        listed = [x["key"] for x in (await categories(c, h))["categories"]]
        assert listed.index(own.json()["category"]["key"]) == 8  # after the eight, before service

        ids = [x["id"] for x in (await categories(c, h))["categories"] if not x["service"]]
        new_order = list(reversed(ids))
        r = await c.patch("/v1/expense-categories/reorder", headers=h,
                          json={"client_id": str(uuid.uuid4()), "ids": new_order})  # fmt: skip
        assert r.status_code == 200, r.text
        after = await categories(c, h)
        assert after["order"] == "manual"
        assert [x["id"] for x in after["categories"] if not x["service"]] == new_order
        # more spending no longer moves the chips: the order is the person's
        groceries = await cat_id(c, h, "groceries")
        for _ in range(3):
            await add(c, h, amount="10", category_id=groceries)
        assert [x["id"] for x in (await categories(c, h))["categories"]
                if not x["service"]] == new_order
        await undo(c, h, r.json()["action"]["id"])
        assert (await categories(c, h))["order"] == "frequency"

        other = next(x for x in (await categories(c, h))["categories"] if x["key"] == "other")
        no = await c.patch(f"/v1/expense-categories/{other['id']}", headers=h,
                           json={"version": other["version"], "hidden": True})  # fmt: skip
        assert no.status_code == 422
        cid = own.json()["category"]["id"]
        ver = next(x["version"] for x in (await categories(c, h))["categories"] if x["id"] == cid)
        hid = await c.patch(f"/v1/expense-categories/{cid}", headers=h,
                            json={"version": ver, "hidden": True})
        assert hid.status_code == 200 and hid.json()["category"]["hidden"] is True
        await undo(c, h, hid.json()["action"]["id"])
        await undo(c, h, own.json()["action"]["id"])  # «Отменить» of a new one = hidden
        mine = next(x for x in (await categories(c, h))["categories"] if x["id"] == cid)
        assert mine["hidden"] is True


# --- the line answers with numbers code computed ---


async def test_answer_numbers_come_from_aggregate_and_invented_ones_are_removed(env9):
    args = {"period": "month", "date_from": None, "date_to": None, "category": "Транспорт",
            "group_by": None, "currency": None}  # fmt: skip
    script = Script12(chat=[
        [ToolCall("c1", "aggregate", args)],
        ChatReply(answer="За этот месяц на транспорт ушло 7 500 ₸. Это 12 345 ₸ в год.",
                  citations=[], insufficient=False),
    ])  # fmt: skip
    async with client(env9.make_app(router9(env9.maker, script))) as c:
        h = await signed_in(c)
        page = (await add_page(c, h, "expenses"))["page"]["id"]
        transport = await cat_id(c, h, "transport")
        await add(c, h, amount="5000", category_id=transport, note="бензин")
        await add(c, h, amount="2500", category_id=transport, note="такси")
        await add(c, h, amount="999")  # another category: not in this total
        evs = await say(c, h, "сколько ушло на транспорт в этом месяце?", page_id=page)
        tokens = "".join(d["text"] for d in by_name(evs, "token"))
        assert tokens == "За этот месяц на транспорт ушло 7 500 ₸. "
        assert by_name(evs, "checked") == [{"ok": False, "removed": 1}]
        result = script.calls["ChatReply"][-1].messages[-1].tool_results[0].content
        assert '"total":"7 500 ₸"' in result and '"count":2' in result


# --- sync and the pages ---


async def test_sync_brings_expenses_categories_and_the_page_fills(env9, monkeypatch):
    import assistant.config as config
    from tests.api.conftest import make_settings

    # week 20 (Ф-48): «Расходы» is a default page, so the first expense makes it even with
    # first-use pages off
    off = make_settings(pages_on_first_use=False)
    monkeypatch.setattr(config, "get_settings", lambda: off)
    async with client(env9.make_app()) as c:
        h = await signed_in(c)
        exp = (await add(c, h, amount="4200", note="свет"))["expense"]
        r = await c.get("/v1/sync", params={"since": 0, "limit": 500}, headers=h)
        body = r.json()
        assert [e["id"] for e in body["expenses"]] == [exp["id"]]
        assert len(body["expense_categories"]) == 9
        notes = [p for p in (await c.get("/v1/pages", headers=h)).json()["pages"]
                 if p["template_key"] == "notes"]  # fmt: skip
        page = next(p["id"] for p in (await c.get("/v1/pages", headers=h)).json()["pages"]
                    if p["template_key"] == "expenses")
        rows = await entries(c, h, page)
        assert [e["expense"]["id"] for e in rows if e["expense"]] == [exp["id"]]
        for p in notes:  # «Расходы» takes it now: it leaves «Заметки»
            assert exp["item_id"] not in [e["item"]["id"] for e in await entries(c, h, p["id"])]
        # purged after the trash: the expense goes with its record (tombstone)
        async with env9.maker() as s:
            await s.execute(text("DELETE FROM items WHERE public_id = :i"), {"i": exp["item_id"]})
            await s.commit()
        r = await c.get("/v1/sync", params={"since": body["next_since"]}, headers=h)
        assert {"entity": "expense", "id": exp["id"]}.items() <= next(
            t for t in r.json()["tombstones"] if t["entity"] == "expense").items()


# --- PATCH /tasks: idempotent by client_id (the phone's undo for «− 2 +») ---


@pytest.mark.usefixtures("shopping_on")  # «Покупки» itself (hidden by default, Ф-49)
async def test_patch_task_repeat_returns_the_first_action(env9):
    async with client(env9.make_app()) as c:
        h = await signed_in(c)
        await add_page(c, h, "shopping")
        r = await c.post("/v1/tasks", headers=h, json={"client_id": str(uuid.uuid4()),
                                                       "list_key": "shopping", "title": "Хлеб"})
        task = r.json()["task"]
        cid = str(uuid.uuid4())
        body = {"version": task["version"], "qty": "2", "client_id": cid}
        first = await c.patch(f"/v1/tasks/{task['id']}", json=body, headers=h)
        assert first.status_code == 200, first.text
        action = first.json()["action"]
        assert first.json()["task"]["qty"] == "2" and first.json()["repeated"] is False
        again = await c.patch(f"/v1/tasks/{task['id']}", json=body, headers=h)  # stale version
        assert again.status_code == 200, again.text
        assert again.json()["repeated"] is True and again.json()["action"]["id"] == action["id"]
        assert again.json()["task"]["version"] == first.json()["task"]["version"]
        other = await c.patch(f"/v1/tasks/{task['id']}", headers=h,
                              json={**body, "client_id": str(uuid.uuid4())})  # fmt: skip
        assert other.status_code == 409
        await undo(c, h, action["id"])
        tasks = (await c.get("/v1/tasks", params={"list_key": "shopping"}, headers=h)).json()
        assert tasks["tasks"][0]["qty"] is None
        async with env9.maker() as s:
            n = await s.scalar(text("SELECT count(*) FROM actions WHERE client_id = :c"),
                               {"c": cid})  # fmt: skip
            assert n == 1
