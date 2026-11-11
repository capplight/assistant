"""Week 14 КП against a real database. The finish criterion: the father makes a КП from his own
(anonymised — here synthetic) ТЗ: «Моя компания» once, «Мой прайс» from Excel, the ТЗ as a PDF →
KP_EXTRACT → prices from the price list, a past КП and «укажите цену» → a typed price → the PDF
with code's totals and the sum in words → «Отменить». Also: masking, consent, the budget never
cutting a started КП, parts with progress, the card file, sync, week 13's «Это разные» undo.
Providers and the PDF renderer are fakes (no network). Synthetic data only. Skipped without
DATABASE_URL."""

import os
import uuid
from decimal import Decimal
from typing import Any

import pytest
from sqlalchemy import func, select, text

from assistant.ai import BudgetExceeded, FakeAdapter
from assistant.ai.types import AdapterRequest
from assistant.db.models_kp import CompanyProfile, Document, DocumentVersion
from assistant.kp import run_extract
from assistant.kp.extract import KpExtractReply, KpLine, KpMatch, KpMatchReply
from assistant.kp.pricelist import PriceLine, PriceListReply
from assistant.kp.profile import ProfileReply
from assistant.kp.render import FakePdfRenderer, fonts_hash, template_hash
from tests.api.conftest import client
from tests.api.test_week9_db import add_page, entries
from tests.chat.test_chat_db import BASE, fake_router, signed_in
from tests.expenses.pdfgen import text_pdf
from tests.expenses.test_week13_db import ingest, upload_item

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set"),
]
BIN_SELLER = "123456789013"  # synthetic, passes the control digit
BIN_CLIENT = "990101300013"
IBAN = "KZ86125KZT5004100100"
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
TZ = ["Техническое задание на поставку", f"Заказчик: ТОО «Тест Строй», БИН {BIN_CLIENT}",
      "Контактное лицо: Ерлан", "1. Кабель ВВГнг 3х2,5 - 500 м", "2. Автомат 16А - 40 шт",
      "3. Щит ЩРН-24 - 4 шт", "4. Розетка двойная - 25 шт", "Доставка до объекта"]  # fmt: skip


def text_of(req: AdapterRequest) -> str:
    return req.system + "\n" + "\n".join(m.text for m in req.messages)


class KpScript:
    """One fake provider: KP_EXTRACT by what is in the request, picks, profile, price lists."""

    def __init__(self, lines: list[KpLine] | None = None, pick: dict[str, str] | None = None,
                 client_name: str = "ТОО «Тест Строй»") -> None:  # fmt: skip
        self.lines, self.pick, self.client_name = lines, pick or {}, client_name
        self.calls: dict[str, list[AdapterRequest]] = {}
        self.profile: ProfileReply | None = None
        self.price_list: PriceListReply | None = None

    def __call__(self, req: AdapterRequest) -> Any:
        self.calls.setdefault(req.schema_name, []).append(req)
        body = text_of(req)
        if req.schema_name == "KpExtractReply":
            masked = "⟨BIN_1⟩" if "⟨BIN_1⟩" in body else ""
            lines = self.lines if self.lines is not None else [
                KpLine(name="Кабель ВВГнг 3х2,5", unit="м", qty="500", ref="1"),
                KpLine(name="Автомат 16А", unit="шт", qty="40", ref="2"),
                KpLine(name="Щит ЩРН-24", unit="шт", qty="4", ref="3"),
                KpLine(name="Розетка двойная", unit="шт", qty="25", ref="4"),
                KpLine(name="Золотой унитаз", unit="шт", qty="1", ref="5")]  # invented: dropped
            return KpExtractReply(is_request=True, client_name=self.client_name,
                                  client_bin=masked, client_contact="Ерлан", lines=lines,
                                  delivery="Доставка до объекта", payment="",
                                  confidence=0.9)  # fmt: skip
        if req.schema_name == "KpMatchReply":
            return KpMatchReply(matches=[KpMatch(line=k, candidate=v)
                                         for k, v in self.pick.items()])  # fmt: skip
        if req.schema_name == "ProfileReply":
            assert self.profile is not None
            return self.profile
        if req.schema_name == "PriceListReply":
            assert self.price_list is not None
            return self.price_list
        raise AssertionError(req.schema_name)


