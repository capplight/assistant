"""Time in words (Ф-89 part 1): «через 2 часа», «в обед», «после работы», «в следующий вторник
вечером», «послезавтра в 9», «к концу дня», «через неделю» and the Kazakh ones, read by code on the
person's local clock. Pure code, no DB, no model («ИИ понимает — скрипт делает»: the model may say
that a phrase is a reminder or a to-do, the moment is computed here).

`TIME_DEFAULTS` is the ONE place for the times of the vague parts of a day («утром», «в обед»,
«вечером»…). Reminders (`reminders.rules`, `reminders.parse`), to-dos (`tasks.parse`) and the
assistant line read them from here; the designer's calendar notes may move them
(`docs/design/system/calendar-time.md`), then only this table changes.

`read(text, now_local)` → `TimeRead` or None (no time words, or two that disagree: then the
caller keeps its own reading). `settle(read, now_local)` → `Settled`: one moment, or a short
question with choices when the time is genuinely unclear — a bare «в 7» (7:00 or 19:00), or a
time today that has already passed. Code never schedules into the past silently.

Kazakh words are a first list pending native review (R-39), like `reminders.rules`.
"""

import re
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta

# --- the one config place: what a vague part of the day means ---------------------------------
TIME_DEFAULTS: dict[str, time] = {
    "morning": time(9, 0),  # утром, с утра, таңертең
    "lunch": time(13, 0),  # в обед, түсте
    "afternoon": time(14, 0),  # днём, после обеда, күндіз
    "evening": time(19, 0),  # вечером, кешке
    "after_work": time(18, 30),  # после работы, жұмыстан кейін
    "night": time(22, 0),  # ночью, түнде
    "end_of_day": time(18, 0),  # к концу дня, күн соңына дейін
    # calendar-time.md §10.1 (designer)
    "early_morning": time(7, 0),  # рано утром
    "before_lunch": time(11, 0),  # до обеда
    "late_evening": time(22, 0),  # перед сном, поздно вечером
}
# Which half of the day a bare hour said with a part of the day is in («вечером в 7» → 19:00).
_PM_PARTS = frozenset({"lunch", "afternoon", "evening", "after_work", "end_of_day",
                       "late_evening"})  # fmt: skip
# How long a to-do with a time lasts when the phrase does not say (calendar-time.md §5).
DEFAULT_DURATION_MIN = 60
DEFAULT_DURATIONS: tuple[tuple[str, int], ...] = (
    (r"созвон|звон|қоңырау", 30),  # звонок, позвонить, созвон
    (r"встреч|визит|при[её]м|урок|тренировк|заняти|кездесу", 60),
)
ROUND_REL_MIN = 5  # «через 20 минут»: rounded up to 5 minutes
# How long a part of the day goes on: «вечером» said at 21:00 may still mean tonight.
PART_LASTS = timedelta(hours=3)
# Parts that mean «today» when no day is said («к концу дня»: of this day).
_TODAY_PARTS = frozenset({"end_of_day"})

WEEKDAY_STEMS = {  # RU accusative / KK names → Mon=0
    "понедельник": 0, "вторник": 1, "сред": 2, "четверг": 3, "пятниц": 4, "суббот": 5,
    "воскресен": 6, "дүйсенбі": 0, "сейсенбі": 1, "сәрсенбі": 2, "бейсенбі": 3, "жұма": 4,
    "сенбі": 5, "жексенбі": 6,
}  # fmt: skip
_NUM_WORDS = {
    "один": 1, "одну": 1, "одна": 1, "два": 2, "две": 2, "три": 3, "четыре": 4, "пять": 5,
    "шесть": 6, "семь": 7, "восемь": 8, "девять": 9, "десять": 10, "одиннадцать": 11,
    "двенадцать": 12, "пятнадцать": 15, "двадцать": 20, "тридцать": 30, "сорок": 40,
    "бір": 1, "екі": 2, "үш": 3, "төрт": 4, "бес": 5, "алты": 6, "жеті": 7, "сегіз": 8,
    "тоғыз": 9, "он": 10,
}  # fmt: skip
_NUM = r"(\d{1,2}|" + "|".join(sorted(_NUM_WORDS, key=len, reverse=True)) + r")"
_B = r"(?<![\w-])"
_E = r"(?![\w])"
_WD_RU = r"(понедельник|вторник|среду|четверг|пятницу|субботу|воскресенье)"
_WD_KK = r"(дүйсенбі|сейсенбі|сәрсенбі|бейсенбі|жұма|сенбі|жексенбі)"
# After «в 2»: a count of something, not an hour (same list as reminders.rules).
_NOT_COUNT = (r"(?!\s*(раз|человек|штук|шт|кг|кило|литр|л(?![\w])|рубл|тенге|тг|₸|%|процент|этаж|"
              r"класс|квартир|кабинет|дом|подъезд|см(?![\w])|мм(?![\w])|метр|грамм|г(?![\w])|"
              r"экземпляр|копи|упаков|пач|бутыл|таблет|капсул|ложк|стакан|недел|"
              r"месяц|год|лет|мин|ряд|очеред|групп|окн|двер))")

