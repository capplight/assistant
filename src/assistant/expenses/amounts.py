"""Amounts in a person's words, RU and KK (spec 6.13): «5000», «5 000», «12,4к», «5 тыс»,
«пять тысяч», «полторы тыщи», «две с половиной тысячи», «бес мың теңге», «$50».

Pure code, no model. Two uses:
- `find_amounts(text)`: every amount the words state, with its currency if said. The model's
  reading of a phrase is checked against it (the amount must be one of these: R-59, the model never
  invents a number). Always on.
- `best_amount(text)`: the one amount of an expense phrase, or None when code is not sure. Only the
  rules-first reader uses it (Ф-1, `settings.expenses_rules_first`, off by default).

What is not money is left out: times («в 10:30», «в 7 утра»), dates («15-го», «15 ноября», «15.11»),
years («2026 год»), quantities with units («2 кг», «20 литров», «3 шт», «10%»), phone and card
numbers. The same rules and the shared vectors (`docs/spec/vectors/amounts.json`) run on the phone.
The text is data; nothing in it is followed.
"""

import re
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation

CENT = Decimal("0.01")

# --- currencies ---

_CUR_AFTER = [  # (regex on the lowercased text right after the number, ISO code)
    (r"₸|тг\b\.?|тенге\b|теңге\b|tenge\b|kzt\b", "KZT"),
    (r"\$|usd\b|долл\w*|бакс\w*|доллар\w*", "USD"),
    (r"₽|руб\w*|rub\b|рубл\w*|р\.(?!\w)", "RUB"),
    (r"€|eur\b|евро\b|еуро\b", "EUR"),
    (r"сом\b|сома\b|сомов\b|сомдар\w*|kgs\b", "KGS"),
]
_CUR_AFTER_RE = [(re.compile(r"^\s*(?:" + rx + ")", re.IGNORECASE), code)
                 for rx, code in _CUR_AFTER]
_CUR_BEFORE_RE = [
    (re.compile(r"(?:₸|kzt)\s*$", re.IGNORECASE), "KZT"),
    (re.compile(r"(?:\$|usd)\s*$", re.IGNORECASE), "USD"),
    (re.compile(r"(?:₽|rub)\s*$", re.IGNORECASE), "RUB"),
    (re.compile(r"(?:€|eur)\s*$", re.IGNORECASE), "EUR"),
]

# --- what follows a number that makes it not money ---

_UNIT_AFTER = re.compile(
    r"^\s*(?:%|процент\w*|кг\b|килограмм\w*|кило\b|гр?\b|грамм\w*|л\b|литр\w*|мл\b|шт\b|штук\w*|"
    r"пач\w*|бутыл\w*|бан(?:ка|ки|ок)\b|упаков\w*|км\b|километр\w*|м\b|метр\w*|см\b|кв\b|"
    r"раз(?:а)?\b|мин\w*|час\w*|ч\b|сек\w*|дн\w*|день\b|недел\w*|месяц\w*|лет\b|год\w*|г\.|г\b|"
    r"сағат\w*|минут\w*|күн\w*|жыл\w*|ай\b|айға\b|"
    r"утра\b|вечера\b|дня\b|ночи\b|человек\w*|чел\b|порци\w*|этаж\w*|класс\w*|"
    r"лет\w*|штук\w*|кусок\w*|кусочк\w*|десят\w*|литр\w*|пар[аы]?\b|"
    r"числ\w*|-?го\b|-(?:е|ое|ого|ым|й|я|ші|шы|інші|ыншы)\b)",
    re.IGNORECASE,
)  # fmt: skip
_MONTHS = (r"январ\w*|феврал\w*|март\w*|апрел\w*|ма[йя]\b|июн\w*|июл\w*|август\w*|сентябр\w*|"
           r"октябр\w*|ноябр\w*|декабр\w*|қаңтар\w*|ақпан\w*|наурыз\w*|сәуір\w*|мамыр\w*|"
           r"маусым\w*|шілде\w*|тамыз\w*|қыркүйек\w*|қазан\w*|қараша\w*|желтоқсан\w*")  # fmt: skip
