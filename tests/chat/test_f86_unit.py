"""Ф-86 without a database: the assistant talks freely, and is strict only about the person's
own data. Answer modes in the sentence gate, the code rules that keep a personal question
checked, help phrases read as questions, web search plumbing (flag off by default). No network."""

import json
import uuid
from datetime import UTC, datetime
from decimal import Decimal
from types import SimpleNamespace as NS

from assistant.ai.adapters.anthropic_adapter import AnthropicAdapter
from assistant.ai.routes import Price
from assistant.ai.types import AdapterRequest, Message, Usage, WebSearchSpec, WebSource
from assistant.chat.intent import Intent, asks_web, rules_first
from assistant.chat.service import AnswerGate, AnswerHook, ChatReply, _domain
from assistant.chat.sources import SourceBook
from assistant.chat.verify import Facts, about_person, personal_question
from assistant.config import Settings

ISTANBUL = ("Стамбул — отличный выбор! Начните с Султанахмета: Айя-София открыта с 9:00 до "
            "19:00, рядом Голубая мечеть. 2. Пройдитесь по Истикляль, это около 1,4 км. "
            "Паром до Кадыкёя идёт 20 минут и стоит около 40 лир.\n— Вечером закат на Галате.")


def _book() -> SourceBook:
    book = SourceBook("Asia/Almaty")
    page = book.add_page(10, uuid.uuid4(), "Расходы", "money", "expenses", 1)
    book.add(pk=1, item_id=uuid.uuid4(), title="Кафе", body="Кафе 4 500 ₸", kind="note",
             occurred_at=None, created_at=datetime(2026, 11, 12, 4, tzinfo=UTC),
             page_pks=[page.pk])  # fmt: skip
    return book


def _gate(phrase: str = "") -> tuple[AnswerGate, list[tuple[str, dict]]]:
    events: list[tuple[str, dict]] = []
    return AnswerGate(_book(), Facts(), set(), lambda n, d: events.append((n, d)),
                      phrase=phrase), events  # fmt: skip


def _tokens(events: list[tuple[str, dict]]) -> str:
    return "".join(d["text"] for n, d in events if n == "token")


# --- the gate: general answers are not cut, personal sentences still are ---


def test_general_answer_with_numbers_is_not_truncated():
    gate, events = _gate("Я лечу в Стамбул, что посмотреть?")
    gate.set_mode("general")
    gate.feed(ISTANBUL)
    gate.finish(ISTANBUL)
    assert _tokens(events) == ISTANBUL and gate.removed == 0 and gate.general_sent >= 4


def test_personal_sentence_in_a_general_answer_is_still_checked():
    gate, events = _gate("Что посмотреть в Стамбуле?")
    gate.set_mode("general")
    text_ = ("У вас в записях кафе за 4 500 ₸. Вы потратили там 9 000 ₸. "
             "Паром стоит около 40 лир.")
    gate.feed(text_)
    gate.finish(text_)
    assert _tokens(events) == "У вас в записях кафе за 4 500 ₸. Паром стоит около 40 лир."
    assert gate.removed == 1 and gate.basis == ["s1"]


def test_a_question_about_own_data_is_checked_whatever_the_mode():
    """The model may call it "general"; code still checks every number of a phrase that asks
    about the person's data."""
    gate, events = _gate("Сколько я потратил на кафе?")
    gate.set_mode("general")
    text_ = "На кафе 4 500 ₸. Всего за месяц 12 000 ₸."
    gate.feed(text_)
    gate.finish(text_)
    assert _tokens(events) == "На кафе 4 500 ₸. " and gate.removed == 1


def test_records_mode_and_unknown_mode_check_everything():
    for mode in ("records", None, "web"):
        gate, events = _gate("Что посмотреть в Стамбуле?")
        gate.set_mode(mode)
        gate.feed(ISTANBUL)
        gate.finish(ISTANBUL)
        assert gate.removed > 0, mode


async def test_hook_reads_the_mode_before_the_answer_streams():
    gate, events = _gate("Как у тебя дела?")
    hook = AnswerHook(gate)
    doc = json.dumps({"mode": "general", "answer": "Всё хорошо, спасибо! Сегодня 3 дела "
                      "закрыл — день удачный. А у вас как?", "citations": [],
                      "insufficient": False}, ensure_ascii=False)  # fmt: skip
    for i in range(0, len(doc), 7):
        await hook(doc[i:i + 7])
    gate.finish(None)
    assert gate.mode == "general" and gate.removed == 0
    assert _tokens(events).startswith("Всё хорошо, спасибо! Сегодня 3 дела")


async def test_reset_forgets_the_mode_of_a_failed_attempt():
    gate, _ = _gate()
    hook = AnswerHook(gate)
    await hook('{"mode": "general", "answer": "Нача')
    hook.reset()
    assert gate.mode is None


def test_chat_reply_mode_first_and_defaults_to_records():
    assert list(ChatReply.model_fields)[:2] == ["mode", "answer"]
    assert ChatReply.model_validate_json('{"answer": "ок"}').mode == "records"


# --- code rules ---


def test_personal_question_and_about_person():
    assert all(personal_question(p) for p in (
        "Сколько я потратил на кафе?", "где мой паспорт", "что у меня завтра?",
        "Что я записывал про Стамбул?", "мои расходы за неделю"))  # fmt: skip
    assert not any(personal_question(p) for p in (
        "Как у тебя дела?", "Я лечу в Стамбул, что посмотреть?", "Составь план на выходные",
        "Я хотел бы узнать про Стамбул", "В интернете поищи"))  # fmt: skip
    assert about_person("Вы потратили 84 500 ₸.") and about_person("У вас в записях кафе.")
    assert not about_person("Вы можете доехать за 40 минут.")
    assert not about_person("Айя-София открыта с 9:00.")


