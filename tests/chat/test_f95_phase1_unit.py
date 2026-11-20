"""Ф-95 phase 1, no DB: the line's operation tools (generated from the registry, chosen by code),
time words for moves, the «Да» rule, the word guards, `touched` and the change-turn cost alert
(docs/spec/proposals/chat-full-control.md §3.2–3.6)."""

from datetime import datetime
from types import SimpleNamespace

import pytest

from assistant.actions.service import touched_of
from assistant.ai.costs import Snapshot, evaluate
from assistant.chat import ops_line
from assistant.chat.intent import Intent, rules_first, undo_phrase
from tests.ai.conftest import make_settings

NOW = datetime(2026, 11, 12, 10, 0)  # local, Thursday


@pytest.mark.parametrize(("phrase", "domains"), [
    ("перенеси встречу с Ерланом на 16:00", ["tasks", "calendar"]),
    ("отмени напоминание про свет", ["reminders"]),
    ("исправь трату: не 500, а 5000", ["expenses"]),
    ("отметь хлеб", ["tasks"]),
    ("поправь заголовок", ["tasks", "calendar"]),  # nothing named: the frequent two
])  # fmt: skip
def test_domains_by_code(phrase: str, domains: list[str]) -> None:
    assert ops_line.domains_for(phrase) == domains


def test_questions_get_no_line_tools_unless_they_ask_about_the_calendar() -> None:
    for q in ("Что у меня на этой странице?", "Какие у меня записи?", "Сколько в чеке?"):
        state = ops_line.LineState(read=bool(ops_line.read_domains_for(q)))
        assert ops_line.tools_of(state, change=False) == ()
    assert ops_line.read_domains_for("что у меня в пятницу?") == ["calendar"]
    assert ops_line.read_domains_for("какие у меня напоминания?") == ["reminders"]
    state = ops_line.LineState(read=True)
    assert [t.name for t in ops_line.tools_of(state, change=False)] == ["lookup"]


def test_change_tools_are_the_chosen_domains_plus_need_tools() -> None:
    state = ops_line.LineState(domains=["reminders"], read=True)
    assert [t.name for t in ops_line.tools_of(state, change=True)] == [
        "lookup", "reminders", "need_tools"]  # fmt: skip
    state.wanted.append("expenses")  # need_tools: on the next step, the order stays fixed
    assert [t.name for t in ops_line.tools_of(state, change=True)] == [
        "lookup", "reminders", "expenses", "need_tools"]  # fmt: skip


@pytest.mark.parametrize(("words", "base", "want"), [
    ("на 16:00", datetime(2026, 11, 13, 15, 0), datetime(2026, 11, 13, 16, 0)),
    ("на пятницу", datetime(2026, 11, 16, 15, 0), datetime(2026, 11, 13, 15, 0)),
    ("на час позже", datetime(2026, 11, 13, 15, 0), datetime(2026, 11, 13, 16, 0)),
    ("на 30 минут раньше", datetime(2026, 11, 13, 15, 0), datetime(2026, 11, 13, 14, 30)),
    ("на 4", datetime(2026, 11, 13, 15, 0), datetime(2026, 11, 13, 16, 0)),
    ("на 3 декабря в 11:00", None, datetime(2026, 12, 3, 11, 0)),
    ("вечером", datetime(2026, 11, 13, 15, 0), datetime(2026, 11, 13, 19, 0)),
])  # fmt: skip
def test_time_words_of_a_move(words: str, base: datetime | None, want: datetime) -> None:
    w = ops_line.read_when(words, NOW, base=base)
    assert (w.status, w.moment) == ("ok", want)


def test_unclear_or_past_time_is_asked() -> None:
    w = ops_line.read_when("на завтра в 9", NOW)
    assert w.status == "ask" and len(w.moments) == 2
    w = ops_line.read_when("сегодня в 8:00", NOW)
    assert w.status == "ask" and w.reason == "past"
    assert ops_line.read_when("попозже", NOW).status == "none"
    w = ops_line.read_when("в пятницу", NOW)  # a day only: an all-day to-do moves its day
    assert w.status == "ok" and w.moment is None and str(w.day) == "2026-11-13"


