"""A plan on the calendar: the phrase readers and the pure helpers (plans.md «A plan on the
calendar»). No DB, no network."""

from datetime import date, time

import pytest

from assistant.chat import plan_line
from assistant.plans import build
from assistant.plans.calendar import point_time, propose_times, range_text

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


# --- Ф-96 ---


@pytest.mark.parametrize("phrase,answer,mode", [
    ("добавь каждый пункт отдельно в календарь", False, "points"),
    ("по пунктам", True, "points"),
    ("Каждый пункт отдельно", True, "points"),
    ("просто добавь план в календарь", False, "days"),
    ("перенеси план по дням в календарь", False, "days"),
    ("нет", True, "days"),
    ("нет", False, None),
    ("без разницы", True, "days"),
    ("не надо отдельно", True, "days"),
    ("добавь план в календарь", False, None),
])  # fmt: skip
def test_mode_of(phrase: str, answer: bool, mode: str | None) -> None:
    assert plan_line.mode_of(phrase, answer=answer) == mode


@pytest.mark.parametrize("phrase,out", [
    ("да", "ok"), ("Поставь так", "ok"), ("ок", "ok"), ("отмена", "cancel"),
    ("лучше по дням", "days"), ("ужин в 20", None),
])  # fmt: skip
def test_times_reply(phrase: str, out: str | None) -> None:
    assert plan_line.times_reply(phrase) == out


DAYS = [{"n": 1, "title": "Султанахмет", "points": [
            {"id": "d1p1", "title": "Голубая мечеть", "note": "до 10 утра"},
            {"id": "d1p2", "title": "Обед у Сулеймание", "note": None},
            {"id": "d1p3", "title": "Музей Топкапы", "note": None},
            {"id": "d1p4", "title": "Ужин на крыше", "note": "в 20:30"}]},
        {"n": 2, "title": "Кадыкёй", "points": [
            {"id": "d2p1", "title": "Рынок Кадыкёя", "note": "утром"},
            {"id": "d2p2", "title": "Ужин в Мода", "note": None}]}]  # fmt: skip


def test_propose_times_keeps_own_and_fills_slots() -> None:
    times = propose_times(DAYS, [date(2026, 12, 10), date(2026, 12, 11)])
    assert times == {"d1p1": "09:00", "d1p2": "13:00", "d1p3": "15:00", "d1p4": "20:30",
                     "d2p1": "09:00", "d2p2": "19:00"}  # fmt: skip


def test_apply_edits_one_phrase() -> None:
    times = propose_times(DAYS, [date(2026, 12, 10), date(2026, 12, 11)])
    new, missed = plan_line.apply_edits("ужин в 8, музей утром и вертолёт в 12", DAYS, times,
                                        TODAY)  # fmt: skip
    # «ужин в 8» → 20:00 (nearest the proposed evening), both dinners; «музей утром» → 9:00
    assert new["d1p4"] == "20:00" and new["d2p2"] == "20:00" and new["d1p3"] == "09:00"
    assert new["d1p2"] == "13:00" and missed == ["вертолёт в 12"]
