"""Phone QA 1 without a database: code reads spends and to-dos when the model is down; a reminder
clause stays out of a to-do's title; «на завтра» is the to-do's day."""

from datetime import date
from decimal import Decimal

from assistant.ai import AIUnavailable
from assistant.db.models_tasks import ListKey
from assistant.expenses import parse as expenses_parse
from assistant.tasks import parse as tasks_parse

TODAY = date(2026, 11, 15)


class DownRouter:
    async def run(self, *args, **kw):  # type: ignore[no-untyped-def]
        raise AIUnavailable("every provider failed")


async def test_expense_by_code_when_the_model_is_down() -> None:
    for router in (DownRouter(), None):
        d = await expenses_parse.read_phrase("Я потратил 2000 на мороженое", today=TODAY,
                                             rules_first=False, router=router, user_id=1,
                                             categories=[])  # fmt: skip
        assert d is not None and d.amount == Decimal("2000.00") and d.source == "rules"


async def test_tasks_by_code_when_the_model_is_down() -> None:
    r = await tasks_parse.read_phrase("купить хлеб на завтра, и напомни в 10 утра", today=TODAY,
                                      rules_first=False, router=DownRouter(), user_id=1)
    assert r is not None and r.source == "rules"
    assert [(s.list_key, s.title, s.due_date) for s in r.specs] == [
        (ListKey.SHOPPING, "Хлеб", date(2026, 11, 16))]


def test_reminder_clause_and_day() -> None:
    r = tasks_parse.rules_parse("надо позвонить маме завтра, напомни в 9", TODAY)
    assert r is not None and [(s.title, s.due_date) for s in r.specs] == [
        ("Позвонить маме", date(2026, 11, 16))]
    r = tasks_parse.rules_parse("купить хлеб, молоко и сыр", TODAY)
    assert r is not None and [s.title for s in r.specs] == ["Хлеб", "Молоко", "Сыр"]
    assert all(s.due_date is None for s in r.specs)


# --- device test 2026-11-18: «Кофе 1500» from the main line was kept as a note ---


def test_bare_price_and_currency_word_reach_the_expense_reader() -> None:
    for phrase in ("Кофе 1500", "кофе 1 500", "такси до дома 2000", "Кофе 1500 тг",
                   "обед 2500 ₸", "бензин 7 000"):  # fmt: skip
        assert expenses_parse.mentions_expense(phrase), phrase
    for phrase in ("Купить морковь", "Таблетка", "что у меня завтра?", "квартира 12",
                   "офис 305", "код 4512", "купить 2 кг мяса", "молоко 2 пачки",
                   "позвонить Ерлану 1500", "кофе 1500?", "аптека в 15:00",
                   "встретиться с Ерланом у кафе в субботу 1500"):  # fmt: skip
        assert not expenses_parse.mentions_expense(phrase), phrase


def test_currency_word_is_read_by_code_and_bare_price_goes_to_the_model() -> None:
    d = expenses_parse.rules_parse("Кофе 1500 тг", TODAY)
    assert d is not None and d.amount == Decimal("1500.00") and d.category_key == "cafe_gifts"
    assert expenses_parse.rules_parse("Кофе 1500", TODAY) is None  # vector «5000 бензин»: null


class ExpenseRouter:
    def __init__(self) -> None:
        self.calls = 0

    async def run(self, task, schema, inputs, **kw):  # type: ignore[no-untyped-def]
        from assistant.ai.types import Result, Usage

        self.calls += 1
        reply = expenses_parse.ExpenseReply(
            is_expense=True, amount="1500", category="cafe_gifts", note="Кофе", day="none",
            method="none", direction="expense")  # fmt: skip
        return Result(data=reply, tool_calls=[], provider="fake", model="fake", usage=Usage(),
                      cost_usd=Decimal(0), attempts=1, fallback_from=None)  # fmt: skip


async def test_bare_price_is_an_expense_with_rules_first() -> None:
    router = ExpenseRouter()
    d = await expenses_parse.read_phrase("Кофе 1500", today=TODAY, rules_first=True,
                                         router=router, user_id=1,
                                         categories=[("cafe_gifts", "Кафе")])  # fmt: skip
    assert router.calls == 1
    assert d is not None and d.amount == Decimal("1500.00") and d.category_key == "cafe_gifts"
