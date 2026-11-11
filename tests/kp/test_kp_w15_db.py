"""Week 15 КП against a real database. The finish criterion: the father edits a КП by a phrase
(«скидка 5% на всё», «убери доставку») with «Отменить», sees the versions, makes the Word file,
sends the PDF through WhatsApp (the phone's share sheet; the server sends nothing), says
«Отправили? — Да» and the sent version stays frozen with its file; a later edit asks «Клиент видел
v2. Отправить новую?». Also drafts (US-13) and «Моя компания» / «Мой прайс» in sync. Providers and
the PDF renderer are fakes; the DOCX is the real python-docx file. Synthetic data only. Skipped
without DATABASE_URL."""

import io
import os
import uuid
from typing import Any

import pytest
from sqlalchemy import select, text

from assistant.db.models_kp import DocumentVersion
from assistant.db.models_v2 import File
from assistant.kp import docx_render
from assistant.kp.edit import TEXT_NUMBER, KpEditOp, KpEditReply
from assistant.kp.extract import KpLine
from assistant.kp.send import DraftReply
from tests.api.conftest import client
from tests.chat.test_chat_db import BASE, signed_in
from tests.kp.test_kp_db import (
    BIN_CLIENT,
    BIN_SELLER,
    IBAN,
    PROFILE,
    KpScript,
    get_doc,
    make_app,
    new_kp,
    note,
    patch,
    put_profile,
    run_job,
    text_of,
    undo,
)

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set"),
]
SPACES = str.maketrans({" ": " ", " ": " "})


def op(kind: str, path: str, value: str = "", **kw: str) -> KpEditOp:
    return KpEditOp(op=kind, path=path, value=value, name=kw.get("name", ""),  # type: ignore[arg-type]
                    unit=kw.get("unit", ""), qty=kw.get("qty", ""),
                    unit_price=kw.get("unit_price", ""), volume=kw.get("volume", ""))


class W15Script(KpScript):
    """KpScript plus KP_EDIT and DRAFT replies set by the test."""

    def __init__(self, **kw: Any) -> None:
        super().__init__(**kw)
        self.edit: KpEditReply | None = None
        self.draft: DraftReply | None = None

    def __call__(self, req: Any) -> Any:
        if req.schema_name == "KpEditReply":
            self.calls.setdefault(req.schema_name, []).append(req)
            assert self.edit is not None
            return self.edit
        if req.schema_name == "DraftReply":
            self.calls.setdefault(req.schema_name, []).append(req)
            assert self.draft is not None
            return self.draft
        return super().__call__(req)


TZ_NOTE = (f"ТЗ от ТОО «Тест Строй», БИН {BIN_CLIENT}, контакт Ерлан\n"
           "1. Кабель ВВГнг 3х2,5 - 100 м\n2. Доставка до объекта - 1 рейс")  # fmt: skip


async def ready_kp(c, h, env9, app, script: W15Script) -> str:  # type: ignore[no-untyped-def]
    """Profile + a КП of 2 priced lines: 100 × 450 + 1 × 15 000 = 60 000 ₸ (v2)."""
    await put_profile(c, h, **PROFILE)
    script.lines = [KpLine(name="Кабель ВВГнг 3х2,5", unit="м", qty="100", ref="1"),
                    KpLine(name="Доставка до объекта", unit="рейс", qty="1", ref="2")]
    item = await note(c, h, env9, app, TZ_NOTE)
    doc = (await new_kp(c, h, [item]))["document"]
    assert await run_job(env9, app, doc["id"]) == "done"
    out = await patch(c, h, doc["id"], 1, [
        {"op": "replace", "path": "/items/i1/unit_price", "value": "450"},
        {"op": "replace", "path": "/items/i2/unit_price", "value": "15000"}])
    assert out["version"]["totals"]["total"] == "60000.00"
    return doc["id"]


async def edit(c, h, doc_id: str, base: int, phrase: str, status: int = 200) -> dict:  # type: ignore[no-untyped-def]
    r = await c.post(f"/v1/documents/{doc_id}/edit", json={
        "client_id": str(uuid.uuid4()), "base_version": base, "text": phrase}, headers=h)
    assert r.status_code == status, r.text
    return r.json()