_MONTH_AFTER = re.compile(r"^\s*(?:" + _MONTHS + ")", re.IGNORECASE)
_MONTH_BEFORE = re.compile(r"(?:" + _MONTHS + r")\s*$", re.IGNORECASE)
_TIME_BEFORE = re.compile(r"(?:^|\s)(?:в|во|к|до|с|после|около|сағат)\s*$", re.IGNORECASE)
_TIME_AFTER_WORD = re.compile(r"^\s*(?:утра|вечера|ночи|дня|час\w*|сағат\w*)\b", re.IGNORECASE)
# «номер заказа 123456», «квартира 12», «кв. 5»: an id or an address, not money
_NUMBER_SIGN_BEFORE = re.compile(r"(?:№|#|(?<!\w)(?:номер\w*|заказ\w*|код\w*|квартир\w*|кв\.?|"
                                 r"дом|подъезд\w*|этаж\w*|офис\w*|комнат\w*|кабинет\w*|n))\s*$",
                                 re.IGNORECASE)  # fmt: skip

# --- digits ---

_SP = "[ \u00a0\u202f\u2009]"
_DIGITS = re.compile(
    rf"(?<![\w.,:/+№#-])"
    rf"(?P<int>\d{{1,3}}(?:{_SP}\d{{3}})+(?!\d)|\d{{1,3}}(?:\.\d{{3}})+(?![.,]?\d)"
    rf"|\d{{1,3}}(?:,\d{{3}})+(?![.,]?\d)|\d+)"
    rf"(?:[.,](?P<frac>\d{{1,2}})(?!\d))?"
    rf"(?![\d:/])"
)  # fmt: skip
# «12,4к», «5k», «2кк» = 2 млн; with a space only at the end («5 к»): «500 к ужину» is not 500 000
_K_SUFFIX = re.compile(r"^(?:кк|к|k)(?!\w)|^ (?:к|k)(?=\s*(?:$|[,.;!?)]|тг|₸|тенге))",
                       re.IGNORECASE)  # fmt: skip

# --- number words ---

_RU_UNITS = {
    "ноль": 0, "один": 1, "одна": 1, "одну": 1, "одного": 1, "два": 2, "две": 2, "двух": 2,
    "три": 3, "трех": 3, "четыре": 4, "четырех": 4, "пять": 5, "пяти": 5, "шесть": 6, "шести": 6,
    "семь": 7, "семи": 7, "восемь": 8, "восьми": 8, "девять": 9, "девяти": 9,
}  # fmt: skip
_RU_TEENS = {
    "десять": 10, "десяти": 10, "одиннадцать": 11, "двенадцать": 12, "тринадцать": 13,
    "четырнадцать": 14, "пятнадцать": 15, "шестнадцать": 16, "семнадцать": 17,
    "восемнадцать": 18, "девятнадцать": 19,
}  # fmt: skip
_RU_TENS = {
    "двадцать": 20, "двадцати": 20, "тридцать": 30, "тридцати": 30, "сорок": 40, "сорока": 40,
    "пятьдесят": 50, "пятидесяти": 50, "шестьдесят": 60, "семьдесят": 70, "восемьдесят": 80,
    "девяносто": 90,
}  # fmt: skip
_RU_HUNDREDS = {
    "сто": 100, "ста": 100, "двести": 200, "триста": 300, "четыреста": 400, "пятьсот": 500,
    "шестьсот": 600, "семьсот": 700, "восемьсот": 800, "девятьсот": 900,
}  # fmt: skip
_KK_UNITS = {"нөл": 0, "бір": 1, "екі": 2, "үш": 3, "төрт": 4, "бес": 5, "алты": 6, "жеті": 7,
             "сегіз": 8, "тоғыз": 9}  # fmt: skip
_KK_TENS = {"он": 10, "жиырма": 20, "отыз": 30, "қырық": 40, "елу": 50, "алпыс": 60,
            "жетпіс": 70, "сексен": 80, "тоқсан": 90}  # fmt: skip
_KK_HUNDRED = {"жүз": 100}
_THOUSAND = re.compile(r"^(?:тысяч\w*|тыщ\w*|тыс\.?|косар\w*|косых|мың\w*)$")
_MILLION = re.compile(r"^(?:миллион\w*|млн\.?|лям\w*|лимон\w*)$")
_ONE_AND_HALF = {"полторы": Decimal("1.5"), "полтора": Decimal("1.5")}
# A multiplier word without a count is «one thousand» only in the singular («тысяча», «мың»)
_SINGULAR = re.compile(r"^(?:тысяча|тысячу|тыща|тыщу|косарь|мың|миллион|лям|лимон)$")
_HALF_PREFIX = re.compile(r"^пол-?(тысяч\w*|тыщ\w*|миллион\w*|лимон\w*|ляма?)$")



