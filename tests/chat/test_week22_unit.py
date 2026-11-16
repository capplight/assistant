"""Steps 3-4 of vision-2026-11-review §5.4 (no database): undo by phrase (Ф-67, Ф-73), trash
without «Да» (Ф-66), the 3-second notice, the «изменил помощник» mark, «разберу позже» (Ф-69)."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest

from assistant.actions.service import notice
from assistant.chat.intent import UndoPhrase, is_delete, undo_phrase
from assistant.chat.parse_later import status_of
from assistant.chat.undo_line import answer_text, score
from assistant.db.models_actions import Action
from assistant.records import MARK_HOURS, mark_fields

NOW = datetime(2026, 11, 16, 10, 0, tzinfo=UTC)


@pytest.mark.parametrize(("phrase", "want"), [
    ("верни как было", UndoPhrase()),
    ("Верните всё как было.", UndoPhrase(all=True)),
    ("отмени", UndoPhrase()),
    ("Отмени последнее", UndoPhrase()),
    ("отмени последнее действие", UndoPhrase()),
    ("отмени всё", UndoPhrase(all=True)),
    ("не туда", UndoPhrase()),
    ("пожалуйста, отмени", UndoPhrase()),
    ("верни запись про хлеб", UndoPhrase(about=("хлеб",))),
    ("отмени то, что ты сделал с хлебом", UndoPhrase(about=("хлебом",))),
    ("қайтар", UndoPhrase()),
])  # fmt: skip
def test_undo_phrases(phrase, want):
    assert undo_phrase(phrase) == want


@pytest.mark.parametrize("phrase", [
    "верни страницу как было", "верни вид", "верни поле", "как отменить?", "отменить?",
    "верни", "купить хлеб", "отменили рейс в Стамбул", "что ты отменил?",
])  # fmt: skip
def test_not_undo_phrases(phrase):
    assert undo_phrase(phrase) is None


def test_trash_needs_a_delete_word_in_the_persons_phrase():
    assert is_delete("удали плитку") and is_delete("убери это в корзину")
    assert is_delete("выброси старые заметки")
    assert not is_delete("перенеси плитку в Ремонт") and not is_delete("удалил вчера")


def _action(**kw) -> Action:  # type: ignore[no-untyped-def]
    a = Action(id=kw.pop("id", 1), public_id=uuid.uuid4(), user_id=1, kind=kw.pop("kind"),
               initiated_by="agent", summary={"ru": kw.pop("summary", ""), "kk": None},
               payload={"changes": kw.pop("changes", []), **kw.pop("payload", {})},
               inverse=[{"op": "x"}], undo_of_action_id=kw.pop("undo_of", None))  # fmt: skip
    return a


def test_score_matches_by_stem():
    a = _action(kind="save_item", summary="Добавил в дела: купить хлеб.",
                changes=[{"item_id": "1", "title": "Купить хлеб", "kind": "create"}])
    assert score(a, ("хлебом",)) == 1.0
    assert score(a, ("плитка",)) == 0.0
    assert score(a, ("хлеб", "плитка")) == 0.5


def test_notice_texts():
    item, page = str(uuid.uuid4()), str(uuid.uuid4())
    where = [{"page_id": page, "title": "Дела", "icon": "x", "template_key": "tasks",
              "item_ids": [item]}]  # fmt: skip
    save = _action(kind="save_item", summary="Добавил в дела: хлеб.",
                   changes=[{"item_id": item, "task_id": "t1", "title": "хлеб", "kind": "create",
                             "page_id": page}])  # fmt: skip
    n = notice(save, where, undoable=True, page_id=None)
    assert n["text_ru"] == "Записал в «Дела»" and n["ms"] == 3000
    assert n["target"] == {"kind": "task", "id": "t1", "page_id": page}
    assert n["undo_label_ru"] == "Отменить" and "text_kk" in n
    trash = _action(kind="delete_item", summary="Убрал в корзину «Шины».",
                    changes=[{"item_id": item, "title": "Шины", "kind": "trash"}])
    n = notice(trash, [], undoable=True, page_id=page)
    assert n["text_ru"] == "Удалил «Шины»" and n["undo_label_ru"] == "Восстановить"
    assert n["target"] == {"kind": "item", "id": item, "page_id": None}
    many = _action(kind="delete_item", changes=[{"item_id": str(i), "title": "x", "kind": "trash"}
                                                for i in range(3)])  # fmt: skip
    assert notice(many, [], undoable=True, page_id=None)["text_ru"] == "Удалил 3 записи"
    spend = _action(kind="create_expense", changes=[
        {"item_id": item, "expense_id": "e1", "title": "такси", "kind": "create"}])
    where[0]["title"] = "Расходы"
    assert notice(spend, where, undoable=True, page_id=None)["text_ru"] \
        == "Записал трату в «Расходы»"  # fmt: skip
    later = _action(kind="create_expense", payload={"parsed_later": True}, changes=[
        {"item_id": item, "expense_id": "e1", "title": "такси", "kind": "create"}])
    assert notice(later, where, undoable=True, page_id=None)["text_ru"] \
        == "Разобрал: перенёс в «Расходы»"  # fmt: skip
    edit = _action(kind="edit_expense", summary="Изменил трату: 5 000 ₸.")
    assert notice(edit, [], undoable=False, page_id=None)["text_ru"] == "Обновил трату"
    assert notice(edit, [], undoable=False, page_id=None)["undo_label_ru"] is None
    undo = _action(kind="save_item", undo_of=7, summary="Отменено: записал.")
    assert notice(undo, [], undoable=True, page_id=None)["text_ru"] == "Вернул как было"
    assert notice(undo, [], undoable=True, page_id=None)["undo_label_ru"] == "Вернуть"


def test_mark_lasts_a_day():
    aid = uuid.uuid4()
    assert mark_fields(NOW, aid, NOW + timedelta(hours=1)) == {
        "assistant_changed_at": NOW, "assistant_action_id": aid}
    gone = mark_fields(NOW, aid, NOW + timedelta(hours=MARK_HOURS))
    assert gone == {"assistant_changed_at": None, "assistant_action_id": None}
    assert mark_fields(None, None, NOW)["assistant_changed_at"] is None


def test_parse_later_status():
    assert status_of({}) is None
    waiting = status_of({"parse_later": True})
    assert waiting["state"] == "waiting"  # type: ignore[index]
    assert waiting["text_ru"] == "Сохранил как заметку, разберу позже"  # type: ignore[index]
    done = status_of({"parsed_later": {"to": "expense", "text_ru": "Разобрал: перенёс в «Расходы»",
                                       "action_id": "a1"}})  # fmt: skip
    assert done == {"state": "done", "text_ru": "Разобрал: перенёс в «Расходы»", "text_kk": None,
                    "to": "expense", "action_id": "a1"}  # fmt: skip


def test_undo_answer_texts():
    from assistant.chat.undo_line import Undone

    assert answer_text(Undone(), UndoPhrase(), "ru").startswith("Не нашёл, что отменить")
    assert "«хлеб»" in answer_text(Undone(), UndoPhrase(about=("хлеб",)), "ru")
