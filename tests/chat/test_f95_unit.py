"""Ф-95 phase 0, no DB: the operation registry and the «ordinary assistant» reading
(docs/spec/proposals/chat-full-control.md §3.1, §4)."""

import pytest

from assistant import operations
from assistant.chat import plan_line
from assistant.chat.context import about_others
from assistant.chat.intent import Intent, Reading, asks_assistant, note_by_code, rules_first


def test_registry_has_the_phase0_operations() -> None:
    assert operations.names() == [
        "calendar.remove_plan", "calendar.shift_many", "calendar.shift_plan",
        "duplicates.cleanup", "expenses.clear_budget", "expenses.delete", "expenses.set_budget",
        "expenses.update", "habits.turn_off", "kp.edit", "pages.delete", "pages.restore",
        "plans.to_calendar", "records.trash", "reminders.create", "reminders.delete",
        "reminders.update", "settings.name", "settings.quiet_hours", "tasks.clear_done",
        "tasks.create", "tasks.delete", "tasks.remove_occurrence", "tasks.reschedule",
        "tasks.set_done", "tasks.update", "trash.restore"]  # fmt: skip
    for name in ("duplicates.cleanup", "tasks.clear_done", "calendar.shift_many"):
        assert operations.get(name).risk == "bulk"
    # Ф-95 (4): no operation for the screen-only things
    for gone in ("account.delete", "consents.revoke", "auth.logout", "items.delete_forever",
                 "kp.send", "imports.start"):
        assert gone not in operations.names()
    assert operations.names("tasks") == ["tasks.clear_done", "tasks.create", "tasks.delete",
                                         "tasks.set_done", "tasks.update"]  # fmt: skip
    assert operations.get("tasks.clear_done").risk == "bulk"
    with pytest.raises(operations.OpError) as exc:
        operations.get("records.delete_forever")  # never from the line (Ф-95 rec. 4)
    assert exc.value.code == "unknown_operation"


def test_registry_rejects_bad_args_and_twins() -> None:
    op = operations.get("tasks.delete")
    with pytest.raises(operations.OpError):
        operations.registry._args(op, {"task_id": "not-a-uuid"})
    with pytest.raises(ValueError):
        operations.register(op)


@pytest.mark.parametrize("phrase", [
    "Переведи на английский: я опоздаю на 10 минут",
    "можешь перевести этот текст на английский",
    "переведи: hello world",
    "напиши поздравление маме с днём рождения",
    "посчитай 1 250 000 × 12 %",
    "сколько будет 15% от 380 000",
    "исправь ошибки: превет как дила",
    "сократи текст: очень длинный текст про поездку",
    "объясни, что такое НДС",
    "как сказать «спасибо» по-казахски",
    "составь письмо арендодателю",
])  # fmt: skip
def test_requests_to_the_assistant_are_questions(phrase: str) -> None:
    assert asks_assistant(phrase)
    assert rules_first(phrase).intent == Intent.QUESTION
    assert note_by_code(phrase, Reading(Intent.UNCLEAR, "rules")).intent == Intent.QUESTION


@pytest.mark.parametrize("phrase,intent", [
    ("запиши купить хлеб", Intent.CHANGE),
    ("исправь ошибки в этой заметке", Intent.CHANGE),
    ("напиши в заметку купить хлеб", Intent.UNCLEAR),
    ("переведи 5000 маме", Intent.UNCLEAR),
    ("купил хлеб за 400", Intent.UNCLEAR),
])  # fmt: skip
def test_not_requests_to_the_assistant(phrase: str, intent: Intent) -> None:
    assert not asks_assistant(phrase)
    assert rules_first(phrase).intent == intent


def test_long_number_heavy_phrase_without_a_request_is_still_a_note() -> None:
    phrase = "Код домофона 4512, Wi-Fi 88003456"
    assert note_by_code(phrase, Reading(Intent.UNCLEAR, "rules")).intent == Intent.NOTE


def test_no_record_search_for_requests_that_name_nothing_of_mine() -> None:
    assert about_others("переведи на английский: доброе утро")
    assert not about_others("переведи на английский мои заметки про Стамбул")
    assert not about_others("что я сохранял про Стамбул?")


def test_times_reply_bare_no() -> None:
    assert plan_line.times_reply("нет") == "no"
    assert plan_line.times_reply("не надо") == "cancel"