def price_xlsx() -> bytes:
    import io

    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.title = "Прайс 2026"
    ws.append(["Артикул", "Наименование", "Ед. изм.", "Цена, тг"])
    ws.append(["K1", "Кабель ВВГнг 3х2,5", "м", 450])
    ws.append(["A16", "Автомат ВА47-29 16А", "шт", 2900])
    ws.append(["A25", "Автомат ВА47-29 25А", "шт", 3100])
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


async def make_app(env9, script: KpScript, **kw: Any):  # type: ignore[no-untyped-def]
    app = env9.make_app(fake_router(env9.maker, FakeAdapter("anthropic", [script])), **kw)
    app.state.ctx.kp_renderer = FakePdfRenderer()
    return app


async def run_job(env9, app, doc_id: str, router: Any = None) -> str:  # type: ignore[no-untyped-def]
    async with env9.maker() as s:
        pk = await s.scalar(select(Document.id).where(Document.public_id == uuid.UUID(doc_id)))
    return await run_extract(env9.maker, router or app.state.ctx.ai_router, app.state.ctx.settings,
                             {"document_id": pk})  # fmt: skip


async def new_kp(c, h, item_ids: list[str], status: int = 202, **kw: Any) -> dict:  # type: ignore[no-untyped-def]
    r = await c.post("/v1/documents/kp", json={"client_id": str(uuid.uuid4()),
                                               "item_ids": item_ids, **kw}, headers=h)
    assert r.status_code == status, r.text
    return r.json()


async def get_doc(c, h, doc_id: str) -> dict:  # type: ignore[no-untyped-def]
    r = await c.get(f"/v1/documents/{doc_id}", headers=h)
    assert r.status_code == 200, r.text
    return r.json()


async def patch(c, h, doc_id: str, base: int, ops: list[dict], status: int = 200,  # type: ignore[no-untyped-def]
                **kw: Any) -> dict:
    r = await c.post(f"/v1/documents/{doc_id}/patch", json={
        "client_id": str(uuid.uuid4()), "base_version": base, "ops": ops, **kw}, headers=h)
    assert r.status_code == status, r.text
    return r.json()


async def undo(c, h, action_id: str) -> dict:  # type: ignore[no-untyped-def]
    r = await c.post(f"/v1/actions/{action_id}/undo", json={}, headers=h)
    assert r.status_code == 200, r.text
    return r.json()


async def put_profile(c, h, **body: Any) -> dict:  # type: ignore[no-untyped-def]
    r = await c.put("/v1/company-profile", json={"client_id": str(uuid.uuid4()), **body},
                    headers=h)  # fmt: skip
    assert r.status_code == 200, r.text
    return r.json()


async def note(c, h, env9, app, text_: str) -> str:  # type: ignore[no-untyped-def]
    r = await c.post("/v1/items", json={"client_id": str(uuid.uuid4()), "text": text_}, headers=h)
    assert r.status_code == 201, r.text
    item_id = r.json()["item"]["id"]
    await ingest(app, env9.maker, item_id)
    return item_id


PROFILE = dict(name="Свет-Монтаж", legal_form="too", bin_iin=BIN_SELLER, address="г. Алматы, "
               "ул. Тестовая 1", bank={"iban": IBAN, "bik": "TESTKZKA", "bank": "АО «Тестбанк»",
                                       "kbe": "17"},
               signer={"name": "Иванов И. И.", "title": "Директор"}, vat_payer=True,
               default_terms={"payment": "100% предоплата", "validity_days": 10})  # fmt: skip


# --- the finish criterion ---


