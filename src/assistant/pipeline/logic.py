"""Pure decisions: escalation, routing, booking validation, trip choice, user-facing texts.

No DB, no network: everything here takes plain data and is unit-tested directly.
"""

import re
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta, tzinfo
from typing import Literal

from assistant.notify import Button
from assistant.pipeline.geo import country_names, load_zone, tz_for_country
from assistant.pipeline.schema import BookingExtract, Extraction

Decision = Literal["booking", "resolve", "ask", "save"]
ZoneLoader = Callable[[str | None], tzinfo | None]

CATEGORY_RU = {
    "food": "еда",
    "beach": "пляж",
    "sight": "что посмотреть",
    "stay": "жильё",
    "transport": "транспорт",
    "booking": "бронь",
    "tip": "совет",
    "shopping": "покупки",
    "other": "разное",
}
BOOKING_TYPE_RU = {
    "flight": "Рейс",
    "hotel": "Отель",
    "transfer": "Трансфер",
    "tour": "Экскурсия",
    "other": "Бронь",
}

FAILED_TEXT = "Не получилось разобрать это сообщение, пришли скриншот?"
ASK_PLACE_TEXT = "Не уверен, какое это место. Выбери, пожалуйста:"
OTHER_BUTTON = "Другое"


# ---------------------------------------------------------------- escalation / routing


def needs_escalation(ex: Extraction, threshold: float) -> bool:
    """Bookings always get the strong model; so does anything the fast model is unsure of."""
    return ex.kind == "booking" or ex.confidence < threshold


def place_options(ex: Extraction) -> list[str]:
    """Up to 3 distinct names to offer as buttons: best guess first, then alternatives."""
    seen: set[str] = set()
    out: list[str] = []
    for name in [ex.place_query, *ex.place_candidates]:
        if name and name.casefold() not in seen:
            seen.add(name.casefold())
            out.append(name)
    return out[:3]


def decide(ex: Extraction, threshold: float) -> Decision:
    if ex.kind == "booking" and ex.booking is not None:
        return "booking"
    if ex.kind == "place":
        if ex.confidence < threshold and len(place_options(ex)) >= 2:
            return "ask"
        if ex.place_query:
            return "resolve"
    return "save"


# ---------------------------------------------------------------- trips


@dataclass
class TripInfo:
    id: int
    title: str
    destination: str | None = None
    starts_on: date | None = None
    ends_on: date | None = None
    tz: str | None = None
    is_active: bool = True


def choose_trip(
    trips: list[TripInfo], existing_trip_id: int | None, city: str | None, country: str | None
) -> TripInfo | None:
    """Keep an explicit trip; else the only active trip; else a destination match."""
    if existing_trip_id is not None:
        return next((t for t in trips if t.id == existing_trip_id), None) or TripInfo(
            id=existing_trip_id, title=""
        )
    active = [t for t in trips if t.is_active]
    if len(active) == 1:
        return active[0]
    needles = [n for n in [(city or "").casefold().strip(), *country_names(country)] if n]
    if not needles:
        return None
    matches = []
    for t in active:
        dest = (t.destination or "").casefold()
        if dest and any(n in dest or dest in n for n in needles):
            matches.append(t)
    return matches[0] if len(matches) == 1 else None


# ---------------------------------------------------------------- bookings

FLIGHT_CODE_RE = re.compile(r"^[A-Z0-9]{6}$")  # airline PNR
GENERIC_CODE_RE = re.compile(r"^[A-Z0-9][A-Z0-9\-]{2,31}$")
IATA_RE = re.compile(r"^[A-Z]{3}$")
FLIGHT_NO_RE = re.compile(r"^([A-Z0-9]{2})\s?(\d{1,4}[A-Z]?)$")

ISSUE_NO_DATE = "no_date"
ISSUE_PAST = "past"
ISSUE_CODE = "bad_code"
ISSUE_END_BEFORE_START = "end_before_start"

ISSUE_RU = {
    ISSUE_NO_DATE: "Не вижу дату и время — проверь, пожалуйста.",
    ISSUE_PAST: "Дата уже прошла — проверь, пожалуйста.",
    ISSUE_CODE: "Код брони не разобрал.",
}


@dataclass
class BookingDraft:
    type: str
    title: str
    confirmation_code: str | None
    starts_at: datetime | None  # aware UTC
    ends_at: datetime | None
    tz: str | None
    start_local: datetime | None  # naive local wall clock, for the message
    details: dict = field(default_factory=dict)
    issues: list[str] = field(default_factory=list)


def parse_local(value: str | None) -> tuple[datetime | None, bool]:
    """'YYYY-MM-DDTHH:MM' (also space separator, seconds, or date only).
    Returns (naive datetime, time_known)."""
    if not value:
        return None, False
    v = value.strip().replace(" ", "T")
    for fmt, has_time in (("%Y-%m-%dT%H:%M", True), ("%Y-%m-%dT%H:%M:%S", True),
                          ("%Y-%m-%d", False)):  # fmt: skip
        try:
            return datetime.strptime(v, fmt), has_time
        except ValueError:
            continue
    return None, False


def first_zone(
    names: list[str | None], loader: ZoneLoader = load_zone
) -> tuple[str, tzinfo] | None:
    for name in names:
        zone = loader(name) if name else None
        if zone is not None:
            return name, zone  # type: ignore[return-value]
    return None


def to_utc(local: datetime, zone: tzinfo) -> datetime:
    return local.replace(tzinfo=zone).astimezone(UTC)


