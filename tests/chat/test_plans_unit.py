"""Step 8 «Составь план», Ф-73 inline edit, the 8th sticker key: pure code, no DB, no network."""

import importlib.util
from datetime import date, datetime
from pathlib import Path

import pytest

from assistant.actions import engine
from assistant.actions.service import counts_text
from assistant.ai.adapters import strict_json_schema
from assistant.ai.routes import load_routes
from assistant.ai.types import LLMTask
from assistant.chat.intent import Intent, asks_text_edit, rules_first
from assistant.chat.mutate import TextEdit, UpdateArgs, apply_edits
from assistant.chat.plan_line import (
    MakePlanArgs,
    _said_date,
    _said_days,
    asks_plan,
    diff_rows,
    to_tasks_phrase,
)
from assistant.chat.verify import facts_of
from assistant.db.models_pages import NOTE_COLORS
from assistant.db.models_v2 import RecordKind
from assistant.plans.build import (
    MAX_STEPS,
    DayOut,
    PlanReply,
    PointOut,
    SourceRef,
    StepOut,
    build,
    card,
    lead,
)
from tests.api.conftest import make_settings

TODAY = date(2026, 11, 19)
MIGRATIONS = Path(__file__).resolve().parents[2] / "migrations" / "versions"


def src(ref: str, text_: str) -> SourceRef:
    return SourceRef(ref, f"00000000-0000-0000-0000-00000000000{ref[1:]}", text_[:20], "note",
                     "2026-10-03T10:00:00+00:00", facts_of(text_))


def step(title: str, **kw) -> StepOut:  # type: ignore[no-untyped-def]
    base = {"note": None, "source": None, "due_in_days": None, "after": [], "remind": False,
            "remind_time": None}
    return StepOut(title=title, **{**base, **kw})


@pytest.mark.parametrize("phrase", [
    "составь план поездки в Стамбул на 4 дня", "план поездки в Стамбул", "спланируй выходные",
    "распиши по дням Алматы", "разложи мои дела по ремонту кухни", "поменяй план",
    "с чего начать переезд", "маршрут по Стамбулу на три дня"])
def test_plan_words(phrase: str) -> None:
    assert asks_plan(phrase)


@pytest.mark.parametrize("phrase", [
    "что у меня завтра", "разложи по темам", "какие кафе я сохранял?", "купить хлеб",
    "какой у меня план на завтра?"])
def test_not_plan_words(phrase: str) -> None:
    assert not asks_plan(phrase)


def test_plan_phrase_is_never_a_note_by_code() -> None:
    assert rules_first("план поездки в Стамбул на 4 дня").intent == Intent.UNCLEAR  # service
    assert rules_first("составь план поездки").intent == Intent.QUESTION


@pytest.mark.parametrize("phrase,yes", [
    ("сделай делами", True), ("Сделай это делами!", True), ("преврати план в дела", True),
    ("сделайте их делами", True), ("сделай дела по дому", False), ("какие у меня дела", False)])
def test_to_tasks_phrase(phrase: str, yes: bool) -> None:
    assert to_tasks_phrase(phrase) is yes


def test_trip_build_checks_sources_numbers_and_dates() -> None:
    sources = [src("s1", "Балат — цветные дома, утром"), src("s2", "Паром в Кадыкёй 40 минут")]
    reply = PlanReply(title="  Стамбул ", steps=[], days=[
        DayOut(title="Балат", points=[
            PointOut(title="Цветные дома", note="утром", source="s1", place="Балат"),
            PointOut(title="Чужой ref", note=None, source="s9", place=None)]),
        DayOut(title="Пусто", points=[]),  # dropped
        DayOut(title="Кадыкёй", points=[
            PointOut(title="Паром", note="30 минут", source="s2", place=None),  # wrong number
            PointOut(title="Паром", note="40 минут", source="S2", place=None)])])
    out = build(reply, kind="trip", sources=sources, phrase="план на 2 дня", today=TODAY,
                start=date(2026, 12, 10), days=2, now=datetime(2026, 11, 19, 10, 0))
    p = out.plan
    assert p["title"] == "Стамбул" and len(p["days"]) == 2 and out.removed == 1
    assert [d["date"] for d in p["days"]] == ["2026-12-10", "2026-12-11"]
    assert (p["start_date"], p["end_date"]) == ("2026-12-10", "2026-12-11")
    pts = [x for d in p["days"] for x in d["points"]]
    assert [x["own"] for x in pts] == [False, True, True, False]
    assert p["counts"] == {"points": 4, "from_records": 2, "own": 2, "sources": 2}
    assert [s["item_id"] for s in p["sources"]] == [sources[0].item_id, sources[1].item_id]
    assert out.text.splitlines()[0] == "Стамбул · 2 дня"
    assert "2. Чужой ref (мой совет)" in out.text
    assert lead(p) == "Собрал из 2 советов. 2 пункта — мои, не из ваших записей."