# --- phrase edits ---


async def test_phrase_edits_apply_at_once_with_undo_and_never_compute(env9):
    script = W15Script()
    app = await make_app(env9, script)
    async with client(app) as c:
        h = await signed_in(c)
        doc_id = await ready_kp(c, h, env9, app, script)

        # «скидка 5% на всё»: applied at once, code's total, one «Отменить»
        script.edit = KpEditReply(understood=True, ops=[op("replace", "/discount_total_pct", "5")])
        out = await edit(c, h, doc_id, 2, "скидка 5% на всё")
        v = out["version"]
        assert out["status"] == "applied" and out["message"] is None and out["refused"] == []
        assert (v["n"], v["author"], v["request_text"]) == (3, "agent_request", "скидка 5% на всё")
        assert v["totals"]["total"] == "57000.00" and v["totals"]["discount_total"] == "3000.00"
        assert {"/discount_total_pct", "/totals/total"} <= set(v["changed_paths"])
        assert out["change_text"].translate(SPACES) == "Итого: 60 000 → 57 000 ₸"
        assert out["action"]["kind"] == "edit_kp" and out["action"]["undoable"]
        assert out["versions"][0]["author_text"] == "Правка: «скидка 5% на всё»"
        req = text_of(script.calls["KpEditReply"][-1])
        assert "скидка 5% на всё" in req and "i1: Кабель ВВГнг 3х2,5" in req
        assert BIN_CLIENT not in req and "data" in req.lower()  # the КП goes as data

        # «убери доставку»: the line goes
        script.edit = KpEditReply(understood=True, ops=[op("remove", "/items/i2")])
        out = await edit(c, h, doc_id, 3, "убери доставку")
        assert [i["id"] for i in out["version"]["items"]] == ["i1"]
        assert out["version"]["totals"]["total"] == "42750.00"  # 45 000 − 5%

        # «Отменить» → the version before, the numbers as they were
        await undo(c, h, out["action"]["id"])
        cur = await get_doc(c, h, doc_id)
        assert cur["version"]["n"] == 5 and cur["version"]["totals"]["total"] == "57000.00"
        assert cur["version"]["author"] == "revert"
        assert cur["versions"][0]["author_text"] == "Вернул версию 3"

        # a computed price is refused: nothing changes
        script.edit = KpEditReply(understood=True, ops=[
            op("replace", "/items/i1/unit_price", "495")])
        out = await edit(c, h, doc_id, 5, "подними цену кабеля на 10%")
        assert out["status"] == "refused" and out["action"] is None
        assert out["refused"] == [{"path": "/items/i1/unit_price", "reason": "number_not_said"}]
        assert out["message"] == TEXT_NUMBER and out["version"]["n"] == 5

        # a said price is the person's (manual); a new line without a price asks for it
        script.edit = KpEditReply(understood=True, ops=[
            op("replace", "/items/i1/unit_price", "470"),
            op("add", "/items/-", name="Монтаж", unit="услуга", qty="1")])
        out = await edit(c, h, doc_id, 5, "цена кабеля 470 и добавь монтаж")
        lines = {i["id"]: i for i in out["version"]["items"]}
        assert lines["i1"]["unit_price"] == "470.00" and lines["i1"]["price_source"] == "manual"
        assert lines["i3"]["name"] == "Монтаж" and lines["i3"]["price_label"] == "укажите цену"
        assert out["version"]["totals"]["complete"] is False
        assert [o["price"] for o in out["price_offers"]] == ["470.00"]  # «Обновить в прайсе?»

        # an invented line name is refused; not a change → not understood
        script.edit = KpEditReply(understood=True, ops=[
            op("add", "/items/-", name="Золотой унитаз", qty="1")])
        out = await edit(c, h, doc_id, 6, "добавь что-нибудь")
        assert out["status"] == "refused" and out["refused"][0]["reason"] == "name_not_said"
        script.edit = KpEditReply(understood=False, ops=[])
        out = await edit(c, h, doc_id, 6, "какая погода завтра")
        assert out["status"] == "not_understood" and out["version"]["n"] == 6
        # tap-edit-only paths and a stale version
        script.edit = KpEditReply(understood=True, ops=[op("replace", "/number", "КП-1")])
        out = await edit(c, h, doc_id, 6, "номер КП-1")
        assert out["refused"] == [{"path": "/number", "reason": "path_not_allowed"}]
        r = await edit(c, h, doc_id, 2, "скидка 5%", status=409)
        assert r["code"] == "conflict" and r["details"]["version"]["n"] == 6


