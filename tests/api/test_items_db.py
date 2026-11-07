"""Items, sync and ingest against a real Postgres migrated to 0004 (alembic upgrade heads).

Skipped unless DATABASE_URL is set. Each test runs in one transaction that is rolled back.
"""

import hashlib
import os
import secrets
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select, text

from assistant.api import consent_texts
from assistant.db import queue
from assistant.db.models import Item, ItemKind, ItemSource, ItemStatus, Job, User
from assistant.db.models_v2 import ConsentKind, File
from assistant.records import FakeOcr, FakeTranscriber, IngestDeps, purge_trashed_items, run_ingest
from assistant.records.worker import run_one
from tests.api.conftest import client
from tests.records.fixtures import make_docx, make_pdf, make_xlsx

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set"),
]

BASE = (ConsentKind.PD_PROCESSING, ConsentKind.TERMS)
ALL = (*BASE, ConsentKind.AI_CROSS_BORDER)


def _grant_body(*kinds: ConsentKind) -> dict:
    items = []
    for kind in kinds:
        t = consent_texts.current(kind, "ru")
        assert t is not None
        items.append({"kind": kind, "version": t.version, "text_hash": t.text_hash,
                      "locale": "ru"})  # fmt: skip
    return {"consents": items, "screen": "S05", "age_confirmed_18": True}


async def _signed_in(c, kinds=ALL) -> dict[str, str]:
    r = await c.post("/v1/auth/anonymous", json={"device_key": secrets.token_urlsafe(32)})
    assert r.status_code == 200, r.text
    h = {"Authorization": f"Bearer {r.json()['access_token']}"}
    if kinds:
        r = await c.post("/v1/consents", json=_grant_body(*kinds), headers=h)
        assert r.status_code == 200, r.text
    return h


def _cid() -> str:
    return str(uuid.uuid4())