def test_lead_says_one_own_point_right() -> None:
    p = {"kind": "trip", "counts": {"sources": 5, "own": 1, "points": 6}}
    assert lead(p) == "Собрал из 5 советов. 1 пункт — мой, не из ваших записей."


def test_trip_without_any_saved_tip() -> None:
    reply = PlanReply(title="Рим", steps=[], days=[DayOut(title="Центр", points=[
        PointOut(title="Колизей", note=None, source=None, place="Колизей, Рим")])])
    p = build(reply, kind="trip", sources=[], phrase="план по Риму", today=TODAY).plan
    assert p["start_date"] is None and p["days"][0]["date"] is None
    assert lead(p) == "В записях об этом ничего не нашёл — составил сам."
    c = card(p, "x", page=None)
    assert c["check_note"] is None and c["can_make_tasks"] is False and c["subtitle"] == "1 день"


def test_action_steps_code_dates_dependencies_and_checks() -> None:
    sources = [src("s1", "Замерщик Алибек, позвонить в 10:30, 8 701 555 12 34")]
    reply = PlanReply(title="Ремонт кухни", days=[], steps=[
        step("Вызвать замерщика", source="s1", due_in_days=1, remind=True, remind_time="10:30"),
        step("Отложить 600 000 ₸"),  # nobody said 600 000: dropped
        step("Выбрать фасады", after=[1, 2, 9], due_in_days=500),  # 2 dropped, 9 unknown
        step("Заказать кухню", after=[3], remind=True, remind_time="07:00", due_in_days=6),
        step("Созвон", remind=True),  # no date: no reminder
        step("  "),
    ])
    out = build(reply, kind="actions", sources=sources, phrase="разложи дела по ремонту",
                today=TODAY)
    st = out.plan["steps"]
    assert [s["title"] for s in st] == ["Вызвать замерщика", "Выбрать фасады", "Заказать кухню",
                                        "Созвон"]
    assert out.removed == 1
    assert [s["due_date"] for s in st] == ["2026-11-20", None, "2026-11-25", None]
    assert st[1]["after"] == ["st1"] and st[2]["after"] == ["st2"]
    assert [s["remind_at"] for s in st] == ["2026-11-20T10:30", None, "2026-11-25T10:00", None]
    assert "2. Выбрать фасады — после шага 1" in out.text
    assert lead(out.plan) == "План из 4 шагов. Сроки — от сегодняшнего дня."
    c = card(out.plan, "pid", page={"page_id": "p", "title": "Заметки"})
    assert c["can_make_tasks"] and [r["after_n"] for r in c["rows"]] == [[], [1], [2], []]
    many = PlanReply(title="x", days=[], steps=[step("Шаг " + "абвгдежзиклмнопрстуф"[i])
                                                for i in range(20)])
    assert len(build(many, kind="actions", sources=[], phrase="шаги", today=TODAY)
               .plan["steps"]) == MAX_STEPS


def test_edit_keeps_tasks_of_the_same_steps() -> None:
    reply = PlanReply(title="Дом", days=[], steps=[step("Купить краску"), step("Покрасить")])
    prev = {"steps": [{"title": "купить краску", "task_id": "t1", "reminder_id": None}]}
    st = build(reply, kind="actions", sources=[], phrase="поменяй план", today=TODAY,
               previous=prev).plan["steps"]
    assert st[0]["task_id"] == "t1" and st[1]["task_id"] is None


