"""Week 13 «Расходы 2» without a database: bank statement templates and the check against the
bank's own summary (to the tiyn), numbers in documents, the receipt reader's checks, the fiscal QR
allowlist and the SSRF guard of the OFD page reader, repeats. All data synthetic; no network
(httpx MockTransport, a fake resolver)."""

from datetime import date
from decimal import Decimal

import httpx
import pytest

from assistant.expenses import documents, ofd, receipts, repeats, statements
from assistant.expenses.receipts import ReceiptLine, ReceiptReply
from tests.expenses.pdfgen import text_pdf
from tests.expenses.statement_fixtures import (
    halyk_pdf,
    halyk_rows,
    kaspi_pdf,
    kaspi_receipt_pdf,
    october_rows,
)

TODAY = date(2026, 11, 9)
KEYS = {"groceries", "home", "transport", "health", "cafe_gifts", "other"}


# --- statements ---


@pytest.mark.parametrize("seed", [13, 7, 2026])
def test_kaspi_rows_and_totals_match_the_bank_to_the_tiyn(seed: int) -> None:
    rows = october_rows(seed=seed, n=90)
    parsed = statements.parse(kaspi_pdf(rows))
    assert (parsed.bank, parsed.parser, parsed.currency) == ("kaspi_gold", "template", "KZT")
    assert (parsed.period_from, parsed.period_to) == (date(2026, 10, 1), date(2026, 10, 31))
    assert len(parsed.ops) == len(rows)  # several pages, a header on each
    assert parsed.check is not None and parsed.check.ok, parsed.check.lines
    keys = {line["key"] for line in parsed.check.lines}
    assert keys == {"topups", "transfers", "purchases", "withdrawals", "other", "closing"}
    # every amount exactly as written, in order
    assert [o.signed for o in parsed.ops] == [r.amount for r in rows]
    assert sum((o.signed for o in parsed.ops), Decimal(0)) == sum((r.amount for r in rows),
                                                                  Decimal(0))  # fmt: skip


def test_kaspi_kinds_wrapped_details_and_stable_keys() -> None:
    rows = october_rows()
    data = kaspi_pdf(rows)
    a, b = statements.parse(data), statements.parse(data)
    assert [o.key for o in a.ops] == [o.key for o in b.ops]
    assert len({o.key for o in a.ops}) == len(a.ops)
    long = next(o for o in a.ops if o.description.startswith("ИП ОЧЕНЬ"))
    assert long.description.endswith("ХОЗТОВАРОВ") and "СТРОИТЕЛЬНЫХ" in long.description
    refund = next(o for o in a.ops if o.signed == Decimal("1890.45"))
    assert (refund.kind, refund.direction) == ("refund", "refund")
    kinds = {(o.label, o.sign): (o.kind, o.direction) for o in a.ops}
    assert kinds[("Покупка", -1)] == ("purchase", "expense")
    assert kinds[("Перевод", -1)] == ("transfer", "expense")
    assert kinds[("Снятие", -1)] == ("withdrawal", "transfer_own")
    assert kinds[("Пополнение", 1)] == ("topup", "income")


def test_a_summary_that_does_not_match_fails_the_check() -> None:
    parsed = statements.parse(kaspi_pdf(october_rows(), tamper=Decimal("0.01")))
    assert parsed.check is not None and not parsed.check.ok
    bad = [line for line in parsed.check.lines if not line["ok"]]
    assert [line["key"] for line in bad] == ["purchases"]
    assert Decimal(bad[0]["bank"]) - Decimal(bad[0]["ours"]) == Decimal("0.01")


def test_halyk_template_fees_and_foreign_currency() -> None:
    parsed = statements.parse(halyk_pdf(halyk_rows()))
    assert (parsed.bank, parsed.currency) == ("halyk", "KZT")
    assert parsed.check is not None and parsed.check.ok, parsed.check.lines
    fees = [o for o in parsed.ops if o.kind == "fee"]
    assert [o.signed for o in fees] == [Decimal("-100.00"), Decimal("-300.00")]
    usd = next(o for o in parsed.ops if "STEAM" in o.description)
    assert usd.signed == Decimal("-5120.37") and usd.note == "10.00 USD"
    assert next(o for o in parsed.ops if "SMALL" in o.description and o.sign > 0).kind == "refund"
    assert next(o for o in parsed.ops if o.description == "SMALL ALMATY").sign == -1
    assert next(o for o in parsed.ops if o.label.startswith("Снятие")).direction == "transfer_own"


