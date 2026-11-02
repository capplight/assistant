import pytest

from assistant.bot.callbacks import (
    BookingAnswer,
    Consent,
    DeleteAll,
    Pick,
    SwitchTrip,
    parse_callback,
    trip_cb,
)


@pytest.mark.parametrize(
    ("data", "expected"),
    [
        ("consent:yes", Consent()),
        ("del:yes", DeleteAll(True)),
        ("del:no", DeleteAll(False)),
        ("trip:12", SwitchTrip(12)),
        (trip_cb(7), SwitchTrip(7)),
        ("pick:5:2", Pick(5, 2)),
        ("pick:5:-1", Pick(5, -1)),
        ("bk:9:ok", BookingAnswer(9, True)),
        ("bk:9:no", BookingAnswer(9, False)),
    ],
)
def test_valid(data, expected):
    assert parse_callback(data) == expected


@pytest.mark.parametrize(
    "data",
    [
        None,
        "",
        "consent:no",
        "trip:",
        "trip:x",
        "trip:-3",
        "trip:1:2",
        "pick:5",
        "pick:a:1",
        "pick:5:-2",
        "bk:9:maybe",
        "bk:x:ok",
        "bk:9",
        "other:1",
    ],
)
def test_invalid(data):
    assert parse_callback(data) is None


def test_callback_data_fits_telegram_limit():
    assert len(trip_cb(2**63 - 1).encode()) <= 64
