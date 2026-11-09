"""Week 11, no DB: the field order rule of `pages.view` (the phone computes the same) and the
code guard that lets the assistant change a view only when the person's words ask for it."""

from assistant.chat.intent import Intent, asks_view, rules_first, save_text
from assistant.pages.view import effective_fields, find_field, prefs_of

TEMPLATE = [
    {"id": "title", "title": {"ru": "Заголовок"}, "type": "text", "required": True,
     "default_visible": True},
    {"id": "text", "title": {"ru": "Текст"}, "type": "long_text", "default_visible": True},
    {"id": "date", "title": {"ru": "Дата"}, "type": "date", "default_visible": False},
]  # fmt: skip
CUSTOM = [{"id": "c_1", "title": "Телефон мастера", "type": "text", "set_by": "user"}]


def test_fields_default_then_prefs_then_new_ones_last() -> None:
    plain = effective_fields(TEMPLATE, CUSTOM, [])
    assert [(f["id"], f["visible"]) for f in plain] == [
        ("title", True), ("text", True), ("date", False), ("c_1", True)]
    prefs = [{"field_id": "c_1", "visible": True, "set_by": "user"},
             {"field_id": "title", "visible": False},  # ★ stays visible
             {"field_id": "gone", "visible": True}]  # fmt: skip
    got = effective_fields(TEMPLATE, CUSTOM, prefs)
    assert [f["id"] for f in got] == ["c_1", "title", "text", "date"]
    assert got[1]["visible"] is True
    assert [p["field_id"] for p in prefs_of(got)] == ["c_1", "title", "text", "date"]


def test_fields_are_found_by_id_or_words() -> None:
    fields = effective_fields(TEMPLATE, CUSTOM, [])
    assert find_field(fields, "date")["id"] == "date"  # type: ignore[index]
    assert find_field(fields, "телефон мастера")["id"] == "c_1"  # type: ignore[index]
    assert find_field(fields, "Телефон")["id"] == "c_1"  # type: ignore[index]
    assert find_field(fields, "цена") is None


def test_view_phrases_are_changes_and_record_words_are_not() -> None:
    for phrase in ("покажи таблицей", "сделай простым списком", "включи доску",
                   "спрячь источник", "приколи код домофона", "верни страницу как было",
                   "добавь поле телефон мастера", "покажи по магазинам"):
        assert rules_first(phrase).intent == Intent.CHANGE, phrase
        assert asks_view(phrase), phrase
    assert save_text("добавь поле телефон мастера") is None  # not a note
    assert not asks_view("удали лопату")
    assert not asks_view("запиши купить хлеб")
    assert rules_first("покажи мои заметки").intent == Intent.QUESTION
