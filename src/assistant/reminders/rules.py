"""Rules-first parser of simple Russian reminder phrases (spec 6.6, founder decision Ф-1).

Deterministic, no network, no model: «завтра в 10», «через 2 часа», «каждый понедельник в 9»,
«15-го», «за час», «накануне», «в 7 вечера», «по будням в 8:30». The phone runs a port of the
same rules; both are checked against `docs/api/reminder-parse-vectors.json`.

The parser only answers when it is sure. Anything it does not fully account for (another time
word left in the text, two dates, an offset outside the allowed set, «на выходных», «после
обеда», Kazakh) returns None, and the caller sends the phrase to the model or the manual form.
It is used only when `settings.reminders_rules_first` is on (Ф-1 is open; off by default).

`parse(text, now, tz)` returns a `RulesResult` with one reading, or two for «в 7» (7:00 or
19:00, likelier first). Past times are the caller's business (assistant.reminders.parse).
"""

import re
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from dateutil.relativedelta import relativedelta
from dateutil.rrule import rrulestr

ALLOWED_OFFSETS = (15, 60, 1440)
DEFAULT_TIME = time(9, 0)  # «утром» / no time said (habit default_time «утром = 9:00»)
DAYPART_TIME = {"утром": time(9, 0), "днем": time(13, 0), "вечером": time(19, 0)}
LOUD_RE = re.compile(r"\b(разбуди\w*|обязательно|не дай(те)? (мне )?забыть|будильник\w*)\b")

_NUM_WORDS = {
    "один": 1, "одну": 1, "одна": 1, "два": 2, "две": 2, "три": 3, "четыре": 4, "пять": 5,
    "шесть": 6, "семь": 7, "восемь": 8, "девять": 9, "десять": 10, "одиннадцать": 11,
    "двенадцать": 12, "пятнадцать": 15, "двадцать": 20, "тридцать": 30, "сорок": 40,
}  # fmt: skip
NUM = r"(\d{1,2}|" + "|".join(sorted(_NUM_WORDS, key=len, reverse=True)) + r")"

WEEKDAYS = {  # stem -> (index Mon=0, RRULE code)
    "понедельник": (0, "MO"), "вторник": (1, "TU"), "сред": (2, "WE"), "четверг": (3, "TH"),
    "пятниц": (4, "FR"), "суббот": (5, "SA"), "воскресен": (6, "SU"),
}  # fmt: skip
_WD = r"(понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье)"
_WD_PL = r"(понедельникам|вторникам|средам|четвергам|пятницам|субботам|воскресеньям)"
MONTHS = {
    "января": 1, "февраля": 2, "марта": 3, "апреля": 4, "мая": 5, "июня": 6, "июля": 7,
    "августа": 8, "сентября": 9, "октября": 10, "ноября": 11, "декабря": 12,
}  # fmt: skip
_MONTH = "(" + "|".join(MONTHS) + ")"
_B = r"(?<![\w-])"  # word start (Cyrillic-aware: \b treats '-' as a boundary)
_E = r"(?![\w])"
# After «в 2»: a count of something, not an hour.
_NOT_COUNT = (r"(?!\s*(раз|человек|штук|шт|кг|кило|литр|л(?![\w])|рубл|тенге|тг|₸|%|процент|этаж|"
              r"класс|квартир|кабинет|дом|подъезд|см(?![\w])|мм(?![\w])|метр|грамм|г(?![\w])|"
              r"экземпляр|копи|упаков|пач|бутыл|таблет|капсул|ложк|стакан|недел|"
              r"месяц|год|лет|мин|ряд|очеред|групп|окн|двер))")


def _num(token: str) -> int:
    return int(token) if token.isdigit() else _NUM_WORDS[token]


def _wd(word: str) -> tuple[int, str]:
    return next(v for stem, v in WEEKDAYS.items() if word.startswith(stem))


@dataclass(frozen=True)
class Reading:
    """One understood reading on the local clock of `tz`."""

    title: str
    local_date: date
    local_time: time
    rrule: str | None
    offsets: tuple[int, ...]
    loud: bool
    time_assumed: bool  # no time in the phrase: DEFAULT_TIME (or the next hour today)