# --- DOCX, versions, sending, «Отправили?» ---


async def test_docx_send_through_the_phone_and_the_sent_version_is_frozen(env9):
    from docx import Document as Docx

    script = W15Script()
    app = await make_app(env9, script)
    async with client(app) as c:
        h = await signed_in(c)
        doc_id = await ready_kp(c, h, env9, app, script)

        # «Ещё → Сделать в Word»: the same numbers, the AI mark in the core properties only
        r = await c.post(f"/v1/documents/{doc_id}/render", params={"format": "docx"}, headers=h)
        assert r.status_code == 200, r.text
        f = r.json()["file"]
        assert f["mime"] == docx_render.DOCX_MIME and f["name"] == "КП_ТОО_Тест_Строй_v2.docx"
        got = await c.get(f["url"], headers=h)
        assert got.status_code == 200 and got.content[:2] == b"PK"
        word = Docx(io.BytesIO(got.content))
        body = "\n".join([p.text for p in word.paragraphs] + [
            cell.text for t in word.tables for row in t.rows for cell in row.cells])
        body = body.translate(SPACES)
        for part in ("КОММЕРЧЕСКОЕ ПРЕДЛОЖЕНИЕ № КП-", "60 000,00", "в т. ч. НДС 16%",
                     "Шестьдесят тысяч тенге 00 тиын", f"БИН {BIN_SELLER}", IBAN, "Исх. № ",
                     "ТОО «Тест Строй»", "Кабель ВВГнг 3х2,5", "Иванов И. И."):
            assert part in body, part
        assert "Подготовил помощник" not in body  # the visible label is off until the lawyer
        cp = word.core_properties
        assert cp.subject == cp.keywords == cp.comments == "Подготовлено с помощью ИИ"
        again = await c.post(f"/v1/documents/{doc_id}/render", params={"format": "docx"},
                             headers=h)  # fmt: skip
        assert again.json()["file"]["id"] == f["id"]  # deterministic: the same file

        # S18 «Отправить» → a pending «Да» with code's preview; nothing is sent
        r = await c.post(f"/v1/documents/{doc_id}/send", json={
            "client_id": str(uuid.uuid4()), "channel": "whatsapp"}, headers=h)
        assert r.status_code == 200, r.text
        out = r.json()
        p = out["pending_action"]
        assert p["kind"] == "send_whatsapp_file" and p["status"] == "proposed"
        assert out["file"]["name"] == "КП_ТОО_Тест_Строй_v2.pdf" and out["resend"] is None
        assert out["hint"] == "Откроется WhatsApp — выберите чат «Ерлан» и нажмите ➤"
        msg = out["message"].translate(SPACES)
        assert msg.startswith("Добрый день, Ерлан! Направляю коммерческое предложение № КП-")
        assert msg.endswith("на сумму 60 000 ₸.")
        assert p["preview"]["total"] == "60000.00" and p["preview"]["version_n"] == 2
        # «Открыть WhatsApp»: what the phone opens; the number is the phone's
        r = await c.post(f"/v1/pending-actions/{p['id']}/confirm", json={}, headers=h)
        assert r.status_code == 200, r.text
        ex = r.json()["execute"]
        assert ex["kind"] == "share_file" and ex["file"]["url"] == out["file"]["url"]
        assert ex["wa_url_template"].startswith("https://wa.me/{phone}?text=%D0%94")
        assert r.json()["pending_action"]["status"] == "confirmed"
        r = await c.post(f"/v1/pending-actions/{p['id']}/confirm", json={}, headers=h)
        assert r.json()["repeated"] is True
        # «Отправили? — Да»
        r = await c.post(f"/v1/pending-actions/{p['id']}/result", json={"outcome": "sent"},
                         headers=h)  # fmt: skip
        assert r.status_code == 200, r.text
        res = r.json()
        assert res["pending_action"]["status"] == "executed"
        assert res["action"]["kind"] == "send_external" and res["action"]["undoable"] is False
        d = res["document"]
        assert (d["status"], d["deal_status"], d["sent_version_n"]) == ("sent", "sent", 2)
        assert d["sent_at"]
        full = await get_doc(c, h, doc_id)
        v2 = next(v for v in full["versions"] if v["n"] == 2)
        assert v2["frozen"] and v2["sent_channel"] == "whatsapp_share"
        assert v2["files"]["pdf"] and v2["files"]["docx"]
        async with env9.maker() as s:
            pk = await s.scalar(select(DocumentVersion.render_file_id).where(
                DocumentVersion.n == 2, DocumentVersion.sent_at.is_not(None)))
            assert (await s.get(File, pk)).keep_reason == "sent_kp"  # type: ignore[union-attr]
        r = await c.post(f"/v1/pending-actions/{p['id']}/result", json={"outcome": "sent"},
                         headers=h)  # fmt: skip
        assert r.json()["repeated"] is True

        # an edit after sending is a new version; the next send asks first
        await patch(c, h, doc_id, 2, [{"op": "replace", "path": "/items/i1/qty", "value": "120"}])
        r = await c.post(f"/v1/documents/{doc_id}/send", json={
            "client_id": str(uuid.uuid4()), "channel": "email", "recipient_name": "Арман"},
            headers=h)  # fmt: skip
        out = r.json()
        assert out["version_n"] == 3 and out["pending_action"]["kind"] == "send_email"
        assert out["resend"]["text"] == "Клиент видел v2. Отправить новую?"
        assert out["hint"] == "Откроется почта — проверьте адрес и нажмите «Отправить»"
        ex = (await c.post(f"/v1/pending-actions/{out['pending_action']['id']}/confirm",
                           json={}, headers=h)).json()["execute"]  # fmt: skip
        assert ex["kind"] == "email" and ex["subject"].startswith("Коммерческое предложение № ")
        # [Нет]: nothing is marked
        r = await c.post(f"/v1/pending-actions/{out['pending_action']['id']}/result",
                         json={"outcome": "not_sent"}, headers=h)  # fmt: skip
        assert r.json()["pending_action"]["status"] == "cancelled_by_user"
        assert (await get_doc(c, h, doc_id))["document"]["sent_version_n"] == 2

        # the frozen version's PDF stays the one sent, even after the profile changed
        calls = len(app.state.ctx.kp_renderer.calls)
        await put_profile(c, h, base_version=1, address="г. Астана, ул. Новая 2")
        r = await c.post(f"/v1/documents/{doc_id}/render", params={"n": 2}, headers=h)
        assert r.json()["file"]["id"] == v2["files"]["pdf"]["id"]
        assert len(app.state.ctx.kp_renderer.calls) == calls
        # a version marked directly (shared from elsewhere); twice changes nothing
        body = {"client_id": str(uuid.uuid4()), "channel": "email"}
        r = await c.post(f"/v1/documents/{doc_id}/versions/3/sent", json=body, headers=h)
        assert r.status_code == 200, r.text
        assert r.json()["document"]["sent_version_n"] == 3 and r.json()["version"]["frozen"]
        assert r.json()["action"]["kind"] == "send_external"
        assert len(app.state.ctx.kp_renderer.calls) == calls  # v3 kept the PDF made for «send»
        r = await c.post(f"/v1/documents/{doc_id}/versions/3/sent",
                         json={**body, "client_id": str(uuid.uuid4())}, headers=h)
        assert r.json()["action"] is None
        r = await c.post(f"/v1/documents/{doc_id}/versions/3/sent", json=body, headers=h)
        assert r.json()["repeated"] is True


