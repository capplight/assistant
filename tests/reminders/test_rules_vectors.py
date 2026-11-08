"""The rules-first parser against the vectors shared with the phone
(docs/api/reminder-parse-vectors.json), plus the cases those vectors exist to protect."""

import json
from datetime import UTC, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

from assistant.reminders import rules

VECTORS = json.loads(
    (Path(__file__).parents[2] / "docs" / "api" / "reminder-parse-vectors.json").read_text(
        encoding="utf-8"
    )
)
NOW = datetime.fromisoformat(VECTORS["now"])
TZ = VECTORS["tz"]


def _shape(result: rules.RulesResult | None) -> dict | None:
    if result is None:
        return None
    return {
        "readings": [
            {
                "title": r.title,
                "date": r.local_date.isoformat(),
                "time": r.local_time.strftime("%H:%M"),
                "rrule": r.rrule,
                "offsets": list(r.offsets),
                "loud": r.loud,
                "time_assumed": r.time_assumed,
            }
            for r in result.readings
        ]
    }


@pytest.mark.parametrize("vector", VECTORS["vectors"], ids=lambda v: v["text"])
def test_vector(vector: dict) -> None:
    assert _shape(rules.parse(vector["text"], NOW, TZ)) == vector["expect"]


def test_vectors_cover_both_sides() -> None:
    understood = [v for v in VECTORS["vectors"] if v["expect"]]
    given_up = [v for v in VECTORS["vectors"] if v["expect"] is None]
    assert len(understood) >= 50 and len(given_up) >= 10
    assert any(len(v["expect"]["readings"]) == 2 for v in understood)  # «в 7»
    assert any(v["expect"]["readings"][0]["rrule"] for v in understood)
    assert any(v["expect"]["readings"][0]["offsets"] for v in understood)


def test_same_moment_in_utc_for_almaty() -> None:
    r = rules.parse("завтра в 10:30 позвонить Ерлану", NOW, TZ)
    assert r is not None
    one = r.readings[0]
    local = datetime.combine(one.local_date, one.local_time)
    assert local.isoformat() == "2026-11-09T10:30:00"
    assert local.replace(tzinfo=ZoneInfo(TZ)).astimezone(UTC).hour == 5  # Almaty is UTC+5


def test_relative_counts_from_now_across_midnight() -> None:
    late = datetime(2026, 11, 8, 18, 50, tzinfo=UTC)  # 23:50 in Almaty
    r = rules.parse("через 20 минут выключить плиту", late, TZ)
    assert r is not None
    one = r.readings[0]
    assert (one.local_date.isoformat(), one.local_time.isoformat()) == ("2026-11-09", "00:10:00")


def test_counts_after_a_number_are_not_hours() -> None:
    r = rules.parse("купить билеты на 2 человека завтра в 9:00", NOW, TZ)
    assert r is not None and [x.local_time.hour for x in r.readings] == [9]
    assert rules.parse("в 2 раза больше воды", NOW, TZ) is None


def test_kazakh_and_long_text_are_left_to_the_model() -> None:
    assert rules.parse("Ертең сағат 10-да дәрігер", NOW, TZ) is None
    assert rules.parse("завтра в 10:00 " + "а" * 600, NOW, TZ) is None