@dataclass(frozen=True)
class RulesResult:
    readings: tuple[Reading, ...]  # 1, or 2 for an ambiguous bare hour (likelier first)

    @property
    def ambiguous(self) -> bool:
        return len(self.readings) > 1


@dataclass
class _Found:
    spans: list[tuple[int, int]] = field(default_factory=list)
    rel: timedelta | None = None  # «через 2 часа» (exact moment)
    rel_days: int | None = None  # «через 3 дня» (date only)
    day: date | None = None
    weekday: int | None = None
    month_day: int | None = None  # «15-го» (this or next month)
    hour: int | None = None
    minute: int = 0
    daypart: str | None = None  # утра | дня | вечера | ночи
    fixed_clock: bool = False  # «19:30», «07:00» - no am/pm question
    time_default: time | None = None  # «утром», «каждый вечер»
    rrule_kind: str | None = None  # daily | weekly | monthly
    rrule_days: list[str] = field(default_factory=list)
    rrule_monthday: int | None = None
    offsets: list[int] = field(default_factory=list)
    dates: int = 0
    times: int = 0


# Phrase starts that are not part of the title.
_TRIGGER = re.compile(
    r"^\s*(пожалуйста\s+)?(напомни(те)?|напоминание|поставь(те)?(\s+мне)?\s+(будильник|напоминание)"
    r"|разбуди(те)?(\s+меня)?|не дай(те)?(\s+мне)?\s+забыть|будильник)(\s+мне)?(\s+пожалуйста)?"
    r"[\s,:]*"
)
_FILLER = re.compile(
    r"^(,?\s*(что|чтобы|о том,? что|о том,? чтобы|про|о|об|мне|пожалуйста|надо|нужно)\s+)+"
)
# Left over after the known parts: another time word we did not read -> not sure, give up.
_RISKY = re.compile(
    r"(?<![\w])(утро|утра|утром|вечер|вечера|вечером|ночь|ночи|ночью|дн[её]м|полдень|полночь|"
    r"после|перед|выходн\w*|конце|конца|начале|начала|следующ\w*|недел\w*|месяц\w*|"
    r"год|года|году|числа|число|час|часа|часов|часам|часу|минут\w*|сутк\w*|"
    r"сегодня|завтра|послезавтра|понедельник\w*|вторник\w*|сред[ауы]|среда|четверг\w*|"
    r"пятниц\w*|суббот\w*|воскресень\w*|" + "|".join(MONTHS) + r"|январ\w*|феврал\w*|"
    r"март|апрел\w*|май|июн\w*|июл\w*|август|сентябр\w*|октябр\w*|ноябр\w*|декабр\w*|"
    r"кажд\w*|ежедневн\w*|будням|накануне|через|\d{1,2}[:.]\d{2})(?![\w])"
)


def _normalize(text: str) -> str:
    # Same length as the input (title spans are cut from the original).
    return text.lower().replace("ё", "е")


class _Scan:
    def __init__(self, low: str) -> None:
        self.low = low
        self.f = _Found()
        self.taken = [False] * len(low)

    def take(self, pattern: str) -> list[re.Match[str]]:
        out = []
        for m in re.finditer(pattern, self.low):
            if any(self.taken[m.start():m.end()]):
                continue
            for i in range(m.start(), m.end()):
                self.taken[i] = True
            self.f.spans.append((m.start(), m.end()))
            out.append(m)
        return out


