"""AI-chat export parsers (step 7): ChatGPT, Claude, Gemini JSON/HTML; limits; summary words."""

import json
from datetime import UTC, datetime

import pytest

from assistant.imports.aichat_service import summary_text
from assistant.imports.aichats import (
    MAX_PARTS,
    PART_CHARS,
    Conversation,
    Limits,
    Turn,
    clean,
    html_date,
    parse,
    read_files,
    records,
)
from assistant.imports.telegram import ExportError
from tests.imports.aichat_fixtures import (
    GEMINI_HTML,
    as_zip,
    chatgpt_export,
    chatgpt_simple,
    chatgpt_zip,
    claude_export,
    claude_zip,
    gemini_export,
    gemini_zip,
)

LIM = Limits(10 * 1024 * 1024, 100, 100, 5000)


def _parse(data: bytes, lim: Limits = LIM):
    return parse(read_files(data, lim), lim)


def test_chatgpt_zip_shown_branch_only():
    ex = _parse(chatgpt_zip())
    assert ex.provider == "chatgpt"
    assert ex.total == 4 and ex.failed == 1 and ex.empty == 1
    assert len(ex.conversations) == 2
    plov, cafe = ex.conversations  # newest first
    assert plov[0].title == "Рецепт плова"
    (r,) = cafe
    assert r.title == "Кафе в Стамбуле" and r.provider == "chatgpt" and r.turns == 4
    assert r.text == ("Я: Посоветуй кафе в Стамбуле с видом на Босфор\n\n"
                      "ChatGPT: Попробуйте кафе «Чайка» у набережной.\n\n"
                      "Я: А это место на фото подходит?\n\n"
                      "ChatGPT: Да, это тоже хороший вариант.")  # fmt: skip
    assert "Старый вариант" not in r.text and "search(" not in r.text and "думаю" not in r.text
    assert ex.media == {"image": 1}
    assert r.occurred_at == datetime.fromtimestamp(1_760_000_000, UTC)
    assert r.external_id.startswith("chatgpt:c-1:1:")


def test_chatgpt_without_current_node_takes_the_latest_leaf():
    conv = chatgpt_export()[0]
    del conv["current_node"]
    ex = parse([json.dumps([conv]).encode()], LIM)
    assert "Да, это тоже хороший вариант." in ex.conversations[0][0].text


def test_chatgpt_sharded_files_are_all_read():
    data = as_zip({"conversations-000.json": json.dumps([chatgpt_simple("a", "Один", "q1", "a1",
                                                                        1.7e9)]),
                   "conversations-001.json": json.dumps([chatgpt_simple("b", "Два", "q2", "a2",
                                                                        1.7e9 + 5)])})
    ex = _parse(data)
    assert [c[0].title for c in ex.conversations] == ["Два", "Один"]


def test_claude_both_shapes():
    ex = _parse(claude_zip())
    assert ex.provider == "claude" and ex.total == 3 and ex.empty == 1
    trip, thanks = ex.conversations
    assert trip[0].title == "План поездки в Алматы"
    assert trip[0].text == ("Я: Что посмотреть в Алматы за два дня?\n\n"
                            "Claude: Медеу, Кок-Тобе и Большое Алматинское озеро.\n\n"
                            "Я: А где поесть?\n\nClaude: В кафе у Зелёного базара.")  # fmt: skip
    assert "скрытое" not in trip[0].text
    assert thanks[0].title == "Как будет «спасибо» по-казахски?"  # no name: the first question
    assert ex.media == {"file": 1}


def test_gemini_json_sessions_and_only_gemini_entries():
    ex = _parse(gemini_zip(html_too=True))  # json is preferred over html
    assert ex.provider == "gemini"
    assert len(ex.conversations) == 2
    later, first = ex.conversations
    assert first[0].title == "Что такое Медеу?" and first[0].turns == 4
    assert "Gemini: Около 2 000 тенге & меньше для детей.\n• взрослый\n• детский" in first[0].text
    assert later[0].text == "Я: А зимой там холодно?\n\nGemini: Да, до −10."
    assert "котики" not in "".join(c[0].text for c in ex.conversations)
    assert ex.media == {"file": 1}


