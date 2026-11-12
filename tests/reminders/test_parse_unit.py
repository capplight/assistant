"""«Как понял» with Ф-1 off (default: every phrase to the model, consent gate) and on (code first),
the code check of the model's dates, and the texts. No DB, no network: the model is a fake."""

from datetime import UTC, datetime, time

import pytest

from assistant.ai import FakeAdapter, MemoryAIStore, Router, load_routes
from assistant.ai.types import ServerError
from assistant.config import Settings
from assistant.reminders import ReminderParseOut, parse_phrase, texts
from assistant.reminders.parse import check_model_reading

NOW = datetime(2026, 11, 8, 5, 0, tzinfo=UTC)  # Sunday 10:00 in Almaty
TZ = "Asia/Almaty"
USER = 7


def settings() -> Settings:
    return Settings(  # type: ignore[call-arg]
        _env_file=None,
        anthropic_api_key="",
        openai_api_key="",
        google_api_key="",
        groq_api_key="",
        ai_primary_provider="anthropic",
        ai_fallback_provider="openai",
    )


def router(*steps: object) -> tuple[Router, FakeAdapter]:
    s = settings()
    fake = FakeAdapter("anthropic", list(steps))  # type: ignore[arg-type]
    store = MemoryAIStore()
    store.profiles[USER] = "regular"
    store.consents[USER] = frozenset({"anthropic", "openai", "google", "groq"})
    r = Router(
        settings=s,
        routes=load_routes(s),
        adapters={"anthropic": fake},
        store=store,
        clock=lambda: NOW,
    )
    return r, fake


async def run(text: str, r: Router | None, *, rules_first: bool, ai: bool = True, via: str = "typed"):  # type: ignore[no-untyped-def]  # noqa: E501
    return await parse_phrase(
        text,
        now=NOW,
        tz=TZ,
        created_via=via,
        rules_first=rules_first,
        ai_allowed=ai,
        router=r,
        user_id=USER,
    )


TOMORROW_7 = ReminderParseOut(
    understood=True, title="выпить таблетку", date="2026-11-09", time="07:00"
)


# --- Ф-1 off (default) ---


async def test_off_simple_phrase_still_goes_to_the_model() -> None:
    r, fake = router(TOMORROW_7)
    out = await run("Напомни завтра в 7:00 выпить таблетку", r, rules_first=False)
    assert fake.calls == 1 and out.source == "llm" and out.status == "ok"
    d = out.drafts[0]
    assert d.title == "Выпить таблетку"
    assert d.due_at == datetime(2026, 11, 9, 2, 0, tzinfo=UTC)
    assert out.model_calls == 1 and out.cost_usd > 0
    # the phrase travelled as data, not as instructions
    assert "<untrusted_data>" in fake.requests[0].messages[-1].text


async def test_off_without_consent_is_the_manual_form() -> None:
    r, fake = router(TOMORROW_7)
    out = await run("завтра в 7:00 выпить таблетку", r, rules_first=False, ai=False)
    assert (out.status, out.reason, fake.calls) == ("form", "no_ai", 0)
    assert out.message == "Укажите время вручную."


async def test_off_provider_down_is_the_manual_form() -> None:
    r, _ = router(ServerError("down"))
    out = await run("завтра в 7:00 выпить таблетку", r, rules_first=False)
    assert (out.status, out.reason) == ("form", "ai_unavailable")


def test_flag_is_off_by_default() -> None:
    assert settings().reminders_rules_first is False


# --- Ф-1 on ---


async def test_on_simple_phrase_is_read_by_code_without_the_model() -> None:
    r, fake = router(TOMORROW_7)
    out = await run("Напомни завтра в 7:00 выпить таблетку", r, rules_first=True)
    assert fake.calls == 0 and out.source == "rules" and out.status == "ok"
    assert out.cost_usd == 0
    assert out.drafts[0].due_at == datetime(2026, 11, 9, 2, 0, tzinfo=UTC)


async def test_on_works_without_consent_and_without_a_router() -> None:
    out = await run("через 2 часа позвонить Ерлану", None, rules_first=True, ai=False)
    assert out.status == "ok" and out.source == "rules"
    assert out.drafts[0].due_at == datetime(2026, 11, 8, 7, 0, tzinfo=UTC)


async def test_on_unclear_phrase_goes_to_the_model() -> None:
    r, fake = router(
        ReminderParseOut(understood=True, title="позвонить", date="2026-11-08", time="14:00")
    )
    out = await run("после обеда позвонить", r, rules_first=True)
    assert fake.calls == 1 and out.source == "llm" and out.status == "ok"


async def test_on_unclear_phrase_without_consent_is_the_form() -> None:
    out = await run("после обеда позвонить", None, rules_first=True, ai=False)
    assert (out.status, out.reason) == ("form", "no_ai")


async def test_on_ambiguous_hour() -> None:
    out = await run("завтра в 7 выпить таблетку", None, rules_first=True, ai=False)
    assert out.status == "ambiguous"
    assert [d.local.time() for d in out.drafts] == [time(7), time(19)]
    assert out.message == "В 7 утра или в 7 вечера?"


# --- the code check of the model's reading ---


