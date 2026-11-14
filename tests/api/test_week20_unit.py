"""Week 20 without a database: structure after UX review 2 and mocks v2 (Ф-48...Ф-51, Ф-55).

- settings and `GET /v1/features` (`shopping`, «Расходы» a default page);
- a thing to buy as a to-do while the shopping list is hidden (Ф-49);
- «ответ значением» by code (search and the line), the КП order in the line (Ф-50);
- the «Сегодня» briefing words (code, RU/KK).
"""

from datetime import datetime
from decimal import Decimal
from pathlib import Path

from assistant.chat import kp_line
from assistant.chat.store import answer_value
from assistant.config import Settings
from assistant.db.models_tasks import ListKey
from assistant.memory import asks_value, find_value, value_of_answer
from assistant.pages import default_keys, first_use_keys
from assistant.suggestions import brief
from assistant.tasks import TaskSpec
from assistant.tasks.service import as_todo
from tests.api.conftest import client, make_settings, unit_app


def test_defaults() -> None:
    s = Settings(_env_file=None)  # type: ignore[call-arg]
    assert not s.feature_shopping
    assert default_keys(s) == ["notes", "expenses", "tasks"]
    assert first_use_keys(s) == ["documents"]  # «Расходы» is default, «Покупки» hidden
    on = make_settings(feature_shopping=True)
    assert first_use_keys(on) == ["shopping", "documents"]
    assert first_use_keys(make_settings(pages_on_first_use=False)) == []


async def test_features_report_shopping_and_default_pages(tmp_path: Path) -> None:
    async with client(unit_app(tmp_path, None)) as c:
        body = (await c.get("/v1/features")).json()
    assert body["shopping"] is False
    assert body["pages"] == {"default": ["today", "notes", "expenses", "tasks"],
                             "first_use": ["documents"]}  # fmt: skip


def test_a_thing_to_buy_is_a_todo() -> None:
    assert as_todo(TaskSpec(ListKey.SHOPPING, "Молоко")) == TaskSpec(ListKey.TODO,
                                                                     "Купить молоко")
    got = as_todo(TaskSpec(ListKey.SHOPPING, "Хлеб", qty="2 шт", where="Магнум"))
    assert got.list_key == ListKey.TODO and got.title == "Купить хлеб, 2 шт (Магнум)"
    assert as_todo(TaskSpec(ListKey.SHOPPING, "купить лекарства маме")).title == \
        "купить лекарства маме"  # fmt: skip
    assert as_todo(TaskSpec(ListKey.SHOPPING, "ТОО Арман подарок")).title == \
        "Купить ТОО Арман подарок"  # fmt: skip
    todo = TaskSpec(ListKey.TODO, "Позвонить маме")
    assert as_todo(todo) is todo


def test_value_from_a_record() -> None:
    assert find_value("код от домофона", "Код домофона 4512, подъезд 3").text == "4512"  # type: ignore[union-attr]
    assert find_value("номер окулиста", "Окулист Сеитов 333 10 10").text == "333 10 10"  # type: ignore[union-attr]
    assert find_value("размер обуви сына",
                      "купила кроссовки, размер обуви сына 34").text == "34"  # type: ignore[union-attr]
    assert find_value("пароль от вайфая", "wifi дома: пароль Qwerty2024").text == "Qwerty2024"  # type: ignore[union-attr]
    assert find_value("день рождения мамы", "У мамы день рождения 12 марта").text == "12 марта"  # type: ignore[union-attr]
    # another subject, or not a value question: no value
    assert find_value("код от домофона", "Код от калитки на даче 0909") is None
    assert find_value("плитка", "плитка 16 м2 по 3000") is None
    assert not asks_value("плитка в ванной")
    # another line is not «next to» the words
    assert find_value("код домофона", "Домофон\n\nПарковка 12") is None


