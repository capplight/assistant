"""Synthetic Kaspi Gold- and Halyk-style statements and receipts (week 13). Invented people, shops,
accounts and amounts only: no real bank data. The bank's summary lines are written by this file
from its own sums, the way a bank would print them, so the parser's check has something to match.
"""

import random
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal

from tests.expenses.pdfgen import LINE_H, Page, build

ROWS_PER_PAGE = 40


def kzt(v: Decimal, *, plus: bool = True) -> str:
    """«- 2 500,00 ₸» / «+ 150 000,00 ₸» like Kaspi prints it."""
    sign = "-" if v < 0 else ("+" if plus else "")
    whole, frac = f"{abs(v):.2f}".split(".")
    grouped = f"{int(whole):,}".replace(",", " ")
    return f"{sign} {grouped},{frac} ₸".strip()


def plain(v: Decimal) -> str:
    """«-1 250,50» like Halyk prints it."""
    whole, frac = f"{abs(v):.2f}".split(".")
    grouped = f"{int(whole):,}".replace(",", " ")
    return ("-" if v < 0 else "") + f"{grouped},{frac}"


@dataclass
class Row:
    day: date
    amount: Decimal  # signed
    label: str  # Kaspi: Покупка / Пополнение / Перевод / Снятие / Разное; Halyk: description
    details: str = ""
    currency: str = "KZT"  # Halyk: the operation's currency
    orig: Decimal | None = None  # Halyk: the amount in that currency
    fee: Decimal = Decimal("0")


SHOPS = ["MAGNUM CASH&CARRY", "SMALL ДОСТЫК", "АПТЕКА ЖАНАР", "АЗС SINOOIL", "KASPI МАГАЗИН",
         "КОФЕЙНЯ ЗЕРНО", "ГАЛМАРТ АБАЯ", "ТОО ЛЕМАНА ПРО", "YANDEX GO", "АРБУЗ.KZ"]
PEOPLE = ["Айгерим С.", "Ержан Т.", "Мадина К."]


def october_rows(seed: int = 13, n: int = 60) -> list[Row]:
    """A month of a synthetic Kaspi Gold card: purchases with tiyn, top-ups, transfers, one cash
    withdrawal, one refund, a wrapped long description."""
    rnd = random.Random(seed)
    start = date(2026, 10, 1)
    rows = [Row(start, Decimal("250000.00"), "Пополнение", "С Kaspi Депозита")]
    for _ in range(n):
        day = start + timedelta(days=rnd.randrange(0, 31))
        roll = rnd.random()
        if roll < 0.72:
            amt = Decimal(rnd.randrange(150, 4_500_000)) / 100
            rows.append(Row(day, -amt, "Покупка", rnd.choice(SHOPS)))
        elif roll < 0.86:
            amt = Decimal(rnd.randrange(1000, 60000))
            rows.append(Row(day, -amt, "Перевод", rnd.choice(PEOPLE)))
        elif roll < 0.93:
            rows.append(Row(day, Decimal(rnd.randrange(5000, 90000)), "Пополнение",
                            "С карты другого банка"))
        else:
            rows.append(Row(day, -Decimal(rnd.randrange(1, 40)) * 1000, "Снятие", "Банкомат"))
    rows.append(Row(date(2026, 10, 17), Decimal("1890.45"), "Покупка", "KASPI МАГАЗИН"))  # refund
    rows.append(Row(date(2026, 10, 20), Decimal("-12345.67"), "Покупка",
                    "ИП ОЧЕНЬ ДЛИННОЕ НАЗВАНИЕ МАГАЗИНА СТРОИТЕЛЬНЫХ МАТЕРИАЛОВ И ХОЗТОВАРОВ"))
    rows.append(Row(date(2026, 10, 21), Decimal("-0.01"), "Разное", "Проверка карты"))
    rows.sort(key=lambda r: r.day)
    return rows