# --- drafts ---


async def test_drafts_are_written_edited_and_sent_by_the_person(env9):
    script = W15Script()
    app = await make_app(env9, script)
    async with client(app) as c:
        base = await signed_in(c, BASE)
        r = await c.post("/v1/drafts", json={"client_id": str(uuid.uuid4()),
                                             "request": "напиши Арману"}, headers=base)
        assert r.status_code == 403 and r.json()["code"] == "consent_required"

        h = await signed_in(c)
        script.draft = DraftReply(ok=True, recipient_name="Арман", subject="",
                                  text="Добрый день, Арман! КП будет готово в пятницу.")
        body = {"client_id": str(uuid.uuid4()),
                "request": "напиши Арману, что КП будет в пятницу +7 701 123 45 67"}
        r = await c.post("/v1/drafts", json=body, headers=h)
        assert r.status_code == 201, r.text
        out = r.json()
        d, p = out["draft"], out["pending_action"]
        assert (d["recipient_name"], d["status"], d["review_fields"]) == ("Арман", "draft", [])
        assert d["ai_generated"] and out["labels"]["ai_generated"].startswith("Подготовил")
        assert p["kind"] == "send_whatsapp_text" and p["preview"]["text"] == d["text"]
        assert "701 123 45 67" not in text_of(script.calls["DraftReply"][-1])  # masked
        r = await c.post("/v1/drafts", json=body, headers=h)
        assert r.status_code == 200 and r.json()["repeated"] is True

        # «Изменить»: the open «Да» is replaced by one with the new text
        r = await c.patch(f"/v1/drafts/{d['id']}", json={"text": "Арман, КП будет в пятницу."},
                          headers=h)  # fmt: skip
        new_p = r.json()["pending_action"]
        assert new_p["id"] != p["id"] and new_p["preview"]["text"] == "Арман, КП будет в пятницу."
        r = await c.post(f"/v1/pending-actions/{p['id']}/confirm", json={}, headers=h)
        assert r.status_code == 409  # the old preview cannot be confirmed
        ex = (await c.post(f"/v1/pending-actions/{new_p['id']}/confirm", json={},
                           headers=h)).json()["execute"]  # fmt: skip
        assert ex["kind"] == "whatsapp_text" and ex["file"] is None
        assert ex["wa_url_template"].startswith("https://wa.me/{phone}?text=")
        r = await c.post(f"/v1/pending-actions/{new_p['id']}/result", json={"outcome": "sent"},
                         headers=h)  # fmt: skip
        assert r.json()["draft"]["status"] == "sent" and r.json()["draft"]["sent_at"]
        assert r.json()["action"]["kind"] == "send_external" and not r.json()["action"]["undoable"]
        r = await c.patch(f"/v1/drafts/{d['id']}", json={"text": "x"}, headers=h)
        assert r.status_code == 409 and r.json()["code"] == "draft_closed"

        # an invented number → «Проверьте»; «Не надо» discards
        script.draft = DraftReply(ok=True, recipient_name="", subject="Счёт",
                                  text="Добрый день! Сумма 500 000 ₸.")
        r = await c.post("/v1/drafts", json={"client_id": str(uuid.uuid4()), "channel": "email",
                                             "request": "напиши письмо про оплату"}, headers=h)
        d2 = r.json()["draft"]
        assert d2["review_fields"] == ["text"] and d2["subject"] == "Счёт"
        assert r.json()["pending_action"]["kind"] == "send_email"
        r = await c.delete(f"/v1/drafts/{d2['id']}", headers=h)
        assert r.json()["draft"]["status"] == "discarded"
        script.draft = DraftReply(ok=False, recipient_name="", subject="", text="")
        r = await c.post("/v1/drafts", json={"client_id": str(uuid.uuid4()),
                                             "request": "сколько времени"}, headers=h)
        assert r.status_code == 422 and r.json()["code"] == "draft_empty"
        listed = (await c.get("/v1/drafts", params={"status": "sent"}, headers=h)).json()
        assert [x["id"] for x in listed["drafts"]] == [d["id"]]
        sync = (await c.get("/v1/sync", params={"since": 0, "limit": 500}, headers=h)).json()
        assert {x["id"] for x in sync["drafts"]} == {d["id"], d2["id"]}