def test_help_phrases_are_questions_not_notes():
    for p in ("Составь план на выходные", "Я лечу в Стамбул, мне нужна инфа куда сходить",
              "В интернете поищи", "Посоветуй фильм", "Как у тебя дела", "Привет",
              "Подскажи рецепт плова", "Придумай подарок маме"):
        assert rules_first(p).intent == Intent.QUESTION, p
    # capture is unchanged: these still go the old way
    assert rules_first("Кофе 1500").intent == Intent.UNCLEAR
    assert rules_first("купить хлеб").intent == Intent.UNCLEAR
    assert rules_first("составь список: хлеб, молоко").intent == Intent.UNCLEAR
    assert rules_first("запиши купить хлеб").intent == Intent.CHANGE


def test_asks_web():
    assert all(asks_web(p) for p in ("В интернете поищи", "Какая погода в Стамбуле?",
                                     "курс доллара сегодня", "до скольки сейчас открыт ЦУМ",
                                     "последние новости"))  # fmt: skip
    assert not any(asks_web(p) for p in ("Как у тебя дела?", "Сколько я потратил на кафе?",
                                         "Составь план на выходные", "Кофе 1500"))  # fmt: skip


# --- web search: off by default, declared without a country, billed per search ---


def test_web_search_is_on_by_default():
    s = Settings(_env_file=None)  # type: ignore[call-arg]
    assert s.web_search_enabled is True and s.web_search_max_uses == 3


def _req(**kw) -> AdapterRequest:  # type: ignore[no-untyped-def]
    return AdapterRequest(model="claude-haiku-5-5", system="s", messages=(Message("user", "q"),),
                          schema_name="ChatReply", json_schema={"type": "object"}, **kw)


def test_web_search_tool_declaration():
    a = AnthropicAdapter(client=object())
    assert "tools" not in a.request_kwargs(_req())
    spec = WebSearchSpec(max_uses=3, city="Almaty", timezone="Asia/Almaty")
    tool = a.request_kwargs(_req(web_search=spec))["tools"][-1]
    assert tool == {"type": "web_search_20250305", "name": "web_search", "max_uses": 3,
                    "user_location": {"type": "approximate", "city": "Almaty",
                                      "timezone": "Asia/Almaty"}}  # fmt: skip
    newer = a.request_kwargs(_req(web_search=WebSearchSpec(tool_type="web_search_20260209")))
    assert newer["tools"][-1]["allowed_callers"] == ["direct"]


class _Block(NS):
    def model_dump(self, **_kw):  # type: ignore[no-untyped-def]
        return {k: v for k, v in vars(self).items()}


class _Messages:
    def __init__(self, *results):  # type: ignore[no-untyped-def]
        self.results = list(results)
        self.calls: list[dict] = []

    async def create(self, **kw):  # type: ignore[no-untyped-def]
        self.calls.append(kw)
        return self.results.pop(0)


def _usage(searches: int) -> NS:
    return NS(input_tokens=10_000, output_tokens=300, cache_read_input_tokens=0,
              cache_creation_input_tokens=0, server_tool_use=NS(web_search_requests=searches))


async def test_web_search_turn_with_a_pause_sources_and_cost():
    result = _Block(type="web_search_tool_result", tool_use_id="srv1", content=[
        _Block(type="web_search_result", url="https://www.zakon.kz/pogoda/almaty/", title="Погода"),
        _Block(type="web_search_result", url="https://tengrinews.kz/weather/", title="Tengri"),
        _Block(type="web_search_result", url="https://yandex.ru/pogoda/", title="Яндекс"),
    ])  # fmt: skip
    first = NS(stop_reason="pause_turn", model="claude-haiku-5-5", usage=_usage(1), content=[
        _Block(type="text", text="Сейчас посмотрю."),
        _Block(type="server_tool_use", id="srv1", name="web_search", input={"query": "погода"}),
        result])  # fmt: skip
    answer = '{"mode": "general", "answer": "Днём около +2°.", "citations": [], ' \
             '"insufficient": false}'
    second = NS(stop_reason="end_turn", model="claude-haiku-5-5", usage=_usage(1),
                content=[_Block(type="text", text=answer)])  # fmt: skip
    messages = _Messages(first, second)
    resp = await AnthropicAdapter(client=NS(messages=messages)).generate(
        _req(web_search=WebSearchSpec()))
    assert len(messages.calls) == 2  # the paused turn was sent back unchanged
    assert messages.calls[1]["messages"][-1]["role"] == "assistant"
    assert resp.text == answer
    assert resp.usage.web_searches == 2 and resp.usage.tokens_in == 20_000
    assert resp.web_sources == [WebSource("https://www.zakon.kz/pogoda/almaty/", "Погода"),
                                WebSource("https://tengrinews.kz/weather/", "Tengri")]
    haiku = Price(*(Decimal(x) for x in ("0.10", "0.50", "0.01", "0.125", "0.20")))
    assert haiku.cost(Usage(tokens_in=10_000, tokens_out=300, web_searches=1)) == \
        Decimal("0.011150")
    assert _domain("https://www.zakon.kz/pogoda/almaty/") == "zakon.kz"