@dataclass(frozen=True)
class Amount:
    value: Decimal  # quantized to 0.01
    currency: str | None  # ISO code when the words say it, else None
    start: int
    end: int
    words: bool  # said in words («пять тысяч»), not digits
    multiplier: bool  # «тыс», «к», «мың» … was part of it
    text: str


def norm(text: str) -> str:
    """Lowercase, «ё» → «е», odd spaces → space. Same length as the input, so spans stay valid."""
    out = text.lower().replace("ё", "е")
    return re.sub("[\u00a0\u202f\u2009\t]", " ", out)


def _q(value: Decimal) -> Decimal:
    return value.quantize(CENT)


def _currency_after(rest: str) -> tuple[str | None, int]:
    for rx, code in _CUR_AFTER_RE:
        m = rx.match(rest)
        if m:
            return code, m.end()
    return None, 0


def _currency_before(head: str) -> str | None:
    for rx, code in _CUR_BEFORE_RE:
        if rx.search(head):
            return code
    return None


def _word_value(word: str) -> tuple[str, Decimal] | None:
    """(kind, value): kind unit | teen | ten | hundred | thousand | million | half15 | halfmul."""
    w = word.strip(".")
    for table, kind in ((_RU_UNITS, "unit"), (_KK_UNITS, "unit"), (_RU_TEENS, "teen"),
                        (_RU_TENS, "ten"), (_KK_TENS, "ten"), (_RU_HUNDREDS, "hundred"),
                        (_KK_HUNDRED, "hundred")):  # fmt: skip
        if w in table:
            return kind, Decimal(table[w])
    if _THOUSAND.match(word):
        return "thousand", Decimal(1000)
    if _MILLION.match(word):
        return "million", Decimal(1_000_000)
    if w in _ONE_AND_HALF:
        return "half15", _ONE_AND_HALF[w]
    m = _HALF_PREFIX.match(w)
    if m:
        mul = 1_000_000 if re.match(r"миллион|лимон|ляма?", m.group(1)) else 1000
        return "halfmul", Decimal(mul) / 2
    if w == "жарым":
        return "kkhalf", Decimal("0.5")
    if w == "пол":
        return "halfword", Decimal("0.5")
    return None


_ORDER = {"unit": 1, "teen": 2, "ten": 3, "hundred": 4}
_FREE = 99  # start of a group (nothing yet, or right after «тысяч» / «мың»)


def _step(kind: str, value: Decimal, word: str, current: Decimal,
          last: int) -> tuple[Decimal, int] | None:  # fmt: skip
    """One number word inside a group below a thousand: the new (current, last order), or None
    when the word cannot follow («двадцать сто», «пять пять»). KK «төрт жүз» = 4 × 100."""
    if kind == "hundred" and word.strip(".") == "жүз":
        if last == 1 and current < 10:
            return (current or Decimal(1)) * 100, 4
        if last == _FREE:
            return Decimal(100), 4
        return None
    need = {"unit": 3, "teen": 4, "ten": 4, "hundred": 5}[kind]
    if last < need:
        return None
    return current + value, _ORDER[kind]