# --- «Моя компания» and «Мой прайс» in sync ---


async def test_profile_without_secrets_and_price_list_in_sync(env9):
    app = await make_app(env9, W15Script())
    async with client(app) as c:
        h = await signed_in(c)
        first = await put_profile(c, h, **PROFILE)
        r = await c.post("/v1/price-lists/items", json={
            "client_id": str(uuid.uuid4()), "source": "typed_sequence",
            "items": [{"name": "Щит ЩРН-24", "unit": "шт", "price": "18500"}]}, headers=h)
        assert r.status_code == 201, r.text
        sync = (await c.get("/v1/sync", params={"since": 0, "limit": 500}, headers=h)).json()
        [prof] = sync["company_profile"]
        assert prof["bin_iin"] is None and prof["bin_iin_hint"] == "…" + BIN_SELLER[-4:]
        assert prof["bank"]["iban"] is None and prof["bank"]["iban_hint"] == "…" + IBAN[-4:]
        assert prof["bank"]["bik"] == "TESTKZKA" and prof["complete"] and prof["secrets_masked"]
        assert BIN_SELLER not in str(sync) and IBAN not in str(sync)
        [pl] = sync["price_lists"]
        assert pl["source"] == "typed_sequence"
        [it] = sync["price_list_items"]
        assert (it["name"], it["price"], it["price_list_id"]) == ("Щит ЩРН-24", "18500.00",
                                                                 pl["id"])
        since = sync["next_since"]
        # a price change comes again; the profile's «Отменить» leaves a tombstone
        await c.patch(f"/v1/price-lists/items/{it['id']}", json={
            "client_id": str(uuid.uuid4()), "price": "19000"}, headers=h)
        await undo(c, h, first["action"]["id"])
        sync = (await c.get("/v1/sync", params={"since": since}, headers=h)).json()
        assert [i["price"] for i in sync["price_list_items"]] == ["19000.00"]
        assert {"company_profile"} <= {t["entity"] for t in sync["tombstones"]}


