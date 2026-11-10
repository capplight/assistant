"""Text helpers of the КП engine (pure, no DB, no model): position names for matching, units,
numbers written in a text, decimals from the person or the model.

`name_norm` is what the price list, past КП and a new ТЗ line are compared by: lower case, «ё» →
«е», «х» / «×» / «*» between digits → «x», «2,5» → «2.5», punctuation → spaces. Latin look-alikes
are not folded (a SKU «ВА47» and «BA47» stay different on purpose: the model then chooses).
"""

import re
from decimal import Decimal, InvalidOperation

MONEY_MAX = Decimal("999999999999.99")
QTY_MAX = Decimal("99999999.999")
NAME_MAX = 300
UNIT_MAX = 20

_TIMES = re.compile(r"(?<=\d)\s*[xх×*]\s*(?=\d)", re.IGNORECASE)
_DECIMAL_COMMA = re.compile(r"(?<=\d),(?=\d)")
_PUNCT = re.compile(r"[^\w.]+")
_LONE_DOT = re.compile(r"(?<!\d)\.|\.(?!\d)")
_SPACES = re.compile(r"\s+")


def name_norm(name: str | None, limit: int | None = NAME_MAX) -> str:
    """`limit=None`: a whole text (to look words up in it), not a name."""
    s = (name or "").lower().replace("ё", "е")
    s = _TIMES.sub("x", s)
    s = _DECIMAL_COMMA.sub(".", s)
    s = _PUNCT.sub(" ", s)
    s = _LONE_DOT.sub(" ", s)
    s = _SPACES.sub(" ", s).strip()
    return s if limit is None else s[:limit]


def clean_text(value: str | None, limit: int) -> str | None:
    text = " ".join((value or "").split())
    return text[:limit] or None


# Units as people write them → the form printed in the КП. Unknown units stay as written.
_UNITS = {
    "шт": "шт", "шт.": "шт", "штук": "шт", "штука": "шт", "штуки": "шт", "pcs": "шт", "дана": "шт",
    "м": "м", "м.": "м", "метр": "м", "метров": "м", "метра": "м", "пм": "п.м", "п.м": "п.м",
    "п.м.": "п.м", "м.п.": "п.м", "мп": "п.м",
    "м2": "м²", "м²": "м²", "кв.м": "м²", "кв.м.": "м²", "кв м": "м²",
    "м3": "м³", "м³": "м³", "куб.м": "м³", "куб": "м³",
    "кг": "кг", "кг.": "кг", "т": "т", "тн": "т", "тонн": "т", "л": "л", "литр": "л",
    "компл": "компл", "компл.": "компл", "комплект": "компл", "к-т": "компл",
    "упак": "упак", "упак.": "упак", "уп": "упак", "уп.": "упак",
    "услуга": "услуга", "усл": "услуга", "усл.": "услуга", "час": "час", "ч": "час",
    "рейс": "рейс", "смена": "смена", "пара": "пара", "рулон": "рулон", "лист": "лист",
}  # fmt: skip


def unit_norm(unit: str | None) -> str | None:
    raw = " ".join((unit or "").lower().split())
    if not raw:
        return None
    return _UNITS.get(raw, _UNITS.get(raw.rstrip("."), raw))[:UNIT_MAX]


def units_agree(a: str | None, b: str | None) -> bool:
    ua, ub = unit_norm(a), unit_norm(b)
    return ua is None or ub is None or ua == ub


_NUMBER = re.compile(r"(?<![\d.,])\d{1,3}(?:[  ]\d{3})+(?:[.,]\d+)?(?![\d])"
                     r"|(?<![\d.,])\d+(?:[.,]\d+)?")
_PLAIN = re.compile(r"(?<![\d.,])\d+(?:[.,]\d+)?")


def parse_decimal(value: str | int | Decimal | None) -> Decimal | None:
    """A decimal from text: «1 240 000,50», «2.5», «450». None if it is not one number."""
    if value is None:
        return None
    if isinstance(value, Decimal):
        return value if value.is_finite() else None
    if isinstance(value, int):
        return Decimal(value)
    text = re.sub(r"[\s  ]", "", str(value)).replace(",", ".")
    if not re.fullmatch(r"\d+(?:\.\d+)?", text):
        return None
    try:
        return Decimal(text)
    except InvalidOperation:
        return None


def numbers_in(text: str | None) -> set[Decimal]:
    """Every number written in the text (normalised: «2,50» and «2.5» are the same)."""
    out: set[Decimal] = set()
    # «1 240 000» is one number, but «3 120» may also be a row number and a quantity: both kept
    for rx in (_NUMBER, _PLAIN):
        for m in rx.finditer(text or ""):
            value = parse_decimal(m.group(0))
            if value is not None:
                out.add(value.normalize())
    return out


def words_of(text: str | None) -> set[str]:
    return {w for w in name_norm(text).split() if len(w) >= 2}


def all_words_in(phrase: str | None, text: str | None) -> bool:
    """Every word (2+ letters) of `phrase` is in `text` (the model did not invent the name)."""
    want = words_of(phrase)
    have = name_norm(text, None)
    return bool(want) and all(w in have for w in want)


def digits(value: str | None) -> str:
    return re.sub(r"\D", "", value or "")


__all__ = ["MONEY_MAX", "NAME_MAX", "QTY_MAX", "UNIT_MAX", "all_words_in", "clean_text", "digits",
           "name_norm", "numbers_in", "parse_decimal", "unit_norm", "units_agree",
           "words_of"]  # fmt: skip
