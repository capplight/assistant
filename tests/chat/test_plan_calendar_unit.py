"""A plan on the calendar: the phrase readers and the pure helpers (plans.md «A plan on the
calendar»). No DB, no network."""

from datetime import date, time

import pytest

from assistant.chat import plan_line
from assistant.plans import build
from assistant.plans.calendar import point_time, range_text

TODAY = date(2026, 11, 20)  # a Friday


@pytest.mark.parametrize("phrase,op", [
    ("добавь план в календарь", "add"),
    ("Поставь поездку в календарь", "add"),
    ("перенеси план по дням в календарь", "add"),
    ("можешь добавить план в календарь?", "add"),
    ("закинь Стамбул в календарь с 10 декабря", "add"),
    ("убери план из календаря", "remove"),
    ("удали поездку из календаря", "remove"),
    ("перенеси поездку на неделю позже", "shift"),
    ("сдвинь план на 2 дня раньше", "shift"),
    ("перенеси поездку на 17 декабря", "shift"),
])  # fmt: skip
def test_calendar_phrase_reads_the_op(phrase: str, op: str) -> None:
    ask = plan_line.calendar_phrase(phrase)
    assert ask is not None and ask.op == op


@pytest.mark.parametrize("phrase", [
    "что у меня в календаре на завтра?", "что в календаре по плану",
    "составь план поездки в Стамбул", "сделай делами", "перенеси встречу", "купил хлеб за 400",
])  # fmt: skip
def test_not_a_calendar_phrase(phrase: str) -> None:
    assert plan_line.calendar_phrase(phrase) is None


def test_a_to_do_for_the_calendar_names_no_plan() -> None:
    ask = plan_line.calendar_phrase("добавь встречу в календарь завтра в 15")
    assert ask is not None and not ask.plan_word  # the line falls through to the to-do path


@pytest.mark.parametrize("phrase,day", [
    ("с 10 декабря", date(2026, 12, 10)),
    ("добавь в календарь с 3 января", date(2027, 1, 3)),
    ("с 10.12", date(2026, 12, 10)),
    ("с понедельника", date(2026, 11, 23)),
    ("со следующей недели", date(2026, 11, 23)),
    ("завтра", date(2026, 11, 21)),
    ("добавь план в календарь", None),
])  # fmt: skip
def test_said_start(phrase: str, day: date | None) -> None:
    assert plan_line.said_start(phrase, TODAY) == day


@pytest.mark.parametrize("phrase,out", [
    ("перенеси поездку на неделю позже", (7, None)),
    ("сдвинь план на 2 дня раньше", (-2, None)),
    ("перенеси поездку на две недели", (14, None)),
    ("перенеси поездку на следующую неделю", (7, None)),
    ("перенеси поездку на 17 декабря", (None, date(2026, 12, 17))),
])  # fmt: skip
def test_shift_of(phrase: str, out: tuple) -> None:
    assert plan_line.shift_of(phrase, TODAY) == out


def test_names_plan_by_title() -> None:
    assert plan_line.names_plan("закинь поездку в Стамбул в календарь", "Стамбул")
    assert not plan_line.names_plan("добавь план в календарь", "Стамбул")
    assert plan_line.names_plan("убери ремонт кухни из календаря", "Ремонт кухни")


def test_point_time_never_guesses() -> None:
    day = date(2026, 12, 10)
    assert point_time({"title": "Ужин на крыше в 19:00", "note": None}, day) == time(19, 0)
    assert point_time({"title": "Балат", "note": "утром"}, day) == time(9, 0)
    assert point_time({"title": "Ужин", "note": "вечером"}, day) == time(19, 0)
    assert point_time({"title": "Голубая мечеть", "note": "до 10 утра"}, day) is None
    assert point_time({"title": "Кафе", "note": "до 23:00"}, day) is None
    assert point_time({"title": "Паром в 7", "note": None}, day) is None  # 7:00 or 19:00?
    assert point_time({"title": "Паром", "note": "40 минут"}, day) is None


def test_range_text() -> None:
    assert range_text(date(2026, 12, 10), date(2026, 12, 14)) == "10–14 декабря"
    assert range_text(date(2026, 11, 30), date(2026, 12, 2)) == "30 ноября – 2 декабря"
    assert range_text(date(2026, 12, 10), date(2026, 12, 10)) == "10 декабря"


def test_date_options() -> None:
    labels = [label for label, _ in plan_line.date_options(TODAY)]
    assert labels == ["С завтра, 21 ноября", "С понедельника, 23 ноября"]  # Sat == tomorrow


def test_text_of_writes_the_dates() -> None:
    plan = {"kind": "trip", "title": "Стамбул", "days": [
        {"n": 1, "date": "2026-12-10", "title": "Балат",
         "points": [{"title": "Дома", "note": "утром", "own": False}]}]}  # fmt: skip
    assert build.text_of(plan) == "Стамбул · 1 день\n\n10 декабря, чт · Балат\n1. Дома — утром"