# (pattern, part key) — longer phrases first
_PARTS: list[tuple[str, str]] = [
    (r"(к|до)\s+концу\s+(рабочего\s+)?дня|в\s+конце\s+(рабочего\s+)?дня", "end_of_day"),
    (r"(күннің|күн)\s+соңына\s+(дейін|шейін)", "end_of_day"),
    (r"после\s+работы|жұмыстан\s+(кейін|соң)", "after_work"),
    (r"перед\s+сном|поздно\s+вечером", "late_evening"),
    (r"рано\s+утром|рано\s+с\s+утра", "early_morning"),
    (r"до\s+обеда|түске\s+дейін", "before_lunch"),
    (r"после\s+обеда|түстен\s+(кейін|соң)", "afternoon"),
    (r"(в|на)\s+обед|в\s+обеденное\s+время|түсте|түскі\s+ас(та|қа)?", "lunch"),
    (r"с\s+утра|утром|таңертең\w*|таңда", "morning"),
    (r"дн[её]м(?!\s+рожд)|күндіз\w*", "afternoon"),
    (r"вечером|кешке|кеште|кешқұрым", "evening"),
    (r"ночью|түнде", "night"),
]
_SUFFIX_PART = {"утра": "morning", "дня": "afternoon", "вечера": "evening", "ночи": "night"}


def _norm(text: str) -> str:
    """Same length as the input: spans are cut from the original."""
    return text.lower().replace("ё", "е")


def _num(token: str) -> int:
    return int(token) if token.isdigit() else _NUM_WORDS[token]


@dataclass(frozen=True)
class TimeRead:
    """What the phrase says about when, on the local clock."""

    day: date | None = None  # the day it names (resolved), None when it names none
    day_said: bool = False  # «сегодня», «завтра», «во вторник», «через неделю»…
    today_said: bool = False  # «сегодня» / «бүгін» / «к концу дня» itself
    weekday_said: bool = False  # «во вторник»: today's weekday already past → next week
    hour: int | None = None  # a said hour («в 7», «в 19:30»)
    minute: int = 0
    fixed: bool = False  # 24-hour form or a part of the day settles am/pm
    part: str | None = None  # TIME_DEFAULTS key of a vague part («в обед»)
    rel: timedelta | None = None  # «через 2 часа»: an exact moment from now
    spans: tuple[tuple[int, int], ...] = ()
    day_spans: tuple[tuple[int, int], ...] = ()  # the day words only (a to-do's title drops them)
    duration_min: int | None = None  # «на час», «с 15 до 16:30», «на 30 минут»
    weekend: bool = False  # «на выходных»: a day, no time

    @property
    def has_time(self) -> bool:
        return self.hour is not None or self.part is not None or self.rel is not None

    def times(self) -> list[time]:
        """Candidate clock times, likelier first: 0 (no time), 1, or 2 (a bare «в 7»)."""
        if self.hour is None:
            return [TIME_DEFAULTS[self.part]] if self.part else []
        h, m = self.hour, self.minute
        if self.part is not None and h < 12:
            if self.part in _PM_PARTS and 1 <= h <= 11:
                return [time(h + 12, m)]
            if self.part == "night":
                return [time(h + 12, m)] if 8 <= h <= 11 else [time(h % 12, m)]
            return [time(h, m)]
        if self.fixed or h == 0 or h >= 12:
            return [time(h % 24, m)]
        am, pm = time(h, m), time(h + 12, m)
        return [pm, am] if h <= 6 else [am, pm]  # 1–6 is more often the afternoon


