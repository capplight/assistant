"""Sums of a КП, computed by code only (decision №7, R-27, spec 6.7 step 4). Pure functions: no DB,
no model, no float. The model gives data (names, units, quantities as written) and at most picks a
price reference; every number of the КП that is a result comes from here.

Rules (`CALC_VERSION` = "kp-calc.v1"; bump it whenever a result for the same input could change):
- Money: `Decimal`, `ROUND_HALF_UP` to 0.01 at every step that makes a printed number.
- A line: `gross = qty × unit_price`, `discount = gross × discount_pct / 100`, `amount = gross −
  discount` (each rounded). A line without a price (`missing`) has no amount, counts in nothing,
  and makes the КП `complete = false` (the PDF is not made until it gets a price).
- `lines_sum = Σ amount`; the КП's own discount `discount_total = lines_sum × pct / 100`;
  `amount = lines_sum − discount_total` = what the prices add up to.
- VAT (`vat.mode`, rate from the dated config, `vat.py`):
  - `none` («без НДС»): `vat = 0`, `net = total = amount`.
  - `on_top` («сверху»: prices are without VAT): `vat = amount × r / 100`, `net = amount`,
    `total = amount + vat`.
  - `included` («в сумме»: prices include VAT): `vat = amount × r / (100 + r)`, `net = amount −
    vat`, `total = amount` (so `net + vat = total` exactly).
  - `rounding = per_line`: the VAT of each line is rounded, then summed; the КП's own discount then
    takes its VAT share off (rounded once). `on_total` (default): VAT once on `amount`. The two
    differ by at most 0.01 × (lines + 1).
"""

from collections.abc import Iterable
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Literal

from assistant.kp.norm import MONEY_MAX, QTY_MAX

CALC_VERSION = "kp-calc.v1"
CENT = Decimal("0.01")
HUNDRED = Decimal(100)
VAT_MODES = ("included", "on_top", "none")
ROUNDINGS = ("on_total", "per_line")
VatMode = Literal["included", "on_top", "none"]


class CalcError(ValueError):
    """`code`: kp_qty_invalid | kp_price_invalid | kp_discount_invalid | kp_vat_invalid |
    kp_total_too_large."""

    def __init__(self, code: str, line: str | None = None) -> None:
        super().__init__(code)
        self.code, self.line = code, line


def money(value: Decimal | int | str) -> Decimal:
    return Decimal(value).quantize(CENT, rounding=ROUND_HALF_UP)


def fmt(value: Decimal | None) -> str | None:
    return None if value is None else f"{money(value):.2f}"


@dataclass(frozen=True)
class Line:
    id: str
    qty: Decimal
    unit_price: Decimal | None  # None = missing («укажите цену»)
    discount_pct: Decimal = Decimal(0)


@dataclass(frozen=True)
class LineTotal:
    id: str
    gross: Decimal | None
    discount: Decimal | None
    amount: Decimal | None
    vat: Decimal | None  # per_line only


@dataclass(frozen=True)
class Totals:
    lines: tuple[LineTotal, ...]
    lines_sum: Decimal
    discount_total: Decimal
    amount: Decimal
    net: Decimal
    vat: Decimal
    total: Decimal
    vat_mode: str
    vat_rate: Decimal | None  # None for `none`
    rounding: str
    priced: int
    missing: int

    @property
    def complete(self) -> bool:
        return self.missing == 0 and self.priced > 0

    def as_json(self) -> dict[str, Any]:
        """`document_versions.totals` and the API: money as text with two places."""
        return {
            "calc_version": CALC_VERSION,
            "lines": [{"id": t.id, "gross": fmt(t.gross), "discount": fmt(t.discount),
                       "amount": fmt(t.amount), "vat": fmt(t.vat)} for t in self.lines],
            "lines_sum": fmt(self.lines_sum), "discount_total": fmt(self.discount_total),
            "amount": fmt(self.amount), "net": fmt(self.net), "vat": fmt(self.vat),
            "total": fmt(self.total), "vat_mode": self.vat_mode,
            "vat_rate": fmt(self.vat_rate) if self.vat_rate is not None else None,
            "rounding": self.rounding, "priced": self.priced, "missing": self.missing,
            "complete": self.complete,
        }  # fmt: skip


def _pct(value: Decimal, code: str, line: str | None = None) -> Decimal:
    if not value.is_finite() or value < 0 or value > HUNDRED:
        raise CalcError(code, line)
    return value


def _vat_part(amount: Decimal, mode: str, rate: Decimal) -> Decimal:
    if mode == "on_top":
        return money(amount * rate / HUNDRED)
    if mode == "included":
        return money(amount * rate / (HUNDRED + rate))
    return Decimal("0.00")


