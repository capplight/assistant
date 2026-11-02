from datetime import UTC, date, datetime

from assistant.pipeline.logic import (
    ISSUE_CODE,
    ISSUE_NO_DATE,
    ISSUE_PAST,
    TripInfo,
    ask_buttons,
    booking_buttons,
    booking_text,
    choose_trip,
    decide,
    needs_escalation,
    parse_local,
    place_options,
    saved_text,
    validate_booking,
)
from tests.pipeline.conftest import NOW, make_booking, make_extraction

# ---------------------------------------------------------------- escalation / routing


def test_escalate_on_low_confidence_only():
    assert needs_escalation(make_extraction(confidence=0.4), 0.6)
    assert not needs_escalation(make_extraction(confidence=0.6), 0.6)
    assert not needs_escalation(make_extraction(kind="tip", confidence=0.9), 0.6)


def test_bookings_always_escalate():
    ex = make_extraction(kind="booking", booking=make_booking(), confidence=0.99)
    assert needs_escalation(ex, 0.6)


def test_decide_routes():
    assert decide(make_extraction(), 0.6) == "resolve"
    assert decide(make_extraction(kind="tip", place_query=None), 0.6) == "save"
    assert decide(make_extraction(kind="booking", booking=make_booking()), 0.6) == "booking"
    # booking without booking details is saved as a note, not crashed on
    assert decide(make_extraction(kind="booking", booking=None), 0.6) == "save"


def test_low_confidence_with_candidates_asks():
    ex = make_extraction(confidence=0.3, place_candidates=["Madam Khanh", "Bánh Mì Phượng"])
    assert decide(ex, 0.6) == "ask"
    # best guess first, duplicates removed (case-insensitive), at most 3
    assert place_options(ex) == ["Bánh Mì Phượng, Hội An", "Madam Khanh", "Bánh Mì Phượng"]
    many = make_extraction(place_query="A", place_candidates=["a", "B", "C", "D"])
    assert place_options(many) == ["A", "B", "C"]


def test_low_confidence_without_alternatives_still_resolves():
    assert decide(make_extraction(confidence=0.3), 0.6) == "resolve"


def test_ask_buttons_callback_format():
    rows = ask_buttons(42, ["A", "B"])
    assert [b.callback_data for row in rows for b in row] == ["pick:42:0", "pick:42:1",
                                                              "pick:42:-1"]
    assert rows[-1][0].text == "Другое"
    assert all(len(b.callback_data.encode()) <= 64 for row in rows for b in row)
    assert [b.callback_data for b in booking_buttons(7)[0]] == ["bk:7:ok", "bk:7:no"]


# ---------------------------------------------------------------- bookings / tz


def test_flight_times_use_departure_and_arrival_zones(zones):
    # 07:40 in Almaty (UTC+5) -> 02:40Z; 13:10 in Phu Quoc (UTC+7) -> 06:10Z
    d = validate_booking(make_booking(), now=NOW, place_tz=None, trip=None,
                         user_tz="Asia/Almaty", loader=zones)  # fmt: skip
    assert d.starts_at == datetime(2026, 12, 20, 2, 40, tzinfo=UTC)
    assert d.ends_at == datetime(2026, 12, 20, 6, 10, tzinfo=UTC)
    assert d.tz == "Asia/Almaty"
    assert d.details["end_tz"] == "Asia/Ho_Chi_Minh"
    assert d.confirmation_code == "AB12CD"
    assert d.details["flight_number"] == "KC 925"
    assert d.details["departure_airport"] == "ALA" and d.details["arrival_airport"] == "PQC"
    assert d.issues == []


def test_hotel_uses_place_tz_first(zones):
    b = make_booking(type="hotel", title="Sol by Meliá", confirmation_code="HX-99812",
                     start_local="2026-12-20T14:00", end_local="2026-12-25T12:00",
                     location_country=None, arrival_country=None, flight_number=None,
                     departure_airport=None, arrival_airport=None)  # fmt: skip
    d = validate_booking(b, now=NOW, place_tz="Asia/Ho_Chi_Minh", trip=None,
                         user_tz="Asia/Almaty", loader=zones)  # fmt: skip
    assert d.tz == "Asia/Ho_Chi_Minh"
    assert d.starts_at == datetime(2026, 12, 20, 7, 0, tzinfo=UTC)
    assert d.ends_at == datetime(2026, 12, 25, 5, 0, tzinfo=UTC)
    assert "flight_number" not in d.details


