from datetime import UTC, datetime

from assistant.db.models import Booking, BookingType, Category, Item
from assistant.scheduler.service import main_city
from assistant.scheduler.texts import compose_trip_last_day, compose_trip_morning, pick_items
from assistant.scheduler.tz import get_tz

VN = "Asia/Ho_Chi_Minh"


def item(title, city="Hoi An", category=Category.FOOD, **kw):
    return Item(title=title, city=city, category=category, **kw)


def test_pick_prefers_city_then_categories_and_limits():
    items = [
        item("Shopping street", category=Category.SHOPPING),
        item("Pho in Hanoi", city="Hanoi"),
        item("Bánh Mì Phượng"),
        item("An Bang beach", category=Category.BEACH),
        item("Japanese bridge", category=Category.SIGHT),
        item("Cao lầu"),
        item("Tip: Grab", category=Category.TIP),
        item("", category=Category.FOOD),  # no label: skipped
    ]
    picked = pick_items(items, "hoi an", (Category.FOOD, Category.BEACH, Category.SIGHT))
    assert [i.title for i in picked] == [
        "Bánh Mì Phượng",
        "Cao lầu",
        "An Bang beach",
        "Japanese bridge",
        "Shopping street",
    ]


def test_pick_rotates_by_day():
    items = [item(f"Place {n}") for n in range(8)]
    day0 = pick_items(items, "Hoi An", (Category.FOOD,))
    day1 = pick_items(items, "Hoi An", (Category.FOOD,), offset=1)
    assert [i.title for i in day0] == [f"Place {n}" for n in range(5)]
    assert [i.title for i in day1] == ["Place 5", "Place 6", "Place 7", "Place 0", "Place 1"]


def test_morning_digest_with_booking_in_local_time():
    flight = Booking(
        type=BookingType.FLIGHT,
        title="Рейс VJ 631 в Хошимин",
        confirmation_code="XYZ9",
        starts_at=datetime(2026, 12, 11, 18, 5, tzinfo=get_tz(VN)).astimezone(UTC),
        tz=VN,
    )
    text = compose_trip_morning("Hoi An", [item("Bánh Mì Phượng")], [flight], None)
    assert text.splitlines() == [
        "Доброе утро! Сегодня в Hoi An:",
        "1. Bánh Mì Phượng",
        "",
        "Брони на сегодня:",
        "— Рейс VJ 631 в Хошимин в 18:05, код брони XYZ9",
    ]


def test_morning_digest_empty_and_no_city():
    text = compose_trip_morning(None, [], [], VN)
    assert text.startswith("Доброе утро! На сегодня:")
    assert "пока ничего не сохранено" in text
    assert "ИИ" not in text and "AI" not in text


def test_last_day_lists_sights_first():
    items = [item("Bánh Mì Phượng"), item("Japanese bridge", category=Category.SIGHT)]
    text = compose_trip_last_day("Вьетнам 2026", "Hoi An", items)
    lines = text.splitlines()
    assert lines[0] == "Последний день поездки «Вьетнам 2026»! Ты хотел посетить:"
    assert lines[1] == "1. Japanese bridge"
    assert compose_trip_last_day("Вьетнам", None, []).startswith("Последний день поездки «Вьетнам»")


def test_main_city_is_most_common():
    items = [item("a", city="Hoi An"), item("b", city="Da Nang"), item("c", city="Hoi An ")]
    assert main_city(items, "Вьетнам") == "Hoi An"
    assert main_city([], "Вьетнам") == "Вьетнам"