def compute(lines: Iterable[Line], *, vat_mode: str, vat_rate: Decimal | None,
            rounding: str = "on_total",
            discount_total_pct: Decimal = Decimal(0)) -> Totals:  # fmt: skip
    if vat_mode not in VAT_MODES or rounding not in ROUNDINGS:
        raise CalcError("kp_vat_invalid")
    rate: Decimal | None = None
    if vat_mode != "none":
        if vat_rate is None:
            raise CalcError("kp_vat_invalid")
        rate = _pct(Decimal(vat_rate), "kp_vat_invalid")
    doc_pct = _pct(Decimal(discount_total_pct), "kp_discount_invalid")
    out: list[LineTotal] = []
    lines_sum = Decimal("0.00")
    line_vat_sum = Decimal("0.00")
    priced = missing = 0
    for ln in lines:
        qty = Decimal(ln.qty)
        if not qty.is_finite() or qty <= 0 or qty > QTY_MAX:
            raise CalcError("kp_qty_invalid", ln.id)
        pct = _pct(Decimal(ln.discount_pct), "kp_discount_invalid", ln.id)
        if ln.unit_price is None:
            missing += 1
            out.append(LineTotal(ln.id, None, None, None, None))
            continue
        price = Decimal(ln.unit_price)
        if not price.is_finite() or price < 0 or price > MONEY_MAX:
            raise CalcError("kp_price_invalid", ln.id)
        gross = money(qty * price)
        discount = money(gross * pct / HUNDRED)
        amount = gross - discount
        vat = None
        if rounding == "per_line" and rate is not None:
            vat = _vat_part(amount, vat_mode, rate)
            line_vat_sum += vat
        lines_sum += amount
        priced += 1
        out.append(LineTotal(ln.id, gross, discount, amount, vat))
    discount_total = money(lines_sum * doc_pct / HUNDRED)
    amount = lines_sum - discount_total
    if rate is None:
        vat = Decimal("0.00")
    elif rounding == "per_line":
        vat = line_vat_sum - _vat_part(discount_total, vat_mode, rate)
    else:
        vat = _vat_part(amount, vat_mode, rate)
    if vat_mode == "on_top":
        net, total = amount, amount + vat
    elif vat_mode == "included":
        net, total = amount - vat, amount
    else:
        net, total = amount, amount
    if total > MONEY_MAX:
        raise CalcError("kp_total_too_large")
    return Totals(lines=tuple(out), lines_sum=lines_sum, discount_total=discount_total,
                  amount=amount, net=net, vat=vat, total=total, vat_mode=vat_mode,
                  vat_rate=money(rate) if rate is not None else None, rounding=rounding,
                  priced=priced, missing=missing)  # fmt: skip


def lines_of(items: Iterable[dict[str, Any]]) -> list[Line]:
    """`document_versions.data.items` → calc lines (values are decimal strings)."""
    out = []
    for it in items:
        price = it.get("unit_price")
        out.append(Line(id=str(it["id"]), qty=Decimal(str(it["qty"])),
                        unit_price=Decimal(str(price)) if price not in (None, "") else None,
                        discount_pct=Decimal(str(it.get("discount_pct") or "0"))))  # fmt: skip
    return out


def format_money(value: Decimal | str, currency: str = "KZT") -> str:
    """«1 240 000 ₸», «1 240 000,50 ₸» (narrow no-break space between thousands)."""
    v = money(Decimal(value))
    whole, cents = f"{v:.2f}".split(".")
    sign = "−" if whole.startswith("-") else ""
    whole = whole.lstrip("-")
    groups = []
    while whole:
        groups.insert(0, whole[-3:])
        whole = whole[:-3]
    text = sign + " ".join(groups) + ("" if cents == "00" else "," + cents)
    symbol = {"KZT": "₸", "RUB": "₽", "USD": "$", "EUR": "€"}.get(currency, currency)
    return f"{text} {symbol}"


def format_amount(value: Decimal | str) -> str:
    """«1 240 000,00» for the PDF table (always two places)."""
    v = money(Decimal(value))
    whole, cents = f"{v:.2f}".split(".")
    groups = []
    digits = whole.lstrip("-")
    while digits:
        groups.insert(0, digits[-3:])
        digits = digits[:-3]
    return ("−" if whole.startswith("-") else "") + " ".join(groups) + "," + cents


__all__ = ["CALC_VERSION", "CalcError", "Line", "LineTotal", "Totals", "VAT_MODES", "compute",
           "fmt", "format_amount", "format_money", "lines_of", "money"]  # fmt: skip
