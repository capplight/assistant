"""Ф-89 part 1: time in words, read by code (assistant.timewords), and where it is used — reminders
(«как понял» by code, the model's vague times settled by code, a past time asked), to-dos (the
day), and the one table of the parts of the day. No DB, no network."""

from datetime import UTC, date, datetime, time

import pytest

from assistant import timewords as tw
from assistant.reminders import ReminderParseOut, parse_phrase, rules
from assistant.tasks.parse import TaskLine, TasksReply, check_reply, phrase_day, rules_parse
from tests.reminders.test_parse_unit import router

FRI = datetime(2026, 11, 20, 10, 0)  # Friday 10:00 local
TZ = "Asia/Almaty"
NOW_UTC = datetime(2026, 11, 8, 5, 0, tzinfo=UTC)  # Sunday 10:00 in Almaty (test_parse_unit)


def settle(text: str, now: datetime = FRI) -> tw.Settled:
    r = tw.read(text, now)
    assert r is not None, text
    return tw.settle(r, now)


def iso(s: tw.Settled) -> list[str]:
    return [m.isoformat(timespec="minutes") for m in s.moments]


def test_the_parts_of_the_day_live_in_one_table() -> None:
    assert tw.TIME_DEFAULTS == {
        "morning": time(9), "lunch": time(13), "afternoon": time(14), "evening": time(19),
        "after_work": time(18, 30), "night": time(22), "end_of_day": time(18),
        "early_morning": time(7), "before_lunch": time(11), "late_evening": time(22)}  # fmt: skip
    # the strict reminder rules read the same table
    assert rules.DEFAULT_TIME == tw.TIME_DEFAULTS["morning"]
    assert rules.DAYPART_TIME["днем"] == tw.TIME_DEFAULTS["afternoon"]
    assert rules.DAYPART_TIME["вечером"] == tw.TIME_DEFAULTS["evening"]


@pytest.mark.parametrize(("text", "moments"), [
    ("через 2 часа позвонить", ["2026-11-20T12:00"]),
    ("через полчаса выключить духовку", ["2026-11-20T10:30"]),
    ("через полтора часа забрать машину", ["2026-11-20T11:30"]),
    ("в обед встреча с Айгерим", ["2026-11-20T13:00"]),
    ("днём забрать костюм", ["2026-11-20T14:00"]),
    ("после обеда позвонить", ["2026-11-20T14:00"]),
    ("вечером позвонить маме", ["2026-11-20T19:00"]),
    ("ночью полить", ["2026-11-20T22:00"]),
    ("после работы в спортзал", ["2026-11-20T18:30"]),
    ("к концу дня отчёт", ["2026-11-20T18:00"]),
    ("завтра утром полить цветы", ["2026-11-21T09:00"]),
    ("в следующий вторник вечером врач", ["2026-11-24T19:00"]),
    ("в эту пятницу в 19:30 ужин", ["2026-11-20T19:30"]),
    ("вечером в 7 кино", ["2026-11-20T19:00"]),
    ("завтра в 7 вечера", ["2026-11-21T19:00"]),
    ("в 3 часа дня", ["2026-11-20T15:00"]),
    ("сегодня в 7", ["2026-11-20T19:00"]),  # 7:00 is past: only 19:00 is still ahead
    ("в 19:30 ужин", ["2026-11-20T19:30"]),
    ("в 9:30", ["2026-11-21T09:30"]),  # no day, past today: tomorrow (the draft says «Завтра»)
    # Kazakh (first list, pending native review)
    ("кешке анама қоңырау шалу", ["2026-11-20T19:00"]),
    ("2 сағаттан кейін", ["2026-11-20T12:00"]),
    ("жарты сағаттан кейін", ["2026-11-20T10:30"]),
    ("келесі сейсенбі кешке", ["2026-11-24T19:00"]),
    ("бүрсігүні түсте", ["2026-11-22T13:00"]),
    ("ертең таңертең", ["2026-11-21T09:00"]),
    ("жұмыстан кейін", ["2026-11-20T18:30"]),
    ("күннің соңына дейін", ["2026-11-20T18:00"]),
])  # fmt: skip
def test_time_words_settle_to_one_moment(text: str, moments: list[str]) -> None:
    s = settle(text)
    assert s.status == "ok" and iso(s) == moments