async def test_father_makes_a_kp_from_his_tz(env9):
    script = KpScript(pick={"i2": "0"})  # «Автомат 16А» → the model picks «Автомат ВА47-29 16А»
    app = await make_app(env9, script)
    async with client(app) as c:
        h = await signed_in(c)
        page = (await add_page(c, h, "documents"))["page"]["id"]

        # «Моя компания» once; БИН and IBAN are stored encrypted
        out = await put_profile(c, h, **PROFILE)
        assert out["profile"]["bin_iin"] == BIN_SELLER and out["profile"]["complete"]
        assert out["action"]["kind"] == "company_profile_edit" and out["action"]["undoable"]
        async with env9.maker() as s:
            row = await s.scalar(select(CompanyProfile))
            assert row is not None and BIN_SELLER.encode() not in (row.bin_iin_enc or b"")
            assert IBAN.encode() not in (row.bank_enc or b"")

        # «Мой прайс» from Excel: read by code (table), no model
        px = await upload_item(c, h, price_xlsx(), XLSX)
        await ingest(app, env9.maker, px["id"])
        r = await c.post("/v1/price-lists", json={"client_id": str(uuid.uuid4()),
                                                  "item_id": px["id"], "title": "Прайс 2026"},
                         headers=h)  # fmt: skip
        assert r.status_code == 201, r.text
        assert (r.json()["price_list"]["items"], r.json()["price_list"]["reader"]) == (3, "table")
        assert "PriceListReply" not in script.calls

        # a past КП with a typed price for «Розетка двойная» (prices from past КП)
        old = await note(c, h, env9, app, "КП для ТОО Ромашка: Розетка двойная - 10 шт")
        script.lines = [KpLine(name="Розетка двойная", unit="шт", qty="10", ref="1")]
        script.client_name = ""
        first = (await new_kp(c, h, [old]))["document"]
        assert await run_job(env9, app, first["id"]) == "done"
        d1 = await get_doc(c, h, first["id"])
        assert d1["version"]["items"][0]["price_source"] == "missing"
        await patch(c, h, first["id"], 1, [{"op": "replace", "path": "/items/i1/unit_price",
                                            "value": "1200"}])

        # the ТЗ as a PDF: KP_EXTRACT reads it; the client's БИН is masked before the call
        script.lines, script.client_name = None, "ТОО «Тест Строй»"
        tz = await upload_item(c, h, text_pdf(TZ), "application/pdf")
        await ingest(app, env9.maker, tz["id"])
        out = await new_kp(c, h, [tz["id"]], wishes="доставка до объекта")
        doc = out["document"]
        assert doc["status"] == "extracting" and out["needs_profile"] is False
        assert await run_job(env9, app, doc["id"]) == "done"
        sent = text_of(script.calls["KpExtractReply"][-1])
        assert BIN_CLIENT not in sent and "⟨BIN_1⟩" in sent
        assert "data" in sent.lower()  # the ТЗ goes as a data block, never as instructions

        full = await get_doc(c, h, doc["id"])
        v = full["version"]
        assert full["document"]["status"] == "draft" and v["n"] == 1 and v["author"] == "initial"
        assert v["client"]["name"] == "ТОО «Тест Строй»" and v["client"]["bin"] == BIN_CLIENT
        assert v["data"]["number"].startswith("КП-20") and v["data"]["number"].endswith("-002")
        lines = {it["name"]: it for it in v["items"]}
        assert list(lines) == ["Кабель ВВГнг 3х2,5", "Автомат 16А", "Щит ЩРН-24",
                               "Розетка двойная"]  # «Золотой унитаз» is not in the ТЗ
        assert lines["Кабель ВВГнг 3х2,5"]["unit_price"] == "450.00"
        assert lines["Кабель ВВГнг 3х2,5"]["price_source"].startswith("price_list:")
        assert lines["Кабель ВВГнг 3х2,5"]["price_label"] == "из прайса «Прайс 2026»"
        auto = lines["Автомат 16А"]
        assert auto["unit_price"] == "2900.00" and auto["price_review"] is True
        assert auto["matched_name"] == "Автомат ВА47-29 16А"
        assert "та ли позиция?" in auto["price_label"]
        assert lines["Розетка двойная"]["unit_price"] == "1200.00"
        assert lines["Розетка двойная"]["price_source"].startswith(f"past_kp:{first['id']}#v")
        assert lines["Розетка двойная"]["price_label"].startswith("из КП от ")
        assert lines["Щит ЩРН-24"]["price_source"] == "missing"
        assert lines["Щит ЩРН-24"]["price_label"] == "укажите цену"
        assert v["price_summary"] == {"price_list": 2, "past_kp": 1, "manual": 0, "missing": 1}
        # code's sums: 500×450 + 40×2900 + 25×1200, VAT 16% inside
        t = v["totals"]
        assert (t["total"], t["vat_mode"], t["vat_rate"]) == ("371000.00", "included", "16.00")
        assert Decimal(t["net"]) + Decimal(t["vat"]) == Decimal(t["total"])
        assert t["vat"] == "51172.41" and t["complete"] is False and t["missing"] == 1
        assert v["data"]["terms"]["delivery"] == "Доставка до объекта"
        assert v["data"]["terms"]["validity_days"] == 10 and v["valid_until"]
        assert "total" in v["missing_required"]

        # no PDF while a price is missing
        r = await c.post(f"/v1/documents/{doc['id']}/render", headers=h)
        assert r.status_code == 422 and r.json()["code"] == "kp_prices_missing"

        # «Ввести цены подряд»: the missing price, saved to «Мой прайс» too
        ed = await patch(c, h, doc["id"], 1, [{"op": "replace", "path": "/items/i3/unit_price",
                                               "value": "18 500"}], save_prices=True)
        v2 = ed["version"]
        assert v2["n"] == 2 and v2["totals"]["total"] == "445000.00"
        assert "/items/i3/unit_price" in v2["changed_paths"]
        assert "/totals/total" in v2["changed_paths"]
        assert ed["change_text"] == "Итого: 371 000 → 445 000 ₸"
        assert ed["price_offers"] == []
        found = (await c.get("/v1/price-lists/items", params={"q": "щит"}, headers=h)).json()
        assert [(i["name"], i["price"]) for i in found["items"]] == [("Щит ЩРН-24", "18500.00")]

        # the PDF: code's numbers, the sum in words, the requisites; the same data → same file
        r = await c.post(f"/v1/documents/{doc['id']}/render", headers=h)
        assert r.status_code == 200, r.text
        f = r.json()["file"]
        assert r.json()["document"]["status"] == "ready" and f["name"] == "КП_ТОО_Тест_Строй_v2.pdf"
        html = app.state.ctx.kp_renderer.calls[-1]
        for part in ("445 000,00", "в т. ч. НДС 16%", "61 379,31",
                     "Четыреста сорок пять тысяч тенге 00 тиын", f"БИН {BIN_SELLER}", IBAN,
                     BIN_CLIENT, "Иванов И. И.", "Подготовлено с помощью ИИ",
                     v2["data"]["number"]):  # fmt: skip
            assert part in html, part
        got = await c.get(f["url"].removeprefix("http://test"), headers=h)
        assert got.status_code == 200 and got.content.startswith(b"%PDF")
        again = await c.post(f"/v1/documents/{doc['id']}/render", headers=h)
        assert again.json()["file"]["id"] == f["id"]
        assert len(app.state.ctx.kp_renderer.calls) == 1

        # «Отменить» the price: a new version equal to v1, the numbers as they were
        back = await undo(c, h, ed["action"]["id"])
        assert back["partial"] is False
        cur = await get_doc(c, h, doc["id"])
        assert cur["version"]["n"] == 3 and cur["version"]["author"] == "revert"
        assert cur["version"]["totals"] == v["totals"]
        assert next(i for i in cur["version"]["items"] if i["id"] == "i3")["unit_price"] is None
        found = (await c.get("/v1/price-lists/items", params={"q": "щит"}, headers=h)).json()
        assert found["items"] == []  # the price saved with it left too

        # the card file: the КП is on «Документы и КП» with its row and fields, not on «Заметки»
        rows = await entries(c, h, page)
        card = next(e for e in rows if e["document"] and e["document"]["id"] == doc["id"])
        assert card["item"]["kind"] == "kp" and card["item"]["ai_generated"] is True
        assert card["fields"]["doc_type"] == "kp" and card["fields"]["amount"] == "371000.00"
        assert card["fields"]["client"] == "ТОО «Тест Строй»"
        summary = (await c.get("/v1/documents/summary", headers=h)).json()
        assert summary["by_type"]["kp"] == 2

        # status strip with «Отменить»
        r = await c.post(f"/v1/documents/{doc['id']}/status",
                         json={"client_id": str(uuid.uuid4()), "deal_status": "accepted"},
                         headers=h)  # fmt: skip
        assert r.json()["document"]["deal_status_text"] == "Принято"
        await undo(c, h, r.json()["action"]["id"])
        assert (await get_doc(c, h, doc["id"]))["document"]["deal_status"] == "draft"

        # sync brings the card file
        sync = (await c.get("/v1/sync", params={"since": 0, "limit": 500}, headers=h)).json()
        mine = [d for d in sync["documents"] if d["id"] == doc["id"]]
        assert mine and mine[-1]["total"] == "371000.00"
        acts = {a["kind"] for a in sync["actions"]}
        assert {"create_kp", "edit_kp", "price_list_edit", "company_profile_edit"} <= acts


