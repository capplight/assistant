"""The sum in words (сумма прописью) for the КП, RU and KK. Code only, never the model (spec 6.7
step 4, 3-engineering 5.6 rule 3). Tested on 0, 1, 21, 1 000 000,01 and more (tests/kp).

Format (as Kazakhstani invoices print it): the whole tenge in words with a capital letter, then
the tiyn as two digits: «Один миллион двести сорок тысяч тенге 00 тиын» / «Бір миллион екі жүз
қырық мың теңге 00 тиын». «тенге» / «теңге» and «тиын» do not change with the number. Other
currencies: the words and the code («Сто USD 50/100»).

KK wording («бір жүз», «бір мың» with «бір») follows 1C-style invoices; it goes to the native
proofreading of week 17 with the other KK strings [проверить носителем].
"""

from decimal import Decimal

from assistant.kp.calc import money

MAX_WHOLE = 999_999_999_999

_RU_ONES_M = ["", "один", "два", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"]
_RU_ONES_F = ["", "одна", "две", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять"]
_RU_TEENS = ["десять", "одиннадцать", "двенадцать", "тринадцать", "четырнадцать", "пятнадцать",
             "шестнадцать", "семнадцать", "восемнадцать", "девятнадцать"]  # fmt: skip
_RU_TENS = ["", "", "двадцать", "тридцать", "сорок", "пятьдесят", "шестьдесят", "семьдесят",
            "восемьдесят", "девяносто"]  # fmt: skip
_RU_HUNDREDS = ["", "сто", "двести", "триста", "четыреста", "пятьсот", "шестьсот", "семьсот",
                "восемьсот", "девятьсот"]  # fmt: skip
# (one, few, many, feminine)
_RU_SCALES = [("", "", "", False), ("тысяча", "тысячи", "тысяч", True),
              ("миллион", "миллиона", "миллионов", False),
              ("миллиард", "миллиарда", "миллиардов", False)]  # fmt: skip

_KK_ONES = ["", "бір", "екі", "үш", "төрт", "бес", "алты", "жеті", "сегіз", "тоғыз"]
_KK_TENS = ["", "он", "жиырма", "отыз", "қырық", "елу", "алпыс", "жетпіс", "сексен", "тоқсан"]
_KK_SCALES = ["", "мың", "миллион", "миллиард"]

_CURRENCY = {"ru": {"KZT": ("тенге", "тиын")}, "kk": {"KZT": ("теңге", "тиын")}}


def _ru_plural(n: int, one: str, few: str, many: str) -> str:
    if 11 <= n % 100 <= 19:
        return many
    if n % 10 == 1:
        return one
    if 2 <= n % 10 <= 4:
        return few
    return many


def _ru_triple(n: int, feminine: bool) -> list[str]:
    out = []
    h, rest = divmod(n, 100)
    if h:
        out.append(_RU_HUNDREDS[h])
    if 10 <= rest <= 19:
        out.append(_RU_TEENS[rest - 10])
    else:
        t, o = divmod(rest, 10)
        if t:
            out.append(_RU_TENS[t])
        if o:
            out.append((_RU_ONES_F if feminine else _RU_ONES_M)[o])
    return out


def _kk_triple(n: int) -> list[str]:
    out = []
    h, rest = divmod(n, 100)
    if h:
        out += [_KK_ONES[h], "жүз"]
    t, o = divmod(rest, 10)
    if t:
        out.append(_KK_TENS[t])
    if o:
        out.append(_KK_ONES[o])
    return out


def _triples(n: int) -> list[int]:
    out = []
    while n:
        n, r = divmod(n, 1000)
        out.append(r)
    return out  # lowest first


def number_ru(n: int) -> str:
    if n == 0:
        return "ноль"
    words: list[str] = []
    for i, part in reversed(list(enumerate(_triples(n)))):
        if not part:
            continue
        one, few, many, fem = _RU_SCALES[i]
        words += _ru_triple(part, fem)
        if i:
            words.append(_ru_plural(part, one, few, many))
    return " ".join(words)


def number_kk(n: int) -> str:
    if n == 0:
        return "нөл"
    words: list[str] = []
    for i, part in reversed(list(enumerate(_triples(n)))):
        if not part:
            continue
        words += _kk_triple(part)
        if i:
            words.append(_KK_SCALES[i])
    return " ".join(words)


def amount_in_words(value: Decimal | str, currency: str = "KZT", lang: str = "ru") -> str:
    v = money(Decimal(value))
    if v < 0:
        raise ValueError("negative amount")
    whole = int(v)
    cents = int((v - whole) * 100)
    if whole > MAX_WHOLE:
        raise ValueError("amount too large for words")
    text = number_kk(whole) if lang == "kk" else number_ru(whole)
    text = text[0].upper() + text[1:]
    names = _CURRENCY.get(lang, _CURRENCY["ru"]).get(currency)
    if names is None:
        return f"{text} {currency} {cents:02d}/100"
    return f"{text} {names[0]} {cents:02d} {names[1]}"


__all__ = ["amount_in_words", "number_kk", "number_ru"]