def _digit_amounts(t: str, out: list[Amount], taken: list[tuple[int, int]]) -> None:
    for m in _DIGITS.finditer(t):
        start, end = m.start(), m.end()
        raw_int = m.group("int")
        frac = m.group("frac")
        digits_only = re.sub(r"\D", "", raw_int)
        head, rest = t[:start], t[end:]
        # long digit strings: phones, cards, ids
        if len(digits_only) >= 9 and not re.search(_SP, raw_int):
            continue
        if _NUMBER_SIGN_BEFORE.search(head):
            continue
        # Digit groups next to each other that are not thousands grouping: a card, a phone, a
        # code, a range («500-600»). Code does not guess which one is the amount.
        if re.match(r"^[ -]*\d", rest) or re.search(r"\d[ -]*$", head):
            continue
        try:
            value = Decimal(digits_only + (f".{frac}" if frac else ""))
        except InvalidOperation:
            continue
        multiplier = False
        k = _K_SUFFIX.match(rest)
        consumed = 0
        if k:
            value *= 1_000_000 if k.group(0).strip().lower() == "кк" else 1000
            multiplier = True
            consumed = k.end()
        else:
            w = re.match(r"^\s*([^\W\d_]+\.?)", rest)
            if w:
                wv = _word_value(w.group(1).lower())
                if wv and wv[0] in ("thousand", "million"):
                    value *= wv[1]
                    multiplier = True
                    consumed = w.end()
                    tail = rest[consumed:]
                    # «5 тысяч 300», «2 тысячи пятьсот»
                    more = re.match(r"^\s*(\d{1,3})(?![\d.,:])", tail)
                    if more and wv[0] == "thousand" and not _UNIT_AFTER.match(tail[more.end():]):
                        value += Decimal(more.group(1))
                        consumed += more.end()
                    else:
                        sub = _words_at(tail, limit=Decimal(wv[1]))
                        if sub is not None:
                            value += sub[0]
                            consumed += sub[1]
                elif re.match(r"^\s*с\s+половин\w*\s+(тысяч\w*|тыщ\w*|миллион\w*|мың\w*)", rest):
                    hm = re.match(r"^\s*с\s+половин\w*\s+(\S+)", rest)
                    assert hm is not None
                    mul = _word_value(hm.group(1))
                    if mul:
                        value = (value + Decimal("0.5")) * mul[1]
                        multiplier = True
                        consumed = hm.end()
                elif re.match(r"^\s*жарым\s+(мың\w*|миллион\w*)", rest):
                    hm = re.match(r"^\s*жарым\s+(\S+)", rest)
                    assert hm is not None
                    mul = _word_value(hm.group(1))
                    if mul:
                        value = (value + Decimal("0.5")) * mul[1]
                        multiplier = True
                        consumed = hm.end()
        after = rest[consumed:]
        if not multiplier:
            if _UNIT_AFTER.match(after) and not _currency_after(after)[0]:
                continue
            if _MONTH_AFTER.match(after) or _MONTH_BEFORE.search(head):
                continue  # «15 ноября», «ноябрь 2026»
            if (frac and len(digits_only) <= 2 and int(digits_only) <= 31 and int(frac) <= 12
                    and not _currency_after(after)[0] and not _currency_before(head)):  # fmt: skip
                continue  # «15.11»: a date, not 15,11 ₸
            if (_TIME_BEFORE.search(head) and value <= 24 and not frac
                    and not _currency_after(after)[0]):  # fmt: skip
                if _TIME_AFTER_WORD.match(after) or value <= 12:
                    continue  # «в 7», «к 10 утра»
            if re.match(r"^(?:19|20)\d\d$", digits_only) and re.match(
                    r"^\s*(?:год\w*|г\.?|жыл\w*)(?!\w)", after):  # fmt: skip
                continue
        cur, clen = _currency_after(after)
        end_all = end + consumed + clen
        if cur is None:
            cur = _currency_before(head)
        if value <= 0:
            continue
        out.append(Amount(_q(value), cur, start, end_all, False, multiplier, t[start:end_all]))
        taken.append((start, end_all))


def _words_at(text: str, limit: Decimal | None = None) -> tuple[Decimal, int] | None:
    """Number words at the start of `text` (after spaces): (value, chars used). `limit`: the value
    must stay below it (the part after «тысяч»)."""
    pos = 0
    current = Decimal(0)
    last = _FREE
    used = 0
    for m in re.finditer(r"\s*([^\W\d_]+(?:-[^\W\d_]+)?)", text):
        if m.start() != pos:
            break
        word = m.group(1).lower()
        wv = _word_value(word)
        if wv is None or wv[0] not in _ORDER:
            break  # a multiplier inside the tail ends it
        nxt = _step(wv[0], wv[1], word, current, last)
        if nxt is None:
            break
        current, last = nxt
        pos = m.end()
        used = pos
    if not used:
        return None
    if limit is not None and current >= limit:
        return None
    return current, used


