"""Founder 2026-11-09: a bare hour («в 7», «сағат 7-де») is always asked «7:00 или 19:00?», on the
model path too (rules off), whatever the model put in its fields. No DB, no network."""

from datetime import time

import pytest

from assistant.reminders import ReminderParseOut, texts
from assistant.reminders.rules import ambiguous_hour
from tests.reminders.test_parse_unit import router, run  # NOW: Sunday 10:00 Almaty


@pytest.mark.parametrize(("text", "options"), [
    ("Напомни в 7 полить цветы", [time(7), time(19)]),
    ("Напомни завтра в 10 позвонить врачу", [time(10), time(22)]),
    ("напомни в 3 забрать сына", [time(15), time(3)]),
    ("Напомни в 7 часов выпить таблетку", [time(7), time(19)]),
    ("Ертең сағат 7-де дәрігерге баруды еске сал", [time(7), time(19)]),
    ("Жұма күні 6-да сәлемдеме алу", [time(18), time(6)]),  # 1-6: afternoon first
    ("сағат 10 жиналыс", [time(10), time(22)]),
])  # fmt: skip
def test_bare_hour_is_found_in_the_phrase(text, options):
    assert ambiguous_hour(text) == options


@pytest.mark.parametrize("text", [
    "Напомни в 7 вечера полить цветы", "Напомни в 7 утра", "в 7, вечером позвонить",
    "Напомни в 19 позвонить", "Напомни в 19:00 позвонить", "в 07 подъём", "в 12 обед",
    "Напомни в 7 после обеда", "через 2 часа выключить духовку", "в 2 раза больше воды",
    "Кешке сағат 7-де жаттығу", "Таңертең сағат 7-де жүгіру", "Ертең сағат 9:00-де",
    "18.11.2026 сағат 18:30", "20 қарашада салық", "купить хлеб",
])  # fmt: skip
def test_settled_or_no_hour_is_not_asked(text):
    assert ambiguous_hour(text) is None


def _out(date: str | None, at: str | None, **kw) -> ReminderParseOut:  # type: ignore[no-untyped-def]
    return ReminderParseOut(understood=True, title="полить цветы", date=date, time=at, **kw)


async def test_model_picks_one_hour_code_still_asks():
    r, _ = router(_out("2026-11-08", "19:00"))
    res = await run("Напомни в 7 полить цветы", r, rules_first=False)
    assert res.status == "ambiguous" and res.source == "llm"
    got = sorted(d.local.isoformat(timespec="minutes") for d in res.drafts)
    # 7:00 today is past at 10:00: tomorrow 7:00, as the rules path does
    assert got == ["2026-11-08T19:00", "2026-11-09T07:00"]
    assert res.message == texts.ambiguous_text([d.local.time() for d in res.drafts])
    assert "7" in res.message and "?" in res.message


async def test_model_morning_tomorrow_still_asked():
    r, _ = router(_out("2026-11-09", "10:00"))
    res = await run("Напомни завтра в 10 позвонить врачу", r, rules_first=False)
    assert res.status == "ambiguous"
    assert sorted(d.local.strftime("%H:%M") for d in res.drafts) == ["10:00", "22:00"]
    assert {d.local.date().isoformat() for d in res.drafts} == {"2026-11-09"}


async def test_kazakh_bare_hour_is_asked_on_the_model_path():
    r, _ = router(_out("2026-11-09", "07:00"))
    res = await run("Ертең сағат 7-де дәрігерге баруды еске сал", r, rules_first=False)
    assert res.status == "ambiguous"
    assert sorted(d.local.strftime("%H:%M") for d in res.drafts) == ["07:00", "19:00"]


async def test_repeating_bare_hour_is_asked_too():
    r, _ = router(_out(None, "08:00", repeat="daily"))
    res = await run("Напомни каждый день в 8 пить воду", r, rules_first=False)
    assert res.status == "ambiguous"
    assert {d.rrule for d in res.drafts} == {"FREQ=DAILY"}


async def test_settled_hour_keeps_the_model_reading():
    r, _ = router(_out("2026-11-08", "19:00"))
    res = await run("Напомни в 7 вечера полить цветы", r, rules_first=False)
    assert res.status == "ok" and res.drafts[0].local.strftime("%H:%M") == "19:00"


async def test_rules_path_unchanged():
    res = await run("Напомни в 7 полить цветы", None, rules_first=True, ai=False)
    assert res.status == "ambiguous" and res.source == "rules"


async def test_model_wrong_hour_for_a_bare_hour_is_replaced_by_the_question():
    """The model's hour does not matter: code asks the person's «в 9» (9:00 or 21:00)."""
    r, _ = router(_out("2026-11-09", "10:00"))
    res = await run("в 9 врач", r, rules_first=False)
    assert res.status == "ambiguous"
    assert sorted(d.local.strftime("%H:%M") for d in res.drafts) == ["09:00", "21:00"]