def _scan(low: str) -> _Found | None:  # noqa: C901 - one rule per phrase shape, kept flat
    s = _Scan(low)
    f = s.f

    # --- repeats ---
    for m in s.take(_B + r"(каждый|каждое|каждую)\s+(день|утро|вечер)" + _E):
        f.rrule_kind = "daily"
        f.time_default = {"утро": time(9, 0), "вечер": time(19, 0)}.get(m.group(2))
    for _ in s.take(_B + r"ежедневно" + _E):
        f.rrule_kind = "daily"
    wd_list = _WD + r"((\s*,\s*|\s+и\s+)" + _WD + r")*"
    for m in s.take(_B + r"(каждый|каждую|каждое)\s+" + wd_list + _E):
        f.rrule_kind = "weekly"
        f.rrule_days += [_wd(w)[1] for w in re.findall(_WD, m.group(0))]
    for m in s.take(_B + r"по\s+" + _WD_PL + r"((\s*,\s*|\s+и\s+)" + _WD_PL + r")*" + _E):
        f.rrule_kind = "weekly"
        f.rrule_days += [_wd(w)[1] for w in re.findall(_WD_PL, m.group(0))]
    for _ in s.take(_B + r"по\s+будням" + _E):
        f.rrule_kind = "weekly"
        f.rrule_days += ["MO", "TU", "WE", "TH", "FR"]
    for _ in s.take(_B + r"по\s+выходным" + _E):
        f.rrule_kind = "weekly"
        f.rrule_days += ["SA", "SU"]
    for _ in s.take(_B + r"(каждую\s+неделю|еженедельно)" + _E):
        f.rrule_kind = "weekly"
    for m in s.take(_B + r"(каждое|каждого)\s+(\d{1,2})(-?е|-?го)?(\s+(число|числа))?" + _E):
        f.rrule_kind = "monthly"
        f.rrule_monthday = int(m.group(2))
    for _ in s.take(_B + r"(каждый\s+месяц|ежемесячно)" + _E):
        f.rrule_kind = "monthly"

    # --- offsets (before the moment: «за час», «накануне») ---
    for m in s.take(_B + r"за\s+(" + NUM + r"\s+)?(минуту|минуты|минут|мин|час|часа|часов|день|"
                    r"сутки)" + _E):  # fmt: skip
        n = _num(m.group(2)) if m.group(2) else 1
        unit = m.group(3)
        f.offsets.append(n * (1 if unit.startswith("мин") else 60 if unit.startswith("час")
                              else 1440))  # fmt: skip
    for _ in s.take(_B + r"за\s+полчаса" + _E):
        f.offsets.append(30)
    for _ in s.take(_B + r"накануне" + _E):
        f.offsets.append(1440)

    # --- relative («через 2 часа», «через 3 дня») ---
    for m in s.take(_B + r"через\s+(" + NUM + r"\s+)?(минуту|минуты|минут|мин|час|часа|часов|"
                    r"день|дня|дней|неделю|недели|недель)" + _E):  # fmt: skip
        n = _num(m.group(2)) if m.group(2) else 1
        unit = m.group(3)
        f.dates += 1
        if unit.startswith("мин"):
            f.rel = timedelta(minutes=n)
            f.times += 1
        elif unit.startswith("час"):
            f.rel = timedelta(hours=n)
            f.times += 1
        else:
            f.rel_days = n * (7 if unit.startswith("недел") else 1)
    for m in s.take(_B + r"через\s+(полчаса|полтора\s+часа)" + _E):
        f.rel = timedelta(minutes=30 if m.group(1) == "полчаса" else 90)
        f.dates += 1
        f.times += 1

    # --- clock with a prefix first: «в 7.30» is a time, a bare «15.11» a date ---
    for m in s.take(_B + r"(в|к|на)\s+(\d{1,2})[:.](\d{2})(\s+(утра|дня|вечера|ночи))?" + _E):
        f.times += 1
        f.hour, f.minute = int(m.group(2)), int(m.group(3))
        f.daypart = m.group(5)
        f.fixed_clock = f.daypart is None

    # --- dates ---
    for m in s.take(_B + r"(сегодня|завтра|послезавтра)" + _E):
        f.dates += 1
        f.rel_days = {"сегодня": 0, "завтра": 1, "послезавтра": 2}[m.group(1)]
    for m in s.take(_B + r"(в|во)\s+" + _WD + _E):
        f.dates += 1
        f.weekday = _wd(m.group(2))[0]
    for m in s.take(_B + r"(\d{1,2})(-?го|-?е)?\s+" + _MONTH + r"(\s+(\d{4})(\s+(года|г\.?))?)?"
                    + _E):  # fmt: skip
        f.dates += 1
        try:
            f.day = date(int(m.group(5)) if m.group(5) else 4, MONTHS[m.group(3)], int(m.group(1)))
        except ValueError:
            return None
        if not m.group(5):
            f.day = f.day.replace(year=4)  # leap placeholder: year chosen later
    for m in s.take(_B + r"(\d{1,2})\.(\d{1,2})(\.(\d{4}|\d{2}))?" + _E):
        f.dates += 1
        year = m.group(4)
        try:
            y = (2000 + int(year) if len(year) == 2 else int(year)) if year else 4
            f.day = date(y, int(m.group(2)), int(m.group(1)))
        except ValueError:
            return None
    for m in s.take(_B + r"(\d{1,2})(-?го|-?е)(\s+(числа|число))?" + _E):
        f.dates += 1
        f.month_day = int(m.group(1))
    for m in s.take(_B + r"(\d{1,2})\s+(числа|число)" + _E):
        f.dates += 1
        f.month_day = int(m.group(1))

    # --- times ---
    # «в 7», «к 10 часам», «в 3 часа дня», «на 7 утра»; not «в 2 раза», «на 2 человека».
    for m in s.take(_B + r"((в|к)\s+" + NUM + r"|на\s+" + NUM
                    + r"(?=\s+(час|утра|дня|вечера|ночи)))(\s+(час|часа|часов|часам))?"
                    r"(\s+(\d{1,2}|тридцать|пятнадцать|сорок пять)\s+"
                    r"(минут|мин))?(\s+(утра|дня|вечера|ночи))?" + _E + _NOT_COUNT):  # fmt: skip
        f.times += 1
        hour = m.group(3) or m.group(4)
        f.hour = _num(hour)
        if m.group(9):
            f.minute = 45 if m.group(9) == "сорок пять" else _num(m.group(9))
        f.daypart = m.group(12)
        if hour.isdigit() and len(hour) == 2 and hour.startswith("0"):
            f.fixed_clock = True  # «в 07»
    for m in s.take(_B + r"(в\s+)?(полдень|полночь)" + _E):
        f.times += 1
        f.hour, f.minute, f.fixed_clock = (12 if m.group(2) == "полдень" else 0), 0, True
    for m in s.take(_B + r"(утром|днем|вечером)" + _E):
        f.times += 1
        f.time_default = DAYPART_TIME[m.group(1)]
    # «в 7 утра» was read above; a lone «утра» after a time («в 7, утра») is not.
    return f


