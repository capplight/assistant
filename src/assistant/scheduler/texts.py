"""Pure text composition for the dynamic trip reminders (built at send time)."""

from collections.abc import Sequence
from datetime import datetime
from typing import Protocol

from assistant.db.models import Category
from assistant.scheduler.tz import get_tz

DIGEST_LIMIT = 5
MORNING_CATEGORIES = (Category.FOOD, Category.BEACH, Category.SIGHT)
LAST_DAY_CATEGORIES = (Category.SIGHT, Category.BEACH, Category.FOOD)


class ItemLike(Protocol):
    title: str | None
    summary: str | None
    city: str | None
    category: Category | None


class BookingLike(Protocol):
    title: str
    confirmation_code: str | None
    starts_at: datetime | None
    tz: str | None


def _norm(s: str | None) -> str:
    return (s or "").strip().casefold()


def _label(item: ItemLike, max_len: int = 80) -> str:
    text = (item.title or item.summary or "").strip().replace("\n", " ")
    return text if len(text) <= max_len else text[: max_len - 1].rstrip() + "…"


def pick_items(
    items: Sequence[ItemLike],
    city: str | None,
    categories: Sequence[Category],
    *,
    limit: int = DIGEST_LIMIT,
    offset: int = 0,
) -> list[ItemLike]:
    """Best items for a digest: matching city first, then preferred categories.

    `offset` rotates the list so a multi-day trip does not repeat the same five every morning.
    Input order is kept as the tie-breaker (pass newest first).
    """
    want_city = _norm(city)
    usable = [i for i in items if _label(i)]

    def score(item: ItemLike) -> tuple[int, int]:
        city_miss = 0 if want_city and _norm(item.city) == want_city else 1
        try:
            cat_rank = categories.index(item.category)  # type: ignore[arg-type]
        except ValueError:
            cat_rank = len(categories)
        return (city_miss, cat_rank)

    ranked = sorted(usable, key=score)  # stable
    if not ranked:
        return []
    if len(ranked) > limit and offset:
        start = (offset * limit) % len(ranked)
        ranked = ranked[start:] + ranked[:start]
    return ranked[:limit]


def _numbered(items: Sequence[ItemLike]) -> list[str]:
    return [f"{n}. {_label(i)}" for n, i in enumerate(items, 1)]


def booking_line(booking: BookingLike, fallback_tz: str | None) -> str:
    line = f"— {booking.title}"
    if booking.starts_at is not None:
        local = booking.starts_at.astimezone(get_tz(booking.tz or fallback_tz))
        if not (local.hour == 0 and local.minute == 0):
            line += f" в {local:%H:%M}"
    if booking.confirmation_code:
        line += f", код брони {booking.confirmation_code}"
    return line


def compose_trip_morning(
    city: str | None,
    items: Sequence[ItemLike],
    bookings: Sequence[BookingLike],
    fallback_tz: str | None,
    *,
    day_index: int = 0,
) -> str:
    picked = pick_items(items, city, MORNING_CATEGORIES, offset=day_index)
    head = f"Доброе утро! Сегодня в {city}:" if city else "Доброе утро! На сегодня:"
    lines = [head]
    if picked:
        lines += _numbered(picked)
    if bookings:
        if picked:
            lines.append("")
        lines.append("Брони на сегодня:")
        lines += [booking_line(b, fallback_tz) for b in bookings]
    if not picked and not bookings:
        lines.append(
            "Для этой поездки пока ничего не сохранено. Пересылай мне рилсы и посты "
            "про места — соберу всё здесь."
        )
    return "\n".join(lines)


def compose_trip_last_day(trip_title: str, city: str | None, items: Sequence[ItemLike]) -> str:
    picked = pick_items(items, city, LAST_DAY_CATEGORIES)
    if not picked:
        return f"Последний день поездки «{trip_title}». Хорошей дороги домой!"
    lines = [f"Последний день поездки «{trip_title}»! Ты хотел посетить:"]
    lines += _numbered(picked)
    lines.append("Успеешь заглянуть хотя бы в одно? Хорошей дороги домой!")
    return "\n".join(lines)