def test_unknown_bank_and_broken_pdf() -> None:
    with pytest.raises(statements.StatementError) as e:
        statements.parse(text_pdf(["ТОО Какой-то банк", "01.10.2026 Покупка 1 000,00"]))
    assert e.value.code == "statement_unknown_format" and e.value.lines
    with pytest.raises(statements.StatementError) as e:
        statements.parse(b"%PDF-1.4 not really")
    assert e.value.code == "statement_unreadable"
    with pytest.raises(statements.StatementError) as e:
        statements.parse(kaspi_pdf([]))
    assert e.value.code == "statement_empty"


# --- numbers in documents ---


def test_amounts_and_days_in_documents() -> None:
    text = "ИТОГО: 12 400,00 ₸\nМолоко 2 x 550,50 = 1 101,00\n1,250.75 USD\nДата 03.11.2026 18:42"
    got = documents.amounts_in(text)
    assert {Decimal("12400.00"), Decimal("550.50"), Decimal("1101.00"),
            Decimal("1250.75")} <= got  # fmt: skip
    assert date(2026, 11, 3) in documents.days_in(text)
    assert documents.signed_amount("- 2 500,00 ₸") == Decimal("-2500.00")
    assert documents.signed_amount("+ 150 000,00 ₸") == Decimal("150000.00")
    assert documents.signed_amount("Покупка 2 500") is None
    assert documents.all_words_in("Magnum", "ТОО MAGNUM CASH&CARRY")
    assert not documents.all_words_in("Small", "ТОО MAGNUM CASH&CARRY")


# --- receipts ---

RECEIPT = ("ТОО «MAGNUM CASH&CARRY»\nБИН 000000000000\nМолоко 2,5% 2 x 550,00 1 100,00\n"
           "Хлеб 250,00\nИТОГО: 1 350,00\nДата: 03.11.2026 18:42")


def reply(**kw) -> ReceiptReply:  # type: ignore[no-untyped-def]
    base = dict(is_receipt=True, total="1350.00", currency="KZT", date="2026-11-03",
                payee="MAGNUM CASH&CARRY", category="groceries",
                lines=[ReceiptLine(name="Молоко 2,5%", qty="2", total="1100.00"),
                       ReceiptLine(name="Хлеб", qty="", total="250.00")], confidence=0.9)
    return ReceiptReply(**{**base, **kw})


def test_receipt_reading_checked_by_code() -> None:
    d = receipts.check_reply(RECEIPT, reply(), today=TODAY, category_keys=KEYS)
    assert d.amount == Decimal("1350.00") and d.spent_on == date(2026, 11, 3)
    assert d.payee == "MAGNUM CASH&CARRY" and d.category_key == "groceries"
    assert d.review == ["amount"]  # R-36: always the amount
    assert [x["total"] for x in d.line_items or []] == ["1100.00", "250.00"]


def test_receipt_numbers_not_on_the_receipt_are_never_taken() -> None:
    d = receipts.check_reply(RECEIPT, reply(total="1500.00"), today=TODAY, category_keys=KEYS)
    assert d.amount is None  # a total the receipt does not show: no expense, the form
    d = receipts.check_reply(RECEIPT, reply(lines=[ReceiptLine(name="Сыр", qty="", total="999")]),
                             today=TODAY, category_keys=KEYS)  # fmt: skip
    assert d.amount == Decimal("1350.00") and d.line_items is None
    d = receipts.check_reply(RECEIPT, reply(lines=[ReceiptLine(name="Молоко", qty="2",
                                                               total="1100.00")]),
                             today=TODAY, category_keys=KEYS)  # fmt: skip
    assert "line_items" in d.review  # the lines do not add up to the total
    d = receipts.check_reply(RECEIPT, reply(date="2026-11-04", payee="Small", category="hack"),
                             today=TODAY, category_keys=KEYS)  # fmt: skip
    assert d.spent_on is None and "spent_on" in d.review
    assert d.payee is None and d.category_key is None
    d = receipts.check_reply(RECEIPT, reply(currency="USD"), today=TODAY, category_keys=KEYS)
    assert d.currency == "KZT"  # no $ on the receipt


def test_rules_read_is_code_first_only() -> None:
    import io

    import pdfplumber

    text = pdfplumber.open(io.BytesIO(kaspi_receipt_pdf())).pages[0].extract_text()
    d = receipts.rules_read(text, TODAY)
    assert d is not None and d.amount == Decimal("7450.00") and d.reader == "rules"
    assert d.spent_on == date(2026, 11, 3) and d.payee == "ТОО ЦВЕТЫ ТЕСТ"
    assert receipts.rules_read("просто текст 500", TODAY) is None


# --- fiscal QR ---

DOMAINS = ofd.DEFAULT_DOMAINS
GOOD = "https://consumer.oofd.kz/?i=1234567890&f=010101012345&s=3400.50&t=20261104T191520"