def _clock(f: _Found) -> list[time] | None:
    """Candidate times on the local clock; None = the hour makes no sense."""
    if f.hour is None:
        return [f.time_default] if f.time_default else []
    h, mnt = f.hour, f.minute
    if not (0 <= h <= 23 and 0 <= mnt <= 59):
        return None
    part = f.daypart
    if part == "утра":
        if not 4 <= h <= 11:
            return None
        return [time(h, mnt)]
    if part == "дня":
        if h == 12:
            return [time(12, mnt)]
        if 1 <= h <= 6:
            return [time(h + 12, mnt)]
        if 12 <= h <= 18:
            return [time(h, mnt)]
        return None
    if part == "вечера":
        if 4 <= h <= 11:
            return [time(h + 12, mnt)]
        if 16 <= h <= 23:
            return [time(h, mnt)]
        return None
    if part == "ночи":
        if h == 12:
            return [time(0, mnt)]
        if 0 <= h <= 4:
            return [time(h, mnt)]
        return None
    if f.fixed_clock or h == 0 or h >= 12:
        return [time(h, mnt)]
    # Bare «в 7»: 7:00 or 19:00 (design 6.4). 1–6 is more often the afternoon/evening.
    am, pm = time(h, mnt), time(h + 12, mnt)
    return [pm, am] if h <= 6 else [am, pm]


def _title(original: str, spans: list[tuple[int, int]]) -> str:
    chars = list(original)
    for a, b in spans:
        for i in range(a, b):
            chars[i] = " "
    text = "".join(chars)
    m = _TRIGGER.match(_normalize(text))
    if m:
        text = text[m.end():]
    # a trigger word left in the middle («концерт, напомни накануне»)
    text = re.sub(r"(?<![\w])[Нн]апомни(те)?(\s+мне)?(?![\w])", " ", text)
    text = re.sub(r"\s+", " ", text).strip(" ,.;:!-—")
    text = re.sub(r"\s+([,.!?])", r"\1", text)
    text = re.sub(r"(^|\s)(,\s*)+", r"\1", text).strip(" ,.;:!-—")
    while True:
        m = _FILLER.match(_normalize(text) + " ")
        if not m or m.end() == 0:
            break
        text = text[min(m.end(), len(text)):].strip(" ,")
    text = re.sub(r"\s+(и|в|во|к|на|за|,)$", "", text).strip(" ,.;:!-—")
    return text[:1].upper() + text[1:] if text else ""


