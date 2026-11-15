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