async def test_trash_and_undo_bring_the_kp_back_and_profile_undo(env9):
    script = KpScript(lines=[KpLine(name="Плитка", unit="м2", qty="12", ref="1")],
                      client_name="")
    app = await make_app(env9, script)
    async with client(app) as c:
        h = await signed_in(c)
        p1 = await put_profile(c, h, name="ИП Тестов", legal_form="ip")
        p2 = await put_profile(c, h, base_version=1, name="ИП Тестов А.")
        assert p2["profile"]["version"] == 2
        r = await c.put("/v1/company-profile", json={"base_version": 1, "name": "x"}, headers=h)
        assert r.status_code == 409 and r.json()["code"] == "conflict"
        await undo(c, h, p2["action"]["id"])
        assert (await c.get("/v1/company-profile", headers=h)).json()["profile"]["name"] == \
            "ИП Тестов"  # fmt: skip
        await undo(c, h, p1["action"]["id"])
        assert (await c.get("/v1/company-profile", headers=h)).json()["profile"]["id"] is None
        r = await c.put("/v1/company-profile", json={"bin_iin": "123456789012"}, headers=h)
        assert r.status_code == 422 and r.json()["code"] == "bin_invalid"

        item = await note(c, h, env9, app, "Плитка напольная 12 м2")
        doc = (await new_kp(c, h, [item]))["document"]
        assert await run_job(env9, app, doc["id"]) == "done"
        full = await get_doc(c, h, doc["id"])
        assert full["needs_profile"] is True
        assert full["version"]["data"]["vat"]["mode"] == "included"
        r = await c.delete(f"/v1/documents/{doc['id']}", params={"client_id": str(uuid.uuid4())},
                           headers=h)  # fmt: skip
        assert r.status_code == 200 and r.json()["document"]["deleted_at"]
        await undo(c, h, r.json()["action"]["id"])
        assert (await get_doc(c, h, doc["id"]))["document"]["deleted_at"] is None
        # the create action's «Отменить» trashes the КП and its record
        sync = (await c.get("/v1/sync", params={"since": 0, "limit": 500}, headers=h)).json()
        create = next(a for a in sync["actions"] if a["kind"] == "create_kp")
        await undo(c, h, create["id"])
        assert (await get_doc(c, h, doc["id"]))["document"]["deleted_at"]