def _rrule(f: _Found, start: date) -> str | None:
    if f.rrule_kind == "daily":
        return "FREQ=DAILY"
    if f.rrule_kind == "weekly":
        days = list(dict.fromkeys(f.rrule_days)) or [list(WEEKDAYS.values())[start.weekday()][1]]
        order = [code for _, code in WEEKDAYS.values()]
        return "FREQ=WEEKLY;BYDAY=" + ",".join(sorted(days, key=order.index))
    if f.rrule_kind == "monthly":
        md = f.rrule_monthday or start.day
        if not 1 <= md <= 31:
            return None
        return f"FREQ=MONTHLY;BYMONTHDAY={md}"
    return None


def first_occurrence(rrule: str, at: time, now_local: datetime) -> date | None:
    """First date on which `rrule` rings at `at` strictly after `now_local` (naive local)."""
    start = datetime.combine(now_local.date(), at)
    rule = rrulestr(rrule, dtstart=start - timedelta(days=1))
    nxt = rule.after(now_local, inc=False)
    return nxt.date() if nxt else None


def _resolve_date(f: _Found, at: time, now_local: datetime) -> date | None:
    today = now_local.date()
    later_today = datetime.combine(today, at) > now_local
    if f.rel_days is not None:
        return today + timedelta(days=f.rel_days)
    if f.weekday is not None:
        ahead = (f.weekday - today.weekday()) % 7
        if ahead == 0 and not later_today:
            ahead = 7
        return today + timedelta(days=ahead)
    if f.day is not None:
        if f.day.year != 4:
            return f.day
        for year in (today.year, today.year + 1):
            try:
                d = f.day.replace(year=year)
            except ValueError:  # 29 февраля
                continue
            if d > today or (d == today and later_today):
                return d
        return None
    if f.month_day is not None:
        if not 1 <= f.month_day <= 31:
            return None
        for k in range(0, 3):
            first = (today.replace(day=1) + relativedelta(months=k))
            try:
                d = first.replace(day=f.month_day)
            except ValueError:
                continue
            if d > today or (d == today and later_today):
                return d
        return None
    return today if later_today else today + timedelta(days=1)


# A day part said anywhere in the phrase settles «в 7» (RU, KK pending native review).
_DAYPART_ANY = re.compile(
    r"(?<![\w])(утром|утра|вечером|вечера|ночью|ночи|дн[её]м|полдень|полночь|после\s+обеда|"
    r"таңертең\w*|таңғы|таңда|кешке|кешкі|кеште|түнде|түнгі|түскі|түстен|күндіз\w*)(?![\w])")
# Kazakh hour: «сағат 7-де», «7-де», «сағат 7» (not «7:30-да», «18.11»; pending native review).
_KK_HOUR = re.compile(r"(?<![\w:.])(?:сағат\s+)?(\d{1,2})\s*-?\s*(?:де|да|те|та)(?![\w])"
                      r"|(?<![\w])сағат\s+(\d{1,2})(?![\w:.\d])")


def ambiguous_hour(text: str) -> list[time] | None:
    """The two readings of a bare hour in the person's own phrase, likelier first («в 7» →
    7:00 / 19:00; «в 3» → 15:00 / 3:00), or None when the phrase settles it: a day part (утра,
    вечером, таңертең, кешке…), the 24-hour form («в 19», «19:00», «в 07»), or no hour at all.
    Founder 2026-11-09: such an hour is always asked, so the model path uses this too
    (reminders.parse), whatever the model put in its fields. Same scanner and `_clock` as
    `parse`; Kazakh «сағат 7-де» is read by `_KK_HOUR` (the scanner is Russian only)."""
    low = _normalize(text)
    if _DAYPART_ANY.search(low):
        return None
    f = _scan(low)
    if f is not None and f.hour is not None:
        if f.times != 1 or f.time_default is not None:
            return None
        opts = _clock(f)
        return opts if opts is not None and len(opts) == 2 else None
    m = _KK_HOUR.search(low)
    if m is None:
        return None
    hour = m.group(1) or m.group(2)
    if hour.startswith("0") and len(hour) == 2:
        return None  # «07-де»: the 24-hour form
    opts = _clock(_Found(hour=int(hour)))
    return opts if opts is not None and len(opts) == 2 else None