def test_yes_rule() -> None:
    one = ops_line.Planned(calls=[("tasks.set_done", {})], count=1)
    assert not ops_line.needs_yes(one, "отметь хлеб")
    many = ops_line.Planned(calls=[("tasks.set_done", {})], count=11)
    assert ops_line.needs_yes(many, "отметь это")  # > 10
    two = ops_line.Planned(calls=[("tasks.set_done", {})], count=2)
    assert ops_line.needs_yes(two, "отметь всё из Магнума")  # «все» over several
    assert not ops_line.needs_yes(two, "отметь молоко и хлеб")


def test_word_guards() -> None:
    assert ops_line.says_delete("удали встречу") and ops_line.says_delete("не напоминай про свет")
    assert not ops_line.says_delete("перенеси встречу попозже")
    assert ops_line.says_fix("не 500, а 5000") and ops_line.says_fix("это было вчера")
    assert not ops_line.says_fix("сколько я потратил?")
    assert ops_line.fixes_expense("исправь трату за такси: не 500, а 5000")
    assert not ops_line.fixes_expense("потратил 5000 на бензин")


def test_cancel_a_reminder_is_not_an_undo_and_is_a_change() -> None:
    assert undo_phrase("отмени напоминание про свет") is None
    assert undo_phrase("отмени встречу с Ерланом") is None
    assert undo_phrase("отмени") is not None  # the last change, as before
    for p in ("отметь хлеб", "сдвинь созвон на час", "поменяй сумму на 1500",
              "не напоминай про свет", "пропусти тренировку во вторник"):
        assert rules_first(p).intent == Intent.CHANGE, p


@pytest.mark.parametrize(("phrase", "kind", "what"), [
    ("хлеб купил", "done", "хлеб"), ("я позвонил маме", "done", "маме"),
    ("не купил хлеб", "undone", "хлеб"), ("не напоминай про свет", "cancel", "свет"),
    ("перенеси врача на пятницу", "move", "врача"),
])  # fmt: skip
def test_code_reads_the_frequent_phrases(phrase: str, kind: str, what: str) -> None:
    ask = ops_line.read_code(phrase)
    assert ask is not None and (ask.kind, ask.what) == (kind, what)


@pytest.mark.parametrize("phrase", ["купил хлеб за 400", "что у меня в пятницу?",
                                    "перенеси плитку на страницу Дом", "сегодня купил кофе"])
def test_code_leaves_the_rest(phrase: str) -> None:
    assert ops_line.read_code(phrase) is None


def test_touched_from_the_operation_or_the_change_rows() -> None:
    own = SimpleNamespace(payload={"touched": ["reminders", "calendar"], "changes": []},
                          screen_id=None)  # fmt: skip
    assert touched_of(own) == ["calendar", "reminders", "today"]  # type: ignore[arg-type]
    old = SimpleNamespace(payload={"changes": [{"item_id": "x", "task_id": "t"}]}, screen_id=7)
    assert touched_of(old) == ["pages", "tasks", "calendar", "today"]  # type: ignore[arg-type]
    note = SimpleNamespace(payload={"changes": [{"item_id": "x"}]}, screen_id=None)
    assert touched_of(note) == ["records"]  # type: ignore[arg-type]


def test_change_turn_cost_alert() -> None:
    s = make_settings()
    now = datetime(2026, 11, 12, 5, 0)
    dear = Snapshot(now=now, day="2026-11-12", yesterday="2026-11-11", change_turns=12,
                    change_avg=0.045, change_model_turns=9, change_model_avg=0.06)
    alerts = [a for a in evaluate(dear, s) if a.kind == "change_turn_cost"]
    assert len(alerts) == 1 and alerts[0].dedup_key == "change_turn_cost:2026-11-11"
    assert alerts[0].details["cap_usd"] == 0.04 and alerts[0].details["model_turns"] == 9
    ok = Snapshot(now=now, day="d", yesterday="y", change_turns=12, change_avg=0.03)
    few = Snapshot(now=now, day="d", yesterday="y", change_turns=3, change_avg=0.5)
    assert not [a for a in (*evaluate(ok, s), *evaluate(few, s)) if a.kind == "change_turn_cost"]
