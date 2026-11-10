"""КП arithmetic, VAT by date and the sum in words: code only (spec 6.7 step 4, section 9 «КП»)."""

import random
from datetime import date
from decimal import Decimal

import pytest

from assistant.kp import calc, vat, words
from assistant.kp.calc import Line, compute
from assistant.kp.norm import name_norm, numbers_in, parse_decimal, unit_norm

D = Decimal
RATES = [{"rate": "16.00", "from": "2026-01-01"}]


def L(i: int, qty: str, price: str | None, disc: str = "0") -> Line:
    return Line(f"i{i}", D(qty), D(price) if price is not None else None, D(disc))


# --- lines and totals ---


def test_line_is_qty_times_price_and_total_is_the_sum():
    t = compute([L(1, "120", "450.00"), L(2, "40", "2900"), L(3, "4", "18500")],
                vat_mode="none", vat_rate=None)  # fmt: skip
    assert [x.amount for x in t.lines] == [D("54000.00"), D("116000.00"), D("74000.00")]
    assert t.total == t.amount == t.net == D("244000.00") and t.vat == 0
    assert t.complete


def test_half_up_to_the_tiyn():
    t = compute([L(1, "3", "0.335"), L(2, "1", "0.005")], vat_mode="none", vat_rate=None)
    assert [x.amount for x in t.lines] == [D("1.01"), D("0.01")]  # 1.005 → 1.01, 0.005 → 0.01


def test_vat_included_net_plus_vat_is_the_total():
    t = compute([L(1, "500", "427.50")], vat_mode="included", vat_rate=D("16"))
    assert t.total == D("213750.00")
    assert t.vat == D("29482.76")  # 213750 × 16 / 116 = 29482.758…
    assert t.net + t.vat == t.total


def test_vat_on_top_adds_to_the_total():
    t = compute([L(1, "10", "1000")], vat_mode="on_top", vat_rate=D("16"))
    assert (t.net, t.vat, t.total) == (D("10000.00"), D("1600.00"), D("11600.00"))


def test_line_and_document_discounts():
    t = compute([L(1, "500", "450", "5"), L(2, "1", "1000")], vat_mode="none", vat_rate=None,
                discount_total_pct=D("10"))  # fmt: skip
    assert t.lines[0].gross == D("225000.00") and t.lines[0].discount == D("11250.00")
    assert t.lines_sum == D("214750.00")
    assert t.discount_total == D("21475.00") and t.total == D("193275.00")


def test_missing_price_counts_in_nothing_and_blocks_complete():
    t = compute([L(1, "2", "100"), L(2, "4", None)], vat_mode="included", vat_rate=D("16"))
    assert t.lines[1].amount is None and t.missing == 1 and not t.complete
    assert t.total == D("200.00")
    assert t.as_json()["lines"][1]["amount"] is None


@pytest.mark.parametrize("bad", [
    dict(lines=[L(1, "0", "1")], code="kp_qty_invalid"),
    dict(lines=[L(1, "-1", "1")], code="kp_qty_invalid"),
    dict(lines=[L(1, "1", "-5")], code="kp_price_invalid"),
    dict(lines=[L(1, "1", "5", "101")], code="kp_discount_invalid"),
])  # fmt: skip
def test_invalid_input_is_refused(bad):
    with pytest.raises(calc.CalcError) as e:
        compute(bad["lines"], vat_mode="none", vat_rate=None)
    assert e.value.code == bad["code"]


def test_property_totals_hold_on_random_kp():
    rnd = random.Random(14)
    for _ in range(400):
        lines = [L(i, str(rnd.choice([1, 2, 3, 7, 12, 120, 500]) + rnd.choice([0, 0, 0.5])),
                   f"{rnd.randint(1, 900000) / 100:.2f}", str(rnd.choice([0, 0, 5, 12.5])))
                 for i in range(rnd.randint(1, 60))]  # fmt: skip
        mode = rnd.choice(["included", "on_top", "none"])
        doc = D(rnd.choice(["0", "3", "10"]))
        a = compute(lines, vat_mode=mode, vat_rate=D("16"), discount_total_pct=doc)
        b = compute(lines, vat_mode=mode, vat_rate=D("16"), discount_total_pct=doc,
                    rounding="per_line")  # fmt: skip
        assert a.lines_sum == sum(x.amount for x in a.lines)  # type: ignore[misc]
        assert a.amount == a.lines_sum - a.discount_total
        assert a.total >= 0 and a.vat >= 0 and a.net >= 0
        if mode == "included":
            assert a.net + a.vat == a.total == a.amount
        if mode == "on_top":
            assert a.net + a.vat == a.total and a.net == a.amount
        assert abs(a.vat - b.vat) <= D("0.01") * (len(lines) + 1)