async def test_not_a_vat_payer_gets_no_vat_and_render_needs_required_fields(env9):
    script = KpScript(lines=[KpLine(name="Монтаж розеток", unit="шт", qty="10", ref="1")],
                      client_name="")
    app = await make_app(env9, script)
    async with client(app) as c:
        h = await signed_in(c)
        await put_profile(c, h, name="Тестов", legal_form="ip", vat_payer=False)
        item = await note(c, h, env9, app, "Монтаж розеток 10 шт")
        doc = (await new_kp(c, h, [item]))["document"]
        await run_job(env9, app, doc["id"])
        v = (await get_doc(c, h, doc["id"]))["version"]
        assert v["data"]["vat"]["mode"] == "none" and v["totals"]["vat"] == "0.00"
        v = (await patch(c, h, doc["id"], 1, [{"op": "replace", "path": "/items/i1/unit_price",
                                               "value": "1500"}]))["version"]
        assert v["totals"]["total"] == "15000.00"
        r = await c.post(f"/v1/documents/{doc['id']}/render", headers=h)
        assert r.status_code == 422 and r.json()["code"] == "kp_fields_missing"
        assert set(r.json()["details"]["fields"]) == {"seller.bin_iin", "buyer.name",
                                                      "seller.address", "seller.bank", "signer"}
        assert (await c.post(f"/v1/documents/{doc['id']}/render?format=docx",
                             headers=h)).json()["code"] == "kp_fields_missing"  # week 15: Word
        r = await patch(c, h, doc["id"], 1, [{"op": "replace", "path": "/client/name",
                                              "value": "x"}], status=409)
        assert r["code"] == "conflict"
        await patch(c, h, doc["id"], 2, [{"op": "replace", "path": "/client/name",
                                          "value": "ТОО «Покупатель»"}])
        await put_profile(c, h, bin_iin=BIN_SELLER, address="г. Алматы",
                          bank={"iban": IBAN, "bik": "TESTKZKA", "kbe": "19"},
                          signer={"name": "Тестов Т.", "title": "ИП"})
        r = await c.post(f"/v1/documents/{doc['id']}/render", headers=h)
        assert r.status_code == 200, r.text
        html = app.state.ctx.kp_renderer.calls[-1]
        assert "ИТОГО без НДС" in html and "ИИН " + BIN_SELLER in html
        assert "не является плательщиком НДС" in html
        assert "Пятнадцать тысяч тенге 00 тиын" in html


