"""Totals of expenses, computed by code only (R-59, spec 6.13). Pure functions, no DB, no model.

- `evaluate(expression)`: the keypad sum («1200+350» → 1550.00). A tokenizer and a fold over `+` /
  `−`, never `eval`. Arithmetic, not phrase parsing: always on (Ф-1 is about phrases).
- `aggregate(rows, group_by=)`: totals per currency and groups. `Decimal`, `ROUND_HALF_UP` to 0.01,
  each currency on its own (no conversion in the MVP). `refund` is subtracted, `income` is its own
  line, `transfer_own` and the service category «Переводы» are in nothing, trashed rows are in
  nothing.
- `period_bounds(kind, day, ...)`: week (Mon–Sun), month, year, all, custom; days are on the
  person's clock (`spent_on`), so a month ends at midnight in Almaty, not UTC.

The phone runs a TS port; both must reproduce docs/spec/vectors/calc.json exactly. Bump
`CALC_VERSION` whenever a result for the same input could change.
"""

import re
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Literal

CALC_VERSION = "calc.v1"
CENT = Decimal("0.01")
AMOUNT_MAX = Decimal("999999999999.99")
EXPRESSION_MAX_CHARS = 200
EXPRESSION_MAX_TERMS = 50
HOME_CURRENCY = "KZT"