async def _upload(c, h, data: bytes, mime: str) -> str:
    body = {"mime": mime, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    up = (await c.post("/v1/uploads", json=body, headers=h)).json()
    url = up["put"]["url"].removeprefix("http://test")
    assert (await c.put(url, content=data, headers=up["put"]["headers"])).status_code == 200
    done = await c.post(f"/v1/uploads/{up['id']}/complete", headers=h)
    assert done.status_code == 200, done.text
    return up["id"]


async def _internal_id(s, public_id: str) -> int:
    item_id = await s.scalar(select(Item.id).where(Item.public_id == uuid.UUID(public_id)))
    assert item_id is not None
    return item_id


def _deps(app, **kw) -> IngestDeps:
    return IngestDeps(storage=app.state.ctx.storage, **kw)


async def _ingest(app, s, public_id: str, deps: IngestDeps) -> dict:
    status = await run_ingest(app.state.ctx.sessionmaker, await _internal_id(s, public_id), deps)
    assert status is not None
    s.expire_all()
    return {"status": status}


# --- schema ---


async def test_items_schema_after_0004(db_app):
    _, _, s = db_app
    rows = await s.execute(text(
        "SELECT column_name, data_type FROM information_schema.columns "
        "WHERE table_name = 'items'"))  # fmt: skip
    cols = {name: dtype for name, dtype in rows}
    assert cols["kind"] == "text" and cols["source"] == "text" and cols["status"] == "text"
    for name in (
        "public_id",
        "client_id",
        "text",
        "review_fields",
        "seq",
        "deleted_at",
        "purge_after",
        "ai_generated",
        "content_hash",
        "canonical_item_id",
    ):
        assert name in cols
    assert await s.scalar(text("SELECT count(*) FROM pg_class WHERE relname = 'sync_seq'")) == 1
    triggers = set(await s.scalars(text(
        "SELECT tgname FROM pg_trigger WHERE tgrelid = 'items'::regclass")))  # fmt: skip
    assert {"items_sync_seq", "items_sync_tombstone", "items_tsv"} <= triggers


async def test_legacy_bot_item_still_works_and_gets_seq(db_app):
    _, _, s = db_app
    user = User(telegram_id=secrets.randbelow(10**12) + 10**12)
    s.add(user)
    await s.flush()
    item = Item(user_id=user.id, kind=ItemKind.PHOTO, source=ItemSource.TELEGRAM,
                status=ItemStatus.PENDING, raw_text="pho", telegram_chat_id=1,
                telegram_message_id=2)  # fmt: skip
    s.add(item)
    await s.flush()
    first = item.seq
    assert first > 0 and item.public_id is not None
    item.status = ItemStatus.DONE
    await s.flush()
    assert item.seq > first
    item_id = item.id
    s.expire_all()
    again = await s.get(Item, item_id)
    assert again is not None and again.kind is ItemKind.PHOTO and again.status is ItemStatus.DONE


async def test_check_rejects_unknown_kind(db_app):
    _, _, s = db_app
    user = User()
    s.add(user)
    await s.flush()
    from sqlalchemy.exc import IntegrityError

    with pytest.raises(IntegrityError):
        async with s.begin_nested():
            s.add(Item(user_id=user.id, kind="spaceship", source="typed"))
            await s.flush()


async def test_enqueue_idempotency_key(db_app):
    _, _, s = db_app
    key = f"test:{uuid.uuid4()}"
    a = await queue.enqueue(s, "ingest:note", {"item_id": 1}, idempotency_key=key)
    b = await queue.enqueue(s, "ingest:note", {"item_id": 1}, idempotency_key=key)
    assert a.id == b.id


# --- create / idempotency / duplicates ---


async def test_create_note_idempotent_by_client_id(db_app):
    app, _, s = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        cid = _cid()
        body = {"client_id": cid, "text": "  Купить хлеб  и молоко ", "source": "typed"}
        r = await c.post("/v1/items", json=body, headers=h)
        assert r.status_code == 201, r.text
        out = r.json()
        item = out["item"]
        assert out["created"] is True and out["auto_merged"] is False and out["duplicate"] is None
        assert item["kind"] == "note" and item["status"] == "pending"
        assert item["text"] == "Купить хлеб и молоко" and item["client_id"] == cid
        assert item["text_lang"] == "ru" and item["seq"] > 0 and len(item["content_hash"]) == 64

        again = await c.post("/v1/items", json={**body, "text": "другое"}, headers=h)
        assert again.status_code == 200
        assert again.json()["created"] is False and again.json()["item"]["id"] == item["id"]

    item_id = await _internal_id(s, item["id"])
    key = f"item:{item_id}:ingest:v1"
    jobs = list(await s.scalars(select(Job).where(Job.idempotency_key == key)))
    assert len(jobs) == 1 and jobs[0].kind == "ingest:note"


async def test_exact_duplicate_auto_merge_and_unmerge(db_app):
    app, _, _ = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        first = (await c.post("/v1/items", json={"client_id": _cid(), "text": "Купить хлеб!"},
                              headers=h)).json()["item"]  # fmt: skip
        r = await c.post("/v1/items", json={"client_id": _cid(), "text": "купить   ХЛЕБ"},
                         headers=h)  # fmt: skip
        out = r.json()
        assert out["auto_merged"] is True
        assert out["duplicate"]["canonical_id"] == first["id"]
        dup = out["item"]
        assert dup["hidden_reason"] == "duplicate_merged" and dup["canonical_id"] == first["id"]
        assert out["duplicate"]["undo_path"] == f"/v1/items/{dup['id']}/unmerge"

        canonical = (await c.get(f"/v1/items/{first['id']}", headers=h)).json()
        assert [f["item_id"] for f in canonical["merged_fragments"]] == [dup["id"]]
        listed = (await c.get("/v1/items", headers=h)).json()["items"]
        assert [i["id"] for i in listed] == [first["id"]]  # the repeat is hidden

        undone = await c.post(out["duplicate"]["undo_path"], headers=h)
        assert undone.status_code == 200, undone.text
        assert undone.json()["hidden_reason"] is None and undone.json()["canonical_id"] is None
        canonical = (await c.get(f"/v1/items/{first['id']}", headers=h)).json()
        assert canonical["merged_fragments"] == []
        listed = (await c.get("/v1/items", headers=h)).json()["items"]
        assert {i["id"] for i in listed} == {first["id"], dup["id"]}


async def test_create_validation_and_gate(db_app):
    app, _, _ = db_app
    async with client(app) as c:
        h = await _signed_in(c, kinds=())
        r = await c.post("/v1/items", json={"client_id": _cid(), "text": "x"}, headers=h)
        assert r.status_code == 403 and r.json()["code"] == "consent_required"
        h = await _signed_in(c, kinds=BASE)
        r = await c.post("/v1/items", json={"client_id": _cid(), "text": "  "}, headers=h)
        assert r.status_code == 422
        r = await c.post("/v1/items", json={"client_id": _cid(), "text": "x", "kind": "pdf"},
                         headers=h)  # fmt: skip
        assert r.status_code == 422 and r.json()["code"] == "item_kind_mismatch"
        r = await c.post("/v1/items", json={"client_id": _cid(), "upload_id": str(uuid.uuid4())},
                         headers=h)  # fmt: skip
        assert r.status_code == 404 and r.json()["code"] == "upload_not_found"
        r = await c.post("/v1/items", json={"client_id": _cid(), "url": "https://kaspi.kz/x",
                                            "text": "смотри"}, headers=h)  # fmt: skip
        assert r.status_code == 201
        link = r.json()["item"]
        assert link["kind"] == "link" and link["source_meta"]["url"] == "https://kaspi.kz/x"


async def test_upload_item_links_file_and_rejects_reuse(db_app):
    app, _, _ = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        up = await _upload(c, h, b"\x89PNG fake image", "image/png")
        body = {"client_id": _cid(), "upload_id": up, "source": "share", "text": "чек"}
        r = await c.post("/v1/items", json=body, headers=h)
        assert r.status_code == 201, r.text
        item = r.json()["item"]
        assert item["kind"] == "image" and item["source_meta"]["caption"] == "чек"
        assert item["text"] is None and len(item["files"]) == 1
        assert item["files"][0]["state"] == "active" and item["original_sha256"]
        r = await c.post("/v1/items", json={"client_id": _cid(), "upload_id": up}, headers=h)
        assert r.status_code == 409 and r.json()["code"] == "upload_in_use"
        # same bytes again (new upload) -> exact repeat by original_sha256
        up2 = await _upload(c, h, b"\x89PNG fake image", "image/png")
        r = await c.post("/v1/items", json={"client_id": _cid(), "upload_id": up2,
                                            "kind": "screenshot"}, headers=h)  # fmt: skip
        out = r.json()
        assert out["auto_merged"] is True and out["duplicate"]["canonical_id"] == item["id"]
        assert out["item"]["files"][0]["state"] == "trash"


# --- read / patch / trash ---


async def test_patch_verify_and_conflict(db_app):
    app, _, s = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        item = (await c.post("/v1/items", json={"client_id": _cid(), "text": "черновик"},
                             headers=h)).json()["item"]  # fmt: skip
        db_item = await s.get(Item, await _internal_id(s, item["id"]))
        assert db_item is not None
        db_item.review_fields = {"phone_1": {"kind": "phone", "value": "+77011234567",
                                             "state": "unverified"}}  # fmt: skip
        db_item.status = "needs_review"
        await s.flush()
        current = (await c.get(f"/v1/items/{item['id']}", headers=h)).json()
        assert current["review_fields"]["phone_1"]["state"] == "unverified"

        stale = await c.patch(f"/v1/items/{item['id']}", json={"title": "x", "base_seq": 1},
                              headers=h)  # fmt: skip
        assert stale.status_code == 409 and stale.json()["code"] == "conflict"
        r = await c.patch(f"/v1/items/{item['id']}",
                          json={"title": "Звонок", "text": "Позвонить  Ерлану",
                                "verify": ["phone_1"], "base_seq": current["seq"]},
                          headers=h)  # fmt: skip
        assert r.status_code == 200, r.text
        out = r.json()
        assert out["title"] == "Звонок" and out["text"] == "Позвонить Ерлану"
        assert out["review_fields"]["phone_1"]["state"] == "verified"
        assert out["status"] == "ready" and out["seq"] > current["seq"]


async def test_trash_restore_and_purge_tombstone(db_app):
    app, _, s = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        item = (await c.post("/v1/items", json={"client_id": _cid(), "text": "в корзину"},
                             headers=h)).json()["item"]  # fmt: skip
        r = await c.delete(f"/v1/items/{item['id']}", headers=h)
        assert r.status_code == 200
        deleted = r.json()
        assert deleted["deleted_at"] is not None
        purge_after = datetime.fromisoformat(deleted["purge_after"])
        deleted_at = datetime.fromisoformat(deleted["deleted_at"])
        assert purge_after - deleted_at == timedelta(days=30)
        assert (await c.get("/v1/items", headers=h)).json()["items"] == []
        trash = (await c.get("/v1/items/trash", headers=h)).json()["items"]
        assert [i["id"] for i in trash] == [item["id"]]
        r = await c.patch(f"/v1/items/{item['id']}", json={"title": "x"}, headers=h)
        assert r.status_code == 409 and r.json()["code"] == "item_deleted"

        restored = (await c.post(f"/v1/items/{item['id']}/restore", headers=h)).json()
        assert restored["deleted_at"] is None and restored["purge_after"] is None
        assert len((await c.get("/v1/items", headers=h)).json()["items"]) == 1

        await c.delete(f"/v1/items/{item['id']}", headers=h)
        before = (await c.get("/v1/sync", headers=h)).json()["next_since"]
        db_item = await s.get(Item, await _internal_id(s, item["id"]))
        assert db_item is not None
        db_item.purge_after = datetime.now(UTC) - timedelta(seconds=1)
        await s.flush()
        assert await purge_trashed_items(s) >= 1
        await s.flush()
        assert (await c.get(f"/v1/items/{item['id']}", headers=h)).status_code == 404
        changes = (await c.get(f"/v1/sync?since={before}", headers=h)).json()
        assert changes["items"] == []
        assert [(t["entity"], t["id"]) for t in changes["tombstones"]] == [("item", item["id"])]


# --- sync ---


async def test_sync_order_pagination_and_tombstones(db_app):
    app, _, _ = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        # A new account already has «Сегодня» in the stream (0007); this test is about items.
        start = (await c.get("/v1/sync", headers=h)).json()["next_since"]
        ids = []
        for n in range(3):
            r = await c.post("/v1/items", json={"client_id": _cid(), "text": f"запись {n}"},
                             headers=h)  # fmt: skip
            ids.append(r.json()["item"]["id"])
        await c.patch(f"/v1/items/{ids[0]}", json={"title": "изменена"}, headers=h)
        await c.delete(f"/v1/items/{ids[1]}", headers=h)

        full = (await c.get("/v1/sync?since=0", headers=h)).json()
        assert [i["id"] for i in full["items"]] == [ids[2], ids[0], ids[1]]  # by last change
        seqs = [i["seq"] for i in full["items"]]
        assert seqs == sorted(seqs) and full["has_more"] is False
        assert full["next_since"] == seqs[-1]
        assert full["items"][2]["deleted_at"] is not None  # trash travels as an item

        page1 = (await c.get(f"/v1/sync?since={start}&limit=2", headers=h)).json()
        assert page1["has_more"] is True and len(page1["items"]) == 2
        page2 = (await c.get(f"/v1/sync?since={page1['next_since']}&limit=2", headers=h)).json()
        assert page2["has_more"] is False
        assert [i["id"] for i in page1["items"] + page2["items"]] == [ids[2], ids[0], ids[1]]

        empty = (await c.get(f"/v1/sync?since={full['next_since']}", headers=h)).json()
        assert empty == {"items": [], "screens": [], "screen_items": [], "tombstones": [],
                         "next_since": full["next_since"], "has_more": False}  # fmt: skip

        other = await _signed_in(c)  # another user sees nothing of this
        assert (await c.get("/v1/sync", headers=other)).json()["items"] == []
        assert (await c.get(f"/v1/items/{ids[0]}", headers=other)).status_code == 404


# --- ingest ---


async def test_ingest_note_ready_with_links(db_app):
    app, _, s = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        item = (await c.post("/v1/items", json={"client_id": _cid(),
                                                "text": "Рецепт https://example.kz/plov"},
                             headers=h)).json()["item"]  # fmt: skip
        assert (await _ingest(app, s, item["id"], _deps(app)))["status"] == "ready"
        out = (await c.get(f"/v1/items/{item['id']}", headers=h)).json()
        assert out["status"] == "ready" and out["source_meta"]["links"] == [
            "https://example.kz/plov"]  # fmt: skip
        assert out["title"] == "Рецепт https://example.kz/plov"


async def test_ingest_screenshot_ocr_review_fields_and_original_trash(db_app):
    app, _, s = db_app
    ocr = FakeOcr("Оплата 12 500 ₸\nтел +7 701 123 45 67", 0.93)
    async with client(app) as c:
        h = await _signed_in(c)
        up = await _upload(c, h, b"screenshot-bytes-1", "image/jpeg")
        item = (await c.post("/v1/items", json={"client_id": _cid(), "upload_id": up,
                                                "kind": "screenshot"},
                             headers=h)).json()["item"]  # fmt: skip
        assert (await _ingest(app, s, item["id"], _deps(app, ocr=ocr)))["status"] == "needs_review"
        out = (await c.get(f"/v1/items/{item['id']}", headers=h)).json()
        assert ocr.calls == 1 and out["text"].startswith("Оплата 12 500 ₸")
        assert {v["kind"] for v in out["review_fields"].values()} == {"amount", "phone"}
        assert out["confidence"] == pytest.approx(0.93)
        assert out["files"][0]["state"] == "trash" and out["files"][0]["trash_until"]

        keys = list(out["review_fields"])
        done = (await c.patch(f"/v1/items/{item['id']}", json={"verify": keys}, headers=h)).json()
        assert done["status"] == "ready"
        # a re-run never resets what the person confirmed
        assert await run_ingest(app.state.ctx.sessionmaker, await _internal_id(s, item["id"]),
                                _deps(app, ocr=ocr)) is None  # fmt: skip


async def test_ingest_image_low_confidence_keeps_original(db_app):
    app, _, s = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        up = await _upload(c, h, b"blurry-photo", "image/jpeg")
        item = (await c.post("/v1/items", json={"client_id": _cid(), "upload_id": up},
                             headers=h)).json()["item"]  # fmt: skip
        await _ingest(app, s, item["id"], _deps(app, ocr=FakeOcr("нечитаемо", 0.4)))
        out = (await c.get(f"/v1/items/{item['id']}", headers=h)).json()
        assert out["status"] == "needs_review"
        assert out["files"][0]["state"] == "active"
        assert out["files"][0]["keep_reason"] == "low_confidence"


async def test_voice_waits_for_consent_then_transcribes(db_app):
    app, _, s = db_app
    stt = FakeTranscriber("Напомни завтра позвонить маме", 0.95)
    async with client(app) as c:
        h = await _signed_in(c, kinds=BASE)  # "Без ИИ"
        up = await _upload(c, h, b"aac-audio", "audio/aac")
        r = await c.post("/v1/items", json={"client_id": _cid(), "upload_id": up,
                                            "source": "mic"}, headers=h)  # fmt: skip
        item = r.json()["item"]
        assert item["kind"] == "voice" and item["status"] == "needs_consent"
        item_id = await _internal_id(s, item["id"])
        for_item = Job.payload["item_id"].as_integer() == item_id
        assert await s.scalar(select(Job.id).where(for_item)) is None

        # the job itself refuses too (gate in ingest, not only in the API)
        status = await run_ingest(app.state.ctx.sessionmaker, item_id, _deps(app, transcriber=stt))
        assert status == "needs_consent"
        assert stt.calls == 0

        r = await c.post("/v1/consents", json=_grant_body(ConsentKind.AI_CROSS_BORDER), headers=h)
        assert r.status_code == 200
        s.expire_all()
        job = await s.scalar(select(Job).where(Job.payload["item_id"].as_integer() == item_id))
        assert job is not None and job.kind == "ingest:voice"
        assert (await c.get(f"/v1/items/{item['id']}", headers=h)).json()["status"] == "pending"

        assert (await _ingest(app, s, item["id"], _deps(app, transcriber=stt)))["status"] == "ready"
        out = (await c.get(f"/v1/items/{item['id']}", headers=h)).json()
        assert stt.calls == 1 and out["text"] == "Напомни завтра позвонить маме"
        assert out["source_meta"]["stt"] == "fake" and out["files"][0]["state"] == "trash"


async def test_voice_provider_not_in_consent_is_blocked(db_app):
    app, _, s = db_app
    stt = FakeTranscriber("x", 0.9, recipient="Voyage")  # not in the accepted providers list
    async with client(app) as c:
        h = await _signed_in(c)
        up = await _upload(c, h, b"aac-audio-2", "audio/mp4")
        item = (await c.post("/v1/items", json={"client_id": _cid(), "upload_id": up},
                             headers=h)).json()["item"]  # fmt: skip
        assert item["status"] == "pending"
        assert (await _ingest(app, s, item["id"], _deps(app, transcriber=stt)))["status"] == (
            "needs_consent"
        )
        assert stt.calls == 0


async def test_voice_low_confidence_needs_review(db_app):
    app, _, s = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        up = await _upload(c, h, b"aac-audio-3", "audio/aac")
        item = (await c.post("/v1/items", json={"client_id": _cid(), "upload_id": up},
                             headers=h)).json()["item"]  # fmt: skip
        deps = _deps(app, transcriber=FakeTranscriber("что-то неразборчиво", 0.5))
        assert (await _ingest(app, s, item["id"], deps))["status"] == "needs_review"
        out = (await c.get(f"/v1/items/{item['id']}", headers=h)).json()
        assert out["review_fields"]["transcript"]["state"] == "unverified"
        assert out["files"][0]["keep_reason"] == "low_confidence"


async def test_ingest_pdf_text_and_scanned_page_ocr(db_app):
    app, _, s = db_app
    line = "Commercial offer for cement delivery to Almaty, valid until December."
    ocr = FakeOcr("Scanned page two with the signature block and stamp of the company.", 0.88)
    async with client(app) as c:
        h = await _signed_in(c)
        up = await _upload(c, h, make_pdf([line, ""]), "application/pdf")
        item = (await c.post("/v1/items", json={"client_id": _cid(), "upload_id": up,
                                                "source": "files"},
                             headers=h)).json()["item"]  # fmt: skip
        assert item["kind"] == "pdf"
        await _ingest(app, s, item["id"], _deps(app, ocr=ocr))
        out = (await c.get(f"/v1/items/{item['id']}", headers=h)).json()
        assert out["status"] == "ready", out
        assert line in out["text"] and "Scanned page two" in out["text"]
        assert out["source_meta"]["pdf"]["ocr_pages"] == 1 and ocr.calls == 1
        assert out["source_meta"]["pdf"]["more_pages"] is False


async def test_ingest_broken_pdf_fails_with_code(db_app):
    app, _, s = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        up = await _upload(c, h, b"%PDF-1.4 broken", "application/pdf")
        item = (await c.post("/v1/items", json={"client_id": _cid(), "upload_id": up},
                             headers=h)).json()["item"]  # fmt: skip
        assert (await _ingest(app, s, item["id"], _deps(app)))["status"] == "failed"
        out = (await c.get(f"/v1/items/{item['id']}", headers=h)).json()
        assert out["error"] == "pdf_unreadable" and out["files"][0]["state"] == "active"


async def test_ingest_docx_and_xlsx(db_app):
    app, _, s = db_app
    docx_mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    xlsx_mime = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    async with client(app) as c:
        h = await _signed_in(c)
        up = await _upload(c, h, make_docx(), docx_mime)
        d = (await c.post("/v1/items", json={"client_id": _cid(), "upload_id": up},
                          headers=h)).json()["item"]  # fmt: skip
        up = await _upload(c, h, make_xlsx(), xlsx_mime)
        x = (await c.post("/v1/items", json={"client_id": _cid(), "upload_id": up},
                          headers=h)).json()["item"]  # fmt: skip
        assert (d["kind"], x["kind"]) == ("docx", "xlsx")
        await _ingest(app, s, d["id"], _deps(app))
        await _ingest(app, s, x["id"], _deps(app))
        d = (await c.get(f"/v1/items/{d['id']}", headers=h)).json()
        x = (await c.get(f"/v1/items/{x['id']}", headers=h)).json()
        assert d["status"] == "ready" and "Цемент | 2500" in d["text"]
        assert d["title"] == "Договор поставки" and d["files"][0]["state"] == "trash"
        assert x["status"] == "ready" and x["source_meta"]["sheets"][0]["headers"][0] == "Товар"
        # tiny sheet: its JSON is smaller than the xlsx file, so the original goes to trash
        assert x["files"][0]["state"] == "trash"


async def test_ingest_merges_repeat_found_after_extraction(db_app):
    app, _, s = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        note = (await c.post("/v1/items", json={"client_id": _cid(), "text": "Код двери 4512"},
                             headers=h)).json()["item"]  # fmt: skip
        up = await _upload(c, h, b"photo-of-door-code", "image/jpeg")
        photo = (await c.post("/v1/items", json={"client_id": _cid(), "upload_id": up},
                              headers=h)).json()["item"]  # fmt: skip
        await _ingest(app, s, photo["id"], _deps(app, ocr=FakeOcr("код двери: 4512", 0.95)))
        out = (await c.get(f"/v1/items/{photo['id']}", headers=h)).json()
        assert out["hidden_reason"] == "duplicate_merged" and out["canonical_id"] == note["id"]


async def test_worker_run_one_completes_job(db_app):
    app, _, s = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        item = (await c.post("/v1/items", json={"client_id": _cid(), "text": "для воркера"},
                             headers=h)).json()["item"]  # fmt: skip
    item_id = await _internal_id(s, item["id"])
    maker = app.state.ctx.sessionmaker
    for _ in range(50):  # other committed ingest jobs may sit in a shared dev DB
        job = await s.scalar(select(Job).where(Job.idempotency_key == f"item:{item_id}:ingest:v1"))
        await s.refresh(job)
        if job.status == "done":
            break
        assert await run_one(maker, _deps(app)) is True
    assert job.status == "done"
    assert (await s.get(Item, item_id, populate_existing=True)).status == "ready"


async def test_file_row_links_to_item(db_app):
    app, _, s = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        up = await _upload(c, h, b"some-binary", "application/zip")
        item = (await c.post("/v1/items", json={"client_id": _cid(), "upload_id": up},
                             headers=h)).json()["item"]  # fmt: skip
        assert item["kind"] == "file_other"
        await _ingest(app, s, item["id"], _deps(app))
    f = await s.scalar(select(File).where(File.item_id == await _internal_id(s, item["id"])))
    assert f is not None and f.state == "active"  # no text replaces it: original stays