def clean_code(code: str | None, booking_type: str) -> tuple[str | None, bool]:
    """(normalized code or None, was_invalid)."""
    if not code or not code.strip():
        return None, False
    c = re.sub(r"\s+", "", code).upper()
    pattern = FLIGHT_CODE_RE if booking_type == "flight" else GENERIC_CODE_RE
    return (c, False) if pattern.match(c) else (None, True)


def clean_iata(code: str | None) -> str | None:
    c = (code or "").strip().upper()
    return c if IATA_RE.match(c) else None


def clean_flight_number(value: str | None) -> str | None:
    m = FLIGHT_NO_RE.match((value or "").strip().upper())
    return f"{m.group(1)} {m.group(2)}" if m else None


def validate_booking(
    b: BookingExtract,
    *,
    now: datetime,
    place_tz: str | None,
    trip: TripInfo | None,
    user_tz: str | None,
    loader: ZoneLoader = load_zone,
) -> BookingDraft:
    """Check the model's booking in code and convert local times to UTC.

    Start tz: resolved place tz, else the booking country's single tz, else trip tz, else
    user tz. End tz: the arrival country's tz (flights), else the start tz.
    """
    issues: list[str] = []
    code, bad_code = clean_code(b.confirmation_code, b.type)
    if bad_code:
        issues.append(ISSUE_CODE)

    details: dict = {}
    if b.type == "flight":
        details["flight_number"] = clean_flight_number(b.flight_number)
        details["departure_airport"] = clean_iata(b.departure_airport)
        details["arrival_airport"] = clean_iata(b.arrival_airport)
    for key in ("location_city", "arrival_city", "details"):
        details[key] = getattr(b, key)
    details = {k: v for k, v in details.items() if v}

    start_zone = first_zone(
        [place_tz, tz_for_country(b.location_country), trip.tz if trip else None, user_tz],
        loader,
    )
    tz_name = start_zone[0] if start_zone else None

    start_local, start_has_time = parse_local(b.start_local)
    starts_at = to_utc(start_local, start_zone[1]) if start_local and start_zone else None
    if start_local is None or starts_at is None:
        issues.append(ISSUE_NO_DATE)
    elif not start_has_time:
        details["time_unknown"] = True

    end_local, _ = parse_local(b.end_local)
    ends_at = None
    if end_local is not None:
        end_zone = first_zone([tz_for_country(b.arrival_country)], loader) or start_zone
        if end_zone is not None:
            ends_at = to_utc(end_local, end_zone[1])
            details["end_tz"] = end_zone[0]
    if ends_at and starts_at and ends_at < starts_at:
        ends_at = None
        details.pop("end_tz", None)

    if starts_at is not None and starts_at < now and not _within_trip(start_local, trip):
        issues.append(ISSUE_PAST)

    return BookingDraft(
        type=b.type,
        title=(b.title or BOOKING_TYPE_RU.get(b.type, "Бронь")).strip()[:500],
        confirmation_code=code,
        starts_at=starts_at,
        ends_at=ends_at,
        tz=tz_name,
        start_local=start_local,
        details=details,
        issues=issues,
    )


def _within_trip(local: datetime | None, trip: TripInfo | None) -> bool:
    if local is None or trip is None or trip.starts_on is None:
        return False
    end = trip.ends_on or trip.starts_on
    return trip.starts_on - timedelta(days=1) <= local.date() <= end + timedelta(days=1)


# ---------------------------------------------------------------- texts


def _trip_suffix(trip: TripInfo | None) -> str:
    return f"\nПоездка: {trip.title}" if trip and trip.title else ""


def saved_text(title: str, city: str | None, category: str | None, trip: TripInfo | None) -> str:
    cat = CATEGORY_RU.get(category or "other", "разное")
    where = f" — {city}, {cat}" if city else f" — {cat}"
    return f"Сохранил: {title}{where}{_trip_suffix(trip)}"


def note_text(title: str, kind: str, trip: TripInfo | None) -> str:
    label = "совет" if kind == "tip" else "заметку"
    return f"Записал {label}: {title}{_trip_suffix(trip)}"


def ask_buttons(item_id: int, options: list[str], cb_prefix: str = "pick") -> list[list[Button]]:
    rows = [[Button(_short(o), f"{cb_prefix}:{item_id}:{i}")] for i, o in enumerate(options[:3])]
    rows.append([Button(OTHER_BUTTON, f"{cb_prefix}:{item_id}:-1")])
    return rows


def booking_text(draft: BookingDraft, trip: TripInfo | None) -> str:
    lines = [f"Нашёл бронь: {draft.title}"]
    if draft.start_local is not None and ISSUE_NO_DATE not in draft.issues:
        fmt = "%d.%m.%Y" if draft.details.get("time_unknown") else "%d.%m.%Y %H:%M"
        lines.append(f"Когда: {draft.start_local.strftime(fmt)} (местное время)")
    if fn := draft.details.get("flight_number"):
        route = " → ".join(
            x for x in (draft.details.get("departure_airport"),
                        draft.details.get("arrival_airport")) if x
        )  # fmt: skip
        lines.append(f"Рейс: {fn}" + (f", {route}" if route else ""))
    if draft.confirmation_code:
        lines.append(f"Код брони: {draft.confirmation_code}")
    lines += [ISSUE_RU[i] for i in draft.issues if i in ISSUE_RU]
    if trip and trip.title:
        lines.append(f"Поездка: {trip.title}")
    lines.append("Всё верно?")
    return "\n".join(lines)


def booking_buttons(booking_id: int, cb_prefix: str = "bk") -> list[list[Button]]:
    return [[
        Button("Да, верно", f"{cb_prefix}:{booking_id}:ok"),
        Button("Нет", f"{cb_prefix}:{booking_id}:no"),
    ]]


def _short(text: str, limit: int = 40) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"
