"""Numbers and days in a document's text (receipt OCR, a shared PDF, an OFD page, a statement line).

Pure code, always on. This is the **check**, not a reader: whatever the model says a receipt's total
or a line's amount is must be one of the amounts code finds here, and its day one of the days. The
text is data; nothing in it is followed.

Amounts in documents look like «12 400,00», «12400.00», «1 250,5», «2,500.00», «₸ 3 400»,
«- 2 500,00 ₸». Grouping is a space (also NBSP / thin space), a dot or a comma when the other one
is the decimal.
"""

import re
from datetime import date
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

CENT = Decimal("0.01")
_SP = "[    ]"
# A number: grouped by spaces / dots / commas, with up to two decimals.
_NUM = re.compile(
    rf"(?<![\w.,])(?P<sign>[-−–+]\s?)?"
    rf"(?P<int>\d{{1,3}}(?:{_SP}\d{{3}})+|\d{{1,3}}(?:\.\d{{3}})+(?=,\d{{1,2}}(?!\d))"
    rf"|\d{{1,3}}(?:,\d{{3}})+(?=\.\d{{1,2}}(?!\d))|\d{{1,3}}(?:,\d{{3}})+(?![.,]?\d)|\d+)"
    rf"(?:[.,](?P<frac>\d{{1,2}}))?(?![\d])"
)  # fmt: skip


def money(value: Decimal) -> Decimal:
    return value.quantize(CENT, rounding=ROUND_HALF_UP)


def _value(m: re.Match[str]) -> Decimal | None:
    raw = re.sub(r"[    .,]", "", m.group("int"))
    frac = m.group("frac")
    try:
        v = Decimal(raw + ("." + frac if frac else ""))
    except InvalidOperation:
        return None
    return money(v)


def amounts_in(text: str | None) -> set[Decimal]:
    """Every non-negative amount written in the text (no sign). Liberal on purpose: it is the
    set a claimed amount must belong to."""
    out: set[Decimal] = set()
    if not text:
        return out
    for m in _NUM.finditer(text):
        v = _value(m)
        if v is not None:
            out.add(v)
    return out


def found(text: str | None, value: Decimal) -> bool:
    return money(value) in amounts_in(text)


_SIGNED = re.compile(
    rf"^\s*(?P<sign>[-−–+])?\s*(?P<int>\d{{1,3}}(?:{_SP}\d{{3}})+|\d+)(?:[.,](?P<frac>\d{{2}}))?"
    rf"\s*(?:₸|тг|KZT|USD|EUR|RUB|\$)?\s*$"
)  # fmt: skip


def signed_amount(cell: str) -> Decimal | None:
    """A statement cell «- 2 500,00 ₸» / «+150 000,00» / «-1 250,50» → a signed Decimal, else None.
    Only a whole cell that is one amount: never a guess from inside a description."""
    m = _SIGNED.match(cell.replace("−", "-"))
    if not m:
        return None
    raw = re.sub(r"[    ]", "", m.group("int"))
    v = Decimal(raw + ("." + m.group("frac") if m.group("frac") else ""))
    if m.group("sign") in ("-", "−", "–"):
        v = -v
    return money(v)


_DMY = re.compile(r"(?<![\d.])(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})(?![\d])")
_YMD = re.compile(r"(?<![\d.])(\d{4})-(\d{2})-(\d{2})(?![\d])")
_MONTHS = {"янв": 1, "фев": 2, "мар": 3, "апр": 4, "мая": 5, "май": 5, "июн": 6, "июл": 7,
           "авг": 8, "сен": 9, "окт": 10, "ноя": 11, "дек": 12}  # fmt: skip
_DAY_MONTH = re.compile(r"(?<!\d)(\d{1,2})\s+(янв|фев|мар|апр|мая|май|июн|июл|авг|сен|окт|ноя|дек)"
                        r"[а-я]*\.?\s+(\d{4})", re.IGNORECASE)  # fmt: skip


def parse_day(token: str) -> date | None:
    """«01.10.26», «01.10.2026», «2026-10-01» → a date."""
    m = _YMD.fullmatch(token.strip())
    if m:
        y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
    else:
        m = _DMY.fullmatch(token.strip())
        if not m:
            return None
        d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        y = y + 2000 if y < 100 else y
    try:
        return date(y, mo, d)
    except ValueError:
        return None


def days_in(text: str | None) -> set[date]:
    out: set[date] = set()
    if not text:
        return out
    for m in _DMY.finditer(text):
        d = parse_day(m.group(0))
        if d:
            out.add(d)
    for m in _YMD.finditer(text):
        d = parse_day(m.group(0))
        if d:
            out.add(d)
    for m in _DAY_MONTH.finditer(text):
        try:
            out.add(date(int(m.group(3)), _MONTHS[m.group(2).lower()[:3]], int(m.group(1))))
        except (ValueError, KeyError):
            pass
    return out


_WORD = re.compile(r"[^\W_]+", re.UNICODE)


def words(text: str | None) -> list[str]:
    return [w.lower().replace("ё", "е") for w in _WORD.findall(text or "")]


def all_words_in(claim: str | None, text: str | None) -> bool:
    """Every word of the model's `claim` (a shop name) is in the document."""
    got = set(words(text))
    want = words(claim)
    return bool(want) and all(w in got for w in want)


__all__ = ["all_words_in", "amounts_in", "days_in", "found", "money", "parse_day",
           "signed_amount", "words"]  # fmt: skip