@dataclass
class _Scan:
    low: str
    taken: list[bool] = field(default_factory=list)
    spans: list[tuple[int, int]] = field(default_factory=list)
    day_spans: list[tuple[int, int]] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.taken = [False] * len(self.low)

    def take(self, pattern: str, *, day: bool = False) -> list[re.Match[str]]:
        out = []
        for m in re.finditer(pattern, self.low):
            if any(self.taken[m.start():m.end()]):
                continue
            for i in range(m.start(), m.end()):
                self.taken[i] = True
            self.spans.append((m.start(), m.end()))
            if day:
                self.day_spans.append((m.start(), m.end()))
            out.append(m)
        return out


def _weekday(word: str) -> int:
    return next(v for stem, v in WEEKDAY_STEMS.items() if word.startswith(stem))


def read(text: str, now_local: datetime) -> TimeRead | None:  # noqa: C901 - one rule per shape
    """The time words of the phrase, or None (none at all, or two days / two times that
    disagree: not sure). `now_local` is naive, on the person's clock."""
    if not text or len(text) > 500:
        return None
    s = _Scan(_norm(text))
    today = now_local.date()
    days: list[date] = []
    today_said = weekday_said = False
    rel: timedelta | None = None
    hours: list[tuple[int, int, bool, str | None]] = []  # hour, minute, fixed, suffix part
    parts: list[str] = []

    # --- relative moment / days
    for m in s.take(_B + r"через\s+(" + _NUM + r"\s+)?(минуту|минуты|минут|мин|час|часа|часов)"
                    + _E):  # fmt: skip
        n = _num(m.group(2)) if m.group(2) else 1
        rel = timedelta(minutes=n) if m.group(3).startswith("мин") else timedelta(hours=n)
    for m in s.take(_B + r"через\s+(полчаса|полтора\s+часа|пол\s+часа)" + _E):
        rel = timedelta(minutes=90 if "полтора" in m.group(1) else 30)
    for _ in s.take(_B + r"жарты\s+сағаттан\s+(кейін|соң)" + _E):
        rel = timedelta(minutes=30)
    for m in s.take(_B + r"(" + _NUM + r"\s+)?(сағаттан|минуттан)\s+(кейін|соң)" + _E):
        n = _num(m.group(2)) if m.group(2) else 1
        rel = timedelta(hours=n) if m.group(3).startswith("сағат") else timedelta(minutes=n)
    for m in s.take(_B + r"через\s+(" + _NUM + r"\s+)?(день|дня|дней|неделю|недели|недель)" + _E,
                    day=True):
        n = _num(m.group(2)) if m.group(2) else 1
        days.append(today + timedelta(days=n * (7 if m.group(3).startswith("недел") else 1)))
    for m in s.take(_B + r"(" + _NUM + r"\s+)?(күннен|аптадан)\s+(кейін|соң)" + _E, day=True):
        n = _num(m.group(2)) if m.group(2) else 1
        days.append(today + timedelta(days=n * (7 if m.group(3) == "аптадан" else 1)))

    # --- day words
    for m in s.take(_B + r"(на\s+)?(сегодня|завтра|послезавтра|бүгін|ертең|бүрсігүні|бүрсүгүні)"
                    + _E, day=True):
        k = {"сегодня": 0, "бүгін": 0, "завтра": 1, "ертең": 1}.get(m.group(2), 2)
        days.append(today + timedelta(days=k))
        today_said |= k == 0
    for m in s.take(_B + r"(в|во)\s+(следующ(ий|ую|ее)|эт(от|у|о))\s+" + _WD_RU + _E
                    + r"|" + _B + r"(келесі|осы)\s+" + _WD_KK + r"(\s*(күні|-?де|-?да|-?те|-?та))?"
                    + _E, day=True):  # fmt: skip
        word = m.group(5) or m.group(7)
        nxt = m.group(2) is not None and m.group(2).startswith("следующ") or m.group(6) == "келесі"
        wd = _weekday(word)
        weekday_said = True
        if nxt:  # «в следующий вторник»: the Tuesday of next week
            monday = today + timedelta(days=7 - today.weekday())
            days.append(monday + timedelta(days=wd))
        else:  # «в эту пятницу»
            days.append(today + timedelta(days=(wd - today.weekday()) % 7))
    for m in s.take(_B + r"(в|во)\s+" + _WD_RU + _E
                    + r"|" + _B + _WD_KK + r"(\s*(күні|-?де|-?да|-?те|-?та))" + _E,
                    day=True):  # fmt: skip
        word = m.group(2) or m.group(3)
        weekday_said = True
        ahead = (_weekday(word) - today.weekday()) % 7
        days.append(today + timedelta(days=ahead))  # today's weekday: today (if still ahead)

    weekend = False
    for _ in s.take(_B + r"(на\s+выходных|в\s+выходные|демалыста)" + _E, day=True):
        weekend = True  # the nearest Saturday (today on a weekend), all day
        days.append(today + timedelta(days=0 if today.weekday() >= 5 else 5 - today.weekday()))

    # --- how long: «с 15 до 16:30», «на час», «на 2 часа», «на 30 минут», «2 сағатқа»
    durations: list[int] = []
    ends: list[tuple[int, int]] = []
    for m in s.take(_B + r"с\s+(\d{1,2})(?:[:.](\d{2}))?\s+до\s+(\d{1,2})(?:[:.](\d{2}))?" + _E):
        sh, sm = int(m.group(1)), int(m.group(2) or 0)
        eh, em = int(m.group(3)), int(m.group(4) or 0)
        fixed_start = sh >= 12 or (m.group(1).startswith("0") and len(m.group(1)) == 2)
        if not fixed_start and eh >= 13 and sh + 12 <= eh:
            sh, fixed_start = sh + 12, True  # «с 3 до 17»: 15:00
        hours.append((sh, sm, fixed_start, None))
        ends.append((eh, em))
    for m in s.take(_B + r"на\s+(полчаса|пол\s+часа|полтора\s+часа|час|сутки)" + _E):
        durations.append({"час": 60, "сутки": 1440, "полтора часа": 90}.get(
            " ".join(m.group(1).split()), 30))
    for m in s.take(_B + r"на\s+" + _NUM + r"\s+(час|часа|часов|ч|минут|минуты|мин)" + _E
                    + r"(?!\s+(утра|дня|вечера|ночи))"):  # fmt: skip
        n = _num(m.group(1))
        durations.append(n if m.group(2).startswith("мин") else n * 60)
    for m in s.take(_B + r"(" + _NUM + r"\s+)?(сағатқа|минутқа)" + _E):
        n = _num(m.group(2)) if m.group(2) else 1
        durations.append(n * 60 if m.group(3) == "сағатқа" else n)

    # --- clock: «в 9:30», «к 19.00», «19:30», «сағат 9:30-да»
    for m in s.take(_B + r"((в|к|на|до)\s+|сағат\s+)?(\d{1,2}):(\d{2})(\s*-?\s*(да|де|та|те))?"
                    r"(\s+(утра|дня|вечера|ночи))?" + _E):  # fmt: skip
        hours.append((int(m.group(3)), int(m.group(4)), m.group(8) is None,
                      _SUFFIX_PART.get(m.group(8) or "")))  # fmt: skip
    for m in s.take(_B + r"(в|к|до)\s+(\d{1,2})\.(\d{2})(\s+(утра|дня|вечера|ночи))?" + _E):
        hours.append((int(m.group(2)), int(m.group(3)), m.group(5) is None,
                      _SUFFIX_PART.get(m.group(5) or "")))  # fmt: skip
    # «в 7», «к 10 часам», «в 3 часа дня», «на 7 утра»; not «в 2 раза»
    for m in s.take(_B + r"((в|к|до)\s+" + _NUM + r"|на\s+" + _NUM
                    + r"(?=\s+(час|утра|дня|вечера|ночи)))(\s+(час|часа|часов|часам))?"
                    r"(\s+(\d{1,2}|тридцать|пятнадцать|сорок пять)\s+(минут|мин))?"
                    r"(\s+(утра|дня|вечера|ночи))?" + _E + _NOT_COUNT):  # fmt: skip
        hour = m.group(3) or m.group(4)
        minute = 0
        if m.group(9):
            minute = 45 if m.group(9) == "сорок пять" else _num(m.group(9))
        suffix = m.group(12)
        fixed = hour.isdigit() and len(hour) == 2 and hour.startswith("0")
        hours.append((_num(hour), minute, fixed, _SUFFIX_PART.get(suffix or "")))
    # Kazakh hour: «сағат 7-де», «7-де», «сағат 7»
    for m in s.take(_B + r"(сағат\s+)?(\d{1,2})\s*-?\s*(де|да|те|та)" + _E
                    + r"|" + _B + r"сағат\s+(\d{1,2})" + _E):  # fmt: skip
        hour = m.group(2) or m.group(4)
        hours.append((int(hour), 0, len(hour) == 2 and hour.startswith("0"), None))
    for m in s.take(_B + r"(в\s+)?(полдень|полночь|түс\s+кезінде)" + _E):
        hours.append((0 if m.group(2) == "полночь" else 12, 0, True, None))

    # --- parts of the day (after the clock, so «в 7 вечера» was read as one)
    for pattern, key in _PARTS:
        for _ in s.take(_B + r"(" + pattern + r")" + _E):
            parts.append(key)

    if len(set(days)) > 1 or len(set(hours)) > 1 or len(set(parts)) > 1:
        return None  # «завтра в пятницу», «в 7 и в 9»: not sure
    if rel is not None and (days or hours or parts):
        return None  # «через 2 часа завтра»
    if not (days or hours or parts or rel):
        return None
    part = parts[0] if parts else None
    hour = minute = None
    fixed = False
    if hours:
        hour, minute, fixed, suffix = hours[0]
        if suffix is not None:
            if part is not None and part != suffix and not (
                    suffix == "afternoon" and part in _PM_PARTS):  # fmt: skip
                return None  # «утром в 7 вечера»
            part = part or suffix
        if not (0 <= hour <= 23 and 0 <= minute <= 59):
            return None
    if part in _TODAY_PARTS and not days:
        today_said = True
    if len(set(durations)) > 1 or len(ends) > 1 or (durations and ends):
        return None  # «на час с 15 до 17»: not sure
    duration = durations[0] if durations else None
    if ends and hour is not None:
        duration = ends[0][0] * 60 + ends[0][1] - (hour * 60 + (minute or 0))
        if duration <= 0:
            duration += 720  # «с 11 до 1»: to 13:00
    if duration is not None and not 5 <= duration <= 1440:
        return None
    if rel is not None and duration is not None:
        return None
    return TimeRead(day=days[0] if days else None, day_said=bool(days), today_said=today_said,
                    weekday_said=weekday_said, duration_min=duration, weekend=weekend,
                    hour=hour, minute=minute or 0, fixed=fixed, part=part, rel=rel,
                    spans=tuple(sorted(s.spans)),
                    day_spans=tuple(sorted(s.day_spans)))  # fmt: skip


