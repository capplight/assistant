"""Parsing of `/trip <title> [dd.mm[.yyyy]-dd.mm[.yyyy]]` and local "today"."""

import re
from dataclasses import dataclass
from datetime import UTC, date, datetime

from assistant.timezones import get_tz

_D = r"(\d{1,2})\.(\d{1,2})(?:\.(\d{2}|\d{4}))?"
RANGE_RE = re.compile(rf"(?:^|\s){_D}\s*[-–—]\s*{_D}\s*$")
# Anything that looks like a date fragment, used to tell "no dates" from "broken dates".
_LOOKS_LIKE_DATE = re.compile(r"\d{1,2}\.\d{1,2}")

class DateParseError(ValueError):
    pass


@dataclass(frozen=True)
class TripSpec:
    title: str
    starts_on: date | None = None
    ends_on: date | None = None


def local_today(tz_name: str | None = None, now: datetime | None = None) -> date:
    return (now or datetime.now(UTC)).astimezone(get_tz(tz_name)).date()


def _year(raw: str | None) -> int | None:
    if raw is None:
        return None
    y = int(raw)
    return 2000 + y if y < 100 else y


def _mk(day: int, month: int, year: int) -> date:
    try:
        return date(year, month, day)
    except ValueError as e:
        raise DateParseError(str(e)) from e


def _next_occurrence(day: int, month: int, today: date) -> date:
    """First dd.mm on or after today (29.02 may be several years ahead)."""
    for year in range(today.year, today.year + 9):
        try:
            d = date(year, month, day)
        except ValueError:
            if month == 2 and day == 29:
                continue
            raise DateParseError(f"{day}.{month}") from None
        if d >= today:
            return d
    raise DateParseError(f"{day}.{month}")


def parse_date_range(text: str, today: date) -> tuple[date, date]:
    """Parse 'dd.mm-dd.mm' with optional years. Missing years: next occurrence from today."""
    m = RANGE_RE.search(" " + text.strip())
    if not m:
        raise DateParseError(text)
    d1, m1, y1, d2, m2, y2 = m.groups()
    y1i, y2i = _year(y1), _year(y2)
    if y1i is not None and y2i is not None:
        start, end = _mk(int(d1), int(m1), y1i), _mk(int(d2), int(m2), y2i)
    elif y1i is not None:
        start = _mk(int(d1), int(m1), y1i)
        end = _mk(int(d2), int(m2), start.year)
        if end < start:
            end = _mk(int(d2), int(m2), start.year + 1)
    elif y2i is not None:
        end = _mk(int(d2), int(m2), y2i)
        start = _mk(int(d1), int(m1), end.year)
        if start > end:
            start = _mk(int(d1), int(m1), end.year - 1)
    else:
        start = _next_occurrence(int(d1), int(m1), today)
        end = _mk(int(d2), int(m2), start.year)
        if end < start:
            end = _mk(int(d2), int(m2), start.year + 1)
    if end < start:
        raise DateParseError(text)
    return start, end


def parse_trip_args(args: str | None, today: date) -> TripSpec:
    """`Фукуок 10.12-20.12` -> TripSpec. Raises DateParseError on broken dates or empty title."""
    text = (args or "").strip()
    if not text:
        raise DateParseError("empty")
    m = RANGE_RE.search(" " + text)
    if m is None:
        if _LOOKS_LIKE_DATE.search(text):
            raise DateParseError(text)
        return TripSpec(title=text[:255])
    title = (" " + text)[: m.start()].strip(" ,-–—")
    if not title:
        raise DateParseError("no title")
    start, end = parse_date_range(text, today)
    return TripSpec(title=title[:255], starts_on=start, ends_on=end)


def format_range(start: date, end: date) -> str:
    if start.year == end.year:
        return f"{start:%d.%m}–{end:%d.%m.%Y}"
    return f"{start:%d.%m.%Y}–{end:%d.%m.%Y}"


# Destinations whose IANA tz is unambiguous. Anything else -> None (pipeline/places decide).
_TZ_BY_PLACE: dict[str, str] = {
    "фукуок": "Asia/Ho_Chi_Minh",
    "phu quoc": "Asia/Ho_Chi_Minh",
    "нячанг": "Asia/Ho_Chi_Minh",
    "дананг": "Asia/Ho_Chi_Minh",
    "хошимин": "Asia/Ho_Chi_Minh",
    "ханой": "Asia/Ho_Chi_Minh",
    "вьетнам": "Asia/Ho_Chi_Minh",
    "бангкок": "Asia/Bangkok",
    "пхукет": "Asia/Bangkok",
    "паттайя": "Asia/Bangkok",
    "самуи": "Asia/Bangkok",
    "таиланд": "Asia/Bangkok",
    "тайланд": "Asia/Bangkok",
    "бали": "Asia/Makassar",
    "дубай": "Asia/Dubai",
    "оаэ": "Asia/Dubai",
    "стамбул": "Europe/Istanbul",
    "анталья": "Europe/Istanbul",
    "анталия": "Europe/Istanbul",
    "турция": "Europe/Istanbul",
    "тбилиси": "Asia/Tbilisi",
    "батуми": "Asia/Tbilisi",
    "грузия": "Asia/Tbilisi",
    "алматы": "Asia/Almaty",
    "астана": "Asia/Almaty",
    "шымкент": "Asia/Almaty",
    "ташкент": "Asia/Tashkent",
    "самарканд": "Asia/Tashkent",
    "бишкек": "Asia/Bishkek",
    "иссык-куль": "Asia/Bishkek",
    "сеул": "Asia/Seoul",
    "токио": "Asia/Tokyo",
    "шри-ланка": "Asia/Colombo",
    "мальдивы": "Indian/Maldives",
    "шарм": "Africa/Cairo",
    "хургада": "Africa/Cairo",
    "египет": "Africa/Cairo",
}


def guess_tz(title: str) -> str | None:
    words = re.findall(r"[\w-]+", title.lower())
    joined = " ".join(words)
    for key, tz in _TZ_BY_PLACE.items():
        if (" " in key and key in joined) or any(w.startswith(key) for w in words):
            return tz
    return None
