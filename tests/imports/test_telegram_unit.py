"""Reading Telegram Desktop exports safely (no DB, no network)."""

import pytest

from assistant.imports.telegram import ExportError, Limits, json_bytes, parse
from tests.imports.fixtures import export_json, export_zip, message, saved_chat

LIM = Limits(max_json_bytes=1_000_000, max_zip_members=50, max_zip_ratio=100, max_messages=1000)


def test_saved_messages_text_media_and_service():
    out = parse(export_json(), LIM)
    texts = [m.text for m in out.messages]
    assert texts[0] == "Купить краску для забора, белую, два ведра"
    assert texts[1] == "Рецепт плова: рис девзира, морковь жёлтая"
    assert "Подпись к видео: как чинить кран" in texts  # the caption comes, the video does not
    assert out.skipped_media == {"photo": 1, "video": 2, "sticker": 1}
    assert out.service == 1 and out.total == 10
    link = next(m for m in out.messages if m.urls)
    assert link.urls == ("https://example.com/master",)  # kept as text, never fetched
    assert out.messages[0].external_id == "777:1"
    assert out.messages[0].occurred_at.tzinfo is not None


def test_a_full_export_takes_only_saved_messages():
    out = parse(export_json(full=True), LIM)
    assert all(not m.text.startswith("чужая") for m in out.messages)
    assert {m.external_id.split(":")[0] for m in out.messages} == {"777"}


def test_another_chat_alone_is_refused():
    raw = b'{"name": "x", "type": "personal_chat", "id": 1, "messages": []}'
    with pytest.raises(ExportError) as e:
        parse(raw, LIM)
    assert e.value.code == "import_not_saved_messages"


@pytest.mark.parametrize("raw", [b"not json", b"[1, 2]", b"\xff\xfe", b'{"a": 1}',
                                 b"[" * 100_000 + b"]" * 100_000])
def test_broken_files_are_refused(raw):
    with pytest.raises(ExportError) as e:
        parse(raw, LIM)
    assert e.value.code == "import_bad_file"


def test_zip_reads_only_the_shallowest_result_json_and_never_a_path():
    z = export_zip(extra={"../../evil/result.json": b"{}", "photos/photo_1.jpg": b"\x89PNG",
                          "/abs/x": b"1"})
    assert parse(json_bytes(z, LIM), LIM).total == 10


def test_zip_without_result_json():
    z = export_zip(name="other.json")
    with pytest.raises(ExportError) as e:
        json_bytes(z, LIM)
    assert e.value.code == "import_no_result_json"


def test_zip_bomb_is_refused_before_reading_it_all():
    bomb = export_zip(raw=b"{" + b" " * 5_000_000 + b"}")
    with pytest.raises(ExportError) as e:
        json_bytes(bomb, LIM)
    assert e.value.code in ("import_too_large", "import_bad_file")


def test_too_many_zip_entries():
    z = export_zip(extra={f"f{i}": b"x" for i in range(60)})
    with pytest.raises(ExportError):
        json_bytes(z, LIM)


def test_json_over_the_limit_and_too_many_messages():
    with pytest.raises(ExportError):
        json_bytes(b"{" + b" " * 1_000_001 + b"}", LIM)
    msgs = [message(i, f"заметка {i}") for i in range(1, 1100)]
    import json

    with pytest.raises(ExportError) as e:
        parse(json.dumps(saved_chat(msgs)).encode(), LIM)
    assert e.value.code == "import_too_many"