def test_tz_falls_back_to_trip_then_user(zones):
    b = make_booking(type="tour", location_country=None, arrival_country=None, end_local=None)
    trip = TripInfo(id=1, title="Фукуок", tz="Asia/Ho_Chi_Minh")
    assert validate_booking(b, now=NOW, place_tz=None, trip=trip, user_tz="Asia/Almaty",
                            loader=zones).tz == "Asia/Ho_Chi_Minh"  # fmt: skip
    d = validate_booking(b, now=NOW, place_tz=None, trip=None, user_tz="Asia/Almaty",
                         loader=zones)  # fmt: skip
    assert d.tz == "Asia/Almaty"
    assert d.starts_at == datetime(2026, 12, 20, 2, 40, tzinfo=UTC)


def test_invalid_flight_code_and_iata_are_dropped(zones):
    b = make_booking(confirmation_code="ABC 1234567", departure_airport="ALMATY",
                     arrival_airport="pqc", flight_number="рейс")  # fmt: skip
    d = validate_booking(b, now=NOW, place_tz=None, trip=None, user_tz=None, loader=zones)
    assert d.confirmation_code is None and ISSUE_CODE in d.issues
    assert "departure_airport" not in d.details
    assert d.details["arrival_airport"] == "PQC"
    assert "flight_number" not in d.details


def test_unparseable_date_is_flagged(zones):
    d = validate_booking(make_booking(start_local="20 декабря", end_local=None), now=NOW,
                         place_tz=None, trip=None, user_tz="Asia/Almaty", loader=zones)
    assert d.starts_at is None and ISSUE_NO_DATE in d.issues
    assert "Не вижу дату" in booking_text(d, None)


def test_past_date_flagged_unless_within_trip(zones):
    b = make_booking(start_local="2026-10-01T10:00", end_local=None)
    d = validate_booking(b, now=NOW, place_tz=None, trip=None, user_tz=None, loader=zones)
    assert ISSUE_PAST in d.issues
    trip = TripInfo(id=1, title="t", starts_on=date(2026, 9, 28), ends_on=date(2026, 10, 5))
    d2 = validate_booking(b, now=NOW, place_tz=None, trip=trip, user_tz=None, loader=zones)
    assert ISSUE_PAST not in d2.issues


def test_end_before_start_is_dropped(zones):
    b = make_booking(end_local="2026-12-19T10:00")
    d = validate_booking(b, now=NOW, place_tz=None, trip=None, user_tz=None, loader=zones)
    assert d.ends_at is None


def test_parse_local_formats():
    assert parse_local("2026-12-20T07:40") == (datetime(2026, 12, 20, 7, 40), True)
    assert parse_local("2026-12-20 07:40") == (datetime(2026, 12, 20, 7, 40), True)
    assert parse_local("2026-12-20") == (datetime(2026, 12, 20), False)
    assert parse_local("tomorrow") == (None, False)


def test_booking_text_is_russian_and_shows_local_time(zones):
    d = validate_booking(make_booking(), now=NOW, place_tz=None, trip=None,
                         user_tz=None, loader=zones)  # fmt: skip
    text = booking_text(d, TripInfo(id=1, title="Фукуок"))
    assert "20.12.2026 07:40" in text and "AB12CD" in text and "Всё верно?" in text
    assert "ИИ" not in text and "AI" not in text


# ---------------------------------------------------------------- trips


TRIPS = [
    TripInfo(id=1, title="Вьетнам", destination="Вьетнам, Фукуок"),
    TripInfo(id=2, title="Стамбул", destination="Стамбул"),
    TripInfo(id=3, title="Старая", destination="Вьетнам", is_active=False),
]


def test_keep_existing_trip():
    assert choose_trip(TRIPS, 2, "Hội An", "VN").id == 2


def test_single_active_trip_attached():
    assert choose_trip(TRIPS[:1], None, "Paris", "FR").id == 1


def test_match_destination_by_country_or_city():
    assert choose_trip(TRIPS, None, "Hội An", "VN").id == 1
    assert choose_trip(TRIPS, None, "Стамбул", "TR").id == 2
    assert choose_trip(TRIPS, None, "Paris", "FR") is None
    assert choose_trip(TRIPS, None, None, None) is None


def test_saved_text():
    assert saved_text("Bánh Mì Phượng", "Hội An", "food", TripInfo(id=1, title="Вьетнам")) == (
        "Сохранил: Bánh Mì Phượng — Hội An, еда\nПоездка: Вьетнам"
    )
    assert saved_text("X", None, "beach", None) == "Сохранил: X — пляж"
