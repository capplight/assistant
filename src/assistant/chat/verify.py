"""Numbers and dates in an answer are checked by code against the sources (R-36, spec 5.6 p.4).

Every number, date, time and long digit string (phone, document number) of an answer sentence
must be found in what the model was shown this turn: the fragments of the sources, the person's
own question, and facts our code computed (today's date, counts). Spelling is normalised
(«125 000» / «125000» / «125 тыс.», «3 ноября» / «03.11» / «2026-11-03»). A sentence with
anything not found is not shown. The model is never trusted with a number.
"""

import re
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal, InvalidOperation

_MONTHS: dict[str, int] = {}
for _n, _stems in enumerate((
    ("январ", "янв", "қаңтар"), ("феврал", "фев", "ақпан"), ("март", "мар", "наурыз"),
    ("апрел", "апр", "сәуір"), ("мая", "май", "мамыр"), ("июн", "маусым"),
    ("июл", "шілде"), ("август", "авг", "тамыз"), ("сентябр", "сен", "қыркүйек"),
    ("октябр", "окт", "қазан"), ("ноябр", "ноя", "қараша"), ("декабр", "дек", "желтоқсан"),
), start=1):  # fmt: skip
    for _stem in _stems:
        _MONTHS[_stem] = _n
_MONTH_WORD = "|".join(sorted(_MONTHS, key=len, reverse=True))
_SHORT_MONTHS = ("янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек")

_SP = "[   ]"
_ISO_RE = re.compile(r"(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)")
_DMY_RE = re.compile(r"(?<![\d.,])(\d{1,2})\.(\d{1,2})(?:\.(\d{4}|\d{2}))?(?![\d,]|\.\d)")
_WORD_DATE_RE = re.compile(
    rf"(?<!\d)(\d{{1,2}}){_SP}*(?:-?го{_SP}+)?({_MONTH_WORD})\w*\.?(?:{_SP}+(\d{{4}}))?",
    re.IGNORECASE,
)
_TIME_RE = re.compile(r"(?<!\d)([01]?\d|2[0-3])[:.]([0-5]\d)(?!\d)")
_LONG_DIGITS_RE = re.compile(r"(?<![\w])\+?\d(?:[\d   ()\-]*\d){6,}")
_NUM_RE = re.compile(
    rf"(?<![\w.,])(\d{{1,3}}(?:{_SP}\d{{3}})+|\d+)(?:[.,](\d+))?"
    rf"(?:{_SP}*(тыс|тысяч|млн|миллион|млрд|миллиард)\w*\.?)?",
    re.IGNORECASE,
)
_LIST_MARK_RE = re.compile(r"(?m)^\s*\d{1,2}[.)]\s")
_MULT = {"тыс": 1000, "тысяч": 1000, "млн": 10**6, "миллион": 10**6, "млрд": 10**9,
         "миллиард": 10**9}  # fmt: skip
_SENT_END = re.compile(r"[.!?…]+[\"»)]*(?:[ \t]*\n+|(?=\s))|\n+")
_ABBREV = re.compile(r"(?:\b(?:тыс|млн|млрд|руб|тг|г|гг|ул|д|кв|стр|им|т\.д|т\.п|др|см|мин|"
                     r"шт|ч|м|с|пр|рис)|\d)\.$", re.IGNORECASE)  # fmt: skip


@dataclass(frozen=True)
class Claim:
    kind: str  # number | date | time | digits
    text: str
    key: object


@dataclass
class Facts:
    """What a piece of text states, normalised for comparison."""

    numbers: set[Decimal] = field(default_factory=set)
    dates: set[tuple[int, int, int | None]] = field(default_factory=set)
    times: set[tuple[int, int]] = field(default_factory=set)
    digits: str = ""  # digits of the text with separators removed, for phone / id lookups

    def add_date(self, d: date | datetime) -> None:
        self.dates.add((d.day, d.month, d.year))
        self.numbers.add(Decimal(d.year))
        if isinstance(d, datetime):
            self.times.add((d.hour, d.minute))

    def update(self, other: "Facts") -> None:
        self.numbers |= other.numbers
        self.dates |= other.dates
        self.times |= other.times
        self.digits += "|" + other.digits

    def supports(self, claim: Claim) -> bool:
        if claim.kind == "number":
            return claim.key in self.numbers
        if claim.kind == "time":
            return claim.key in self.times
        if claim.kind == "digits":
            return isinstance(claim.key, str) and claim.key in self.digits
        d, m, y = claim.key  # type: ignore[misc]
        if y is not None:
            return (d, m, y) in self.dates or (d, m, None) in self.dates
        return any(sd == d and sm == m for sd, sm, _ in self.dates)


def _year(raw: str | None) -> int | None:
    if not raw:
        return None
    y = int(raw)
    return y + 2000 if y < 100 else y


def _valid(d: int, m: int) -> bool:
    return 1 <= d <= 31 and 1 <= m <= 12


