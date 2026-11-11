"""Week 15 КП pure parts: the phrase-edit checks (the model never computes, never invents a price
or a name), the DOCX file (real python-docx: nothing native), the send helpers and drafts.
Synthetic data only, no network, no database."""

import io
from decimal import Decimal

from docx import Document as Docx

from assistant.db.models_tasks import PendingAction
from assistant.kp import calc, docx_render, edit, patch, send
from assistant.kp.edit import KpEditOp, KpEditReply
from tests.kp.test_kp_unit import _context

DATA = {"number": "КП-2026-001", "date": "2026-11-10", "currency": "KZT",
        "vat": {"mode": "included"}, "discount_total_pct": "0",
        "client": {"name": "ТОО «Тест»", "contact": "Ерлан"},
        "terms": {"payment": "100% предоплата", "delivery": "5 рабочих дней",
                  "warranty": None, "validity_days": 10},
        "text_blocks": {"intro": None, "outro": None},
        "items": [{"id": "i1", "name": "Кабель ВВГнг 3х2,5", "unit": "м", "qty": "100",
                   "unit_price": "450.00", "discount_pct": "0", "price_source": "manual"},
                  {"id": "i2", "name": "Доставка", "unit": "рейс", "qty": "1",
                   "unit_price": "15000.00", "discount_pct": "0",
                   "price_source": "manual"}]}  # fmt: skip
SPACES = str.maketrans({" ": " ", " ": " "})


def op(kind: str, path: str, value: str = "", **kw: str) -> KpEditOp:
    return KpEditOp(op=kind, path=path, value=value, name=kw.get("name", ""),  # type: ignore[arg-type]
                    unit=kw.get("unit", ""), qty=kw.get("qty", ""),
                    unit_price=kw.get("unit_price", ""), volume=kw.get("volume", ""))


def check(phrase: str, *ops: KpEditOp) -> edit.Checked:
    return edit.check_ops(KpEditReply(understood=True, ops=list(ops)), DATA, phrase)


def total_after(c: edit.Checked) -> str:
    data, _, _ = patch.apply_patch(DATA, c.ops)
    t = calc.compute(calc.lines_of(data["items"]), vat_mode="included", vat_rate=Decimal("16"),
                     discount_total_pct=Decimal(data["discount_total_pct"]))  # fmt: skip
    return calc.fmt(t.total)


def test_said_numbers_apply_and_code_computes():
    c = check("скидка 5% на всё", op("replace", "/discount_total_pct", "5"))
    assert c.ops == [{"op": "replace", "path": "/discount_total_pct", "value": "5"}]
    assert total_after(c) == "57000.00"
    c = check("скидка 5% на всё", op("replace", "/items/i1/discount_pct", "5"),
              op("replace", "/items/i2/discount_pct", "5"))
    assert not c.refused and total_after(c) == "57000.00"
    c = check("срок 7 дней", op("replace", "/terms/validity_days", "7"))
    assert c.ops[0]["value"] == 7
    c = check("убери доставку", op("remove", "/items/i2"))
    assert total_after(c) == "45000.00"
    c = check("перенеси дату на 15 ноября", op("replace", "/date", "2026-11-15"))
    assert not c.refused


def test_computed_or_invented_numbers_are_refused_whole():
    c = check("подними цену кабеля на 10%", op("replace", "/items/i1/unit_price", "495"))
    assert c.refused == [{"path": "/items/i1/unit_price", "reason": "number_not_said"}]
    assert c.ops == [] and c.message == edit.TEXT_NUMBER
    # one bad op refuses all: nothing half-applied
    c = check("убери доставку и скидка 10%", op("remove", "/items/i2"),
              op("replace", "/discount_total_pct", "15"))
    assert c.ops == [] and c.refused[0]["path"] == "/discount_total_pct"
    c = check("оплата частями", op("replace", "/terms/payment", "50% предоплата, 50% после"))
    assert c.refused[0]["reason"] == "number_not_said"
    c = check("дата 15", op("replace", "/date", "2026-11-16"))
    assert c.refused[0]["reason"] == "number_not_said"


