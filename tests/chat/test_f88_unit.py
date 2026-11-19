"""Ф-88 (device 2026-11-19): no claimed-but-not-done actions, mixed phrases, follow-ups, change
turns on the strong model. Code only, no network."""

from datetime import date, timedelta
from pathlib import Path

import pytest
import yaml

from assistant.ai import LLMTask
from assistant.ai.adapters.anthropic_adapter import AnthropicAdapter
from assistant.ai.adapters.openai_adapter import OpenAIAdapter
from assistant.ai.masking import Masker
from assistant.ai.prompting import TaskInputs, build_messages
from assistant.ai.routes import load_routes
from assistant.ai.types import AdapterRequest, Message, Tier
from assistant.chat import READ_TOOLS
from assistant.chat.intent import (
    PhrasePart,
    PhraseParts,
    check_parts,
    claims_action,
    follow_up_phrase,
    looks_mixed,
    split_parts,
)
from assistant.expenses import parse as expenses_parse
from assistant.tasks import parse as tasks_parse
from tests.api.conftest import make_settings

B = ("Мне завтра надо поехать в сто, ходовку машины посмотреть, потом я сегодня купил кофе "
     "за 1000 тенге")
TODAY = date(2026, 11, 19)


def test_phrase_b_splits_into_a_todo_and_a_spend():
    parts = split_parts(B)
    assert parts == ["Мне завтра надо поехать в сто, ходовку машины посмотреть",
                     "я сегодня купил кофе за 1000 тенге"]
    todo = tasks_parse.rules_parse(parts[0], TODAY)
    assert todo is not None and todo.list_key == "todo"
    assert todo.specs[0].title == "Поехать в сто, ходовку машины посмотреть"
    assert todo.specs[0].due_date == TODAY + timedelta(days=1)
    spend = expenses_parse.rules_parse(parts[1], TODAY)
    assert spend is not None and spend.amount == 1000 and spend.note == "кофе"
    assert spend.spent_on == TODAY
    assert not expenses_parse.mentions_expense(parts[0])


def test_clause_split_keeps_one_thought_whole():
    assert split_parts("сначала хлеб, потом молоко") == ["сначала хлеб, потом молоко"]
    assert split_parts("потратил 5000 на бензин") == ["потратил 5000 на бензин"]
    assert len(split_parts("Купил кофе за 1000 тенге. Завтра позвонить маме")) == 2


@pytest.mark.parametrize(("text", "mixed"), [
    (B, True),
    ("Завтра к стоматологу, сегодня кофе за 1000 тенге", True),
    ("потратил 5000 на бензин", False),
    ("я сегодня купил кофе за 1000 тенге", False),
    ("кофе 1500 тг вчера каспи", False),
])  # fmt: skip
def test_looks_mixed(text, mixed):
    assert looks_mixed(text) is mixed


@pytest.mark.parametrize(("answer", "claims"), [
    ("Создаю страницу «Стамбул».", True),
    ("Записал трату.", True),
    ("Перенёс заметку в «Ремонт».", True),
    ("Бетті жасадым.", True),
    ("Как назвать страницу?", False),
    ("Вот что нашёл в записях.", False),
    ("", False),
])  # fmt: skip
def test_claims_action(answer, claims):
    assert claims_action(answer) is claims


@pytest.mark.parametrize(("text", "follow"), [
    ("Ну и где эта страница?", True), ("давай", True), ("Давай, создай", True),
    ("сделай это", True), ("да", True), ("где ключи от машины которые я вчера положил", False),
    ("Сколько я потратил на бензин?", False),
    ("Создай страницу стамбул", False),  # a request of its own
])  # fmt: skip
def test_follow_up_phrase(text, follow):
    assert follow_up_phrase(text) is follow


