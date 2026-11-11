"""Which pages S35 ticks after the first phrase (spec 3.11, product 4.1, R-48; US-23). Code only:
no model call, nothing stored. Shared vectors: docs/spec/vectors/onboarding-marks.json (the phone
runs the same rule offline).

Rule, in order, at most `MAX_MARKED`:
1. «Заметки» + «Дела и напоминания» always;
2. from the phrase, in this order: «КП» / «клиент» → «Документы и КП»; «купить» / «в магазин» /
   «список покупок» → «Покупки» (a plan to buy; «купил» is past and ticks nothing by itself);
   «тенге» / «потратил» → «Расходы»;
3. from the welcome frame 2 ticks (S02): `kp` → documents; `expenses`, `photo_receipt` → expenses.
"""

import re

DEFAULT_TEMPLATES: tuple[str, ...] = ("notes", "tasks")
MAX_MARKED = 3
INTRO_MARKS = {"remind": None, "find": None, "kp": "documents", "expenses": "expenses",
               "photo_receipt": "expenses"}  # fmt: skip

# Whole short words (dots ignored: «к.п.») and word starts (lower case, «ё» read as «е»).
_EXACT_DOCUMENTS = frozenset({"кп", "кұ"})
_DOCUMENTS = ("коммерческ", "клиент", "смет", "коммерциялық")
_EXACT_EXPENSES = frozenset({"тг"})
_EXPENSES = ("тенге", "теңге", "потрат", "заплатил", "расход", "жұмса")
_CURRENCY = re.compile(r"\d[\d\s.,]*\s*(?:к|тыс\.?|тысяч\w*|млн)?\s*(?:тг|тенге|теңге)|₸")
# «Покупки»: what to buy (imperative / infinitive / future), not what was bought.
_EXACT_SHOPPING = frozenset({"купи", "купить", "куплю", "купите", "купим", "докупить",
                             "докупи", "прикупить", "закупить"})  # fmt: skip
_SHOPPING = ("покупк", "покупок")
_SHOPPING_PHRASE = re.compile(r"(?:^|\s)(?:в|до) магазин|сатып ал|дүкен(?:ге|нен)")
_WORD = re.compile(r"[0-9a-zа-яәғқңөұүһі.]+")


def _words(phrase: str) -> list[str]:
    return _WORD.findall(phrase.lower().replace("ё", "е"))


def _has(words: list[str], exact: frozenset[str], stems: tuple[str, ...]) -> bool:
    return any(w.replace(".", "") in exact or w.strip(".").startswith(stems) for w in words)


def suggested_pages(
    phrase: str | None, intro_marks: list[str] | None = None, *, max_marked: int = MAX_MARKED
) -> tuple[list[str], dict[str, str]]:
    """(template keys to tick, why each one: default | phrase | intro)."""
    keys = list(DEFAULT_TEMPLATES)
    reasons = {k: "default" for k in keys}

    def add(key: str, why: str) -> None:
        if key not in reasons and len(keys) < max_marked:
            keys.append(key)
            reasons[key] = why

    text = (phrase or "")[:2000]
    words = _words(text)
    if _has(words, _EXACT_DOCUMENTS, _DOCUMENTS):
        add("documents", "phrase")
    # a plan to buy beats its price: «купить хлеб на 500 тг» is a shopping line
    if _has(words, _EXACT_SHOPPING, _SHOPPING) or _SHOPPING_PHRASE.search(text.lower()):
        add("shopping", "phrase")
    if _has(words, _EXACT_EXPENSES, _EXPENSES) or _CURRENCY.search(text.lower()):
        add("expenses", "phrase")
    for mark in intro_marks or []:
        key = INTRO_MARKS.get(mark)
        if key:
            add(key, "intro")
    return keys, reasons
