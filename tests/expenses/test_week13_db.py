"""Week 13 «Расходы 2» against a real database. The finish criterion: a month's bank statement →
a plan → one «Да» → the month's totals computed by code match the bank's own summary to the tiyn
→ one «Отменить». Also: nothing saved before «Да», repeats (receipt + statement), the receipt
photo read by the model and checked by code, the fiscal QR, masking, consent. Synthetic
statements and receipts only; providers and the OFD page are fakes (no network). Skipped without
DATABASE_URL."""

import hashlib
import os
import uuid
from decimal import Decimal
from typing import Any

import pytest
from sqlalchemy import func, select

from assistant.ai.types import AdapterRequest
from assistant.db.models import Item
from assistant.db.models_expenses import ExpenseEntry, StatementImport
from assistant.expenses import ReceiptReply, StatementReply
from assistant.expenses.imports import StatementRow
from assistant.expenses.ofd import FakeOfdReader
from assistant.expenses.receipts import ReceiptLine
from assistant.records import FakeOcr, IngestDeps, run_ingest
from tests.api.conftest import client
from tests.api.test_week9_db import add_page, entries, router9
from tests.chat.test_chat_db import BASE, signed_in
from tests.expenses.pdfgen import text_pdf
from tests.expenses.statement_fixtures import (
    halyk_pdf,
    halyk_rows,
    kaspi_pdf,
    kaspi_receipt_pdf,
    october_rows,
)
from tests.expenses.test_expenses_db import Script12, add, cat_id, month, undo

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set"),
]
# Ф-37 (week 19): statements and QR are off for the beta; these tests switch them on.
ON = {"feature_statements_pdf": True, "feature_receipt_qr": True}
OCT = "2026-10-15"


class Script13(Script12):
    """+ the week 13 readers (`ReceiptReply`, `StatementReply`)."""

    def __init__(self, receipt: ReceiptReply | None = None,
                 statement: StatementReply | None = None) -> None:  # fmt: skip
        super().__init__()
        self.receipt, self.statement = receipt, statement

    def __call__(self, req: AdapterRequest) -> Any:
        if req.schema_name == "ReceiptReply":
            self.calls.setdefault("ReceiptReply", []).append(req)
            assert self.receipt is not None
            return self.receipt
        if req.schema_name == "StatementReply":
            self.calls.setdefault("StatementReply", []).append(req)
            assert self.statement is not None
            return self.statement
        return super().__call__(req)


