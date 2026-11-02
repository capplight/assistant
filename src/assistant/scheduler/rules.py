"""Pure reminder planning: which reminders a booking or trip gets and when. No DB here.

Edit BOOKING_RULES / TRIP_RULES to change reminder timing or wording.
"""

from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time, timedelta

from assistant.db.models import Booking, BookingType, Reminder, ReminderStatus
from assistant.scheduler.tz import get_tz

MAX_TRIP_DAYS = 60


@dataclass(frozen=True)
class BookingRule:
    """One reminder for a booking.

    Either relative (`before` the anchor) or wall-clock (`at` local time on the anchor's
    local date shifted by `day_offset`). Template fields: {title}, {when}, {code}.
    {when} renders as " <time_word> HH:MM" or "" when the booking has no time of day.
    """

    kind: str
    template: str
    anchor: str = "start"  # "start" -> booking.starts_at, "end" -> booking.ends_at
    before: timedelta | None = None
    at: time | None = None
    day_offset: int = 0
    time_word: str = "в"


BOOKING_RULES: dict[BookingType, tuple[BookingRule, ...]] = {
    BookingType.FLIGHT: (
        BookingRule(
            "flight_day_before",
            "Завтра рейс {title}{when}{code}.",
            at=time(19, 0),
            day_offset=-1,
        ),
        BookingRule(
            "flight_3h_before",
            "Через 3 часа рейс {title}, вылет{when}{code}. Пора собираться в аэропорт!",
            before=timedelta(hours=3),
        ),
    ),
    BookingType.HOTEL: (
        BookingRule(
            "hotel_checkin",
            "Сегодня заселение: {title}{when}{code}.",
            at=time(10, 0),
            time_word="с",
        ),
        BookingRule(
            "hotel_checkout",
            "Сегодня выезд из {title}{when}{code}. Проверь, ничего ли не забыл!",
            anchor="end",
            at=time(8, 0),
            time_word="до",
        ),
    ),
    BookingType.TRANSFER: (
        BookingRule(
            "transfer_2h_before",
            "Через 2 часа трансфер: {title}{when}{code}.",
            before=timedelta(hours=2),
        ),
    ),
    BookingType.TOUR: (
        BookingRule(
            "tour_2h_before",
            "Через 2 часа экскурсия: {title}{when}{code}.",
            before=timedelta(hours=2),
        ),
    ),
    BookingType.OTHER: (
        BookingRule(
            "booking_2h_before", "Через 2 часа: {title}{when}{code}.", before=timedelta(hours=2)
        ),
    ),
}


@dataclass(frozen=True)
class TripRule:
    kind: str
    at: time
    last_day_only: bool = False


TRIP_MORNING = "trip_morning"
TRIP_LAST_DAY = "trip_last_day"
DYNAMIC_KINDS = frozenset({TRIP_MORNING, TRIP_LAST_DAY})  # text is composed at send time

TRIP_RULES: tuple[TripRule, ...] = (
    TripRule(TRIP_MORNING, at=time(8, 30)),
    TripRule(TRIP_LAST_DAY, at=time(10, 0), last_day_only=True),
)


@dataclass
class ReminderSpec:
    kind: str
    due_at: datetime  # aware UTC
    text: str
    payload: dict = field(default_factory=dict)


def _is_date_only(local: datetime) -> bool:
    return local.hour == 0 and local.minute == 0


def _when(local: datetime, word: str) -> str:
    return "" if _is_date_only(local) else f" {word} {local:%H:%M}"


def booking_reminder_specs(
    booking: Booking, fallback_tz: str | None, now: datetime
) -> list[ReminderSpec]:
    """Reminders for a confirmed booking, in the event's tz. Past ones are skipped."""
    if booking.confirmed_at is None:
        return []
    tz = get_tz(booking.tz or fallback_tz)
    code = f", код брони {booking.confirmation_code}" if booking.confirmation_code else ""
    specs: list[ReminderSpec] = []
    for rule in BOOKING_RULES.get(BookingType(booking.type), ()):
        anchor = booking.starts_at if rule.anchor == "start" else booking.ends_at
        if anchor is None:
            continue
        local = anchor.astimezone(tz)
        if rule.before is not None:
            due = anchor - rule.before
        else:
            assert rule.at is not None
            day = local.date() + timedelta(days=rule.day_offset)
            due = datetime.combine(day, rule.at, tzinfo=tz)
            # e.g. checkout at 07:00 but the reminder is at 08:00: it would come too late.
            if due > anchor and not _is_date_only(local):
                continue
        due = due.astimezone(UTC)
        if due <= now:
            continue
        text = rule.template.format(
            title=booking.title, when=_when(local, rule.time_word), code=code
        )
        specs.append(ReminderSpec(rule.kind, due, text, {"booking_id": booking.id}))
    return specs


def trip_reminder_specs(
    trip_id: int | None,
    starts_on: date | None,
    ends_on: date | None,
    tz_name: str | None,
    now: datetime,
) -> list[ReminderSpec]:
    """Per-day trip reminders at local wall-clock time. Text is a placeholder, built when sent."""
    if starts_on is None or ends_on is None or ends_on < starts_on:
        return []
    tz = get_tz(tz_name)
    days = min((ends_on - starts_on).days + 1, MAX_TRIP_DAYS)
    specs: list[ReminderSpec] = []
    for i in range(days):
        day = starts_on + timedelta(days=i)
        for rule in TRIP_RULES:
            if rule.last_day_only and day != ends_on:
                continue
            due = datetime.combine(day, rule.at, tzinfo=tz).astimezone(UTC)
            if due <= now:
                continue
            payload = {"trip_id": trip_id, "date": day.isoformat(), "day_index": i}
            specs.append(ReminderSpec(rule.kind, due, "Доброе утро!", payload))
    return specs


def cancel_scheduled(reminders: Iterable[Reminder]) -> list[Reminder]:
    """Replacement semantics: still-scheduled reminders are cancelled, sent ones are kept."""
    cancelled = []
    for r in reminders:
        if r.status == ReminderStatus.SCHEDULED:
            r.status = ReminderStatus.CANCELLED
            cancelled.append(r)
    return cancelled


# Sending outcome -----------------------------------------------------------------------------

MAX_ATTEMPTS = 3
# A reminder this late (scheduler was down) is dropped: "через 3 часа рейс" after departure,
# or yesterday's morning digest, would only confuse.
MAX_LATENESS = timedelta(hours=2)


def is_stale(reminder: Reminder, now: datetime) -> bool:
    return now - reminder.due_at > MAX_LATENESS


_BLOCKED_MARKERS = ("bot was blocked", "forbidden", "user is deactivated", "chat not found")


def is_permanent_send_error(exc: BaseException) -> bool:
    """User blocked the bot / deleted the account: retrying will never help."""
    if type(exc).__name__ == "TelegramForbiddenError":
        return True
    msg = str(exc).lower()
    return any(m in msg for m in _BLOCKED_MARKERS)


def apply_send_failure(reminder: Reminder, exc: BaseException) -> None:
    reminder.attempts = (reminder.attempts or 0) + 1
    if is_permanent_send_error(exc):
        reminder.status = ReminderStatus.CANCELLED
    elif reminder.attempts >= MAX_ATTEMPTS:
        reminder.status = ReminderStatus.FAILED


def apply_send_success(reminder: Reminder, now: datetime) -> None:
    reminder.status = ReminderStatus.SENT
    reminder.sent_at = now