def test_a_day_without_a_time() -> None:
    assert settle("через неделю сдать отчёт").day == date(2026, 11, 27)
    assert settle("через 3 дня").day == date(2026, 11, 23)
    assert settle("послезавтра").day == date(2026, 11, 22)
    assert settle("аптадан кейін").day == date(2026, 11, 27)
    assert settle("в следующий понедельник").day == date(2026, 11, 23)
    assert settle("во вторник").day == date(2026, 11, 24)


def test_a_bare_hour_is_asked_likelier_first() -> None:
    s = settle("послезавтра в 9 стоматолог")
    assert (s.status, s.reason) == ("ask", "ambiguous_hour")
    assert iso(s) == ["2026-11-22T09:00", "2026-11-22T21:00"]
    assert tw.question(s, FRI.date()) == "В 9:00 или в 21:00?"
    s = settle("в 7 выпить таблетку")  # no day at 10:00: 19:00 today, 7:00 tomorrow
    assert iso(s) == ["2026-11-20T19:00", "2026-11-21T07:00"]
    assert tw.question(s, FRI.date()) == "Сегодня в 19:00 или завтра в 7:00?"
    assert settle("ертең сағат 9-да").status == "ask"


def test_a_time_already_past_is_asked_never_set() -> None:
    late = datetime(2026, 11, 20, 20, 0)
    s = settle("сегодня в 19:00 позвонить", late)
    assert (s.status, s.reason) == ("ask", "past")
    assert iso(s) == ["2026-11-20T21:00", "2026-11-21T19:00"]
    assert tw.question(s, late.date()) == ("Это время уже прошло. Сегодня в 21:00 или завтра "
                                           "в 19:00?")  # fmt: skip
    s = settle("вечером позвонить маме", datetime(2026, 11, 20, 21, 0))  # the evening goes on
    assert s.status == "ask" and iso(s) == ["2026-11-20T22:00", "2026-11-21T19:00"]
    assert settle("к концу дня отчёт", late).status == "ask"
    # «утром» at 15:00: the morning is over — tomorrow's, stated in the draft
    assert iso(settle("утром полить", datetime(2026, 11, 20, 15, 0))) == ["2026-11-21T09:00"]
    # «во вторник в 9» on Tuesday at 10:00 → next Tuesday 9:00 (21:00 today is also ahead: asked)
    tue = datetime(2026, 11, 24, 22, 0)
    assert iso(settle("во вторник в 9:00", tue)) == ["2026-12-01T09:00"]
    for text, now in (("через 2 часа", FRI), ("вечером", FRI), ("в обед", FRI)):
        assert all(m > now for m in settle(text, now).moments)


def test_not_time_words_or_two_that_disagree() -> None:
    for text in ("купить хлеб", "в 2 раза больше", "с днём рождения", "на 5000 тенге",
                 "завтра в пятницу", "в 7 и в 9", "утром в 7 вечера", "через 2 часа завтра"):
        assert tw.read(text, FRI) is None, text


def test_title_without_the_time_words() -> None:
    r = tw.read("в следующий вторник вечером врач", FRI)
    assert r is not None and tw.strip("в следующий вторник вечером врач", r.spans) == "врач"


# --- reminders: code reads what the strict rules leave; the model's vague times are code's


async def run(text: str, r=None, *, rules_first: bool = True):  # type: ignore[no-untyped-def]
    return await parse_phrase(text, now=NOW_UTC, tz=TZ, rules_first=rules_first,
                              ai_allowed=r is not None, router=r, user_id=7)  # fmt: skip


@pytest.mark.parametrize(("text", "title", "local"), [
    ("Напомни в обед позвонить в банк", "Позвонить в банк", "2026-11-08T13:00"),
    ("напомни после работы купить хлеб", "Купить хлеб", "2026-11-08T18:30"),
    ("в следующий вторник вечером врач", "Врач", "2026-11-10T19:00"),
    ("через неделю сдать отчёт", "Сдать отчёт", "2026-11-15T09:00"),
    ("к концу дня отправить счёт", "Отправить счёт", "2026-11-08T18:00"),
    ("после обеда позвонить", "Позвонить", "2026-11-08T14:00"),
])  # fmt: skip
async def test_reminder_phrases_read_by_code_without_the_model(text: str, title: str,
                                                                local: str) -> None:
    r, fake = router()
    out = await run(text, r)
    assert fake.calls == 0 and out.source == "rules" and out.status == "ok", out
    d = out.drafts[0]
    assert d.title == title and d.local.isoformat(timespec="minutes") == local


