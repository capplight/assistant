"""«Ответ значением» (Ф-50, ia-v2 §3): when a question asks for a value («код от домофона»,
«номер окулиста», «размер обуви сына»), the value itself («4512») from the person's own record.

Code only, no model: the value is a token written in the record (digits, a code, a phone, a sum,
a date), next to the words the question is about. Nothing is computed or made up: no token near
those words → no value (the list of results stays as it is).
"""

import re
from dataclasses import dataclass

MAX_TEXT = 4000
NEAR = 60  # chars between the asked-about word and the value

# Words that ask for a value (stems, lower case, «ё» → «е»).
_ASK = ("код", "номер", "телефон", "тел", "пароль", "парол", "пин", "pin", "размер", "сколько",
        "адрес", "счет", "иин", "бин", "iban", "wifi", "вайфай", "wi-fi", "артикул", "цена",
        "стоил", "стоимост", "сумм", "дата", "когда", "день рождения", "др", "нөмір", "қанша",
        "құпия", "мекенжай", "квартир", "кв", "подъезд", "этаж", "серия", "госномер", "vin")
_STOP = frozenset({"от", "для", "у", "в", "на", "мой", "моя", "мое", "мои", "какой", "какая",
                   "какое", "какие", "где", "что", "это", "а", "и", "по", "с", "к", "ли", "же",
                   "мне", "меня", "наш", "наша", "был", "была", "скажи", "напомни", "какой-то",
                   "қандай", "менің"})  # fmt: skip
_MONTHS = (r"(?:январ|феврал|март|апрел|ма[яй]|июн|июл|август|сентябр|октябр|ноябр|декабр|"
           r"қаңтар|ақпан|наурыз|сәуір|мамыр|маусым|шілде|тамыз|қыркүйек|қазан|қараша|"
           r"желтоқсан)\w*")  # fmt: skip
_UNIT = r"(?:\s?(?:₸|тг|тенге|теңге|руб|\$|€|кг|г|м²|м2|м|см|мм|л|%|шт|р-р))?"
_VALUE = re.compile(
    rf"(?<![\w+])(?:\d{{1,2}}\s{_MONTHS}(?:\s\d{{4}})?"  # 12 марта 2026
    r"|\+?\d[\d\-‑–()./: ]{0,22}\d"  # 4512, +7 701 123 45 67, 12.03.2026, 3 000
    r"|\d"  # 7
    r"|(?=[A-Za-zА-Яа-я0-9_\-]*\d)(?=[A-Za-zА-Яа-я0-9_\-]*[A-Za-zА-Яа-я])[A-Za-zА-Яа-я0-9_\-]{4,40}"
    rf"){_UNIT}(?![\w])",
)
_WORD = re.compile(r"[\wё\-]+", re.IGNORECASE)


@dataclass(frozen=True)
class Value:
    text: str
    start: int  # offset in the record's text


def _norm(text: str) -> str:
    return text.lower().replace("ё", "е")


def asks_value(question: str) -> bool:
    """The question asks for a value (a code, a number, a size, a sum, a date)."""
    q = _norm(question)
    words = _WORD.findall(q)
    return any(w.startswith(a) for w in words for a in _ASK if " " not in a) or any(
        a in q for a in _ASK if " " in a)


def _subject(question: str) -> list[str]:
    """Stems of what the question is about (all content words, ask words included)."""
    out = []
    for w in _WORD.findall(_norm(question)):
        if w in _STOP or len(w) < 2:
            continue
        out.append(w[:5] if len(w) > 5 else w)
    return out


def find_value(question: str, text: str | None) -> Value | None:
    """The value in `text` the question asks for, or None. Prefers a token right after the
    asked-about words, in the same line; the subject words must be there (not only «код»)."""
    if not text or not asks_value(question):
        return None
    body = text[:MAX_TEXT]
    low = _norm(body)
    stems = _subject(question)
    if not stems:
        return None
    ask = [s for s in stems if any(s.startswith(a[:5]) or a.startswith(s) for a in _ASK)]
    topic = [s for s in stems if s not in ask]
    hits = [(m.start(), m.end()) for s in stems
            for m in re.finditer(rf"(?<![\w]){re.escape(s)}", low)]
    if not hits:
        return None
    if topic and not any(re.search(rf"(?<![\w]){re.escape(s)}", low) for s in topic):
        return None  # «код» alone in a record about something else
    best: tuple[int, Value] | None = None
    for m in _VALUE.finditer(body):
        token = m.group(0).strip(" -–./:()")
        if not token or not any(ch.isdigit() for ch in token):
            continue
        for hs, he in hits:
            if body.count("\n", min(he, m.start()), max(he, m.start())):
                continue  # another line
            gap = m.start() - he if m.start() >= he else hs - m.end()
            if gap < 0 or gap > NEAR:
                continue
            score = gap + (0 if m.start() >= he else NEAR)  # after the word is better
            if best is None or score < best[0]:
                best = (score, Value(token, m.start()))
    return best[1] if best else None


def value_of_answer(answer: str, *, max_chars: int = 80) -> str | None:
    """The single value a short checked answer gives («Код домофона — 4512.» → «4512»), else
    None. The number check (chat.verify) already made sure the value is in the sources."""
    clean = re.sub(r"\s*\[(?:s\d+(?:,\s*)?)+\]", "", answer or "").strip()
    if not clean or len(clean) > max_chars:
        return None
    found = {m.group(0).strip(" -–./:()") for m in _VALUE.finditer(clean)}
    found = {v for v in found if any(ch.isdigit() for ch in v)}
    return found.pop() if len(found) == 1 else None
