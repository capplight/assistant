"""Step 5 (no database): what the memory may keep, the phrases that read / change it, the layer's
order, and the conversation search helpers (Ф-59…Ф-61, Ф-70)."""

from datetime import UTC, datetime

import pytest

from assistant.chat import memory, recall
from assistant.chat.memory import MemoryAsk, clean, fact_key, guess_kind, memory_phrase, pick
from assistant.db.models_memory import MemoryFact

NOW = datetime(2026, 11, 16, 10, 0, tzinfo=UTC)


@pytest.mark.parametrize("value", [
    "У сына аллергия на орехи", "ИИН 900101300123", "Карта 4242 4242 4242 4242",
    "Пароль от почты qwerty", "Ходит в мечеть по пятницам", "Голосовал за партию X",
    "Номер паспорта N1234567", "Мама принимает таблетки от давления", "Значение ⟨CARD_1⟩",
])  # fmt: skip
def test_sensitive_is_never_kept(value):
    assert clean("other", value) is None


def test_clean_keeps_plain_facts():
    assert clean("person", "ерлан — брат, ДР 3 мая") == ("person", "Ерлан — брат, ДР 3 мая")
    assert clean("weird", "Дача в Талгаре") == ("other", "Дача в Талгаре")
    assert clean("place", "x" * 300) is None
    assert fact_key("Дача в Талгаре!") == fact_key("дача   в талгаре")


@pytest.mark.parametrize(("phrase", "want"), [
    ("Что ты обо мне помнишь?", MemoryAsk("list")),
    ("что ты знаешь обо мне", MemoryAsk("list")),
    ("Что ты помнишь про меня?", MemoryAsk("list")),
    ("забудь про ремонт", MemoryAsk("forget", about=("ремонт",))),
    ("Забудь всё", MemoryAsk("forget_all")),
    ("забудь всё, что знаешь обо мне", MemoryAsk("forget_all")),
    ("запомни: я не ем свинину", MemoryAsk("remember", value="я не ем свинину")),
    ("Запомни, что мой брат Ерлан", MemoryAsk("remember", value="мой брат Ерлан")),
])  # fmt: skip
def test_memory_phrases(phrase, want):
    assert memory_phrase(phrase) == want


@pytest.mark.parametrize("phrase", ["забудь", "что ты знаешь о плитке?", "запомни?",
                                    "я забыл ключи", "помнишь, где ключи?"])
def test_not_memory_phrases(phrase):
    assert memory_phrase(phrase) is None


def test_guess_kind():
    assert guess_kind("я не ем свинину") == "preference"
    assert guess_kind("мой брат Ерлан") == "person"
    assert guess_kind("по понедельникам спортзал") == "routine"
    assert guess_kind("пароль от wifi в прихожей") == "other"


def _fact(i: int, kind: str, value: str, mentions: int = 1, source: str = "said") -> MemoryFact:
    return MemoryFact(id=i, kind=kind, text=value, source=source, mentions=mentions,
                      last_seen_at=NOW, valid_until=None)  # fmt: skip


def test_layer_puts_projects_and_the_topic_first_within_budget():
    facts = [_fact(1, "preference", "Любит недорогие отели", 5),
             _fact(2, "person", "Ерлан — брат", 1),
             _fact(3, "project", "Ремонт кухни: мастер Серик", 1),
             _fact(4, "place", "Дача в Талгаре", 1, source="material")]
    lines = pick(facts, "Когда приедет брат Ерлан?")
    assert lines[0].endswith("Ремонт кухни: мастер Серик")
    assert "Ерлан" in lines[1]
    assert any(line.endswith("(из материала)") for line in lines)
    assert len(pick(facts, "", budget=12)) == 1


def test_list_text():
    assert "Пока ничего" in memory.list_text([])
    out = memory.list_text([_fact(1, "person", "Ерлан — брат"),
                            _fact(2, "place", "Дача в Талгаре", source="material")])
    assert "Люди: Ерлан — брат." in out and "Дача в Талгаре (из материала)" in out


def test_recall_helpers():
    assert recall.points_to_past("Что ты мне советовал про кафе?")
    assert recall.points_to_past("сделай как в прошлый раз")
    assert not recall.points_to_past("сколько стоила плитка")
    assert recall.query_words("Что мне советовали про кафе в Стамбуле?") == ["кафе", "стамбуле"]
    assert recall._rrf([1, 2, 3], [3, 4]) [0] == 3
