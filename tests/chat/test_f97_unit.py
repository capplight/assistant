"""Ф-97 (chat-full-control.md phases 2–3), no DB: the domains of the new phrases, the new domain
tools built from the registry, their word guards, the КП-edit phrase, offline-edit protection,
free windows, and the notice targets `calendar` / `budget`."""

import uuid
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from types import SimpleNamespace
from typing import Any

import pytest

from assistant import operations
from assistant.actions.service import notice
from assistant.chat import kp_line, ops_line
from assistant.chat.sources import SourceBook


@dataclass
class Mut:
    phrase: str
    allowed: bool = True
    clock: Any = field(default=lambda: datetime(2026, 11, 12, 5, 0, tzinfo=UTC))


@dataclass
class Env:
    book: SourceBook
    mut: Mut


def env(phrase: str) -> Env:
    return Env(SourceBook("Asia/Almaty"), Mut(phrase))


@pytest.mark.parametrize(("phrase", "domain"), [
    ("верни из корзины заметку про шины", "pages"),
    ("удали страницу Ремонт", "pages"),
    ("поставь бюджет на месяц", "settings"),
    ("тихие часы с 23 до 7", "settings"),
    ("больше не клади чеки на страницу Ремонт", "settings"),
    ("зови меня Али", "settings"),
])
def test_new_domains_by_the_words(phrase, domain):
    assert domain in ops_line.domains_for(phrase)


def test_plain_change_phrase_does_not_carry_the_new_tools():
    assert ops_line.domains_for("перенеси встречу с Ерланом на 16:00") == ["tasks", "calendar"]
    assert "pages" not in ops_line.domains_for("купи бетон и цемент")  # «бет…» is not «бет»


def test_new_domain_tools_come_from_the_registry_and_are_never_irreversible():
    for domain in ("pages", "settings"):
        spec = ops_line.domain_spec(domain)
        for names in ops_line.LINE_OPS[domain].values():
            for n in names:
                assert operations.get(n).risk != "irreversible"
                assert operations.get(n).description in spec.description
    assert "only on the" in ops_line.domain_spec("settings").description  # screen-only list
    state = ops_line.LineState(domains=["settings"], read=True)
    names = [t.name for t in ops_line.tools_of(state, change=True)]
    assert names == ["lookup", "settings", "need_tools"]


def test_settings_guards():
    p = ops_line.plan_settings(env("поставь бюджет 300 000"), ops_line.SettingsArgs(
        op="clear_budget", refs=[], amount=None, quiet_from=None, quiet_to=None, name=None))
    assert p.error  # no «убери» in the phrase
    p = ops_line.plan_settings(env("поставь бюджет 300 000"), ops_line.SettingsArgs(
        op="budget", refs=[], amount="1", quiet_from=None, quiet_to=None, name=None))
    assert not p.error and p.calls == [("expenses.set_budget", {"amount": "300000.00"})]
    p = ops_line.plan_settings(env("называй меня Айгерим"), ops_line.SettingsArgs(
        op="name", refs=[], amount=None, quiet_from=None, quiet_to=None, name="Хозяин"))
    assert p.error


def test_pages_guards():
    p = ops_line.plan_pages(env("перенеси встречу на 16"), ops_line.PagesArgs(
        op="restore", refs=["x1"]))
    assert p.error and "bring" in p.error
    p = ops_line.plan_pages(env("удали страницу Ремонт"), ops_line.PagesArgs(
        op="delete_page", refs=["p7"]))
    assert p.error and "unknown" in p.error


def test_tasks_update_only_with_the_persons_values():
    e = env("молоко купить в Магнуме")
    e.book.add_obj("task", uuid.uuid4(), "Молоко", "Молоко", list_key="shopping")
    ok = ops_line.plan_call(e, "tasks", ops_line.TasksArgs(
        op="update", refs=["t1"], when=None, title=None, where="Магнум"))
    assert not ok.error and ok.calls[0][1]["where"] == "Магнум"
    bad = ops_line.plan_call(e, "tasks", ops_line.TasksArgs(
        op="update", refs=["t1"], when=None, title=None, where="Чужой"))
    assert bad.error


def test_with_versions_marks_what_the_line_saw():
    e = env("хлеб купил")
    tid = uuid.uuid4()
    e.book.add_obj("task", tid, "Хлеб", "Хлеб", data={"version": 4})
    calls = ops_line.with_versions(e, [("tasks.set_done", {"task_id": tid, "done": True}),
                                       ("calendar.shift_many", {"entries": [
                                           {"task_id": tid, "occurrence_at": None}],
                                           "minutes": 60})])  # fmt: skip
    assert calls[0][1]["_v"] == 4 and calls[1][1]["_vs"] == {str(tid): 4}


def test_free_windows_and_line():
    tz = SourceBook("Asia/Almaty").tz
    day = date(2026, 11, 13)
    busy = ops_line.Obj("c1", "event", uuid.uuid4(), "Созвон", "Созвон",
                        start=datetime(2026, 11, 13, 10, 0, tzinfo=tz), duration_min=60)
    now = datetime(2026, 11, 12, 10, 0)
    wins = ops_line.free_windows([busy], day, tz, now)
    assert [(a.hour, b.hour) for a, b in wins] == [(8, 10), (11, 22)]
    assert "8:00–10:00, 11:00–22:00" in ops_line.free_line(wins, day)
    assert ops_line.free_windows([busy], date(2026, 11, 11), tz, now) == []  # a past day


@pytest.mark.parametrize(("phrase", "edits"), [
    ("цену светильников 4 500", True), ("убери доставку", True), ("скидка 5% на всё", True),
    ("отправь КП клиенту", False), ("удали это", False), ("сколько стоит кабель?", False),
    ("сделай КП для ТОО Ромашка", False), ("напомни завтра в 9 позвонить клиенту", False),
    ("потратил 5000 на такси", False), ("кабель 120 метров", True),
])
def test_kp_edit_phrase(phrase, edits):
    assert kp_line.edits(phrase) is edits


def _action(op: str, changes: list[dict[str, Any]]) -> Any:
    return SimpleNamespace(payload={"op": op, "changes": changes}, summary={"ru": "Готово"},
                           undo_of_action_id=None, kind="facet_edit")  # fmt: skip


def test_notice_targets_calendar_and_budget():
    tid = str(uuid.uuid4())
    moved = notice(_action("tasks.reschedule", [{"task_id": tid, "item_id": "x", "kind": "edit",
                                                 "text": "Перенёс"}]),
                   [], undoable=True, page_id=None)  # fmt: skip
    assert moved["target"] == {"kind": "calendar", "id": tid, "page_id": None}
    budget = notice(_action("expenses.set_budget", [{"item_id": None, "kind": "budget",
                                                     "text": "Бюджет"}]),
                    [], undoable=True, page_id=None)  # fmt: skip
    assert budget["target"] == {"kind": "budget", "id": None, "page_id": None}
    ticked = notice(_action("tasks.set_done", [{"task_id": tid, "item_id": "x", "kind": "done",
                                                "text": "Сделал"}]),
                    [], undoable=True, page_id=None)  # fmt: skip
    assert ticked["target"]["kind"] == "task"  # not a calendar move: as before
