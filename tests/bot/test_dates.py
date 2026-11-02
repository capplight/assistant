from datetime import UTC, date, datetime

import pytest

from assistant.bot.dates import (
    DateParseError,
    TripSpec,
    format_range,
    guess_tz,
    local_today,
    parse_date_range,
    parse_trip_args,
)

TODAY = date(2026, 11, 2)


def test_range_this_year():
    assert parse_date_range("10.12-20.12", TODAY) == (date(2026, 12, 10), date(2026, 12, 20))


def test_range_already_passed_goes_to_next_year():
    assert parse_date_range("01.03-10.03", TODAY) == (date(2027, 3, 1), date(2027, 3, 10))


def test_range_starting_today_is_this_year():
    assert parse_date_range("2.11-5.11", TODAY) == (date(2026, 11, 2), date(2026, 11, 5))


def test_range_across_new_year():
    assert parse_date_range("28.12-05.01", TODAY) == (date(2026, 12, 28), date(2027, 1, 5))


def test_explicit_years_and_dashes():
    assert parse_date_range("10.12.2026 — 02.01.2027", TODAY) == (
        date(2026, 12, 10),
        date(2027, 1, 2),
    )
    assert parse_date_range("10.12.26 – 20.12.26", TODAY) == (
        date(2026, 12, 10),
        date(2026, 12, 20),
    )


def test_year_only_on_end():
    assert parse_date_range("28.12-05.01.2027", TODAY) == (date(2026, 12, 28), date(2027, 1, 5))


def test_year_only_on_start():
    assert parse_date_range("28.12.2026-05.01", TODAY) == (date(2026, 12, 28), date(2027, 1, 5))


def test_leap_day():
    assert parse_date_range("29.02-01.03", TODAY) == (date(2028, 2, 29), date(2028, 3, 1))


@pytest.mark.parametrize(
    "bad", ["32.12-01.01", "10.13-20.12", "20.12.2026-10.12.2026", "завтра", "30.02-01.03"]
)
def test_bad_ranges(bad):
    with pytest.raises(DateParseError):
        parse_date_range(bad, TODAY)


def test_trip_args_with_dates():
    assert parse_trip_args("Фукуок 10.12-20.12", TODAY) == TripSpec(
        "Фукуок", date(2026, 12, 10), date(2026, 12, 20)
    )


def test_trip_args_multiword_title_without_dates():
    assert parse_trip_args("  Бали с семьёй ", TODAY) == TripSpec("Бали с семьёй")


@pytest.mark.parametrize("bad", ["Фукуок 10.12", "10.12-20.12", "", None])
def test_trip_args_rejected(bad):
    with pytest.raises(DateParseError):
        parse_trip_args(bad, TODAY)


def test_guess_tz():
    assert guess_tz("Фукуок") == "Asia/Ho_Chi_Minh"
    assert guess_tz("Отпуск на Пхукете") == "Asia/Bangkok"
    assert guess_tz("Phu Quoc winter") == "Asia/Ho_Chi_Minh"
    assert guess_tz("Европа") is None


def test_local_today_is_utc_plus_5_in_almaty():
    assert local_today("Asia/Almaty", datetime(2026, 11, 1, 20, 0, tzinfo=UTC)) == date(2026, 11, 2)


def test_format_range():
    assert format_range(date(2026, 12, 10), date(2026, 12, 20)) == "10.12–20.12.2026"
    assert format_range(date(2026, 12, 28), date(2027, 1, 5)) == "28.12.2026–05.01.2027"