async def test_docx_template_row_matches_the_builder(env9):
    async with env9.maker() as s:
        row = (await s.execute(text(
            "SELECT storage_key, template_hash, fonts_hash FROM doc_templates "
            "WHERE user_id IS NULL AND kind = 'kp' AND engine = 'docx' AND version = 1"))).one()
    assert row == ("builtin:kp_docx_v1", docx_render.template_hash(), docx_render.fonts_hash())


async def test_html_v2_template_row_matches_the_packaged_file(env9):
    from assistant.kp import render

    async with env9.maker() as s:
        row = (await s.execute(text(
            "SELECT storage_key, template_hash, fonts_hash FROM doc_templates "
            "WHERE user_id IS NULL AND kind = 'kp' AND engine = 'html' AND version = 2"))).one()
    assert row == ("builtin:kp_v2", render.template_hash(), render.fonts_hash())


async def test_outgoing_number_and_licence_come_from_the_profile(env9):
    script = W15Script()
    app = await make_app(env9, script)
    async with client(app) as c:
        h = await signed_in(c)
        await put_profile(c, h, **PROFILE, outgoing={"next": 118},
                          license={"number": "00000-TEST", "date": "2020-01-15",
                                   "category": "II категория"})  # fmt: skip
        script.lines = [KpLine(name="Кабель ВВГнг 3х2,5", unit="м", qty="100", ref="1")]
        item = await note(c, h, env9, app, TZ_NOTE)
        doc = (await new_kp(c, h, [item]))["document"]
        assert await run_job(env9, app, doc["id"]) == "done"
        v = (await get_doc(c, h, doc["id"]))["version"]
        year = v["data"]["date"][:4]
        assert v["data"]["outgoing"] == {"number": f"{year}-118-1", "date": v["data"]["date"]}
        prof = (await c.get("/v1/company-profile", headers=h)).json()["profile"]
        assert prof["outgoing"] == {"year": int(year), "next": 119}
        assert prof["license"]["number"] == "00000-TEST"
        await patch(c, h, doc["id"], 1, [
            {"op": "replace", "path": "/items/i1/unit_price", "value": "450"},
            {"op": "replace", "path": "/subject", "value": "на поставку кабеля"}])
        r = await c.post(f"/v1/documents/{doc['id']}/render", headers=h)
        assert r.status_code == 200, r.text
        html = app.state.ctx.kp_renderer.calls[-1]
        for part in (f"Исх. № {year}-118-1 от ", "государственная лицензия № 00000-TEST",
                     "на поставку кабеля", "Будем рады сотрудничеству."):
            assert part in html, part