async def upload_item(c, h, data: bytes, mime: str, source: str = "share") -> dict:  # type: ignore[no-untyped-def]
    body = {"mime": mime, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    up = (await c.post("/v1/uploads", json=body, headers=h)).json()
    url = up["put"]["url"].removeprefix("http://test")
    assert (await c.put(url, content=data, headers=up["put"]["headers"])).status_code == 200
    assert (await c.post(f"/v1/uploads/{up['id']}/complete", headers=h)).status_code == 200
    r = await c.post("/v1/items", json={"client_id": str(uuid.uuid4()), "upload_id": up["id"],
                                        "source": source}, headers=h)  # fmt: skip
    assert r.status_code == 201, r.text
    return r.json()["item"]


async def ingest(app, maker, item_id: str, ocr_text: str = "") -> None:  # type: ignore[no-untyped-def]
    async with maker() as s:
        pk = await s.scalar(select(Item.id).where(Item.public_id == uuid.UUID(item_id)))
    deps = IngestDeps(storage=app.state.ctx.storage, ocr=FakeOcr(ocr_text, 0.95))
    await run_ingest(maker, pk, deps)


async def expense_count(maker) -> int:  # type: ignore[no-untyped-def]
    async with maker() as s:
        return await s.scalar(select(func.count()).select_from(ExpenseEntry)) or 0


async def plan(c, h, item_id: str, status: int = 201) -> dict:  # type: ignore[no-untyped-def]
    r = await c.post("/v1/expenses/statements", json={"client_id": str(uuid.uuid4()),
                                                      "item_id": item_id}, headers=h)  # fmt: skip
    assert r.status_code == status, r.text
    return r.json()


async def october(c, h) -> dict:  # type: ignore[no-untyped-def]
    return await month(c, h, date=OCT)


def kzt_total(agg: dict) -> dict:
    return next(t for t in agg["totals"] if t["currency"] == "KZT")


# --- the finish criterion ---


async def test_statement_plan_one_yes_totals_match_the_bank_one_undo(env9):
    rows = october_rows(seed=13, n=86)
    pdf = kaspi_pdf(rows)
    bank = {"Покупки": sum((r.amount for r in rows if r.label == "Покупка"), Decimal(0)),
            "Разное": sum((r.amount for r in rows if r.label == "Разное"), Decimal(0)),
            "Пополнения": sum((r.amount for r in rows if r.label == "Пополнение"), Decimal(0))}
    async with client(env9.make_app(**ON)) as c:
        h = await signed_in(c, BASE)  # no ai_cross_border: a known bank needs no model
        page = (await add_page(c, h, "expenses"))["page"]["id"]
        item = await upload_item(c, h, pdf, "application/pdf")
        before = await expense_count(env9.maker)

        out = await plan(c, h, item["id"])
        st, pending = out["statement"], out["pending_action"]
        assert (st["status"], st["bank"], st["parser"]) == ("proposed", "kaspi_gold", "template")
        assert st["rows_found"] == len(rows) and st["rows_new"] == len(rows)
        assert st["rows_existing"] == 0 and st["check"]["ok"] is True
        assert st["summary_ru"] == f"Нашёл {len(rows)} операций за октябрь"
        assert pending["kind"] == "import_statement" and pending["status"] == "proposed"
        assert pending["preview"]["title_ru"] == f"Записать {len(rows)} операций из выписки?"
        spend = Decimal(st["adds"]["expense"]) - Decimal(st["adds"]["refund"])
        assert spend == -(bank["Покупки"] + bank["Разное"])
        # nothing is saved before «Да»
        assert await expense_count(env9.maker) == before
        assert (await october(c, h))["totals"] == []
        got = (await c.get(f"/v1/expenses/statements/{st['id']}", headers=h)).json()
        assert len(got["rows"]) == len(rows) and all(r["state"] == "new" for r in got["rows"])
        assert all(r["review_fields"] == [] for r in got["rows"])  # reconciled to the tiyn
        assert "key" not in got["rows"][0]
        listed = (await c.get("/v1/pending-actions", headers=h)).json()["pending_actions"]
        assert [p["id"] for p in listed] == [pending["id"]]

        # one «Да» (the generic pending route)
        r = await c.post(f"/v1/pending-actions/{pending['id']}/confirm", json={}, headers=h)
        assert r.status_code == 200, r.text
        action = r.json()["action"]
        assert action["kind"] == "bulk_create_expenses"
        assert action["summary"]["ru"] == f"Записал {len(rows)} операций из выписки"
        again = await c.post(f"/v1/expenses/statements/{st['id']}/confirm", json={}, headers=h)
        assert again.json()["repeated"] is True and again.json()["action"]["id"] == action["id"]
        assert await expense_count(env9.maker) == before + len(rows)

        # the month's totals, by code, match the bank's summary to the tiyn
        agg = await october(c, h)
        t = kzt_total(agg)
        assert Decimal(t["total"]) == -(bank["Покупки"] + bank["Разное"])
        assert Decimal(t["income"]) == bank["Пополнения"]
        assert agg["review_count"] == 0
        listed = (await c.get("/v1/expenses", params={"from": "2026-10-01", "to": "2026-10-31",
                                                      "limit": 500}, headers=h)).json()["expenses"]
        assert len(listed) == len(rows)
        assert {e["source"] for e in listed} == {"statement_pdf"}
        assert {e["statement_id"] for e in listed} == {st["id"]}
        transfers = [e for e in listed if e["category_key"] == "transfers"]
        assert transfers and all(e["method"] == "transfer" for e in transfers)
        on_page = [e for e in await entries(c, h, page) if e["expense"]]
        assert len(on_page) >= min(len(rows), 50)
        st2 = (await c.get(f"/v1/expenses/statements/{st['id']}", headers=h)).json()
        assert st2["statement"]["status"] == "confirmed" and st2["rows"] == []

        # one «Отменить»: every row to the trash, the totals are code again: nothing
        await undo(c, h, action["id"])
        assert (await october(c, h))["totals"] == []
        st3 = (await c.get(f"/v1/expenses/statements/{st['id']}", headers=h)).json()
        assert st3["statement"]["status"] == "undone"


async def test_reimport_and_typed_ones_already_there_are_not_created(env9):
    rows = october_rows(seed=5, n=30)
    async with client(env9.make_app(**ON)) as c:
        h = await signed_in(c, BASE)
        item = await upload_item(c, h, kaspi_pdf(rows), "application/pdf")
        purchase = next(r for r in rows if r.label == "Покупка" and r.amount < 0)
        # the person typed this one with the same payee: the plan says «уже есть»
        await add(c, h, amount=f"{-purchase.amount:.2f}", spent_on=purchase.day.isoformat(),
                  payee=purchase.details, category_id=await cat_id(c, h, "groceries"))
        out = await plan(c, h, item["id"])
        st = out["statement"]
        assert st["rows_existing"] == 1 and st["rows_new"] == len(rows) - 1
        assert st["summary_ru"].endswith(", 1 уже есть")
        assert out["pending_action"]["preview"]["text_ru"].endswith("Отменить можно одной кнопкой.")
        r = await c.post(f"/v1/expenses/statements/{st['id']}/confirm", json={}, headers=h)
        assert r.json()["created"] == len(rows) - 1
        # the same statement again: every row is already there
        again = (await plan(c, h, item["id"]))["statement"]
        assert again["rows_new"] == 0 and again["rows_existing"] == len(rows)
        # the person's own category for that payee is used for its other rows
        same = [x for x in rows if x.details == purchase.details and x is not purchase
                and x.label == "Покупка"]
        if same:
            listed = (await c.get("/v1/expenses", params={"limit": 500}, headers=h)).json()
            keys = {e["category_key"] for e in listed["expenses"]
                    if e["payee"] == purchase.details and e["source"] == "statement_pdf"}
            assert keys == {"groceries"}


async def test_reject_saves_nothing_and_clears_the_rows(env9):
    async with client(env9.make_app(**ON)) as c:
        h = await signed_in(c, BASE)
        item = await upload_item(c, h, halyk_pdf(halyk_rows()), "application/pdf")
        out = await plan(c, h, item["id"])
        st = out["statement"]
        assert st["bank"] == "halyk" and st["check"]["ok"] is True
        r = await c.post(f"/v1/pending-actions/{out['pending_action']['id']}/reject", headers=h)
        assert r.status_code == 200 and r.json()["pending_action"]["status"] == "rejected"
        got = (await c.get(f"/v1/expenses/statements/{st['id']}", headers=h)).json()
        assert got["statement"]["status"] == "rejected" and got["rows"] == []
        async with env9.maker() as s:
            row = await s.scalar(select(StatementImport).where(
                StatementImport.public_id == uuid.UUID(st["id"])))  # fmt: skip
            assert row is not None and row.rows == []
        assert (await month(c, h, date=OCT))["totals"] == []
        r = await c.post(f"/v1/expenses/statements/{st['id']}/confirm", json={}, headers=h)
        assert r.status_code == 409


async def test_halyk_fees_and_a_summary_that_does_not_match(env9):
    async with client(env9.make_app(**ON)) as c:
        h = await signed_in(c, BASE)
        item = await upload_item(c, h, halyk_pdf(halyk_rows()), "application/pdf")
        st = (await plan(c, h, item["id"]))["statement"]
        r = await c.post(f"/v1/expenses/statements/{st['id']}/confirm", json={}, headers=h)
        assert r.json()["created"] == 10
        t = kzt_total(await october(c, h))
        # purchases + KCELL − refund + 2 fees (the transfer and the withdrawal are in no total)
        want = (Decimal("1250.50") + Decimal("5120.37") + Decimal("18990.99") + Decimal("77777.77")
                - Decimal("1250.50") + Decimal("400.00"))
        assert Decimal(t["total"]) == want and Decimal(t["income"]) == Decimal("320000.00")
        listed = (await c.get("/v1/expenses", params={"limit": 50}, headers=h)).json()["expenses"]
        assert next(e for e in listed if e["payee"] == "STEAM PURCHASE")["note"] == "10.00 USD"

        bad = await upload_item(c, h, kaspi_pdf(october_rows(seed=3, n=10),
                                                tamper=Decimal("1.00")), "application/pdf")
        st = (await plan(c, h, bad["id"]))["statement"]
        assert st["check"]["ok"] is False
        assert st["summary_ru"].endswith("Суммы не сошлись с выпиской — проверьте")
        rows = (await c.get(f"/v1/expenses/statements/{st['id']}", headers=h)).json()["rows"]
        assert all(r["review_fields"] == ["amount"] for r in rows)


async def test_unknown_bank_needs_the_model_and_each_row_is_checked(env9):
    lines = ["ТОО Тестовый Банк", "Выписка по счёту", "01.10.2026 Оплата Кофейня 1 500,00",
             "02.10.2026 Зачисление 20 000,00", "03.10.2026 Оплата Аптека 2 750,25"]
    data = text_pdf(lines)
    async with client(env9.make_app(**ON)) as c:
        h = await signed_in(c, BASE)
        item = await upload_item(c, h, data, "application/pdf")
        r = await c.post("/v1/expenses/statements", json={"client_id": str(uuid.uuid4()),
                                                          "item_id": item["id"]}, headers=h)
        assert r.status_code == 422 and r.json()["code"] == "statement_unknown_format"

    script = Script13(statement=StatementReply(is_statement=True, currency="KZT", rows=[
        StatementRow(line=3, date="2026-10-01", amount="1500.00", sign="-",
                     description="Оплата Кофейня"),
        StatementRow(line=4, date="2026-10-02", amount="20000.00", sign="+",
                     description="Зачисление"),
        StatementRow(line=5, date="2026-10-03", amount="9999.00", sign="-",
                     description="Оплата Аптека"),  # not on that line: dropped
    ]))  # fmt: skip
    async with client(env9.make_app(router9(env9.maker, script), **ON)) as c:
        h = await signed_in(c)
        item = await upload_item(c, h, data, "application/pdf")
        st = (await plan(c, h, item["id"]))["statement"]
        assert (st["parser"], st["bank"], st["rows_found"], st["check"]) == ("model", "other", 2,
                                                                             None)  # fmt: skip
        rows = (await c.get(f"/v1/expenses/statements/{st['id']}", headers=h)).json()["rows"]
        assert all(r["review_fields"] == ["amount"] for r in rows)
        assert "<untrusted_data>" in script.calls["StatementReply"][0].messages[-1].text


# --- receipts and repeats ---

RECEIPT_OCR = ("ТОО MAGNUM CASH&CARRY\nМолоко 2 x 550,00 1 100,00\nХлеб 250,00\n"
               "ИТОГО: 1 350,00\nДата: 03.10.2026 18:42")


def magnum(**kw: Any) -> ReceiptReply:
    base = dict(is_receipt=True, total="1350.00", currency="KZT", date="2026-10-03",
                payee="MAGNUM CASH&CARRY", category="groceries", confidence=0.9,
                lines=[ReceiptLine(name="Молоко", qty="2", total="1100.00"),
                       ReceiptLine(name="Хлеб", qty="", total="250.00")])  # fmt: skip
    return ReceiptReply(**{**base, **kw})


async def test_receipt_photo_then_statement_one_payment_merged_once(env9):
    script = Script13(receipt=magnum())
    app = env9.make_app(router9(env9.maker, script), **ON)
    async with client(app) as c:
        h = await signed_in(c)
        page = (await add_page(c, h, "expenses"))["page"]["id"]
        photo = await upload_item(c, h, b"\xff\xd8fake-jpeg-receipt", "image/jpeg", "camera")
        cid = str(uuid.uuid4())
        r = await c.post("/v1/expenses/from-item", json={"client_id": cid, "item_id": photo["id"]},
                         headers=h)  # fmt: skip
        assert r.json()["status"] == "waiting" and r.json()["retry_after"] == 2
        await ingest(app, env9.maker, photo["id"], RECEIPT_OCR)
        r = await c.post("/v1/expenses/from-item", json={"client_id": cid, "item_id": photo["id"]},
                         headers=h)  # fmt: skip
        assert r.status_code == 201, r.text
        body = r.json()
        exp = body["expense"]
        assert body["status"] == "ok" and body["reader"] == "llm"
        assert (exp["amount"], exp["spent_on"], exp["payee"], exp["category_key"]) == (
            "1350.00", "2026-10-03", "MAGNUM CASH&CARRY", "groceries")
        assert exp["source"] == "receipt_ocr" and exp["review_fields"] == ["amount"]
        assert exp["item_id"] == photo["id"] and len(exp["line_items"]) == 2
        assert body["action"]["kind"] == "create_expense"
        rows_on_page = await entries(c, h, page)
        assert any(e["item"]["id"] == photo["id"] and e["expense"] for e in rows_on_page)
        again = await c.post("/v1/expenses/from-item", json={"client_id": cid,
                                                             "item_id": photo["id"]}, headers=h)
        assert again.json()["repeated"] is True and again.json()["expense"]["id"] == exp["id"]

        # the statement has the same payment: created, and suggested as a repeat
        rows = [r for r in october_rows(seed=21, n=12) if r.details != "MAGNUM CASH&CARRY"]
        from datetime import date as d_

        from tests.expenses.statement_fixtures import Row

        rows.append(Row(d_(2026, 10, 4), Decimal("-1350.00"), "Покупка", "MAGNUM CASH&CARRY"))
        rows.sort(key=lambda x: x.day)
        stmt = await upload_item(c, h, kaspi_pdf(rows), "application/pdf")
        st = (await plan(c, h, stmt["id"]))["statement"]
        assert st["rows_similar"] == 1 and st["rows_existing"] == 0
        r = await c.post(f"/v1/expenses/statements/{st['id']}/confirm", json={}, headers=h)
        [dup] = r.json()["duplicates"]
        assert dup["text_ru"] == "Похоже, эта трата уже есть (из выписки)"
        assert dup["keep"]["id"] == exp["id"] and dup["other"]["source"] == "statement_pdf"
        listed = (await c.get("/v1/expenses/duplicates", headers=h)).json()["duplicates"]
        assert [x["id"] for x in listed] == [dup["id"]]
        before = Decimal(kzt_total(await october(c, h))["total"])

        m = await c.post(f"/v1/expenses/duplicates/{dup['id']}/merge", json={}, headers=h)
        assert m.status_code == 200, m.text
        assert m.json()["action"]["kind"] == "merge_expenses"
        assert m.json()["action"]["summary"]["ru"] == "Объединил траты: 1 350 ₸ · MAGNUM CASH&CARRY"
        assert Decimal(kzt_total(await october(c, h))["total"]) == before - Decimal("1350.00")
        assert (await c.get("/v1/expenses/duplicates", headers=h)).json()["duplicates"] == []
        # «Отменить» the merge: both back, the pair is not suggested again
        await undo(c, h, m.json()["action"]["id"])
        assert Decimal(kzt_total(await october(c, h))["total"]) == before
        undone = (await c.get("/v1/expenses/duplicates", params={"status": "undone"},
                              headers=h)).json()["duplicates"]  # fmt: skip
        assert [x["id"] for x in undone] == [dup["id"]]

        # «Отменить» of the receipt expense leaves the photo record
        await undo(c, h, body["action"]["id"])
        got = await c.get(f"/v1/items/{photo['id']}", headers=h)
        assert got.status_code == 200 and got.json().get("deleted_at") is None
        # the model's prompt had the receipt as data
        req = script.calls["ReceiptReply"][0]
        assert "<untrusted_data>" in req.messages[-1].text and "ИТОГО" in req.messages[-1].text


async def test_receipt_without_consent_or_with_a_wrong_number_is_the_form(env9):
    script = Script13(receipt=magnum(total="1500.00"))  # not on the receipt
    app = env9.make_app(router9(env9.maker, script), **ON)
    async with client(app) as c:
        h = await signed_in(c)
        photo = await upload_item(c, h, b"\xff\xd8receipt-two", "image/jpeg", "camera")
        await ingest(app, env9.maker, photo["id"], RECEIPT_OCR)
        r = await c.post("/v1/expenses/from-item", json={"client_id": str(uuid.uuid4()),
                                                         "item_id": photo["id"]}, headers=h)
        assert r.json()["status"] == "form" and r.json()["expense"] is None
        assert r.json()["message"] == "Не разобрал сумму на чеке — наберите её на клавишах."
    script = Script13(receipt=magnum())
    app = env9.make_app(router9(env9.maker, script), **ON)
    async with client(app) as c:
        h = await signed_in(c, BASE)  # no ai_cross_border: nothing goes to the model
        photo = await upload_item(c, h, b"\xff\xd8receipt-three", "image/jpeg", "camera")
        await ingest(app, env9.maker, photo["id"], RECEIPT_OCR)
        r = await c.post("/v1/expenses/from-item", json={"client_id": str(uuid.uuid4()),
                                                         "item_id": photo["id"]}, headers=h)
        assert r.json()["status"] == "form" and script.n("ReceiptReply") == 0
    # Ф-1 on: code reads the labelled total itself, no model
    app = env9.make_app(router9(env9.maker, script), expenses_rules_first=True, **ON)
    async with client(app) as c:
        h = await signed_in(c, BASE)
        photo = await upload_item(c, h, b"\xff\xd8receipt-four", "image/jpeg", "camera")
        await ingest(app, env9.maker, photo["id"], RECEIPT_OCR)
        r = await c.post("/v1/expenses/from-item", json={"client_id": str(uuid.uuid4()),
                                                         "item_id": photo["id"]}, headers=h)
        assert r.status_code == 201 and r.json()["reader"] == "rules"
        assert r.json()["expense"]["amount"] == "1350.00" and script.n("ReceiptReply") == 0


async def test_shared_kaspi_receipt_pdf_is_masked_before_the_model(env9):
    from assistant.ai.masking import iban_ok

    iban = next(f"KZ{n:02d}722C000012345678" for n in range(100)
                if iban_ok(f"KZ{n:02d}722C000012345678"))  # fmt: skip
    lines = ["Kaspi.kz", "Платеж успешно совершен", "Получатель: ТОО ЦВЕТЫ ТЕСТ",
             f"Счёт получателя: {iban}", "Сумма: 7 450,00 ₸", "Дата и время: 03.11.2026 18:42"]
    script = Script13(receipt=ReceiptReply(
        is_receipt=True, total="7450.00", currency="KZT", date="2026-11-03",
        payee="ТОО ЦВЕТЫ ТЕСТ", category="cafe_gifts", lines=[], confidence=0.95))
    app = env9.make_app(router9(env9.maker, script), **ON)
    async with client(app) as c:
        h = await signed_in(c)
        pdf = await upload_item(c, h, text_pdf(lines), "application/pdf")
        await ingest(app, env9.maker, pdf["id"])
        r = await c.post("/v1/expenses/from-item", json={"client_id": str(uuid.uuid4()),
                                                         "item_id": pdf["id"],
                                                         "kind": "shared_receipt"}, headers=h)
        assert r.status_code == 201, r.text
        exp = r.json()["expense"]
        assert (exp["source"], exp["method"], exp["amount"], exp["category_key"]) == (
            "shared_receipt", "kaspi", "7450.00", "cafe_gifts")
        sent = script.calls["ReceiptReply"][0].messages[-1].text
        assert iban not in sent and "⟨IBAN_1⟩" in sent
    assert kaspi_receipt_pdf()  # the fixture builds


async def test_fiscal_qr_amount_from_the_link_page_only_from_the_allowlist(env9):
    url = "https://consumer.oofd.kz/?i=1234567890&f=010101012345&s=3400.50&t=20261104T191520"
    script = Script13(receipt=ReceiptReply(
        is_receipt=True, total="3400.50", currency="KZT", date="2026-11-04", payee="ТОО ТЕСТ",
        category="groceries", lines=[], confidence=0.9))
    app = env9.make_app(router9(env9.maker, script), **ON)
    app.state.ctx.ofd = FakeOfdReader({url: "ТОО ТЕСТ\nИТОГО 3 400,50\n04.11.2026 19:15"})
    async with client(app) as c:
        h = await signed_in(c)
        r = await c.post("/v1/expenses/from-qr", json={"client_id": str(uuid.uuid4()),
                                                       "url": "https://evil.example/?s=1"},
                         headers=h)  # fmt: skip
        assert r.status_code == 422 and r.json()["code"] == "qr_not_fiscal"
        assert app.state.ctx.ofd.urls == []
        r = await c.post("/v1/expenses/from-qr", json={"client_id": str(uuid.uuid4()), "url": url},
                         headers=h)  # fmt: skip
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["fiscal"]["amount"] == "3400.50" and body["fiscal"]["page"] == "read"
        exp = body["expense"]
        assert (exp["amount"], exp["spent_on"], exp["payee"], exp["source"]) == (
            "3400.50", "2026-11-04", "ТОО ТЕСТ", "receipt_qr")
        assert exp["review_fields"] == ["amount"]
        again = await c.post("/v1/expenses/from-qr", json={"client_id": str(uuid.uuid4()),
                                                           "url": url}, headers=h)
        assert again.json()["status"] == "exists" and again.json()["expense"]["id"] == exp["id"]

    app = env9.make_app(**ON)
    app.state.ctx.ofd = FakeOfdReader({})  # the OFD page is down; no consent either
    async with client(app) as c:
        h = await signed_in(c, BASE)
        r = await c.post("/v1/expenses/from-qr", json={"client_id": str(uuid.uuid4()), "url": url},
                         headers=h)  # fmt: skip
        assert r.status_code == 201 and r.json()["fiscal"]["page"] == "failed"
        assert r.json()["expense"]["amount"] == "3400.50"