class CalcError(ValueError):
    """`code`: expression_invalid | amount_not_positive | amount_too_large."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def money(value: Decimal | int | str) -> Decimal:
    return Decimal(value).quantize(CENT, rounding=ROUND_HALF_UP)


_SPACES = re.compile(r"[\s   ]+")
_TOKEN = re.compile(r"(\d+(?:[.,]\d*)?|[.,]\d+)|([+\-−–])")


@dataclass(frozen=True)
class Evaluated:
    amount: Decimal
    canonical: str  # «1200+350», «99.9-10»: digits, «.», «+», «-»
    terms: int


def evaluate(expression: str) -> Evaluated:
    """The keypad sum. Digits, one «,» or «.» per number (at most 2 decimals), «+» and «-» / «−»
    between numbers. A trailing operator is ignored (the person pressed «+» then «Записать»). The
    result must be > 0 and fit numeric(14, 2)."""
    raw = _SPACES.sub("", expression or "")
    if not raw or len(raw) > EXPRESSION_MAX_CHARS:
        raise CalcError("expression_invalid")
    while raw and raw[-1] in "+-−–":
        raw = raw[:-1]
    pos = 0
    total = Decimal(0)
    sign = 1
    want_number = True
    terms = 0
    parts: list[str] = []
    while pos < len(raw):
        m = _TOKEN.match(raw, pos)
        if m is None:
            raise CalcError("expression_invalid")
        number, op = m.group(1), m.group(2)
        if want_number:
            if number is None:
                raise CalcError("expression_invalid")  # «+5», «5++3»
            text = number.replace(",", ".")
            if text.endswith("."):
                text = text[:-1]
            if text.startswith("."):
                text = "0" + text
            if "." in text and len(text.split(".")[1]) > 2:
                raise CalcError("expression_invalid")
            try:
                value = Decimal(text)
            except InvalidOperation as exc:
                raise CalcError("expression_invalid") from exc
            total += value if sign > 0 else -value
            terms += 1
            if terms > EXPRESSION_MAX_TERMS:
                raise CalcError("expression_invalid")
            parts.append(_canon_number(value))
            want_number = False
        else:
            if op is None:
                raise CalcError("expression_invalid")
            sign = 1 if op == "+" else -1
            parts.append("+" if sign > 0 else "-")
            want_number = True
        pos = m.end()
    if terms == 0:
        raise CalcError("expression_invalid")
    amount = money(total)
    if amount <= 0:
        raise CalcError("amount_not_positive")
    if amount > AMOUNT_MAX:
        raise CalcError("amount_too_large")
    return Evaluated(amount, "".join(parts), terms)


def _canon_number(value: Decimal) -> str:
    text = format(value, "f")
    if "." in text:
        text = text.rstrip("0").rstrip(".")
    return text or "0"


# --- totals ---


@dataclass(frozen=True)
class Row:
    """What a total looks at, one expense."""

    id: str
    amount: Decimal
    currency: str
    direction: str  # expense | income | refund | transfer_own
    spent_on: date
    category: str | None = None  # the group key of `category`: a category id (str) or None
    service: bool = False  # the category is «Переводы»
    payee: str | None = None
    method: str | None = None
    review: bool = False  # «Проверьте» is still on its amount
    deleted: bool = False


@dataclass
class Total:
    currency: str
    expense: Decimal = Decimal(0)
    refund: Decimal = Decimal(0)
    income: Decimal = Decimal(0)
    count: int = 0

    @property
    def total(self) -> Decimal:
        return money(self.expense - self.refund)


@dataclass
class Group:
    key: str | None
    currency: str
    total: Decimal = Decimal(0)
    count: int = 0


@dataclass
class Result:
    totals: list[Total] = field(default_factory=list)
    groups: list[Group] = field(default_factory=list)
    review_count: int = 0
    basis: list[str] = field(default_factory=list)
    calc_version: str = CALC_VERSION


GROUP_BY = ("category", "month", "payee", "method")


def _group_key(row: Row, group_by: str) -> str | None:
    if group_by == "category":
        return row.category
    if group_by == "month":
        return row.spent_on.strftime("%Y-%m")
    if group_by == "payee":
        return " ".join(row.payee.split()) if row.payee else None
    return row.method


def counted(row: Row) -> bool:
    """In the spend: expenses and refunds, not trashed, not a move between own accounts."""
    return (not row.deleted and not row.service
            and row.direction in ("expense", "refund"))  # fmt: skip


def currency_order(code: str) -> tuple[int, str]:
    return (0 if code == HOME_CURRENCY else 1, code)


def aggregate(rows: Iterable[Row], *, group_by: str | None = None) -> Result:
    if group_by is not None and group_by not in GROUP_BY:
        raise ValueError("group_by")
    totals: dict[str, Total] = {}
    groups: dict[tuple[str | None, str], Group] = {}
    out = Result()
    for row in rows:
        if row.deleted or row.service or row.direction == "transfer_own":
            continue
        amount = money(row.amount)
        t = totals.setdefault(row.currency, Total(row.currency))
        if row.direction == "income":
            t.income += amount
            continue
        if row.direction == "refund":
            t.refund += amount
        elif row.direction == "expense":
            t.expense += amount
        else:
            continue
        t.count += 1
        out.basis.append(row.id)
        if row.review:
            out.review_count += 1
        if group_by is not None:
            key = _group_key(row, group_by)
            g = groups.setdefault((key, row.currency), Group(key, row.currency))
            g.total += amount if row.direction == "expense" else -amount
            g.count += 1
    for t in totals.values():
        t.expense, t.refund, t.income = money(t.expense), money(t.refund), money(t.income)
    out.totals = sorted(totals.values(), key=lambda t: currency_order(t.currency))
    for g in groups.values():
        g.total = money(g.total)
    out.groups = sorted(groups.values(),
                        key=lambda g: (currency_order(g.currency), -g.total,
                                       g.key is None, g.key or ""))  # fmt: skip
    return out


# --- periods ---

PERIODS = ("week", "month", "year", "all", "custom")
PeriodStr = Literal["week", "month", "year", "all", "custom"]
GroupByStr = Literal["category", "month", "payee", "method"]


def period_bounds(kind: str, day: date, *, start: date | None = None,
                  end: date | None = None) -> tuple[date | None, date | None]:  # fmt: skip
    """Inclusive (from, to) on the person's clock. `all` = (None, None)."""
    if kind == "week":
        first = day - timedelta(days=day.weekday())
        return first, first + timedelta(days=6)
    if kind == "month":
        first = day.replace(day=1)
        nxt = (first + timedelta(days=32)).replace(day=1)
        return first, nxt - timedelta(days=1)
    if kind == "year":
        return day.replace(month=1, day=1), day.replace(month=12, day=31)
    if kind == "all":
        return None, None
    if kind == "custom":
        if start is None or end is None or end < start:
            raise ValueError("custom period needs from <= to")
        return start, end
    raise ValueError("period")


def in_period(spent_on: date, bounds: tuple[date | None, date | None]) -> bool:
    lo, hi = bounds
    return (lo is None or spent_on >= lo) and (hi is None or spent_on <= hi)


# --- words for people ---

SYMBOLS = {"KZT": "₸", "USD": "$", "RUB": "₽", "EUR": "€", "KGS": "сом"}


def format_money(amount: Decimal, currency: str) -> str:
    """«5 000 ₸», «1 550,50 ₸», «120 $». Decimals only when there are some."""
    value = money(amount)
    sign = "−" if value < 0 else ""
    whole, _, frac = format(abs(value), "f").partition(".")
    groups = []
    while len(whole) > 3:
        groups.insert(0, whole[-3:])
        whole = whole[:-3]
    groups.insert(0, whole)
    text = " ".join(groups)
    if frac and frac != "00":
        text += "," + frac
    return f"{sign}{text} {SYMBOLS.get(currency, currency)}"