# --- parts, progress, the budget ---


class PartsRouter:
    """A router stand-in: KP_EXTRACT per part, records `continuing`; can refuse by budget."""

    def __init__(self, refuse: str | None = None) -> None:
        self.refuse = refuse  # "first" | "later"
        self.continuing: list[bool] = []
        self.adapters = {"fake": None}

    async def run(self, task, schema, inputs, *, user_id, continuing=False, **kw):  # type: ignore[no-untyped-def]
        from assistant.ai.types import Result, Usage

        self.continuing.append(continuing)
        if self.refuse == "first" and not continuing:
            raise BudgetExceeded("documents_monthly")
        if self.refuse == "later" and not continuing:
            pass
        text_ = inputs.untrusted[0].text
        rows = [ln for ln in text_.splitlines() if ln[:1].isdigit()]
        lines = [KpLine(name=ln.split(". ", 1)[1].split(" - ")[0], unit="шт",
                        qty=ln.rsplit(" - ", 1)[1].split()[0], ref=ln.split(".")[0])
                 for ln in rows]  # fmt: skip
        data = schema(is_request=True, client_name="", client_bin="", client_contact="",
                      lines=lines, delivery="", payment="", confidence=0.9) \
            if schema is KpExtractReply else KpMatchReply(matches=[])  # fmt: skip
        return Result(data=data, tool_calls=[], provider="fake", model="fake",
                      usage=Usage(tokens_in=1, tokens_out=1), cost_usd=Decimal(0), attempts=1,
                      fallback_from=None)  # fmt: skip


def big_tz(n: int) -> str:
    return "ТЗ на материалы\n" + "\n".join(f"{i}. Болт М{i} - {i} шт" for i in range(1, n + 1))


async def test_big_tz_goes_in_parts_with_progress_and_is_never_cut(env9):
    app = await make_app(env9, KpScript())
    async with client(app) as c:
        h = await signed_in(c)
        item = await note(c, h, env9, app, big_tz(100))
        doc = (await new_kp(c, h, [item]))["document"]
        router = PartsRouter()
        assert await run_job(env9, app, doc["id"], router) == "done"
        assert router.continuing == [False, True, True]  # parts 2 and 3 never cut by budget
        p = (await c.get(f"/v1/documents/{doc['id']}/progress", params={"once": True},
                         headers=h)).json()  # fmt: skip
        assert (p["state"], p["done"], p["total"], p["parts_total"]) == ("done", 100, 100, 3)
        v = (await get_doc(c, h, doc["id"]))["version"]
        assert len(v["items"]) == 100 and v["items"][99]["name"] == "Болт М100"
        assert [i["id"] for i in v["items"][:3]] == ["i1", "i2", "i3"]

        item2 = await note(c, h, env9, app, big_tz(5))
        doc2 = (await new_kp(c, h, [item2]))["document"]
        assert await run_job(env9, app, doc2["id"], PartsRouter("first")) == "failed:kp_budget"
        p = (await c.get(f"/v1/documents/{doc2['id']}/progress", params={"once": True},
                         headers=h)).json()  # fmt: skip
        assert p["state"] == "failed" and p["message"].startswith("На сегодня достаточно")


async def test_consent_daily_limit_and_source_checks(env9):
    app = await make_app(env9, KpScript(), kp_per_day=1)
    async with client(app) as c:
        h0 = await signed_in(c, BASE)  # no ai_cross_border
        r = await c.post("/v1/items", json={"client_id": str(uuid.uuid4()), "text": "Болт 5 шт"},
                         headers=h0)  # fmt: skip
        out = await new_kp(c, h0, [r.json()["item"]["id"]], status=403)
        assert out["code"] == "consent_required" and "ai_cross_border" in out["details"]["missing"]

        h = await signed_in(c)
        r = await c.post("/v1/items", json={"client_id": str(uuid.uuid4()), "text": "Болт 5 шт"},
                         headers=h)  # fmt: skip
        pending = r.json()["item"]["id"]
        assert (await new_kp(c, h, [pending], status=409))["code"] == "kp_source_not_ready"
        await ingest(app, env9.maker, pending)
        await new_kp(c, h, [pending])
        assert (await new_kp(c, h, [pending], status=429))["code"] == "kp_daily_limit"
        assert (await new_kp(c, h, [str(uuid.uuid4())], status=404))["code"] == "not_found"