# --- VAT by date (Ф-18: 16% confirmed 2026-11-10) ---


def test_rate_comes_from_the_dated_config():
    assert vat.rate_on(RATES, date(2026, 11, 3)) == D("16.00")
    rows = [*RATES, {"rate": "18.00", "from": "2028-01-01"}]
    assert vat.rate_on(rows, date(2027, 12, 31)) == D("16.00")
    assert vat.rate_on(rows, date(2028, 1, 1)) == D("18.00")
    with pytest.raises(vat.VatConfigError):
        vat.rate_on(RATES, date(2025, 12, 31))  # no older rate is guessed


def test_default_mode_follows_vat_payer():
    assert vat.default_mode(True, "included") == "included"
    assert vat.default_mode(None, "on_top") == "on_top"
    assert vat.default_mode(False, "included") == "none"


# --- the sum in words ---


@pytest.mark.parametrize("value,ru,kk", [
    ("0", "Ноль тенге 00 тиын", "Нөл теңге 00 тиын"),
    ("1", "Один тенге 00 тиын", "Бір теңге 00 тиын"),
    ("21", "Двадцать один тенге 00 тиын", "Жиырма бір теңге 00 тиын"),
    ("1000000.01", "Один миллион тенге 01 тиын", "Бір миллион теңге 01 тиын"),
    ("1240000", "Один миллион двести сорок тысяч тенге 00 тиын",
     "Бір миллион екі жүз қырық мың теңге 00 тиын"),
    ("1218500.50", "Один миллион двести восемнадцать тысяч пятьсот тенге 50 тиын",
     "Бір миллион екі жүз он сегіз мың бес жүз теңге 50 тиын"),
    ("2001", "Две тысячи один тенге 00 тиын", "Екі мың бір теңге 00 тиын"),
    ("11000", "Одиннадцать тысяч тенге 00 тиын", "Он бір мың теңге 00 тиын"),
    ("1100", "Одна тысяча сто тенге 00 тиын", "Бір мың бір жүз теңге 00 тиын"),
    ("5000000000", "Пять миллиардов тенге 00 тиын", "Бес миллиард теңге 00 тиын"),
    ("342.99", "Триста сорок два тенге 99 тиын", "Үш жүз қырық екі теңге 99 тиын"),
])  # fmt: skip
def test_amount_in_words(value, ru, kk):
    assert words.amount_in_words(value, "KZT", "ru") == ru
    assert words.amount_in_words(value, "KZT", "kk") == kk


def test_words_other_currency_and_rounding():
    assert words.amount_in_words("100.505", "USD") == "Сто USD 51/100"  # 100.505 → 100.51
    assert words.number_ru(22_000) == "двадцать две тысячи"
    assert words.number_ru(5_000_000) == "пять миллионов"


def test_money_formatting():
    assert calc.format_money(D("1240000")) == "1 240 000 ₸"
    assert calc.format_money(D("427.5")) == "427,50 ₸"
    assert calc.format_amount(D("213750")) == "213 750,00"


# --- names, units, numbers ---


def test_name_norm_and_numbers():
    assert name_norm("Кабель ВВГнг 3х2,5") == name_norm("кабель  ВВГНГ 3x2.5")
    assert name_norm("Кабель ВВГнг 3х2,5") == "кабель ввгнг 3x2.5"
    assert name_norm("Автомат ВА47-29, 16А.") == "автомат ва47 29 16а"
    assert unit_norm("Шт.") == "шт" and unit_norm("кв.м") == "м²" and unit_norm("") is None
    assert numbers_in("Кабель 120 м, 2,5 мм; итого 1 240 000,50") >= {
        D("120"), D("2.5"), D("1240000.50")}
    assert parse_decimal("1 240 000,50") == D("1240000.50") and parse_decimal("12a") is None