async def test_reminder_past_and_bare_hour_are_questions() -> None:
    out = await run("напомни сегодня в 9:00 позвонить", None)  # 10:00 now
    assert (out.status, out.reason) == ("ambiguous", "past")
    assert [d.local.isoformat() for d in out.drafts] == ["2026-11-08T11:00:00",
                                                         "2026-11-09T09:00:00"]
    assert out.message == "Это время уже прошло. Сегодня в 11:00 или завтра в 9:00?"
    out = await run("послезавтра в 9 стоматолог", None)
    assert out.status == "ambiguous" and [d.local.hour for d in out.drafts] == [9, 21]


async def test_the_models_vague_time_is_settled_by_code() -> None:
    """Kazakh goes to the model; «кешке» is our 19:00, whatever hour the model picked."""
    r, fake = router(ReminderParseOut(understood=True, title="анама қоңырау шалу",
                                      date="2026-11-08", time="18:00"))  # fmt: skip
    out = await run("кешке анама қоңырау шалу еске сал", r)
    assert fake.calls == 1 and out.status == "ok"
    assert out.drafts[0].local.isoformat() == "2026-11-08T19:00:00"
    # a day word the model got wrong is not offered as understood
    r, _ = router(ReminderParseOut(understood=True, title="врач", date="2026-11-11",
                                   time="10:00"))  # fmt: skip
    out = await run("келесі сейсенбі сағат 10:00 дәрігер", r)
    assert (out.status, out.reason) == ("form", "check_failed")
    assert "day_words" in out.checks_failed


# --- to-dos keep the day


def test_todo_day_from_the_longer_words() -> None:
    today = date(2026, 11, 20)
    cases = {
        "Мне через неделю надо сдать отчёт": ("Сдать отчёт", date(2026, 11, 27)),
        "надо позвонить маме в следующий вторник": ("Позвонить маме", date(2026, 11, 24)),
        "надо сдать отчёт через 3 дня": ("Сдать отчёт", date(2026, 11, 23)),
        "Мне завтра надо оплатить свет": ("Оплатить свет", date(2026, 11, 21)),
    }
    for text, want in cases.items():
        r = rules_parse(text, today)
        assert r is not None and [(s.title, s.due_date) for s in r.specs] == [want], text
    assert phrase_day("ертең дүкенге бару", today) == date(2026, 11, 21)
    assert phrase_day("через 2 часа", today) is None  # a moment, not a to-do's day
    # the model's reading: the day is code's, from the phrase
    reply = TasksReply(list="todo", items=[TaskLine(title="Сдать отчёт", qty=None)], day="none")
    got = check_reply("через неделю сдать отчёт", reply, today)
    assert got is not None and got.specs[0].due_date == date(2026, 11, 27)


# --- the calendar (0035): length, the designer's parts, rounding, a to-do with a time


def test_lengths_and_the_designers_parts() -> None:
    def dur(text: str) -> int | None:
        r = tw.read(text, FRI)
        assert r is not None, text
        return r.duration_min

    assert dur("встреча завтра в 15:00 на час") == 60
    assert dur("в обед на 40 минут") == 40
    assert dur("тренировка в 19:00 на 2 часа") == 120
    assert dur("в 10:00 на полтора часа") == 90
    assert dur("созвон с 15 до 16:30") == 90
    assert dur("с 3 до 17") == 120  # 15:00–17:00
    assert iso(settle("встреча с 3 до 5")) == ["2026-11-20T15:00", "2026-11-21T03:00"]
    assert tw.default_duration("Созвон с Ерланом") == 30
    assert tw.default_duration("Встреча") == 60 and tw.default_duration("Купить хлеб") == 60
    assert iso(settle("рано утром таблетка", datetime(2026, 11, 20, 5, 0))) == ["2026-11-20T07:00"]
    assert iso(settle("до обеда")) == ["2026-11-20T11:00"]
    assert iso(settle("перед сном")) == ["2026-11-20T22:00"]
    assert settle("на выходных съездить на дачу").day == date(2026, 11, 21)
    # «через 20 минут» is rounded up to 5 minutes
    assert iso(settle("через 20 минут", datetime(2026, 11, 20, 10, 2))) == ["2026-11-20T10:25"]