def _value(whole: str, frac: str | None, mult: str | None) -> Decimal | None:
    try:
        v = Decimal(re.sub(r"\D", "", whole) + (f".{frac}" if frac else ""))
    except InvalidOperation:
        return None
    if mult:
        v *= _MULT[mult.lower()]
    return v.normalize()


def claims(text: str) -> list[Claim]:
    """Numbers, dates, times and long digit strings in `text`, each once, in order."""
    out: list[Claim] = []
    rest = _LIST_MARK_RE.sub(" ", text)

    def take(regex: re.Pattern[str], make) -> None:  # type: ignore[no-untyped-def]
        nonlocal rest

        def repl(m: re.Match[str]) -> str:
            claim = make(m)
            if claim is None:
                return m.group(0)
            out.append(claim)
            return " " * len(m.group(0))

        rest = regex.sub(repl, rest)

    def iso(m: re.Match[str]) -> Claim | None:
        y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
        return Claim("date", m.group(0), (d, mo, y)) if _valid(d, mo) else None

    def word_date(m: re.Match[str]) -> Claim | None:
        d = int(m.group(1))
        word = m.group(2).lower()
        mo = _MONTHS.get(word) or next((n for s, n in _MONTHS.items() if word.startswith(s)), 0)
        return Claim("date", m.group(0), (d, mo, _year(m.group(3)))) if _valid(d, mo) else None

    def dmy(m: re.Match[str]) -> Claim | None:
        d, mo = int(m.group(1)), int(m.group(2))
        if not _valid(d, mo) or (m.group(3) is None and len(m.group(2)) != 2):
            return None
        return Claim("date", m.group(0), (d, mo, _year(m.group(3))))

    def time_(m: re.Match[str]) -> Claim:
        return Claim("time", m.group(0), (int(m.group(1)), int(m.group(2))))

    def digits(m: re.Match[str]) -> Claim | None:
        only = re.sub(r"\D", "", m.group(0))
        return Claim("digits", m.group(0), only) if len(only) >= 9 else None

    def number(m: re.Match[str]) -> Claim | None:
        v = _value(m.group(1), m.group(2), m.group(3))
        return Claim("number", m.group(0).strip(), v) if v is not None else None

    take(_ISO_RE, iso)
    take(_WORD_DATE_RE, word_date)
    take(_DMY_RE, dmy)
    take(_TIME_RE, time_)
    take(_LONG_DIGITS_RE, digits)
    take(_NUM_RE, number)
    seen: set[tuple[str, object]] = set()
    unique = []
    for c in out:
        if (c.kind, c.key) not in seen:
            seen.add((c.kind, c.key))
            unique.append(c)
    return unique


def facts_of(*texts: str) -> Facts:
    f = Facts()
    for text in texts:
        if not text:
            continue
        for c in claims(text):
            if c.kind == "number":
                f.numbers.add(c.key)  # type: ignore[arg-type]
            elif c.kind == "date":
                d, m, y = c.key  # type: ignore[misc]
                f.dates.add((d, m, y))
                if y is not None:
                    f.numbers.add(Decimal(y))
            elif c.kind == "time":
                f.times.add(c.key)  # type: ignore[arg-type]
            else:
                f.numbers.add(Decimal(c.key))  # type: ignore[arg-type]
        f.digits += "|" + re.sub(r"[^\d|]", "", re.sub(r"[^\d   ()\-+]", "|", text))
    return f


@dataclass
class SentenceCheck:
    ok: bool
    supported_by: dict[str, set[str]]  # claim text -> refs of sources that state it
    missing: list[str]


def check_sentence(sentence: str, sources: dict[str, Facts], extra: Facts) -> SentenceCheck:
    """`sources`: ref -> facts of what the model saw of that source; `extra`: the question,
    today, counts our code computed. OK when every claim is found somewhere."""
    support: dict[str, set[str]] = {}
    missing: list[str] = []
    for c in claims(sentence):
        refs = {ref for ref, f in sources.items() if f.supports(c)}
        if refs:
            support[c.text] = refs
        elif not extra.supports(c):
            missing.append(c.text)
    return SentenceCheck(not missing, support, missing)


def split_sentences(text: str) -> tuple[list[str], str]:
    """Complete sentences (each with its trailing space / newline) and the unfinished rest."""
    out: list[str] = []
    start = 0
    for m in _SENT_END.finditer(text):
        if m.start() < start:
            continue
        end = m.end()
        while end < len(text) and text[end] in " \t":
            end += 1
        if m.group(0)[0] == "." and _ABBREV.search(text[start:m.start() + 1]):
            if end >= len(text):
                break  # «5 тыс.» or the end of a sentence: the next letter tells, wait for it
            if not text[end].isupper():
                continue
        out.append(text[start:end])
        start = end
    return out, text[start:]


def short_date(d: datetime | date) -> str:
    """«3 ноя» - for source chips."""
    return f"{d.day} {_SHORT_MONTHS[d.month - 1]}"


def merge(facts: Iterable[Facts]) -> Facts:
    out = Facts()
    for f in facts:
        out.update(f)
    return out