def _word_amounts(t: str, out: list[Amount], taken: list[tuple[int, int]]) -> None:
    tokens = [(m.start(), m.end(), m.group(0))
              for m in re.finditer(r"[^\W\d_]+(?:-[^\W\d_]+)?", t)]  # fmt: skip
    i = 0
    while i < len(tokens):
        s0, _, w0 = tokens[i]
        if any(a <= s0 < b for a, b in taken) or _word_value(w0) is None:
            i += 1
            continue
        total = Decimal(0)
        current = Decimal(0)
        last = _FREE
        multiplier = False
        half = Decimal(0)  # «с половиной», «жарым», «пол»: + 0.5 of the next multiplier
        j = i
        end = tokens[i][1]
        seen = 0
        while j < len(tokens):
            s, e, w = tokens[j]
            if j > i and t[tokens[j - 1][1]:s].strip() not in ("", "-"):
                break  # punctuation between words ends the number
            if w == "с" and j + 1 < len(tokens) and tokens[j + 1][2].startswith("половин"):
                if not current:
                    break
                half = Decimal("0.5")
                j += 2
                continue
            wv = _word_value(w)
            if wv is None:
                break
            kind, v = wv
            if kind in _ORDER:
                nxt = _step(kind, v, w, current, last)
                if nxt is None:
                    break
                current, last = nxt
                seen += 1
            elif kind == "half15":
                if current or last != _FREE:
                    break
                current, last = v, 1
                seen += 1
            elif kind in ("kkhalf", "halfword"):
                if kind == "halfword" and (current or last != _FREE):
                    break
                half = v
            elif kind == "halfmul":
                if current:
                    break
                total += v
                multiplier = True
                seen += 1
                end = e
                j += 1
                break
            else:  # thousand | million
                if total and v >= 1_000_000:
                    break
                if not (current or half) and not _SINGULAR.match(w):
                    break  # «пару тысяч», «тысячи две»: no count said, code does not guess
                base = current + half if (current or half) else Decimal(1)
                total += base * v
                current, last, half = Decimal(0), _FREE, Decimal(0)
                multiplier = True
                seen += 1
            end = e
            j += 1
        value = total + current
        if seen == 0 or value <= 0 or half:
            i = max(j, i + 1)
            continue
        # «он» is also «he» in Russian: a lone «он» is not ten.
        if t[s0:end] == "он":
            i = j
            continue
        after = t[end:]
        cur, clen = _currency_after(after)
        if not multiplier and cur is None and (_UNIT_AFTER.match(after) or value < 10):
            i = j  # «две булки», «один раз»: a count, not money
            continue
        end_all = end + clen
        out.append(Amount(_q(value), cur or _currency_before(t[:s0]), s0, end_all, True,
                          multiplier, t[s0:end_all]))  # fmt: skip
        taken.append((s0, end_all))
        i = j


def find_amounts(text: str) -> list[Amount]:
    """Every amount the words state, in order of appearance."""
    t = norm(text)
    out: list[Amount] = []
    taken: list[tuple[int, int]] = []
    _digit_amounts(t, out, taken)
    _word_amounts(t, out, taken)
    out.sort(key=lambda a: a.start)
    return out


_FOR_BEFORE = re.compile(r"(?:^|\s)(?:за|на\s+сумму|сумма|сумму|итого|всего|стоил\w*|"
                         r"обошл\w*|отдал\w*|заплатил\w*|оплатил\w*|потратил\w*|ушл\w*|"
                         r"жұмсадым|төледім|бердім)\s*[:—-]?\s*$", re.IGNORECASE)  # fmt: skip
_EACH_BEFORE = re.compile(r"(?:^|\s)(?:по|каждый|каждая|каждое|бір)\s*$", re.IGNORECASE)


def best_amount(text: str) -> Amount | None:
    """The single amount of an expense phrase, or None if code is not sure (none, or two that
    could both be it: «2 по 150» is not added up here)."""
    found = find_amounts(text)
    if not found:
        return None
    t = norm(text)
    if any(_EACH_BEFORE.search(t[:a.start]) for a in found):
        return None  # «по 150»: a price per piece, the total is not said
    if len(found) == 1:
        return found[0]
    def count_like(a: Amount) -> bool:  # «3 кофе за 1500»: the 3 is how many, not money
        return not a.currency and not a.multiplier and a.value <= 20 and a.value == int(a.value)

    for pick in (
        [a for a in found if a.currency],
        [a for a in found if _FOR_BEFORE.search(t[:a.start])
         and all(count_like(b) for b in found if b is not a)],
        [a for a in found if a.multiplier],
    ):
        if len(pick) == 1:
            return pick[0]
        if len(pick) > 1:
            return None
    return None


def said(text: str, value: Decimal) -> Amount | None:
    """The amount of the words equal to `value` (the model's reading), or None."""
    want = _q(value)
    for a in find_amounts(text):
        if a.value == want:
            return a
    return None


def parse_decimal(value: str) -> Decimal | None:
    """A decimal string from a client or the model («5000», «5000.5», «5 000,50») → Decimal."""
    s = re.sub(r"[ \u00a0\u202f\u2009]", "", str(value or "")).replace(",", ".")
    if not re.fullmatch(r"\d{1,12}(?:\.\d{1,2})?", s):
        return None
    try:
        return _q(Decimal(s))
    except InvalidOperation:
        return None