def test_a_todo_with_a_time_from_the_phrase() -> None:
    from assistant.tasks.parse import timed_phrase

    r = timed_phrase("добавь встречу завтра в 15:00 на час", FRI)
    assert r is not None and (r.title, r.duration_min, r.status) == ("Встреча", 60, "ok")
    assert [m.isoformat() for m in r.moments] == ["2026-11-21T15:00:00"]
    r = timed_phrase("поставь тренировку каждый вторник в 19:00", FRI)
    assert r is not None and r.rrule == "FREQ=WEEKLY;BYDAY=TU" and r.title == "Тренировка"
    assert r.moments[0].isoformat() == "2026-11-24T19:00:00"
    r = timed_phrase("запиши созвон в пятницу в 11:30", FRI)
    assert r is not None and r.duration_min == 30 and r.title == "Созвон"
    r = timed_phrase("добавь встречу с Айгерим на завтра", FRI)
    assert r is not None and r.moments == () and r.day == date(2026, 11, 21)
    r = timed_phrase("добавь звонок маме сегодня в 9:00", FRI)
    assert r is not None and (r.status, r.reason) == ("ask", "past")
    for text in ("добавь в покупки молоко", "добавь хлеб", "запиши 5000 тенге на бензин сегодня",
                 "добавь страницу Стамбул", "что у меня завтра в 15:00?"):
        assert timed_phrase(text, FRI) is None, text


def test_calendar_repeats_by_code() -> None:
    from assistant.tasks.calendar import Window, check_rrule, expand, with_until
    from assistant.tasks.service import TaskError

    assert check_rrule("rrule:freq=weekly;byday=tu,th") == "FREQ=WEEKLY;BYDAY=TU,TH"
    assert check_rrule("FREQ=DAILY;UNTIL=20261130T000000Z") == "FREQ=DAILY;UNTIL=20261130T000000Z"
    for bad in ("FREQ=YEARLY", "FREQ=DAILY;BYDAY=MO", "FREQ=DAILY;COUNT=3", "FREQ=DAILY;UNTIL=x"):
        with pytest.raises(TaskError):
            check_rrule(bad)
    start = datetime(2026, 11, 20, 2, 0, tzinfo=UTC)  # 7:00 in Almaty
    lo, hi = datetime(2026, 11, 20, tzinfo=UTC), datetime(2026, 11, 24, tzinfo=UTC)
    got = expand(start, "FREQ=DAILY", "Asia/Almaty", lo, hi)
    assert [g.isoformat() for g in got][:2] == ["2026-11-20T02:00:00+00:00",
                                                "2026-11-21T02:00:00+00:00"]
    ended = with_until("FREQ=DAILY", datetime(2026, 11, 22, 2, 0, tzinfo=UTC))
    assert len(expand(start, ended, "Asia/Almaty", lo, hi)) == 2
    assert expand(start, None, "Asia/Almaty", lo, hi) == [start]
    with pytest.raises(ValueError):
        Window("Asia/Almaty", date(2026, 11, 1), date(2027, 1, 30))


def test_migration_0035_is_frozen_and_chained() -> None:
    import importlib.util
    from pathlib import Path

    path = Path(__file__).parents[1] / "migrations" / "versions" / "0035_calendar.py"
    spec = importlib.util.spec_from_file_location("m0035", path)
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    assert (mod.revision, mod.down_revision) == ("0035", "0034")
    assert "create_all(" not in path.read_text(encoding="utf-8")
    assert any("task_occurrences" in sql for sql in mod.UPGRADE)
    assert "'task_occurrence'" in mod._TOMBS_NEW and "'task_occurrence'" not in mod._TOMBS_OLD