def parse(text: str, now: datetime, tz: str) -> RulesResult | None:
    """Read a simple phrase, or None (not sure: the caller asks the model or shows the form)."""
    if not text or len(text) > 500:
        return None
    zone = ZoneInfo(tz)
    now_local = now.astimezone(zone).replace(tzinfo=None, second=0, microsecond=0)
    low = _normalize(text)
    f = _scan(low)
    if f is None:
        return None
    loud = bool(LOUD_RE.search(low))
    # Mark the loud words and the trigger as consumed for the leftover check (title keeps the
    # rest; «обязательно» is dropped from it).
    rest = low
    for a, b in f.spans:
        rest = rest[:a] + " " * (b - a) + rest[b:]
    trig = _TRIGGER.match(rest)
    if trig:
        rest = " " * trig.end() + rest[trig.end():]
    rest = re.sub(r"(?<![\w])обязательно(?![\w])", " ", rest)
    if _RISKY.search(rest):
        return None
    if f.dates == 0 and f.times == 0 and f.rrule_kind is None:
        return None
    if f.dates > 1 or f.times > 1:
        return None
    if any(o not in ALLOWED_OFFSETS for o in f.offsets) or len(set(f.offsets)) != len(f.offsets):
        return None
    if (f.rrule_kind == "monthly" and f.month_day and not f.rrule_monthday and f.dates == 1
            and f.day is None and f.weekday is None and f.rel_days is None):  # fmt: skip
        f.rrule_monthday, f.month_day, f.dates = f.month_day, None, 0  # «каждый месяц 5-го»
    if f.rrule_kind and (f.dates or f.rel is not None):
        return None  # «каждый понедельник завтра»: not sure what is meant
    if f.rrule_kind == "weekly" and f.rrule_monthday:
        return None

    spans = f.spans + [(m.start(), m.end()) for m in
                       re.finditer(r"(?<![\w])обязательно(?![\w])", low)]  # fmt: skip
    title = _title(text, spans)
    if not title:
        title = "Подъём" if re.search(r"разбуди|будильник", low) else "Напоминание"
    offsets = tuple(sorted(set(f.offsets)))

    if f.rel is not None:  # exact moment from now
        if f.hour is not None or f.time_default or f.rel_days is not None:
            return None
        moment = now_local + f.rel
        return RulesResult((Reading(title, moment.date(), moment.time(), None, offsets, loud,
                                    False),))  # fmt: skip

    clocks = _clock(f)
    if clocks is None:
        return None
    time_assumed = not clocks
    if not clocks:
        clocks = [DEFAULT_TIME]
    if offsets and time_assumed:
        return None  # «за час» without a time: before what?

    readings: list[Reading] = []
    for at in clocks:
        if f.rrule_kind:
            rule = _rrule(f, now_local.date())
            if rule is None:
                return None
            day = first_occurrence(rule, at, now_local)
            if day is None:
                return None
            readings.append(Reading(title, day, at, rule, offsets, loud, time_assumed))
            continue
        # A said date is one day for every option («8 ноября в 9» today: 21:00, not next year);
        # with no date each option takes its own next day («в 7» at 10:00: 19:00 today, 7:00
        # tomorrow).
        day = _resolve_date(f, max(clocks) if f.dates else at, now_local)
        if day is None:
            return None
        if time_assumed and day == now_local.date() and datetime.combine(day, at) <= now_local:
            nxt = (now_local + timedelta(hours=1)).replace(minute=0)
            if nxt.date() != day:
                return None
            at = nxt.time()
        readings.append(Reading(title, day, at, None, offsets, loud, time_assumed))

    if len(readings) == 2:
        # «сегодня в 7» at 10:00: only 19:00 is still ahead.
        ahead = [r for r in readings
                 if datetime.combine(r.local_date, r.local_time) > now_local]  # fmt: skip
        if len(ahead) == 1:
            readings = ahead
        elif f.dates == 0 and not f.rrule_kind:
            # no date said: the sooner one first («в 7» at 10:00 -> 19:00 today, 7:00 tomorrow)
            readings.sort(key=lambda r: datetime.combine(r.local_date, r.local_time))
    return RulesResult(tuple(readings))