# --- profile from a card, price list from a photo (the model, checked by code) ---


async def test_profile_from_a_card_is_a_draft_with_checks(env9):
    card = (f"ТОО «Свет-Монтаж»\nБИН {BIN_SELLER}\nИИК {IBAN}\nг. Алматы, ул. Тестовая 1\n"
            "+7 701 000 00 01")
    script = KpScript()
    script.profile = ProfileReply(
        is_company=True, name="Свет-Монтаж", legal_form="too", bin_iin="⟨BIN_1⟩",
        address="г. Алматы, ул. Тестовая 1", iban="⟨IBAN_1⟩", bik="", bank="", kbe="",
        phone="⟨PHONE_1⟩", email="", website="", signer_name="", signer_title="")  # fmt: skip
    app = await make_app(env9, script)
    async with client(app) as c:
        h = await signed_in(c)
        item = await note(c, h, env9, app, card)
        r = await c.post("/v1/company-profile/extract", json={"item_id": item}, headers=h)
        assert r.status_code == 200, r.text
        d = r.json()["draft"]
        assert d["bin_iin"] == BIN_SELLER and d["bank"]["iban"] == IBAN  # put back after masking
        assert d["contacts"]["phone"] == "+7 701 000 00 01"
        assert {"bin_iin", "bank.iban", "contacts.phone"} <= set(d["review_fields"])
        sent = text_of(script.calls["ProfileReply"][0])
        assert BIN_SELLER not in sent and IBAN not in sent and "701 000" not in sent
        async with env9.maker() as s:  # a draft: nothing saved
            assert await s.scalar(select(func.count()).select_from(CompanyProfile)) == 0


async def test_price_list_from_a_photo_keeps_written_prices_with_review(env9):
    script = KpScript()
    script.price_list = PriceListReply(is_price_list=True, lines=[
        PriceLine(name="Щит ЩРН-24", unit="шт", price="18 500"),
        PriceLine(name="Розетка двойная", unit="шт", price="999")])  # not written: dropped
    app = await make_app(env9, script)
    async with client(app) as c:
        h = await signed_in(c)
        item = await note(c, h, env9, app, "Прайс\nЩит ЩРН-24 — 18 500 тг\nРозетка двойная — 1 200")
        r = await c.post("/v1/price-lists", json={"client_id": str(uuid.uuid4()), "item_id": item},
                         headers=h)  # fmt: skip
        assert r.status_code == 201, r.text
        pl = r.json()["price_list"]
        assert (pl["items"], pl["reader"], pl["review_count"]) == (1, "model", 1)
        items = (await c.get("/v1/price-lists/items", headers=h)).json()["items"]
        assert [(i["name"], i["price"], i["review_fields"]) for i in items] == [
            ("Щит ЩРН-24", "18500.00", ["price"])]
        r = await c.patch(f"/v1/price-lists/items/{items[0]['id']}",
                          json={"checked": True, "price": "19000"}, headers=h)
        assert r.json()["item"]["review_fields"] == [] and r.json()["item"]["price"] == "19000.00"
        await undo(c, h, r.json()["action"]["id"])
        items = (await c.get("/v1/price-lists/items", headers=h)).json()["items"]
        assert items[0]["price"] == "18500.00" and items[0]["review_fields"] == ["price"]
        # typed prices: a new one and a known one; one «Отменить» for both
        r = await c.post("/v1/price-lists/items", json={"client_id": str(uuid.uuid4()), "items": [
            {"name": "щит ЩРН-24", "unit": "шт", "price": "20000"},
            {"name": "Лампа LED", "unit": "шт", "price": "900"}]}, headers=h)
        assert r.status_code == 201, r.text
        await undo(c, h, r.json()["action"]["id"])
        items = (await c.get("/v1/price-lists/items", headers=h)).json()["items"]
        assert [(i["name"], i["price"]) for i in items] == [("Щит ЩРН-24", "18500.00")]
        r = await c.post("/v1/price-lists", json={"client_id": str(uuid.uuid4()), "item_id": item},
                         headers=h)  # fmt: skip
        await undo(c, h, r.json()["action"]["id"])  # the whole list leaves
        lists = (await c.get("/v1/price-lists", headers=h)).json()["price_lists"]
        assert [(x["source"], x["items"]) for x in lists] == [("upload", 1),
                                                              ("typed_sequence", 0)]