def test_value_of_a_short_checked_answer() -> None:
    assert value_of_answer("Код домофона — 4512 [s1].") == "4512"
    assert value_of_answer("В октябре — 45 000 ₸.") == "45 000 ₸"
    assert value_of_answer("Не нашёл в записях.") is None
    assert value_of_answer("Код 4512, квартира 47.") is None  # two values: show the text
    assert value_of_answer("Плитка " + "очень " * 20 + "дорогая, 5000.") is None  # long
    cite = {"ref": "s1", "item_id": "x", "_pk": 3, "page": None, "title": "Домофон",
            "label": "Заметки · Домофон", "occurred_at": None}
    assert answer_value("Код — 4512.", [cite]) == {"text": "4512", "source": {
        k: v for k, v in cite.items() if k != "_pk"}}
    assert answer_value("Код — 4512.", []) is None  # no source, no value


def test_kp_order_in_the_line() -> None:
    k = kp_line.read("сделай КП для ТОО Ромашка на 20 светильников и монтаж")
    assert k is not None and not k.from_this
    assert k.request == "для ТОО Ромашка на 20 светильников и монтаж"
    k = kp_line.read("Сделать документ из этого")
    assert k is not None and k.from_this and k.request == ""
    k = kp_line.read("составь коммерческое предложение из этого файла")
    assert k is not None and k.from_this and k.request == ""
    k = kp_line.read("надо сделать КП для Арман: кабель 100 м")
    assert k is not None and k.request == "для Арман: кабель 100 м"
    for text in ("напиши документ", "где КП для Ромашки?", "купить хлеб", "КП отправил"):
        assert kp_line.read(text) is None, text


def _d(h: int, m: int, day: int = 13) -> datetime:
    return datetime(2026, 11, day, h, m)


def _plan() -> list[brief.PlanEntry]:
    return [brief.PlanEntry("reminder", "Таблетка от давления", _d(9, 0)),
            brief.PlanEntry("reminder", "Забрать Алию", _d(14, 30)),
            brief.PlanEntry("task", "Оплатить интернет", None),
            brief.PlanEntry("task", "КП для «АлмаСтрой»", None),
            brief.PlanEntry("task", "Купить молоко", None)]  # fmt: skip


def test_brief_morning_day_evening() -> None:
    out = brief.build(brief.Facts(now=_d(8, 12), plan=_plan(), spent_month=Decimal(18400),
                                  budget_left=Decimal(41600)))  # fmt: skip
    assert out["part"] == "morning"
    assert out["headline"]["ru"] == "Доброе утро · 5 дел"
    assert out["lines"]["ru"] == ["Спокойный день.",
                                  "Таблетка от давления в 9:00, в 14:30 — забрать Алию.",
                                  "Потрачено 18 400 ₸, в бюджете ещё 41 600 ₸."]  # fmt: skip
    assert len(out["lines"]["kk"]) == 3 and out["headline"]["kk"].startswith("Қайырлы таң")
    plan = _plan()
    plan[0].done = True
    out = brief.build(brief.Facts(now=_d(14, 5), plan=plan))
    assert out["headline"]["ru"] == "День в разгаре · 1 из 5"
    assert out["lines"]["ru"][0] == "Через 25 мин — забрать Алию."
    for p in plan[:3] + plan[4:]:
        p.done = True
    out = brief.build(brief.Facts(now=_d(20, 40), plan=plan, spent_today=Decimal(13950),
                                  tomorrow=[brief.PlanEntry("reminder", "Звонок папе",
                                                            _d(10, 0, 14))]))  # fmt: skip
    assert out["headline"]["ru"] == "Вечер · 4 из 5 сделано"
    assert out["lines"]["ru"] == ["Почти всё.", "Осталось: КП для «АлмаСтрой».",
                                  "Завтра в 10:00 — звонок папе."]  # fmt: skip


def test_brief_empty_over_budget_and_waiting() -> None:
    out = brief.build(brief.Facts(now=_d(9, 0)))
    assert out["headline"]["ru"] == "Доброе утро" and out["lines"]["ru"] == ["Свободный день."]
    out = brief.build(brief.Facts(now=_d(13, 0), spent_month=Decimal(130000),
                                  budget_left=Decimal(-10000), waiting=2))  # fmt: skip
    assert out["lines"]["ru"][0] == "Есть что проверить — ниже."
    assert out["lines"]["ru"][-1] == "Потрачено 130 000 ₸ — бюджет превышен на 10 000 ₸."
    assert all(len(x) <= 3 for x in out["lines"].values())
