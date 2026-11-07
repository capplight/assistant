"""Items/sync endpoints without a DB: consent gate, validation, mime -> kind, legacy mapping."""

import uuid
from datetime import UTC, datetime

from assistant.api.routes.items import item_out, kind_from_mime
from assistant.db.models import Item
from tests.api.conftest import client, unit_app


async def test_items_and_sync_need_base_consent(tmp_path):
    app = unit_app(tmp_path, active_kinds=set())
    async with client(app) as c:
        r = await c.post("/v1/items", json={"client_id": str(uuid.uuid4()), "text": "x"})
        assert r.status_code == 403 and r.json()["details"]["missing"] == ["pd_processing", "terms"]
        assert (await c.get("/v1/sync")).status_code == 403
        assert (await c.get(f"/v1/items/{uuid.uuid4()}")).status_code == 403


async def test_items_need_auth(tmp_path):
    async with client(unit_app(tmp_path, active_kinds=None)) as c:
        assert (await c.get("/v1/sync")).status_code == 401


async def test_create_body_validation(tmp_path):
    app = unit_app(tmp_path, active_kinds={"pd_processing", "terms"})
    async with client(app) as c:
        r = await c.post("/v1/items", json={"text": "no client id"})
        assert r.status_code == 422 and r.json()["code"] == "validation_error"
        r = await c.post("/v1/items", json={"client_id": str(uuid.uuid4()), "url": "ftp://x"})
        assert r.status_code == 422
        r = await c.get("/v1/sync?since=-1")
        assert r.status_code == 422


def test_kind_from_mime():
    assert kind_from_mime("image/heic") == "image"
    assert kind_from_mime("audio/aac") == "voice"
    assert kind_from_mime("application/pdf") == "pdf"
    assert (
        kind_from_mime("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        == "xlsx"
    )
    assert kind_from_mime("application/zip") == "file_other"


def test_legacy_values_are_mapped_on_output():
    now = datetime.now(UTC)
    item = Item(id=1, public_id=uuid.uuid4(), user_id=1, kind="photo", source="instagram",
                status="done", raw_text="old", telegram_chat_id=1, telegram_message_id=1,
                error="Traceback ...", seq=5, created_at=now, updated_at=now,
                review_fields={}, merged_fragments=[], source_meta={},
                ai_generated=False)  # fmt: skip
    out = item_out(item, [], None)
    assert (out.kind, out.source, out.status) == ("image", "bot_forward", "ready")
    assert out.text == "old" and out.error == "legacy_failed"