def test_model_parts_are_checked_against_the_words():
    phrase = "Завтра к стоматологу, сегодня кофе за 1000 тенге"
    ok = PhraseParts(parts=[PhrasePart(text="Завтра к стоматологу", kind="task"),
                            PhrasePart(text="сегодня кофе за 1000 тенге", kind="expense")])
    assert check_parts(phrase, ok) == [("Завтра к стоматологу", "task"),
                                       ("сегодня кофе за 1000 тенге", "expense")]
    added = PhraseParts(parts=[PhrasePart(text="Завтра к врачу", kind="task")])
    assert check_parts(phrase, added) is None  # a word the person did not say
    number = PhraseParts(parts=[PhrasePart(text="кофе за 2000 тенге", kind="expense")])
    assert check_parts(phrase, number) is None  # a number the person did not say
    kind = PhraseParts(parts=[PhrasePart(text="кофе за 1000 тенге", kind="booking")])
    assert check_parts(phrase, kind) is None


def test_change_turns_and_splitting_run_on_sonnet_questions_on_haiku():
    t = load_routes(make_settings(model_fast="claude-haiku-5-5", model_strong="claude-sonnet-5-5"))
    assert t.route(LLMTask.CHAT).tier is Tier.LIGHT
    assert t.route(LLMTask.CHAT_CHANGE).tier is Tier.STRONG
    assert t.route(LLMTask.PHRASE_SPLIT).tier is Tier.STRONG
    assert t.model("anthropic", t.route(LLMTask.CHAT_CHANGE).tier) == "claude-sonnet-5-5"
    assert t.model("anthropic", t.route(LLMTask.CHAT).tier) == "claude-haiku-5-5"
    assert t.route(LLMTask.CHAT_CHANGE).chain == t.route(LLMTask.CHAT).chain  # same fallback
    assert t.route(LLMTask.CHAT_CHANGE).budget_class.value == "answers"


def test_an_older_override_file_borrows_the_new_tasks(tmp_path: Path):
    raw = yaml.safe_load(Path("src/assistant/ai/routes.yaml").read_text(encoding="utf-8"))
    for name in ("chat_change", "phrase_split"):
        raw["tasks"].pop(name)
    raw["tasks"]["chat"] = {**raw["tasks"]["chat"], "timeout_s": 25}
    f = tmp_path / "routes-device.yaml"
    f.write_text(yaml.safe_dump(raw, allow_unicode=True), encoding="utf-8")
    t = load_routes(make_settings(), f)
    assert t.route(LLMTask.CHAT).timeout_s == 25  # the file wins where it names a task
    assert t.route(LLMTask.CHAT_CHANGE).tier is Tier.STRONG  # borrowed from routes.yaml


DEVICE = Path("D:/a/routes-device.yaml")


@pytest.mark.skipif(not DEVICE.exists(), reason="no device routes file on this machine")
def test_device_routes_file_names_the_new_tasks():
    t = load_routes(make_settings(), DEVICE)
    assert t.route(LLMTask.CHAT_CHANGE).tier is Tier.STRONG
    assert t.route(LLMTask.CHAT_CHANGE).timeout_s >= 20
    assert t.route(LLMTask.PHRASE_SPLIT).tier is Tier.STRONG


def _req(choice: str) -> AdapterRequest:
    return AdapterRequest(model="m", system="s", messages=(Message("user", "q"),),
                          schema_name="ChatReply", json_schema={"type": "object"},
                          tools=READ_TOOLS, tool_choice=choice)  # fmt: skip


def test_forced_tool_choice_per_provider():
    # Anthropic rejects forced any/tool on claude-*-5-5 (400): auto, the chat re-asks in code
    assert "tool_choice" not in AnthropicAdapter(client=object()).request_kwargs(_req("required"))
    assert OpenAIAdapter(client=object()).request_kwargs(_req("required"))["tool_choice"] \
        == "required"  # fmt: skip
    from assistant.ai.adapters.gemini_adapter import GeminiAdapter

    _, cfg = GeminiAdapter(client=object()).request_parts(_req("required"))
    assert cfg.tool_config.function_calling_config.mode == "ANY"


def test_after_messages_follow_the_tool_rounds():
    inputs = TaskInputs(system="s", instruction="q",
                        after=[Message("assistant", "Создаю."), Message("user", "вызови")])
    _, msgs = build_messages(inputs, Masker())
    assert [m.role for m in msgs] == ["user", "assistant", "user"]
    assert msgs[-1].text == "вызови"
