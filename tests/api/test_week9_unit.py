"""Week 9 without a database: list phrases by code (Ф-1 switch) and the check of the model's
reading, reminder phrases from the line, suggestion texts."""

from datetime import date

import pytest

from assistant.chat.service import is_reminder_phrase
from assistant.tasks.parse import TaskLine, TasksReply, check_reply, mentions_list, rules_parse

TODAY = date(2026, 11, 9)  # a Monday


@pytest.mark.parametrize("phrase, list_key, titles", [
    ("купить хлеб, молоко и лекарства маме", "shopping", ["Хлеб", "Молоко", "Лекарства маме"]),
    ("Надо купить хлеб", "shopping", ["Хлеб"]),
    ("добавь в покупки молоко", "shopping", ["Молоко"]),
    ("в список: яйца; сыр", "shopping", ["Яйца", "Сыр"]),
    ("добавь в дела забрать посылку", "todo", ["Забрать посылку"]),
    ("нужно позвонить маме в пятницу", "todo", ["Позвонить маме"]),
])  # fmt: skip
def test_rules_read_simple_lists(phrase, list_key, titles):
    r = rules_parse(phrase, TODAY)
    assert r is not None and r.list_key == list_key
    assert [s.title for s in r.specs] == titles


def test_rules_quantity_day_and_give_up():
    r = rules_parse("купи 2 кг яблок", TODAY)
    assert r is not None and (r.specs[0].title, r.specs[0].qty) == ("Яблок", "2 кг")
    r = rules_parse("надо позвонить маме в пятницу", TODAY)
    assert r is not None and r.specs[0].due_date == date(2026, 11, 13)
    for phrase in ("где мой хлеб?", "Мастер Ерлан плитка", "надо же"):
        assert rules_parse(phrase, TODAY) is None
    assert [s.title for s in rules_parse("хлеб и сыр", TODAY, "shopping").specs] == ["Хлеб", "Сыр"]


def test_model_reading_is_checked_against_the_phrase():
    phrase = "купить хлеба и молоко"
    reply = TasksReply(list="shopping", day="none", items=[
        TaskLine(title="Хлеб", qty=None), TaskLine(title="Молоко", qty="2 л"),
        TaskLine(title="Сыр", qty=None)])  # fmt: skip
    r = check_reply(phrase, reply, TODAY)
    assert r is not None
    assert [(s.title, s.qty) for s in r.specs] == [("Хлеб", None), ("Молоко", None)]
    todo = TasksReply(list="todo", day="fri", items=[TaskLine(title="Позвонить маме", qty=None)])
    assert check_reply("позвонить маме", todo, TODAY).specs[0].due_date is None  # day not said
    assert check_reply("позвонить маме в пятницу", todo, TODAY).specs[0].due_date == date(
        2026, 11, 13)  # fmt: skip
    assert check_reply(phrase, TasksReply(list="none", items=[], day="none"), TODAY) is None


def test_routing_words():
    assert mentions_list("купить хлеб") and mentions_list("добавь в покупки молоко")
    assert not mentions_list("где ключи")


@pytest.mark.parametrize("phrase, yes", [
    ("Напомни завтра в 7 выпить таблетку", True), ("разбуди в 6:30", True),
    ("не дай забыть оплатить свет", True), ("поставь будильник на 7", True),
    ("напомни, как зовут мастера?", False), ("напомни мне что я записывал", False),
    ("когда мне к врачу", False),
])  # fmt: skip
def test_reminder_phrases(phrase, yes):
    assert is_reminder_phrase(phrase) is yes