def strip(text: str, spans: tuple[tuple[int, int], ...]) -> str:
    """The phrase without its time words (for a title)."""
    chars = list(text)
    for a, b in spans:
        for i in range(a, b):
            chars[i] = " "
    out = re.sub(r"\s+", " ", "".join(chars)).strip(" ,.;:!-—")
    return re.sub(r"\s+([,.!?])", r"\1", out)


# --- settling a moment --------------------------------------------------------------------------


@dataclass(frozen=True)
class Settled:
    """`ok`: one moment (or a day without a time); `ask`: a short question with 2 choices."""

    status: str  # ok | ask
    moments: tuple[datetime, ...] = ()  # naive local; 1 for ok with a time, 2 for ask
    day: date | None = None  # ok without a time: just the day
    reason: str | None = None  # ask: ambiguous_hour | past


def next_hour(now_local: datetime) -> datetime:
    return (now_local + timedelta(hours=1)).replace(minute=0, second=0, microsecond=0)


def settle(r: TimeRead, now_local: datetime) -> Settled:
    """One moment, or a question. Nothing is ever in the past without asking."""
    now_local = now_local.replace(second=0, microsecond=0)
    today = now_local.date()
    if r.rel is not None:  # «через 20 минут»: rounded up to 5 minutes (calendar-time.md §10.1)
        moment = now_local + r.rel
        extra = (-moment.minute) % ROUND_REL_MIN
        return Settled("ok", (moment + timedelta(minutes=extra),))
    clocks = r.times()
    if not clocks:
        return Settled("ok", day=r.day)
    day = r.day if r.day is not None else today
    moments = [datetime.combine(day, t) for t in clocks]
    if not r.day_said and not r.today_said:
        # No day said: a precise hour already past today is the next one («в 19:30» at 20:00 →
        # tomorrow; the draft names the day). A vague part already past: tomorrow, unless that
        # part of the day is still going on («вечером» at 21:00) — then it is asked.
        if r.hour is None and moments[0] <= now_local < moments[0] + PART_LASTS:
            return past_choices(moments[0], now_local)
        moments = [m if m > now_local else m + timedelta(days=1) for m in moments]
        if len(moments) == 2:
            moments.sort()  # «в 7» at 10:00 → 19:00 today, then 7:00 tomorrow
    ahead = [m for m in moments if m > now_local]
    if not ahead and r.weekday_said and day == today:  # «во вторник в 9» on Tuesday at 10:00
        ahead = [m + timedelta(days=7) for m in moments]
    if not ahead:
        return past_choices(moments[0], now_local)
    if len(ahead) == 1:
        return Settled("ok", (ahead[0],))
    return Settled("ask", tuple(ahead[:2]), reason="ambiguous_hour")