def test_gemini_html_english_and_russian():
    ex = parse([GEMINI_HTML.encode()], LIM)
    assert ex.provider == "gemini" and len(ex.conversations) == 1
    (r,) = ex.conversations[0]
    assert r.text == ("Я: Как сварить бешбармак?\n\nGemini: Варить мясо три часа.\n"
                      "Тесто раскатать тонко.\n\nЯ: Сколько соли?\n\nGemini: Две ложки.")
    assert r.occurred_at == datetime(2025, 10, 2, 10, 0, tzinfo=UTC)


def test_html_dates():
    from zoneinfo import ZoneInfo

    tz = ZoneInfo("Asia/Almaty")
    assert html_date("Jun 7, 2025, 2:52:31 PM UTC", tz) == datetime(2025, 6, 7, 14, 52, 31,
                                                                      tzinfo=UTC)
    assert html_date("7 июн. 2025 г., 14:52:31 GMT+05:00", tz) == datetime(2025, 6, 7, 9, 52,
                                                                           31, tzinfo=UTC)
    assert html_date("not a date", tz) is None


def test_long_conversation_is_split_and_capped():
    turn = "слово " * 2000  # ~12 000 chars, cut to 6 000 per turn
    c = Conversation("x", "Длинный", datetime(2025, 1, 1, tzinfo=UTC), None,
                     [Turn("user" if i % 2 == 0 else "assistant", clean(turn)) for i in range(80)])
    recs, cut = records("chatgpt", c)
    assert cut and len(recs) == MAX_PARTS
    assert all(len(r.text) <= PART_CHARS for r in recs)
    assert recs[1].title == "Длинный (часть 2)" and recs[0].parts == MAX_PARTS
    assert len({r.external_id for r in recs}) == MAX_PARTS
    assert recs[0].text.split("\n\n")[0].endswith(" …")


def test_conversation_limit_keeps_the_newest():
    convs = [chatgpt_simple(f"c{i}", f"Чат {i}", "вопрос", "ответ", 1.7e9 + i) for i in range(5)]
    ex = parse([json.dumps(convs).encode()], Limits(10**7, 100, 100, 3))
    assert ex.older == 2 and [c[0].title for c in ex.conversations] == ["Чат 4", "Чат 3", "Чат 2"]


def test_same_export_same_ids():
    a = [r.external_id for c in _parse(chatgpt_zip()).conversations for r in c]
    b = [r.external_id for c in _parse(chatgpt_zip()).conversations for r in c]
    assert a == b


@pytest.mark.parametrize("data,code", [
    (b"not json at all", "import_bad_file"),
    (b"[1, 2]", "import_unknown_format"),
    (json.dumps([{"foo": "bar"}]).encode(), "import_unknown_format"),
    (as_zip({"readme.txt": "hi"}), "import_no_chats_file"),
    (b"PK\x03\x04broken", "import_bad_file"),
    (b"[" * 100_000 + b"]" * 100_000, "import_bad_file"),
])
def test_bad_files(data, code):
    with pytest.raises(ExportError) as e:
        _parse(data)
    assert e.value.code == code


def test_too_large_and_zip_bomb():
    with pytest.raises(ExportError) as e:
        read_files(b"[" + b" " * 2000 + b"]", Limits(1000, 10, 100, 10))
    assert e.value.code == "import_too_large"
    bomb = as_zip({"conversations.json": "[" + " " * 500_000 + "]"})
    with pytest.raises(ExportError) as e:
        read_files(bomb, Limits(10**7, 10, 100, 10))
    assert e.value.code == "import_bad_file"


def test_unknown_fields_and_partial_entries_are_tolerated():
    data = claude_export()
    data.append("строка вместо разговора")
    data[0]["chat_messages"].append({"sender": "robot", "text": "?"})
    data[0]["chat_messages"].append(None)
    ex = parse([json.dumps(data).encode()], LIM)
    assert ex.failed == 1 and len(ex.conversations) == 2


def test_summary_words():
    assert summary_text("chatgpt", 312, 0, 0, 0, 0, {}, 5000) == "Принёс 312 разговоров из ChatGPT."
    t = summary_text("gemini", 1, 2, 3, 40, 1, {"image": 2}, 5000)
    assert t == ("Принёс 1 разговор из Gemini. Повторов не взял: 2. Уже были раньше: 3. "
                 "Старые (40) не перенёс: за раз беру 5 000 самых новых. "
                 "Картинки (2) не перенёс — только текст. Не прочитал: 1.")
    assert gemini_export()  # fixture sanity