def test_fiscal_link_read_by_code() -> None:
    f = ofd.parse_link(GOOD, DOMAINS)
    assert (f.domain, f.sign, f.register, f.amount) == ("consumer.oofd.kz", "1234567890",
                                                       "010101012345", Decimal("3400.50"))
    assert f.at is not None and f.at.isoformat() == "2026-11-04T14:15:20+00:00"
    assert f.ref == "ofd:010101012345:1234567890"
    assert ofd.parse_link("http://oofd.kz/ticket?i=1&f=2", DOMAINS).amount is None


@pytest.mark.parametrize("url", [
    "https://oofd.kz.evil.example/?s=1", "https://evil-oofd.kz/?s=1", "https://10.0.0.5/?s=1",
    "https://[::1]/?s=1", "https://consumer.oofd.kz:8443/?s=1", "https://u:p@consumer.oofd.kz/",
    "javascript:alert(1)", "file:///etc/passwd", "https://example.com/?s=100",
])  # fmt: skip
def test_only_allowlisted_ofd_links(url: str) -> None:
    with pytest.raises(ofd.QrError) as e:
        ofd.parse_link(url, DOMAINS)
    assert e.value.code == "qr_not_fiscal"


def _reader(handler, addrs: dict[str, list[str]]) -> ofd.HttpOfdReader:  # type: ignore[no-untyped-def]
    async def resolve(host: str) -> list[str]:
        return addrs.get(host, [])

    return ofd.HttpOfdReader(DOMAINS, resolver=resolve,
                             client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))


async def test_ofd_page_read_pinned_to_a_public_address() -> None:
    seen: list[httpx.Request] = []

    def handler(req: httpx.Request) -> httpx.Response:
        seen.append(req)
        html = "<html><head><script>x()</script></head><body><h1>ТОО ТЕСТ</h1>" \
               "<table><tr><td>ИТОГО</td><td>3 400,50</td></tr></table></body></html>"  # fmt: skip
        return httpx.Response(200, html=html)

    r = _reader(handler, {"consumer.oofd.kz": ["93.184.216.34"]})
    text = await r.read(GOOD)
    assert text is not None and "ТОО ТЕСТ" in text and "3 400,50" in text and "x()" not in text
    assert seen[0].url.host == "93.184.216.34" and seen[0].headers["host"] == "consumer.oofd.kz"


@pytest.mark.parametrize("addr", ["10.1.2.3", "127.0.0.1", "169.254.169.254", "192.168.0.1",
                                  "::1", "fd00::1", "::ffff:10.0.0.1"])  # fmt: skip
async def test_ofd_page_never_from_a_private_address(addr: str) -> None:
    calls: list[httpx.Request] = []
    r = _reader(lambda req: calls.append(req) or httpx.Response(200, html="x"),
                {"consumer.oofd.kz": [addr]})  # fmt: skip
    assert await r.read(GOOD) is None and calls == []


async def test_ofd_redirects_stay_on_the_allowlist() -> None:
    hops: list[str] = []

    def off(req: httpx.Request) -> httpx.Response:
        hops.append(req.headers["host"])
        return httpx.Response(302, headers={"location": "https://evil.example/steal"})

    r = _reader(off, {"consumer.oofd.kz": ["93.184.216.34"], "evil.example": ["93.184.216.35"]})
    assert await r.read(GOOD) is None and hops == ["consumer.oofd.kz"]

    def inside(req: httpx.Request) -> httpx.Response:
        hops.append(req.headers["host"])
        if req.headers["host"] == "consumer.oofd.kz":
            return httpx.Response(301, headers={"location": "https://ofd1.kz/t/1"})
        return httpx.Response(200, html="<p>ИТОГО 3 400,50</p>")

    hops.clear()
    r = _reader(inside, {"consumer.oofd.kz": ["93.184.216.34"], "ofd1.kz": ["93.184.216.36"]})
    assert await r.read(GOOD) == "ИТОГО 3 400,50" and hops == ["consumer.oofd.kz", "ofd1.kz"]


# --- repeats ---


def test_payees_compared_across_alphabets() -> None:
    assert repeats.payees_agree("Магнум", "MAGNUM CASH&CARRY")
    assert repeats.payees_agree(None, "SMALL")
    assert not repeats.payees_agree("SMALL ДОСТЫК", "MAGNUM CASH&CARRY")
    assert repeats.payees_agree("ТОО «Magnum Cash&Carry»", "MAGNUM CASH&CARRY ALMATY")


def test_statement_rows_are_not_sent_for_enrichment() -> None:
    from assistant.db.models import Item
    from assistant.records.enrich import enrichable

    row = Item(text="MAGNUM CASH&CARRY — 2 500 ₸", source_meta={"expense": True,
                                                                "statement_row": True})
    typed = Item(text="Бензин — 5 000 ₸", source_meta={"expense": True})
    assert not enrichable(row) and enrichable(typed)