def test_new_lines_need_said_words_and_have_no_invented_price():
    c = check("добавь доставку", op("add", "/items/-", name="Доставка до объекта", qty="1"))
    assert c.refused[0]["reason"] == "name_not_said"  # «до объекта» was not said
    c = check("добавь доставку", op("add", "/items/-", name="Доставка", unit="рейс"))
    assert c.ops == [{"op": "add", "path": "/items/-", "value": {
        "name": "Доставка", "unit": "рейс", "qty": "1", "unit_price": None}}]
    data, _, _ = patch.apply_patch(DATA, c.ops)
    assert data["items"][-1]["price_source"] == "missing"
    c = check("добавь монтаж", op("add", "/items/-", name="Монтаж", unit_price="20000"))
    assert c.refused[0]["reason"] == "number_not_said"
    c = check("добавь монтаж 20000", op("add", "/items/-", name="Монтаж", unit_price="20000"))
    data, _, _ = patch.apply_patch(DATA, c.ops)
    assert data["items"][-1]["price_source"] == "manual"
    assert edit.name_said("Доставка", "добавь доставку") and not edit.name_said("Унитаз", "кабель")


def test_a_said_lump_sum_line_and_volume():
    c = check("добавь пусконаладку 500000 на 1 здание",
              op("add", "/items/-", name="Пусконаладка", volume="1 здание", unit_price="500000"))
    assert c.ops[0]["value"]["kind"] == "lump" and not c.refused
    c = check("добавь пусконаладку на 2 здания",
              op("add", "/items/-", name="Пусконаладка", volume="3 здания"))
    assert c.refused[0]["reason"] == "number_not_said"


def test_tap_only_and_unknown_paths_are_refused():
    for path in ("/number", "/client/bin", "/totals/total", "/items/i9/qty", "/items/i1/amount"):
        c = check("номер 5", op("replace", path, "5"))
        assert c.refused == [{"path": path, "reason": "path_not_allowed"}], path


def test_the_listing_has_no_sums_and_the_phrase_is_data():
    inputs = edit.model_inputs(DATA, "скидка 5%")
    kp = inputs.untrusted[0].text
    assert "i1: Кабель ВВГнг 3х2,5 | unit м | qty 100 | price 450.00" in kp
    assert "60000" not in kp and "total" not in kp.lower()
    assert [u.label for u in inputs.untrusted] == ["kp", "request"]


# --- DOCX ---


def test_docx_has_the_same_numbers_and_the_single_ai_rule():
    raw = docx_render.build_docx(_context(langs=("ru", "kk")))
    assert raw == docx_render.build_docx(_context(langs=("ru", "kk")))  # deterministic
    word = Docx(io.BytesIO(raw))
    body = "\n".join([p.text for p in word.paragraphs] + [
        c.text for t in word.tables for r in t.rows for c in r.cells]).translate(SPACES)
    for part in ("ТОВАРИЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ", "«Свет-Монтаж»",
                 "КОММЕРЧЕСКОЕ ПРЕДЛОЖЕНИЕ № КП-2026-001", "4 500,00", "22 075,00",
                 "в том числе НДС 16% — 3 044,83 ₸", "Скидка",
                 "Двадцать две тысячи семьдесят пять тенге 00 тиын",
                 "Жиырма екі мың жетпіс бес теңге 00 тиын", "ТОО «Қазақ Құрылыс»", "Директор"):
        assert part in body, part
    assert "Подготовил помощник" not in body
    cp = word.core_properties
    assert cp.subject == cp.keywords == cp.comments == "Подготовлено с помощью ИИ"
    assert cp.created.isoformat().startswith("2026-11-10T08:00")
    visible = docx_render.build_docx(_context(visible="Подготовил помощник (ИИ) — проверьте"))
    word = Docx(io.BytesIO(visible))
    assert any("Подготовил помощник (ИИ)" in p.text for p in word.paragraphs)
    assert word.styles["Normal"].font.name == "Arial"


# --- sending, drafts ---