def past_choices(moment: datetime, now_local: datetime) -> Settled:
    """«сегодня в 9» at 10:00: «уже прошло» — the same time tomorrow, or later today."""
    tomorrow = datetime.combine(now_local.date() + timedelta(days=1), moment.time())
    later = next_hour(now_local)
    options = (later, tomorrow) if later.date() == now_local.date() else (tomorrow,)
    return Settled("ask", options, reason="past")


def day_of(text: str, today: date) -> date | None:
    """The day a to-do phrase names («через неделю», «в следующий вторник», «послезавтра в 9»,
    «ертең»), or None. A to-do keeps only its day."""
    r = read(text, datetime.combine(today, time(0, 0)))
    if r is None:
        return None
    if r.rel is not None:
        return None  # «через 2 часа»: a reminder's business; the to-do stays without a day
    return r.day if r.day is not None else (today if r.today_said else None)


# --- texts (short, Russian; KK after review, R-39) --------------------------------------------

_REL_DAY = {0: "сегодня", 1: "завтра", 2: "послезавтра"}
_WEEKDAY_ACC = ("в понедельник", "во вторник", "в среду", "в четверг", "в пятницу", "в субботу",
                "в воскресенье")  # fmt: skip
_MONTH_GEN = ("января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа",
              "сентября", "октября", "ноября", "декабря")  # fmt: skip