def _m(**kw: object) -> ReminderParseOut:
    return ReminderParseOut(understood=True, title="т", **kw)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("text", "out", "check"),
    [
        ("завтра в 7:00 выпить таблетку", _m(date="2026-11-09", time="08:00"), "clock"),
        ("завтра в 7 выпить таблетку", _m(date="2026-11-10", time="07:00"), "day_word"),
        ("в пятницу в 18:00 концерт", _m(date="2026-11-12", time="18:00"), "weekday"),
        ("20 ноября в 10:00 день рождения", _m(date="2026-11-21", time="10:00"), "day_month"),
        ("через 2 часа позвонить", _m(date="2026-11-08", time="13:00"), "relative"),
        # week 17: a bare «в 9» is now asked by code (test_ambiguous_hour_unit.py)
        ("в 9 вечера врач", _m(date="2026-11-09", time="10:00"), "hour"),
        ("завтра в 9:00 врач", _m(date="2026-11-09", time="09:00", offsets=[30]), "offsets"),
        ("завтра в 9:00 врач", _m(date="2031-11-09", time="09:00"), "day_word"),
    ],
)
async def test_model_reading_that_contradicts_the_phrase_is_not_offered(
    text: str, out: ReminderParseOut, check: str
) -> None:
    r, _ = router(out)
    res = await run(text, r, rules_first=False)
    assert (res.status, res.reason) == ("form", "check_failed")
    assert check in res.checks_failed
    assert res.message == "Проверьте время — я мог ошибиться."


@pytest.mark.parametrize(
    "bad",
    [
        _m(date="2026-11-31", time="09:00"),
        _m(date="2026-11-09", time="25:00"),
        _m(repeat="monthly", month_day=40, time="09:00"),
    ],
)
async def test_model_bad_formats_are_rejected(bad: ReminderParseOut) -> None:
    r, _ = router(bad)
    res = await run("что-то когда-то", r, rules_first=False)
    assert (res.status, res.reason) == ("form", "check_failed")


async def test_model_ambiguous_repeat() -> None:
    r, _ = router(_m(repeat="weekly", weekdays=["MO"], time_options=["09:00", "21:00"]))
    res = await run("каждый понедельник в 9 планёрка", r, rules_first=False)
    assert res.status == "ambiguous" and res.drafts[0].rrule == "FREQ=WEEKLY;BYDAY=MO"
    assert res.drafts[0].local.isoformat() == "2026-11-09T09:00:00"


async def test_model_past_and_not_understood() -> None:
    r, _ = router(_m(date="2026-11-08", time="09:00"))
    res = await run("сегодня в 9:00 позвонить", r, rules_first=False)
    assert (res.status, res.reason) == ("form", "past")
    r, _ = router(ReminderParseOut(understood=False))
    res = await run("какая погода", r, rules_first=False)
    assert (res.status, res.reason) == ("form", "not_understood")


def test_consistent_reading_passes_every_check() -> None:
    out = _m(date="2026-11-13", time="19:00", offsets=[1440])
    local = datetime(2026, 11, 13, 19, 0)
    now_local = datetime(2026, 11, 8, 10, 0)
    phrase = "в пятницу в 7 вечера ужин, накануне"
    assert check_model_reading(phrase, out, local, now_local, None) == []


# --- level (R-11) and texts ---


async def test_level_loud_words_and_voice() -> None:
    out = await run("разбуди завтра в 6:30", None, rules_first=True, ai=False)
    assert out.drafts[0].level == "alarm"
    out = await run("завтра в 9:00 врач", None, rules_first=True, ai=False)
    assert out.drafts[0].level == "notification"
    out = await run("завтра в 9:00 врач", None, rules_first=True, ai=False, via="voice")
    assert out.drafts[0].level == "alarm"
    out = await run("завтра позвонить", None, rules_first=True, ai=False, via="voice")
    assert out.drafts[0].level == "notification" and out.drafts[0].time_assumed


def test_texts() -> None:
    today = datetime(2026, 11, 8).date()
    d = datetime(2026, 11, 9, 7, 0)
    assert (
        texts.when_text(d, None, [60], "alarm", today)
        == "Завтра, понедельник, 9 ноября · 7:00 · Будильник · и за час"
    )
    assert texts.saved_text(d, None, today) == "Напомню завтра в 7:00"
    after = texts.saved_text(datetime(2026, 11, 10, 9, 0), None, today)
    assert after == "Напомню послезавтра в 9:00"
    assert texts.saved_text(datetime(2026, 11, 11, 9, 0), None, today) == "Напомню в среду в 9:00"
    assert texts.saved_text(datetime(2026, 11, 24, 9, 0), None, today) == "Напомню 24 ноября в 9:00"
    assert (
        texts.when_text(d, "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", [], "notification", today)
        == "По будням · 7:00 · Уведомление"
    )
    assert texts.repeat_label("FREQ=WEEKLY;BYDAY=WE") == "Каждую среду"
    assert texts.repeat_label("FREQ=MONTHLY;BYMONTHDAY=5") == "Каждый месяц, 5-го"
    assert texts.ambiguous_text([time(3), time(15)]) == "В 3 ночи или в 3 дня?"
    for line in [*texts.MSG.values(), texts.PUSH_BACKUP, texts.PUSH_MISSED, texts.TEST_TITLE]:
        assert "ИИ" not in line