def test_cover_message_hint_and_execute_params():
    totals = {"total": "1218500.00"}
    text = send.cover_message(DATA, totals, "Ерлан").translate(SPACES)
    assert text == ("Добрый день, Ерлан! Направляю коммерческое предложение № КП-2026-001 на "
                    "сумму 1 218 500 ₸.")
    assert send.cover_message({}, {}, None) == "Добрый день! Направляю коммерческое предложение."
    assert send.hint("whatsapp", None) == "Откроется WhatsApp — выберите нужный чат и нажмите ➤"
    p = PendingAction(kind="send_whatsapp_file", preview={
        "message": "Добрый день!", "hint": "h", "subject": "s",
        "file": {"url": "/v1/documents/x/files/y", "name": "КП_v1.pdf", "mime": "application/pdf"}})
    ex = send.execute_params(p)
    assert ex["kind"] == "share_file" and ex["file"]["name"] == "КП_v1.pdf"
    assert ex["wa_url_template"] == ("https://wa.me/{phone}?text=%D0%94%D0%BE%D0%B1%D1%80%D1%8B"
                                     "%D0%B9%20%D0%B4%D0%B5%D0%BD%D1%8C%21")
    p2 = PendingAction(kind="send_whatsapp_text", preview={"text": "Привет"})
    assert send.execute_params(p2)["kind"] == "whatsapp_text"


def test_draft_numbers_not_in_the_request_or_facts_are_review():
    ok = send.DraftReply(ok=True, recipient_name="Арману", subject="", text="КП будет в пятницу.")
    assert send.check_draft(ok, "напиши Арману", "")["review_fields"] == []
    bad = send.DraftReply(ok=True, recipient_name="", subject="", text="Сумма 500 000 ₸.")
    assert send.check_draft(bad, "напиши про оплату", "")["review_fields"] == ["text"]
    assert send.check_draft(bad, "напиши про оплату", "сумма КП: 500 000 ₸")[
        "review_fields"] == []
    assert send.check_draft(send.DraftReply(ok=False, recipient_name="", subject="", text="x"),
                            "?", "") is None


# --- the layout of the founder's father's real КП (structure only; synthetic values) ---

FATHER_PROFILE = {
    "name": "Тест-Инжиниринг", "legal_form": "too", "bin_iin": "123456789013",
    "address": "г. Алматы, ул. Тестовая, 10, офис 5",
    "bank": {"iban": "KZ86125KZT5004100100", "bank": "АО «Тестбанк»", "bik": "TESTKZKA",
             "kbe": "17"},
    "contacts": {"phone": "+7 700 000 00 02", "email": "office@example.kz"},
    "signer": {"name": "Петров П. П.", "title": "Директор"},
    "license": {"number": "00000-TEST", "date": "2020-01-15", "category": "II категория"},
}  # fmt: skip
FATHER_DATA = {
    "number": "7", "date": "2026-10-29", "currency": "KZT", "vat": {"mode": "none"},
    "discount_total_pct": "0", "outgoing": {"number": "2026-118-1", "date": "2026-10-29"},
    "subject": "на монтаж систем пожарной сигнализации",
    "client": {"name": "ТОО «Тестовый Заказчик»"},
    "terms": {"validity_days": 60, "conditions": [
        "Стоимость рассчитана на 1 здание, материалы заказчика.",
        "Сроки — по графику производства работ."]},
    "text_blocks": {"intro": "Объект: «Тестовый комплекс», г. Алматы.", "outro": None},
    "items": [{"id": "i1", "kind": "lump", "name": "Монтаж систем пожарной сигнализации",
               "volume": "1 здание", "qty": "1", "unit_price": "38000000.00",
               "discount_pct": "0", "price_source": "manual"},
              {"id": "i2", "kind": "lump", "name": "Техническое сопровождение",
               "volume": "на срок работ (40 дней)", "qty": "1", "unit_price": "635000.00",
               "discount_pct": "0", "price_source": "manual"}],
}  # fmt: skip


def _father_context() -> dict:
    from assistant.kp import render

    totals = calc.compute(calc.lines_of(FATHER_DATA["items"]), vat_mode="none",
                          vat_rate=None).as_json()  # fmt: skip
    return render.build_context(data=FATHER_DATA, totals=totals, profile=FATHER_PROFILE,
                                images={"logo": None, "signature": None, "stamp": None},
                                created_at="2026-10-29T05:00:00+00:00", word_langs=["ru"],
                                ai_metadata="Подготовлено с помощью ИИ", visible_label=None,
                                valid_until=None)  # fmt: skip