def kaspi_pdf(rows: list[Row], *, opening: Decimal = Decimal("948210.37"),
              p_from: date = date(2026, 10, 1), p_to: date = date(2026, 10, 31),
              tamper: Decimal | None = None) -> bytes:  # fmt: skip
    """A Kaspi Gold-style statement. `tamper`: added to the printed «Покупки» line (a statement
    whose summary does not match its rows)."""
    groups = {"Пополнения": "Пополнение", "Переводы": "Перевод", "Покупки": "Покупка",
              "Снятия": "Снятие", "Разное": "Разное"}  # fmt: skip
    sums = {title: sum((r.amount for r in rows if r.label == label), Decimal("0"))
            for title, label in groups.items()}  # fmt: skip
    if tamper:
        sums["Покупки"] += tamper
    closing = opening + sum((r.amount for r in rows), Decimal("0"))
    d = lambda x: x.strftime("%d.%m.%y")  # noqa: E731
    pages: list[Page] = []
    page = Page()
    y = 40.0
    for head in ["АО «Kaspi Bank», БИК CASPKZKA, www.kaspi.kz",
                 "ВЫПИСКА",
                 f"по Kaspi Gold за период с {d(p_from)} по {d(p_to)}",
                 "Тестов Тест Тестович",
                 "Номер карты: *0000",
                 "Номер счета: KZ00722C000000000000",
                 "Валюта счета: тенге",
                 f"Доступно на {d(p_to)}: {kzt(closing, plus=False)}",
                 "Краткое содержание операций по карте:"]:
        page.text(40, y, head)
        y += LINE_H
    summary = [(f"Доступно на {d(p_from)}", opening), *sums.items(),
               (f"Доступно на {d(p_to)}", closing)]
    for title, v in summary:
        page.text(40, y, title)
        page.text(200, y, kzt(v))
        y += LINE_H
    y += LINE_H

    def header(p: Page, at: float) -> float:
        for x, name in ((40, "Дата"), (100, "Сумма"), (200, "Операция"), (270, "Детали")):
            p.text(x, at, name)
        return at + LINE_H

    y = header(page, y)
    count = 0
    for r in rows:
        if count and count % ROWS_PER_PAGE == 0:
            page.text(40, 820, f"Страница {len(pages) + 1}")
            pages.append(page)
            page = Page()
            y = header(page, 40.0)
        page.text(40, y, d(r.day))
        page.text(100, y, kzt(r.amount))
        page.text(200, y, r.label)
        words, line = r.details.split(), ""
        for w in words:  # wrap long details inside their column, at words
            if line and len(line) + 1 + len(w) > 45:
                page.text(270, y, line)
                y += LINE_H
                line = w
            else:
                line = f"{line} {w}".strip()
        if line:
            page.text(270, y, line)
        y += LINE_H
        count += 1
    page.text(40, 820, f"Страница {len(pages) + 1}")
    pages.append(page)
    return build(pages)


def halyk_rows() -> list[Row]:
    return [
        Row(date(2026, 10, 2), Decimal("-1250.50"), "Покупка. SMALL ALMATY"),
        Row(date(2026, 10, 3), Decimal("320000.00"), "Зачисление заработной платы"),
        Row(date(2026, 10, 5), Decimal("-5120.37"), "Покупка. STEAM PURCHASE", currency="USD",
            orig=Decimal("-10.00")),
        Row(date(2026, 10, 7), Decimal("-20000.00"), "Перевод на карту Ержан Т.",
            fee=Decimal("-100.00")),
        Row(date(2026, 10, 9), Decimal("-30000.00"), "Снятие наличных ATM HALYK",
            fee=Decimal("-300.00")),
        Row(date(2026, 10, 12), Decimal("-18990.99"), "Оплата. KCELL МОБИЛЬНАЯ СВЯЗЬ"),
        Row(date(2026, 10, 15), Decimal("1250.50"), "Возврат. SMALL ALMATY"),
        Row(date(2026, 10, 28), Decimal("-77777.77"), "Покупка. ТОО МЕБЕЛЬ ЛЮКС АЛМАТЫ"),
    ]


def halyk_pdf(rows: list[Row], *, opening: Decimal = Decimal("100000.00")) -> bytes:
    credit = sum((r.amount for r in rows if r.amount > 0), Decimal("0"))
    debit = sum((r.amount for r in rows if r.amount < 0), Decimal("0"))
    fees = sum((r.fee for r in rows), Decimal("0"))
    closing = opening + credit + debit + fees
    page = Page()
    y = 40.0
    for line in ["АО «Народный Банк Казахстана» (Halyk Bank)",
                 "Выписка по счёту KZ006010000000000000 за период 01.10.2026 - 31.10.2026",
                 "Клиент: Тестова Тест", "Валюта счета: KZT",
                 f"Входящий остаток: {plain(opening)} KZT"]:
        page.text(40, y, line)
        y += LINE_H
    cols = [(20, "Дата"), (62, "Дата"), (104, "Описание"), (300, "Сумма"), (350, "Валюта"),
            (385, "Приход"), (440, "Расход"), (500, "Комиссия")]
    for x, name in cols:
        page.text(x, y, name)
    y += LINE_H
    for r in rows:
        page.text(20, y, r.day.strftime("%d.%m.%Y"))
        page.text(62, y, (r.day + timedelta(days=1)).strftime("%d.%m.%Y"))
        page.text(104, y, r.label[:38])
        page.text(300, y, plain(r.orig if r.orig is not None else r.amount))
        page.text(350, y, r.currency)
        page.text(385, y, plain(r.amount) if r.amount > 0 else "0,00")
        page.text(440, y, plain(r.amount) if r.amount < 0 else "0,00")
        page.text(500, y, plain(r.fee))
        y += LINE_H
    y += LINE_H
    for line in [f"Итого поступлений: {plain(credit)} KZT", f"Итого расходов: {plain(debit)} KZT",
                 f"Итого комиссий: {plain(fees)} KZT", f"Исходящий остаток: {plain(closing)} KZT"]:
        page.text(40, y, line)
        y += LINE_H
    return build([page])


def kaspi_receipt_pdf() -> bytes:
    """A Kaspi-style payment receipt shared from the app (synthetic)."""
    from tests.expenses.pdfgen import text_pdf

    return text_pdf(["Kaspi.kz", "Платеж успешно совершен", "Магазин: ТОО ЦВЕТЫ ТЕСТ",
                     "Сумма: 7 450,00 ₸", "Комиссия: 0,00 ₸", "Дата и время: 03.11.2026 18:42",
                     "№ квитанции: 0000000001", "ИИН/БИН продавца: 000000000000"])
