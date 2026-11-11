"""Week 16 pure code: S35 ticks (shared vectors), the S32 / W-01 texts, money on tiles, the export's
readable files. No DB, no network."""

import json
import zipfile
from datetime import UTC, datetime
from decimal import Decimal
from io import BytesIO
from pathlib import Path

import pytest

from assistant.account.export import item_markdown, plain, slug, zip_bytes
from assistant.api.routes.account import deletion_points, pending_message, ru_date
from assistant.api.routes.today import money
from assistant.onboarding import suggested_pages

VECTORS = json.loads((Path(__file__).parents[2] / "docs/spec/vectors/onboarding-marks.json")
                     .read_text(encoding="utf-8"))  # fmt: skip


@pytest.mark.parametrize("case", VECTORS["cases"], ids=lambda c: str(c["phrase"])[:30])
def test_ticks_follow_the_shared_vectors(case: dict) -> None:
    keys, reasons = suggested_pages(case["phrase"], case["intro_marks"])
    assert keys == case["template_keys"] and reasons == case["reasons"]
    assert len(keys) <= VECTORS["max_marked"] and keys[:2] == ["notes", "tasks"]


def test_deletion_points_say_the_grace_plainly() -> None:
    assert deletion_points(7, phone=True)[1] == "7 дней можно передумать — войдите по SMS."
    assert deletion_points(1, phone=False)[1] == "1 день можно передумать — откройте приложение."
    assert "Отменить будет нельзя." in deletion_points(0, phone=True)[1]
    assert all("ИИ" not in p for p in deletion_points(7, phone=True))
    when = datetime(2026, 11, 18, 5, 0, tzinfo=UTC)
    assert ru_date(when, "Asia/Almaty") == "18 ноября"
    assert pending_message(when, "Asia/Almaty", phone=True, grace_days=7) == \
        "Аккаунт удаляется. До 18 ноября можно передумать: войдите по SMS."  # fmt: skip


def test_money_on_tiles() -> None:
    assert money(Decimal("7500"), "KZT") == "7 500 ₸"
    assert money(Decimal("1234567.5"), "KZT") == "1 234 567,50 ₸"
    assert money("20", "USD") == "20 $"
    assert money("3", "GBP") == "3 GBP"


def test_export_files_are_readable() -> None:
    assert slug("Код домофона: 4512!") == "Код-домофона-4512"
    assert slug("") == "zapis"
    md = item_markdown({"title": "", "text": "Хлеб", "kind": "note", "source": "typed",
                        "created_at": datetime(2026, 11, 1, tzinfo=UTC)})  # fmt: skip
    assert md.startswith("# Запись\n") and md.rstrip().endswith("Хлеб")
    assert plain({"a": Decimal("1.50"), "b": [datetime(2026, 1, 1, tzinfo=UTC)],
                  "c": b"secret"}) == {"a": "1.50", "b": ["2026-01-01T00:00:00+00:00"],
                                       "c": None}  # fmt: skip
    z = zipfile.ZipFile(BytesIO(zip_bytes({"b.txt": b"2", "a.txt": b"1"})))
    assert z.namelist() == ["a.txt", "b.txt"]