def test_said_dates_and_days_are_from_the_phrase() -> None:
    phrase = "составь план поездки в Стамбул, 10–11 декабря"
    assert _said_date("2026-12-10", phrase, TODAY) == date(2026, 12, 10)
    assert _said_date("2026-12-11", phrase, TODAY) == date(2026, 12, 11)
    assert _said_date("2026-12-12", phrase, TODAY) is None  # never said
    assert _said_date("2026-11-20", "план на завтра", TODAY) == date(2026, 11, 20)
    assert _said_date("bad", phrase, TODAY) is None
    args = MakePlanArgs(kind="trip", topic="Стамбул", title=None, days=9, start_date=None,
                        end_date=None)
    assert _said_days(args, phrase, date(2026, 12, 10), date(2026, 12, 11)) == 2
    assert _said_days(args, "план на 4 дня", None, None) is None  # 9 was not said
    args.days = 4
    assert _said_days(args, "план на 4 дня", None, None) == 4
    assert _said_days(args, "план на четыре дня", None, None) == 4


def test_counts_and_notice_text() -> None:
    assert counts_text({"tasks": 5, "reminders": 2}) == "5 дел и 2 напоминания"
    assert counts_text({"tasks": 1, "reminders": 0}) == "1 дело"
    assert counts_text({"tasks": 0, "reminders": 0}) == ""


def test_inline_edit_rules() -> None:
    assert apply_edits("Паром 40 минут", [TextEdit(find="40", replace="20")]) == "Паром 20 минут"
    assert apply_edits("Хлеб", [TextEdit(find="", replace="Молоко")]) == "Хлеб\nМолоко"
    assert apply_edits("Ёлка зелёная", [TextEdit(find="елка", replace="Сосна")]) == \
        "Сосна зелёная"
    assert apply_edits("Хлеб", [TextEdit(find="сыр", replace="x")]) is None
    assert diff_rows({"title": "A", "text": "x"}, {"text": "y"}) == [
        {"field": "text", "before": "x", "after": "y"}]
    assert diff_rows({"title": "A", "text": "x"}, {"title": "A", "text": "x"}) == []
    assert asks_text_edit("исправь в заметке телефон")
    assert asks_text_edit("добавь в эту заметку: взять зонт")
    assert not asks_text_edit("добавь в покупки молоко")
    assert not asks_text_edit("сколько идёт паром?")
    assert rules_first("допиши в заметку про паром").intent == Intent.CHANGE
    assert UpdateArgs(records=["s1"], title=None, trash=False).edits is None  # old calls


def test_schemas_ops_routes_and_kinds() -> None:
    for model in (PlanReply, MakePlanArgs, UpdateArgs):
        schema = strict_json_schema(model)
        assert schema["additionalProperties"] is False
        assert set(schema["required"]) == set(schema["properties"])
    assert "set_item_content" in engine.OPS
    engine.validate([{"op": "set_item_content", "entity": "items", "id": "x",
                      "values": {"text": "y"}}])
    assert engine.op_items({"op": "set_item_content", "entity": "items", "id": "x"}) == {"x"}
    route = load_routes(make_settings()).route(LLMTask.PLAN)
    assert route.max_tokens == 7000 and route.tier == "light"
    assert load_routes(make_settings()).route(LLMTask.CHAT).max_tokens == 3000
    assert RecordKind.PLAN == "plan"


def _migration(name: str):  # type: ignore[no-untyped-def]
    spec = importlib.util.spec_from_file_location(name, MIGRATIONS / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


def test_migrations_are_frozen_and_chained() -> None:
    m32, m33 = _migration("0032_sticker_aqua"), _migration("0033_plans")
    assert (m32.revision, m32.down_revision) == ("0032", "0031")
    assert (m33.revision, m33.down_revision) == ("0033", "0032")
    for old in ("yellow", "pink", "green", "blue", "peach", "white", "lilac"):
        assert f"'{old}'" in m32._NEW and old in NOTE_COLORS
    assert "'aqua'" in m32._NEW and "'aqua'" not in m32._OLD and "aqua" in NOTE_COLORS
    assert "'plan'" in m33.UPGRADE[1] and "'ai_chat'" in m33.UPGRADE[1]
    assert m33.DOWNGRADE[0].startswith("UPDATE items SET kind = 'note'")
    for name in ("0032_sticker_aqua.py", "0033_plans.py"):
        assert "create_all(" not in (MIGRATIONS / name).read_text(encoding="utf-8")