FATHER_PARTS = (
    "ТОВАРИЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ", "«Тест-Инжиниринг»",
    "г. Алматы, ул. Тестовая, 10, офис 5",
    "БИН 123456789013, ИИК KZ86125KZT5004100100 в АО «Тестбанк», БИК TESTKZKA, Кбе 17",
    "Исх. № 2026-118-1 от 29.10.2026 г.", "ТОО «Тестовый Заказчик»",
    "КОММЕРЧЕСКОЕ ПРЕДЛОЖЕНИЕ № 7", "на монтаж систем пожарной сигнализации",
    "ТОО «Тест-Инжиниринг», государственная лицензия № 00000-TEST от 15.01.2020 г., II категория.",
    "Объём", "Стоимость, ₸", "1 здание", "на срок работ (40 дней)", "38 000 000,00",
    "ИТОГО без НДС", "38 635 000,00",
    "Общая стоимость: 38 635 000 ₸ (Тридцать восемь миллионов шестьсот тридцать пять тысяч тенге "
    "00 тиын), без НДС.",
    "Условия:",
    "– Цены указаны в тенге без НДС, ТОО «Тест-Инжиниринг» не является плательщиком НДС.",
    "– Стоимость рассчитана на 1 здание, материалы заказчика.",
    "– Предложение действительно 60 календарных дней.", "Будем рады сотрудничеству.",
    "Директор ТОО «Тест-Инжиниринг»", "Петров П. П.", "моб.: +7 700 000 00 02",
    "e-mail: office@example.kz",
)  # fmt: skip


def test_lump_sum_lines_are_summed_by_code_without_qty_times_price():
    t = calc.compute(calc.lines_of(FATHER_DATA["items"]), vat_mode="none", vat_rate=None)
    assert calc.fmt(t.total) == "38635000.00" and t.complete and t.vat == 0
    mixed = [*FATHER_DATA["items"], {"id": "i3", "qty": "3", "unit_price": "100"}]
    assert calc.fmt(calc.compute(calc.lines_of(mixed), vat_mode="none",
                                 vat_rate=None).total) == "38635300.00"  # fmt: skip
    data, changed, _ = patch.apply_patch(FATHER_DATA, [
        {"op": "add", "path": "/items/-", "value": {"kind": "lump", "name": "Пусконаладка",
                                                    "volume": "1 здание", "unit_price": "500000"}},
        {"op": "replace", "path": "/items/i2/volume", "value": "на срок работ (45 дней)"},
        {"op": "replace", "path": "/outgoing/number", "value": "2026-118-2"},
        {"op": "replace", "path": "/terms/conditions", "value": ["Материалы заказчика."]}])
    new = data["items"][-1]
    assert (new["kind"], new["qty"], new["unit"], new["unit_price"]) == ("lump", "1", None,
                                                                         "500000.00")
    assert data["outgoing"]["number"] == "2026-118-2"
    assert data["terms"]["conditions"] == ["Материалы заказчика."]
    assert "/items/i2/volume" in changed
    import pytest

    with pytest.raises(patch.PatchError):  # a lump sum has no quantity
        patch.apply_patch(FATHER_DATA, [{"op": "replace", "path": "/items/i1/qty", "value": "2"}])


def test_pdf_and_docx_follow_the_fathers_layout():
    from assistant.kp import render

    ctx = _father_context()
    html = render.render_html(ctx).translate(SPACES)
    for part in FATHER_PARTS:
        assert part in html, part
    assert "<th>Цена" not in html  # lump sums: 4 columns
    word = Docx(io.BytesIO(docx_render.build_docx(ctx)))
    body = "\n".join([p.text for p in word.paragraphs] + [
        c.text for t in word.tables for r in t.rows for c in r.cells]).translate(SPACES)
    for part in FATHER_PARTS:
        assert part in body, part
    assert [c.text for c in word.tables[0].rows[0].cells] == ["№", "Наименование", "Объём",
                                                              "Стоимость, ₸"]


def test_outgoing_number_is_year_sequence_index():
    from datetime import date

    from assistant.db.models_kp import CompanyProfile
    from assistant.kp import profile

    p = CompanyProfile(outgoing={"next": 118})
    assert profile.take_outgoing(p, date(2026, 10, 29), 1) == "2026-118-1"
    assert profile.take_outgoing(p, date(2026, 10, 30), 2) == "2026-119-1"
    assert profile.take_outgoing(p, date(2027, 1, 5), 3) == "2027-1-1"  # a new year starts at 1
    assert profile.take_outgoing(None, date(2026, 1, 2), 14) == "2026-14-1"
    assert profile.clean_change({"license": {"number": "1", "date": "2020-01-15"},
                                 "outgoing": {"next": 118}}).values["outgoing"] == {"next": 118}