# --- the template version is reproducible ---


async def test_template_row_matches_the_packaged_files(env9):
    async with env9.maker() as s:
        row = (await s.execute(text(
            "SELECT storage_key, template_hash, fonts_hash FROM doc_templates "
            "WHERE user_id IS NULL AND kind = 'kp' AND engine = 'html' AND version = 1"))).one()
    assert row == ("builtin:kp_v1", template_hash("kp_v1.html.j2"), fonts_hash())


async def test_versions_list_and_revert(env9):
    script = KpScript(lines=[KpLine(name="Болт М8", unit="шт", qty="100", ref="1")],
                      client_name="")
    app = await make_app(env9, script)
    async with client(app) as c:
        h = await signed_in(c)
        item = await note(c, h, env9, app, "Болт М8 - 100 шт")
        doc = (await new_kp(c, h, [item]))["document"]
        await run_job(env9, app, doc["id"])
        await patch(c, h, doc["id"], 1, [{"op": "replace", "path": "/items/i1/unit_price",
                                          "value": "50"}])
        await patch(c, h, doc["id"], 2, [{"op": "replace", "path": "/items/i1/qty",
                                          "value": "200"}])
        r = await c.post(f"/v1/documents/{doc['id']}/revert",
                         json={"client_id": str(uuid.uuid4()), "n": 2}, headers=h)
        assert r.status_code == 200 and r.json()["version"]["n"] == 4
        assert r.json()["version"]["totals"]["total"] == "5000.00"
        vs = (await c.get(f"/v1/documents/{doc['id']}/versions", headers=h)).json()["versions"]
        assert [(v["n"], v["total"], v["current"]) for v in vs] == [
            (4, "5000.00", True), (3, "10000.00", False), (2, "5000.00", False),
            (1, "0.00", False)]
        # undo of the revert after another edit: the person's edit stays
        await patch(c, h, doc["id"], 4, [{"op": "replace", "path": "/items/i1/qty",
                                          "value": "300"}])
        back = await undo(c, h, r.json()["action"]["id"])
        assert back["partial"] is True
        async with env9.maker() as s:
            n = await s.scalar(select(func.max(DocumentVersion.n)))
        assert n == 5


# --- week 13: «Это разные» is undoable; plans and repeats come in sync ---


async def test_expense_dismiss_is_an_action_with_undo_and_sync(env9):
    from tests.expenses.test_expenses_db import add

    app = await make_app(env9, KpScript())
    async with client(app) as c:
        h = await signed_in(c, BASE)
        await add_page(c, h, "expenses")
        await add(c, h, amount="4500", payee="Магнум")
        e2 = (await add(c, h, amount="4500", payee="Magnum"))["expense"]
        async with env9.maker() as s:  # a repeat as a receipt / statement would suggest it
            from assistant.db.models_expenses import ExpenseEntry
            from assistant.expenses import repeats

            entry = await s.scalar(select(ExpenseEntry).where(
                ExpenseEntry.public_id == uuid.UUID(e2["id"])))
            assert await repeats.suggest_for(s, entry.user_id, entry) is not None
            await s.commit()
        dups = (await c.get("/v1/expenses/duplicates", headers=h)).json()["duplicates"]
        assert len(dups) == 1
        sync = (await c.get("/v1/sync", params={"since": 0, "limit": 500}, headers=h)).json()
        assert [d["id"] for d in sync["expense_duplicates"]] == [dups[0]["id"]]
        since = sync["next_since"]
        r = await c.post(f"/v1/expenses/duplicates/{dups[0]['id']}/dismiss",
                         json={"client_id": str(uuid.uuid4())}, headers=h)
        assert r.status_code == 200, r.text
        out = r.json()
        assert out["duplicate"]["status"] == "dismissed"
        assert out["action"]["kind"] == "dismiss_expenses" and out["action"]["undoable"]
        await undo(c, h, out["action"]["id"])
        dups = (await c.get("/v1/expenses/duplicates", headers=h)).json()["duplicates"]
        assert [d["status"] for d in dups] == ["suggested"]
        sync = (await c.get("/v1/sync", params={"since": since}, headers=h)).json()
        assert [d["status"] for d in sync["expense_duplicates"]] == ["suggested"]