def clock(t: time) -> str:
    return f"{t.hour}:{t.minute:02d}"


def moment_label(moment: datetime, today: date) -> str:
    """«Сегодня в 19:00», «Завтра в 7:00», «Во вторник в 9:00», «25 ноября в 9:00»."""
    delta = (moment.date() - today).days
    if delta in _REL_DAY:
        head = _REL_DAY[delta]
    elif 0 < delta < 7:
        head = _WEEKDAY_ACC[moment.weekday()]
    else:
        head = f"{moment.day} {_MONTH_GEN[moment.month - 1]}"
    text = f"{head} в {clock(moment.time())}"
    return text[:1].upper() + text[1:]


def question(s: Settled, today: date) -> str:
    """The short question for `ask`: «В 7:00 или в 19:00?» / «Это время уже прошло. Завтра в 9:00
    или сегодня в 11:00?»."""
    labels = [moment_label(m, today) for m in s.moments]
    if s.reason == "past":
        head = "Это время уже прошло."
        if len(labels) == 1:
            return f"{head} {labels[0]}?"
        return f"{head} {labels[0]} или {labels[1][:1].lower() + labels[1][1:]}?"
    if len({m.date() for m in s.moments}) == 1:
        a, b = s.moments
        return f"В {clock(a.time())} или в {clock(b.time())}?"
    return f"{labels[0]} или {labels[1][:1].lower() + labels[1][1:]}?"


__all__ = ["DEFAULT_DURATIONS", "DEFAULT_DURATION_MIN", "TIME_DEFAULTS", "Settled", "TimeRead",
           "clock", "day_of", "default_duration", "moment_label", "next_hour", "past_choices",
           "question", "read", "settle", "strip"]  # fmt: skip


def default_duration(title: str) -> int:
    """The length of a to-do with a time when the phrase says none (calendar-time.md §5)."""
    low = _norm(title)
    for pattern, minutes in DEFAULT_DURATIONS:
        if re.search(pattern, low):
            return minutes
    return DEFAULT_DURATION_MIN
