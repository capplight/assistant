"""Enrichment, links, voice fragments, batches and page placement on a real Postgres.

Skipped unless DATABASE_URL is set. Each test runs in one transaction that is rolled back.
All providers are fakes.
"""

import hashlib
import os
import secrets
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
import yaml
from sqlalchemy import select, text, update

from assistant.ai import BatchEntry, FakeAdapter, PgAIStore, Router, load_routes
from assistant.ai.routes import DEFAULT_ROUTES_FILE, RouteTable
from assistant.ai.types import ServerError, Usage
from assistant.api import consent_texts
from assistant.config import Settings
from assistant.db.models import Item, Job
from assistant.db.models_ai import AIBatch, AIBatchRequest, ProviderUsage
from assistant.db.models_v2 import ConsentKind, File
from assistant.records import (
    FakeLinkReader,
    FakeOcr,
    FakeTranscriber,
    IngestDeps,
    LinkContent,
    flush_batches,
    poll_batches,
    run_enrich,
    sweep_recording,
)
from assistant.records.worker import run_one
from tests.api.conftest import client
from tests.records.fixtures import make_docx, make_pdf

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set"),
]

BASE = (ConsentKind.PD_PROCESSING, ConsentKind.TERMS)
ALL = (*BASE, ConsentKind.AI_CROSS_BORDER)
LONG = "Договор аренды офиса на Абая, сумма и сроки описаны подробно в этой длинной записи. " * 2


def envelope(**kw) -> dict:
    base = dict(
        type="note", title="Заголовок записи", summary="Краткая сводка", lang="ru",
        entities=dict(people=[], orgs=[], phones=[], amounts=[], dates=[], places=[]),
        proposed=dict(reminders=[], tasks=[], kp=False), topics=["аренда"], critical_numbers=[],
        sensitivity=[], verify_fields=[], confidence=0.9,
    )  # fmt: skip
    base.update(kw)
    return base


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
    r = await c.post("/v1/consents", json=_grant_body(*kinds), headers=h)
    assert r.status_code == 200, r.text
    return h


def _settings(**kw) -> Settings:
    base = dict(anthropic_api_key="", openai_api_key="", google_api_key="", groq_api_key="",
                ai_primary_provider="anthropic", ai_fallback_provider="openai",
                model_fast="claude-haiku-5-5", model_strong="claude-sonnet-5-5",
                ai_batch_flush_seconds=0, ai_batch_poll_seconds=0)  # fmt: skip
    base.update(kw)
    return Settings(_env_file=None, **base)


def _router(app, adapter: FakeAdapter, **kw) -> Router:
    settings = _settings(**kw)
    maker = app.state.ctx.sessionmaker
    return Router(settings=settings, routes=load_routes(settings), adapters={"anthropic": adapter},
                  store=PgAIStore(maker))  # fmt: skip


def _batch_router(app, adapter: FakeAdapter, **kw) -> Router:
    """Batches are off in routes.yaml. The mechanism stays, so it is tested with them on."""
    settings = _settings(**kw)
    raw = yaml.safe_load(DEFAULT_ROUTES_FILE.read_text(encoding="utf-8"))
    raw["tasks"]["enrich"]["batch"] = "bulk"
    return Router(settings=settings, routes=RouteTable(raw, settings),
                  adapters={"anthropic": adapter},
                  store=PgAIStore(app.state.ctx.sessionmaker))  # fmt: skip


def _deps(app, router=None, **kw) -> IngestDeps:
    return IngestDeps(storage=app.state.ctx.storage, router=router,
                      settings=router.s if router else None, **kw)  # fmt: skip


async def _drain(app, deps, limit: int = 40) -> None:
    maker = app.state.ctx.sessionmaker
    for _ in range(limit):
        if not await run_one(maker, deps):
            return
    raise AssertionError("the queue did not drain")


async def _note(c, h, body: str = LONG, **kw) -> dict:
    payload = {"client_id": str(uuid.uuid4()), "text": body, **kw}
    r = await c.post("/v1/items", json=payload, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["item"]


async def _get(c, h, public_id: str) -> dict:
    r = await c.get(f"/v1/items/{public_id}", headers=h)
    assert r.status_code == 200, r.text
    return r.json()


async def _row(s, public_id: str) -> Item:
    s.expire_all()
    item = await s.scalar(select(Item).where(Item.public_id == uuid.UUID(public_id)))
    assert item is not None
    return item


async def _upload(c, h, data: bytes, mime: str) -> str:
    body = {"mime": mime, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    up = (await c.post("/v1/uploads", json=body, headers=h)).json()
    url = up["put"]["url"].removeprefix("http://test")
    assert (await c.put(url, content=data, headers=up["put"]["headers"])).status_code == 200
    assert (await c.post(f"/v1/uploads/{up['id']}/complete", headers=h)).status_code == 200
    return up["id"]


# --- enrichment


async def test_note_is_enriched_and_labelled(db_app):
    app, _, s = db_app
    fake = FakeAdapter("anthropic", [envelope()])
    deps = _deps(app, _router(app, fake))
    async with client(app) as c:
        h = await _signed_in(c)
        item = await _note(c, h)
        assert item["enrich_state"] is None and item["ai_label"] is None
        await _drain(app, deps)
        got = await _get(c, h, item["id"])
    assert got["title"] == "Заголовок записи" and got["summary"] == "Краткая сводка"
    assert got["status"] == "ready" and got["enrich_state"] == "done"
    assert got["ai_fields"] == ["title", "summary"] and got["ai_generated"] is False
    assert got["ai_label"] == "Подготовил помощник (ИИ) по вашим записям — проверьте"
    assert fake.calls == 1
    req = fake.requests[0]
    assert req.model == "claude-haiku-5-5" and req.json_schema is not None
    assert "<untrusted_data>" in req.messages[0].text and "подробно" in req.messages[0].text
    assert "подробно" not in req.system
    usage = await s.scalar(select(ProviderUsage).where(ProviderUsage.task == "enrich"))
    assert usage.prompt_version == "enrich.v1" and usage.batch is False


async def test_nothing_goes_out_without_consent_then_it_catches_up(db_app):
    app, _, _ = db_app
    fake = FakeAdapter("anthropic", [envelope()])
    deps = _deps(app, _router(app, fake))
    async with client(app) as c:
        h = await _signed_in(c, BASE)
        item = await _note(c, h)
        await _drain(app, deps)
        got = await _get(c, h, item["id"])
        assert fake.calls == 0
        assert got["status"] == "ready" and got["enrich_state"] == "no_consent"
        assert got["text"] and got["summary"] is None  # usable in "Без ИИ" mode

        r = await c.post("/v1/consents", json=_grant_body(ConsentKind.AI_CROSS_BORDER), headers=h)
        assert r.status_code == 200
        await _drain(app, deps)
        got = await _get(c, h, item["id"])
    assert got["enrich_state"] == "done" and fake.calls == 1


async def test_consent_revoked_before_the_job_runs(db_app):
    app, _, s = db_app
    fake = FakeAdapter("anthropic", [envelope()])
    deps = _deps(app, _router(app, fake))
    async with client(app) as c:
        h = await _signed_in(c)
        item = await _note(c, h)
        assert (await c.delete("/v1/consents/ai_cross_border", headers=h)).status_code == 200
        await _drain(app, deps)
        got = await _get(c, h, item["id"])
    assert fake.calls == 0 and got["enrich_state"] == "no_consent"


async def test_low_confidence_escalates_once_short_text_does_not(db_app):
    app, _, s = db_app
    fake = FakeAdapter("anthropic", [envelope(confidence=0.3), envelope(confidence=0.8)])
    deps = _deps(app, _router(app, fake))
    async with client(app) as c:
        h = await _signed_in(c)
        item = await _note(c, h)
        await _drain(app, deps)
        row = await _row(s, item["id"])
        assert [r.model for r in fake.requests] == ["claude-haiku-5-5", "claude-sonnet-5-5"]
        assert row.envelope["escalated"] is True and row.envelope["confidence"] == 0.8

        fake.requests.clear()
        fake.steps = [envelope(confidence=0.2, title="Хлеб")]
        short = await _note(c, h, "Купить хлеб")
        await _drain(app, deps)
        row = await _row(s, short["id"])
    assert [r.model for r in fake.requests] == ["claude-haiku-5-5"]
    assert row.envelope["escalated"] is False


async def test_user_edits_win(db_app):
    app, _, s = db_app
    fake = FakeAdapter("anthropic", [envelope()])
    deps = _deps(app, _router(app, fake))
    async with client(app) as c:
        h = await _signed_in(c)
        titled = await _note(c, h, title="Моё название")
        await _drain(app, deps)
        got = await _get(c, h, titled["id"])
        assert got["title"] == "Моё название" and got["ai_fields"] == ["summary"]

        plain = await _note(c, h, LONG + " другая")
        await _drain(app, deps)
        r = await c.patch(f"/v1/items/{plain['id']}", json={"title": "Поправил"}, headers=h)
        assert r.json()["ai_fields"] == ["summary"]
        new_text = "Совсем другой текст записи, который человек написал сам. " * 2
        r = await c.patch(f"/v1/items/{plain['id']}", json={"text": new_text}, headers=h)
        assert r.json()["summary"] is None and r.json()["enrich_state"] == "pending"
        fake.steps = [envelope(summary="Новая сводка", title="Не то")]
        await _drain(app, deps)
        got = await _get(c, h, plain["id"])
    assert got["summary"] == "Новая сводка" and got["title"] == "Поправил"


async def test_answer_about_old_text_is_dropped(db_app):
    app, _, s = db_app
    router = _router(app, FakeAdapter("anthropic", [envelope()]))
    async with client(app) as c:
        h = await _signed_in(c)
        item = await _note(c, h)
        await _drain(app, _deps(app))  # ingest only: no router, enrich job waits
        row = await _row(s, item["id"])

        adapter = router.adapters["anthropic"]
        original = adapter.generate
        row_id = row.id

        async def generate(req):  # the person edits while the provider is thinking
            await s.execute(update(Item).where(Item.id == row_id).values(text="изменили текст"))
            await s.commit()
            return await original(req)

        adapter.generate = generate
        await run_enrich(app.state.ctx.sessionmaker, router, row_id, live=True)
        row = await _row(s, item["id"])
    assert row.summary is None and row.text == "изменили текст"


async def test_budget_stop_comes_back_tomorrow(db_app):
    app, _, s = db_app
    fake = FakeAdapter("anthropic", [envelope()])
    deps = _deps(app, _router(app, fake, budget_regular_background_daily_usd=0.0))
    async with client(app) as c:
        h = await _signed_in(c)
        await s.execute(text("UPDATE users SET profile = 'regular'"))
        await s.commit()
        item = await _note(c, h)
        await _drain(app, deps)
        got = await _get(c, h, item["id"])
    assert fake.calls == 0 and got["enrich_state"] == "deferred_budget" and got["status"] == "ready"
    job = await s.scalar(select(Job).where(Job.kind == "ai:enrich", Job.status == "queued"))
    assert job is not None and job.run_after > datetime.now(UTC)
    assert ":budget:" in job.idempotency_key


async def test_outage_retries_and_the_record_stays_usable(db_app):
    app, _, s = db_app
    fake = FakeAdapter("anthropic", [ServerError("http 503")])
    deps = _deps(app, _router(app, fake))
    async with client(app) as c:
        h = await _signed_in(c)
        item = await _note(c, h)
        await _drain(app, deps)
        got = await _get(c, h, item["id"])
    assert got["status"] == "ready" and got["enrich_state"] == "pending"
    job = await s.scalar(select(Job).where(Job.kind == "ai:enrich"))
    assert job.attempts == 1 and job.status == "queued" and job.run_after > datetime.now(UTC)


@pytest.mark.parametrize("make,mime", [
    (lambda: make_pdf(["Счёт на оплату офиса. " * 12]), "application/pdf"),
    (make_docx, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
])  # fmt: skip
async def test_documents_reach_enrichment(db_app, make, mime):
    app, _, s = db_app
    fake = FakeAdapter("anthropic", [envelope(type="document")])
    deps = _deps(app, _router(app, fake))
    async with client(app) as c:
        h = await _signed_in(c)
        upload = await _upload(c, h, make(), mime)
        r = await c.post("/v1/items", json={"client_id": str(uuid.uuid4()), "source": "files",
                                            "upload_id": upload}, headers=h)  # fmt: skip
        await _drain(app, deps)
        got = await _get(c, h, r.json()["item"]["id"])
    assert got["enrich_state"] == "done" and fake.calls == 1


# --- pages


async def test_enriched_record_lands_on_the_matching_page(db_app):
    """Rules that read the envelope: the text alone gives no match, the envelope does."""
    app, _, s = db_app
    fake = FakeAdapter("anthropic", [envelope(type="receipt", title="Чек")])
    deps = _deps(app, _router(app, fake))
    async with client(app) as c:
        h = await _signed_in(c)
        r = await c.post("/v1/pages", json={"client_id": str(uuid.uuid4()),
                                            "template_key": "expenses"}, headers=h)  # fmt: skip
        assert r.status_code == 201, r.text
        page = r.json()["page"]["id"]
        item = await _note(c, h)
        await _drain(app, _deps(app))
        r = await c.get(f"/v1/pages/{page}/items", headers=h)
        assert [e["item"]["id"] for e in r.json()["entries"]] == []

        await _drain(app, deps)
        r = await c.get(f"/v1/pages/{page}/items", headers=h)
    assert [e["item"]["id"] for e in r.json()["entries"]] == [item["id"]]


# --- links


async def test_link_gets_the_page_text_and_keeps_what_was_sent(db_app):
    app, _, s = db_app
    url = "https://example.com/statya"
    reader = FakeLinkReader(LinkContent(
        source="web", title="Статья о ремонте", text="Основной текст статьи.",
        description="Описание"))  # fmt: skip
    fake = FakeAdapter("anthropic", [envelope(title="Ремонт")])
    deps = _deps(app, _router(app, fake), links=reader)
    async with client(app) as c:
        h = await _signed_in(c)
        r = await c.post("/v1/items", json={"client_id": str(uuid.uuid4()), "source": "share",
                                            "url": url}, headers=h)  # fmt: skip
        assert r.status_code == 201, r.text
        item = r.json()["item"]
        hash_before = item["content_hash"]
        await _drain(app, _deps(app, links=reader))
        got = await _get(c, h, item["id"])
        assert reader.urls == [url] and got["status"] == "ready"
        assert got["text"].startswith(url) and "Основной текст статьи." in got["text"]
        assert got["title"] == "Статья о ремонте"
        assert got["source_meta"]["link"]["title"] == "Статья о ремонте"
        assert "text" not in got["source_meta"]["link"]
        assert got["content_hash"] == hash_before  # the same link again is still a repeat

        again = await c.post("/v1/items", json={"client_id": str(uuid.uuid4()), "source": "share",
                                                "url": url}, headers=h)  # fmt: skip
        assert again.json()["auto_merged"] is True

        await _drain(app, deps)
        got = await _get(c, h, item["id"])
    body = fake.requests[0].messages[0].text
    assert "<untrusted_data>" in body and "Основной текст статьи." in body
    assert got["title"] == "Ремонт"


async def test_dead_link_is_still_saved(db_app):
    app, _, s = db_app
    deps = _deps(app, links=FakeLinkReader(None))
    async with client(app) as c:
        h = await _signed_in(c)
        body = {"client_id": str(uuid.uuid4()), "source": "share",
                "url": "https://gone.example/x"}
        r = await c.post("/v1/items", json=body, headers=h)
        await _drain(app, deps)
        got = await _get(c, h, r.json()["item"]["id"])
    assert got["status"] == "ready" and got["text"] == "https://gone.example/x"
    assert got["source_meta"]["link"] == {"error": "unavailable"}


async def test_a_shared_bare_url_is_a_link(db_app):
    app, _, s = db_app
    reader = FakeLinkReader(LinkContent(source="web", title="Страница"))
    async with client(app) as c:
        h = await _signed_in(c)
        item = await _note(c, h, "https://example.com/page", kind="link")
        await _drain(app, _deps(app, links=reader))
        got = await _get(c, h, item["id"])
    assert reader.urls == ["https://example.com/page"] and got["title"] == "Страница"


# --- voice fragments


class Scripted(FakeTranscriber):
    """Each audio file has its own transcript."""

    def __init__(self, by_audio: dict[bytes, tuple[str, float]]) -> None:
        super().__init__()
        self.by_audio = by_audio

    async def transcribe(self, audio, *, mime, lang_hint):
        from assistant.records import Transcript

        text_, conf = self.by_audio[audio]
        return Transcript(text=text_, confidence=conf)


AUDIO = {
    b"frag-0": ("Первая часть записи про аренду офиса.", 0.95),
    b"frag-1": ("Вторая часть, платёж 125 000 тенге.", 0.95),
    b"frag-2": ("Третья часть совсем неразборчиво.", 0.4),
}


async def _fragment(c, h, recording: str, n: int, total: int, audio: bytes | None = None) -> dict:
    data = audio or f"frag-{n}".encode()
    upload = await _upload(c, h, data, "audio/mp4")
    body = {
        "client_id": recording if n == 0 else str(uuid.uuid4()), "source": "mic",
        "upload_id": upload, "occurred_at": "2026-11-07T06:00:00Z",
        "source_meta": {"recording_id": recording, "fragment": n, "fragments": total,
                        "duration_ms": 180000, "total_duration_ms": 360000,
                        "server_owned": "dropped"},
    }  # fmt: skip
    r = await c.post("/v1/items", json=body, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["item"]


async def _visible(c, h) -> list[dict]:
    return (await c.get("/v1/items", headers=h)).json()["items"]


async def test_fragments_make_one_record_in_any_order(db_app):
    app, _, s = db_app
    fake = FakeAdapter("anthropic", [envelope(title="Аренда офиса")])
    deps = _deps(app, _router(app, fake), transcriber=Scripted(AUDIO))
    recording = str(uuid.uuid4())
    async with client(app) as c:
        h = await _signed_in(c)
        # The second fragment arrives first.
        second = await _fragment(c, h, recording, 1, 2)
        assert second["hidden_reason"] == "voice_fragment"
        await _drain(app, deps)
        assert await _visible(c, h) == []

        first = await _fragment(c, h, recording, 0, 2)
        assert first["client_id"] == recording and first["hidden_reason"] is None
        assert "server_owned" not in first["source_meta"]
        await _drain(app, deps)

        shown = await _visible(c, h)
        assert [i["id"] for i in shown] == [first["id"]]
        got = shown[0]
        assert got["text"] == ("Первая часть записи про аренду офиса.\n\n"
                               "Вторая часть, платёж 125 000 тенге.")  # fmt: skip
        assert got["status"] == "needs_review" and got["enrich_state"] == "done"
        amounts = [v for v in got["review_fields"].values() if v["kind"] == "amount"]
        assert amounts[0]["value"] == "125 000 тенге"
        assert got["title"] == "Аренда офиса"

        synced = (await c.get("/v1/sync", headers=h)).json()
        assert [i["id"] for i in synced["items"]] == [first["id"]]

    assert fake.calls == 1  # the whole recording, once
    assert "Вторая часть" in fake.requests[0].messages[0].text
    record = await _row(s, first["id"])
    record_id, record_result = record.id, record.source_meta["fragment_result"]
    child = await _row(s, second["id"])
    assert child.canonical_item_id == record_id and child.text is None
    assert child.source_meta["fragment_result"]["text"] is None  # kept in one place only
    assert record_result["text"] is None
    # Originals are replaced by the text.
    states = {f.state for f in await s.scalars(
        select(File).where(File.item_id.in_([child.id, record_id])))}  # fmt: skip
    assert states == {"trash"}


async def test_partial_text_while_waiting_and_low_confidence_fragment(db_app):
    app, _, s = db_app
    fake = FakeAdapter("anthropic", [envelope()])
    deps = _deps(app, _router(app, fake), transcriber=Scripted(AUDIO))
    recording = str(uuid.uuid4())
    async with client(app) as c:
        h = await _signed_in(c)
        first = await _fragment(c, h, recording, 0, 2)
        await _drain(app, deps)
        got = await _get(c, h, first["id"])
        assert got["status"] == "processing" and got["text"].startswith("Первая часть")
        assert fake.calls == 0  # waits for the whole recording

        third = await _fragment(c, h, recording, 1, 2, audio=b"frag-2")
        await _drain(app, deps)
        got = await _get(c, h, first["id"])
        assert got["review_fields"]["transcript_2"]["value"].startswith("Третья часть")
        assert got["status"] == "needs_review"
        kept = await s.scalar(select(File).join(Item, Item.id == File.item_id).where(
            Item.public_id == uuid.UUID(third["id"])))  # fmt: skip
        assert kept.keep_reason == "low_confidence"
        kept_id = kept.id

        # «Верно» on the record releases the fragment's kept original too.
        r = await c.patch(f"/v1/items/{first['id']}", json={"verify": ["transcript_2"]}, headers=h)
        assert r.json()["status"] == "ready"
    s.expire_all()
    assert (await s.get(File, kept_id)).state == "trash"


async def test_missing_fragment_is_swept_and_a_late_one_rebuilds(db_app):
    app, _, s = db_app
    fake = FakeAdapter("anthropic", [envelope()])
    deps = _deps(app, _router(app, fake), transcriber=Scripted(AUDIO))
    recording = str(uuid.uuid4())
    maker = app.state.ctx.sessionmaker
    async with client(app) as c:
        h = await _signed_in(c)
        first = await _fragment(c, h, recording, 0, 2)
        await _drain(app, deps)
        sweep = await s.scalar(select(Job).where(Job.kind == "records:recording_sweep"))
        assert sweep.run_after > datetime.now(UTC) + timedelta(minutes=50)

        row = await _row(s, first["id"])
        async with maker() as w:
            await sweep_recording(w, row.user_id, uuid.UUID(recording), datetime.now(UTC))
            await w.commit()
        got = await _get(c, h, first["id"])
        assert got["status"] == "needs_review" and "missing_2" in got["review_fields"]
        await _drain(app, deps)
        assert fake.calls == 1  # not left without enrichment

        await _fragment(c, h, recording, 1, 2)
        await _drain(app, deps)
        got = await _get(c, h, first["id"])
    assert "missing_2" not in got["review_fields"] and "Вторая часть" in got["text"]
    assert fake.calls == 2


async def test_sweep_promotes_a_fragment_when_the_first_never_came(db_app):
    app, _, s = db_app
    deps = _deps(app, transcriber=Scripted(AUDIO))
    recording = str(uuid.uuid4())
    async with client(app) as c:
        h = await _signed_in(c)
        second = await _fragment(c, h, recording, 1, 2)
        await _drain(app, deps)
        row = await _row(s, second["id"])
        async with app.state.ctx.sessionmaker() as w:
            await sweep_recording(w, row.user_id, uuid.UUID(recording), datetime.now(UTC))
            await w.commit()
        shown = await _visible(c, h)
    assert [i["id"] for i in shown] == [second["id"]]
    assert "missing_1" in shown[0]["review_fields"]


async def test_late_fragment_does_not_overwrite_an_edit(db_app):
    app, _, s = db_app
    deps = _deps(app, transcriber=Scripted(AUDIO))
    recording = str(uuid.uuid4())
    async with client(app) as c:
        h = await _signed_in(c)
        first = await _fragment(c, h, recording, 0, 2)
        await _drain(app, deps)
        await c.patch(f"/v1/items/{first['id']}", json={"text": "Я сам переписал."}, headers=h)
        await _fragment(c, h, recording, 1, 2)
        await _drain(app, deps)
        got = await _get(c, h, first["id"])
    assert got["text"] == "Я сам переписал."
    assert got["review_fields"]["late_fragment_2"]["value"].startswith("Вторая часть")


async def test_trash_takes_the_fragments_along(db_app):
    app, _, s = db_app
    deps = _deps(app, transcriber=Scripted(AUDIO))
    recording = str(uuid.uuid4())
    async with client(app) as c:
        h = await _signed_in(c)
        first = await _fragment(c, h, recording, 0, 2)
        second = await _fragment(c, h, recording, 1, 2)
        await _drain(app, deps)
        assert (await c.delete(f"/v1/items/{first['id']}", headers=h)).status_code == 200
        trash = (await c.get("/v1/items/trash", headers=h)).json()["items"]
        assert [i["id"] for i in trash] == [first["id"]]
        assert (await _row(s, second["id"])).deleted_at is not None
        assert (await c.post(f"/v1/items/{first['id']}/restore", headers=h)).status_code == 200
        assert (await _row(s, second["id"])).deleted_at is None


async def test_voice_without_consent_waits_as_one_record(db_app):
    app, _, s = db_app
    fake = FakeAdapter("anthropic", [envelope()])
    transcriber = Scripted(AUDIO)
    deps = _deps(app, _router(app, fake), transcriber=transcriber)
    recording = str(uuid.uuid4())
    async with client(app) as c:
        h = await _signed_in(c, BASE)
        first = await _fragment(c, h, recording, 0, 2)
        await _fragment(c, h, recording, 1, 2)
        await _drain(app, deps)
        got = await _get(c, h, first["id"])
        assert got["status"] == "needs_consent" and transcriber.calls == 0 and fake.calls == 0
        await c.post("/v1/consents", json=_grant_body(ConsentKind.AI_CROSS_BORDER), headers=h)
        await _drain(app, deps)
        got = await _get(c, h, first["id"])
    assert got["text"].startswith("Первая часть") and "Вторая часть" in got["text"]
    assert fake.calls == 1


async def test_bad_or_foreign_source_meta(db_app):
    app, _, s = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        body = {"client_id": str(uuid.uuid4()), "text": "заметка", "source_meta": {
            "recording_id": str(uuid.uuid4()), "fragment": 1, "fragments": 2,
            "file_name": "a.txt"}}  # fmt: skip
        r = await c.post("/v1/items", json=body, headers=h)
        assert r.status_code == 201
        item = r.json()["item"]  # not voice: no recording link, not hidden
        assert item["hidden_reason"] is None and item["source_meta"] == {"file_name": "a.txt"}
        body = {"client_id": str(uuid.uuid4()), "text": "заметка", "source_meta": {
            "recording_id": str(uuid.uuid4()), "fragment": 5, "fragments": 2}}  # fmt: skip
        assert (await c.post("/v1/items", json=body, headers=h)).status_code == 422


# --- batches


def _batch_adapter(steps=None) -> FakeAdapter:
    return FakeAdapter("anthropic", steps or [envelope(title="Из пакета")], supports_batch=True,
                       usage=Usage(tokens_in=1_000_000, tokens_out=0))  # fmt: skip


async def _imported(c, h, s, body: str = LONG) -> dict:
    """The API takes no imports; the importer writes this source itself."""
    item = await _note(c, h, body)
    await s.execute(update(Item).where(Item.public_id == uuid.UUID(item["id"]))
                    .values(source="import_telegram"))  # fmt: skip
    await s.commit()
    return item


async def test_import_waits_for_a_batch_at_half_price(db_app):
    app, _, s = db_app
    fake = _batch_adapter()
    router = _batch_router(app, fake)
    deps = _deps(app, router)
    maker = app.state.ctx.sessionmaker
    async with client(app) as c:
        h = await _signed_in(c)
        item = await _imported(c, h, s)
        await _drain(app, deps)
        got = await _row(s, item["id"])
        assert got.enrich_state == "queued_batch" and got.status == "ready" and fake.calls == 0

        fake.batch_done = False
        assert await flush_batches(maker, router, router.s) == 1
        assert fake.calls == 0 and len(fake.batches) == 1
        sent = fake.batches["fakebatch-1"][0][1]
        assert sent.cache_ttl == "1h" and "<untrusted_data>" in sent.messages[0].text
        assert await poll_batches(maker, router, router.s) == 0  # still running

        fake.batch_done = True
        assert await poll_batches(maker, router, router.s) == 1
        row = await _row(s, item["id"])
    assert row.enrich_state == "done" and row.title == "Из пакета"
    assert row.envelope["escalated"] is False
    usage = await s.scalar(select(ProviderUsage).where(ProviderUsage.batch.is_(True)))
    assert usage.cost_usd == Decimal("0.050000")  # Haiku $0.10 per 1M, half
    req = await s.scalar(select(AIBatchRequest).where(AIBatchRequest.item_id == row.id))
    assert req.state == "done" and len(req.payload_sha256) == 64
    batch = await s.get(AIBatch, req.batch_id)
    assert batch.status == "ended" and batch.provider_batch_id == "fakebatch-1"


async def test_live_capture_never_waits_for_a_batch(db_app):
    app, _, s = db_app
    fake = _batch_adapter()
    deps = _deps(app, _batch_router(app, fake))
    async with client(app) as c:
        h = await _signed_in(c)
        item = await _note(c, h, source="typed")
        await _drain(app, deps)
        got = await _get(c, h, item["id"])
    assert got["enrich_state"] == "done" and fake.calls == 1 and not fake.batches


async def test_opening_a_waiting_record_pulls_it_out(db_app):
    app, _, s = db_app
    fake = _batch_adapter([envelope(title="Сейчас")])
    router = _batch_router(app, fake)
    deps = _deps(app, router)
    maker = app.state.ctx.sessionmaker
    async with client(app) as c:
        h = await _signed_in(c)
        item = await _imported(c, h, s)
        await _drain(app, deps)
        await flush_batches(maker, router, router.s)  # already at the provider

        opened = await _get(c, h, item["id"])
        assert opened["enrich_state"] == "pending"
        await _drain(app, deps)
        got = await _get(c, h, item["id"])
        assert got["title"] == "Сейчас" and got["enrich_state"] == "done" and fake.calls == 1

        # The batch answer arrives later: charged, not applied.
        fake.steps = [envelope(title="Поздно")]
        assert await poll_batches(maker, router, router.s) == 1
        got = await _get(c, h, item["id"])
    assert got["title"] == "Сейчас"
    paid = list(await s.scalars(select(ProviderUsage).where(ProviderUsage.batch.is_(True))))
    assert len(paid) == 1 and paid[0].cost_usd > 0


async def test_failed_batch_answers_run_live(db_app):
    app, _, s = db_app
    fake = _batch_adapter([envelope(title="Живой")])
    router = _batch_router(app, fake)
    deps = _deps(app, router)
    maker = app.state.ctx.sessionmaker
    async with client(app) as c:
        h = await _signed_in(c)
        item = await _imported(c, h, s)
        await _drain(app, deps)
        await flush_batches(maker, router, router.s)
        req = await s.scalar(select(AIBatchRequest))
        req_id = req.id
        custom = f"r{req_id}"
        fake.overrides[custom] = BatchEntry(custom, error=ServerError("expired"))
        assert await poll_batches(maker, router, router.s) == 1
        s.expire_all()
        assert (await s.get(AIBatchRequest, req_id)).state == "failed"
        fake.overrides.clear()
        await _drain(app, deps)
        row = await _row(s, item["id"])
    assert row.title == "Живой" and row.enrich_state == "done"
    assert fake.calls == 1  # live, no second batch


async def test_invalid_batch_answer_runs_live(db_app):
    app, _, s = db_app
    fake = _batch_adapter(["not json"])
    router = _batch_router(app, fake)
    deps = _deps(app, router)
    maker = app.state.ctx.sessionmaker
    async with client(app) as c:
        h = await _signed_in(c)
        item = await _imported(c, h, s)
        await _drain(app, deps)
        await flush_batches(maker, router, router.s)
        await poll_batches(maker, router, router.s)
        fake.steps = [envelope(title="Живой")]
        await _drain(app, deps)
        row = await _row(s, item["id"])
    assert row.title == "Живой"


async def test_batch_past_its_deadline_is_cancelled(db_app):
    app, _, s = db_app
    fake = _batch_adapter()
    router = _batch_router(app, fake)
    deps = _deps(app, router)
    maker = app.state.ctx.sessionmaker
    async with client(app) as c:
        h = await _signed_in(c)
        await _imported(c, h, s)
        await _drain(app, deps)
        await flush_batches(maker, router, router.s)
        await s.execute(update(AIBatch).values(
            deadline_at=datetime.now(UTC) - timedelta(minutes=1)))  # fmt: skip
        await s.commit()
        fake.batch_done = False
        await poll_batches(maker, router, router.s)
    assert fake.cancelled == ["fakebatch-1"]
    s.expire_all()
    assert (await s.scalar(select(AIBatch))).status == "canceling"


async def test_consent_revoked_while_batch_ran_drops_the_answer(db_app):
    app, _, s = db_app
    fake = _batch_adapter()
    router = _batch_router(app, fake)
    deps = _deps(app, router)
    maker = app.state.ctx.sessionmaker
    async with client(app) as c:
        h = await _signed_in(c)
        item = await _imported(c, h, s)
        await _drain(app, deps)
        await flush_batches(maker, router, router.s)
        await c.delete("/v1/consents/ai_cross_border", headers=h)
        await poll_batches(maker, router, router.s)
        row = await _row(s, item["id"])
    assert row.enrich_state == "no_consent" and row.summary is None


async def test_no_consent_at_sending_means_nothing_is_sent(db_app):
    app, _, s = db_app
    fake = _batch_adapter()
    router = _batch_router(app, fake)
    deps = _deps(app, router)
    maker = app.state.ctx.sessionmaker
    async with client(app) as c:
        h = await _signed_in(c)
        item = await _imported(c, h, s)
        await _drain(app, deps)
        await c.delete("/v1/consents/ai_cross_border", headers=h)
        assert await flush_batches(maker, router, router.s) == 0
        row = await _row(s, item["id"])
    assert not fake.batches and row.enrich_state == "no_consent"


async def test_batch_without_support_falls_back_to_live(db_app):
    app, _, s = db_app
    fake = FakeAdapter("anthropic", [envelope(title="Живой")], supports_batch=False)
    deps = _deps(app, _batch_router(app, fake))
    async with client(app) as c:
        h = await _signed_in(c)
        item = await _imported(c, h, s)
        await _drain(app, deps)
        row = await _row(s, item["id"])
    assert row.title == "Живой" and fake.calls == 1


async def test_flush_waits_for_more_unless_old_enough(db_app):
    app, _, s = db_app
    fake = _batch_adapter()
    router = _batch_router(app, fake, ai_batch_flush_seconds=3600, ai_batch_flush_min_requests=2)
    deps = _deps(app, router)
    maker = app.state.ctx.sessionmaker
    async with client(app) as c:
        h = await _signed_in(c)
        await _imported(c, h, s)
        await _drain(app, deps)
        assert await flush_batches(maker, router, router.s) == 0
        await _imported(c, h, s, LONG + " вторая")
        await _drain(app, deps)
        assert await flush_batches(maker, router, router.s) == 2


async def test_a_users_next_records_wait_for_the_running_batch(db_app):
    app, _, s = db_app
    fake = _batch_adapter()
    router = _batch_router(app, fake, ai_batch_user_requests=1)
    deps = _deps(app, router)
    maker = app.state.ctx.sessionmaker
    async with client(app) as c:
        h = await _signed_in(c)
        await _imported(c, h, s)
        await _imported(c, h, s, LONG + " вторая")
        await _drain(app, deps)
        assert await flush_batches(maker, router, router.s) == 1
        assert await flush_batches(maker, router, router.s) == 0  # its costs are not known yet
        assert await poll_batches(maker, router, router.s) == 1
        assert await flush_batches(maker, router, router.s) == 1


async def test_deleted_record_batch_answer_is_still_accounted(db_app):
    app, _, s = db_app
    fake = _batch_adapter()
    router = _batch_router(app, fake)
    deps = _deps(app, router)
    maker = app.state.ctx.sessionmaker
    async with client(app) as c:
        h = await _signed_in(c)
        item = await _imported(c, h, s)
        await _drain(app, deps)
        await flush_batches(maker, router, router.s)
        await s.execute(text("DELETE FROM items WHERE public_id = :p"), {"p": item["id"]})
        await s.commit()
        assert await poll_batches(maker, router, router.s) == 1
    rows = list(await s.scalars(select(ProviderUsage).where(ProviderUsage.batch.is_(True))))
    assert len(rows) == 1 and rows[0].user_id is None and rows[0].cost_usd > 0


async def test_as_shipped_an_import_runs_live_and_nothing_goes_to_a_batch(db_app):
    app, _, s = db_app
    fake = _batch_adapter([envelope(title="Живой")])
    deps = _deps(app, _router(app, fake))
    async with client(app) as c:
        h = await _signed_in(c)
        item = await _imported(c, h, s)
        await _drain(app, deps)
        row = await _row(s, item["id"])
    assert row.title == "Живой" and row.enrich_state == "done"
    assert fake.calls == 1 and not fake.batches
    assert await s.scalar(select(AIBatchRequest.id)) is None


async def test_turning_batches_off_sends_what_was_waiting_live(db_app):
    app, _, s = db_app
    fake = _batch_adapter([envelope(title="Живой")])
    parked = _deps(app, _batch_router(app, fake))
    async with client(app) as c:
        h = await _signed_in(c)
        item = await _imported(c, h, s)
        await _drain(app, parked)
        assert (await _row(s, item["id"])).enrich_state == "queued_batch"

        shipped = _router(app, fake)
        assert await flush_batches(app.state.ctx.sessionmaker, shipped, shipped.s) == 0
        await _drain(app, _deps(app, shipped))
        row = await _row(s, item["id"])
    assert row.title == "Живой" and fake.calls == 1 and not fake.batches


# --- «Исправить»

RECEIPT = "Итого 389 990 ₸, звонить +7 701 123 45 67, ещё 1 500 ₸"


async def _receipt(app, c, h, fake: FakeAdapter) -> dict:
    deps = _deps(app, _router(app, fake), ocr=FakeOcr(RECEIPT, 0.95))
    upload = await _upload(c, h, b"receipt-photo", "image/png")
    body = {"client_id": str(uuid.uuid4()), "upload_id": upload, "source": "camera"}
    r = await c.post("/v1/items", json=body, headers=h)
    assert r.status_code == 201, r.text
    await _drain(app, deps)
    return await _get(c, h, r.json()["item"]["id"])


async def test_correcting_a_field(db_app):
    app, _, s = db_app
    amounts = dict(people=[], orgs=[], phones=[], dates=[], places=[], amounts=["389 990 ₸"])
    fake = FakeAdapter("anthropic", [envelope(entities=amounts, title="Чек")])
    async with client(app) as c:
        h = await _signed_in(c)
        item = await _receipt(app, c, h, fake)
        url = f"/v1/items/{item['id']}"
        assert item["status"] == "needs_review"
        assert item["review_fields"]["amount_1"]["value"] == "389 990 ₸"
        fix = {"corrections": {"amount_1": "389 900 ₸"}}

        no_base = await c.patch(url, json=fix, headers=h)
        assert no_base.status_code == 422 and no_base.json()["code"] == "validation_error"
        stale = await c.patch(url, json={**fix, "base_seq": item["seq"] - 1}, headers=h)
        assert stale.status_code == 409 and stale.json()["details"]["seq"] == item["seq"]
        empty = {"corrections": {"amount_1": "  "}, "base_seq": item["seq"]}
        blank = await c.patch(url, json=empty, headers=h)
        assert blank.status_code == 422
        unknown = await c.patch(url, json={"corrections": {"nope": "1"}, "base_seq": item["seq"]},
                                headers=h)  # fmt: skip
        assert unknown.status_code == 422 and unknown.json()["code"] == "review_field_unknown"

        r = await c.patch(url, json={**fix, "base_seq": item["seq"]}, headers=h)
        assert r.status_code == 200, r.text
        out = r.json()
        assert out["review_fields"]["amount_1"] == {
            "kind": "amount", "value": "389 900 ₸", "state": "verified"}  # fmt: skip
        assert out["review_fields"]["phone_1"]["state"] == "unverified"
        assert out["status"] == "needs_review" and out["seq"] > item["seq"]
        # Search and answers read the text, and only the whole number is touched.
        assert "389 900 ₸" in out["text"] and "389 990" not in out["text"]
        assert "1 500 ₸" in out["text"] and out["content_hash"] != item["content_hash"]
        row = await _row(s, item["id"])
        assert row.envelope["entities"]["amounts"][0]["value"] == "389900"

        changes = (await c.get(f"/v1/sync?since={item['seq']}", headers=h)).json()
        assert [i["id"] for i in changes["items"]] == [item["id"]]
        assert changes["items"][0]["review_fields"]["amount_1"]["value"] == "389 900 ₸"

        # The answer got lost: the phone sends the same thing again.
        again = await c.patch(url, json={**fix, "base_seq": item["seq"]}, headers=h)
        assert again.status_code == 200 and again.json()["seq"] == out["seq"]

        # The text changed, so it is read again: the person's number is no reason to doubt it.
        fake.steps = [envelope(
            entities={**amounts, "amounts": ["389 900 ₸"]}, title="Чек на 389 900 ₸",
            critical_numbers=["389 900"])]  # fmt: skip
        await _drain(app, _deps(app, _router(app, fake), ocr=FakeOcr(RECEIPT, 0.95)))
        got = await _get(c, h, item["id"])
        assert got["title"] == "Чек на 389 900 ₸"
        assert got["review_fields"]["amount_1"]["value"] == "389 900 ₸"
        open_fields = [k for k, v in got["review_fields"].items() if v["state"] != "verified"]
        assert sorted(open_fields) == ["amount_2", "phone_1"]

        # Everything settled: the record is done. The value needs no source, or even a format.
        done = await c.patch(url, json={"corrections": {"phone_1": "не помню"},
                                        "verify": ["amount_2"], "base_seq": got["seq"]},
                             headers=h)  # fmt: skip
        assert done.status_code == 200 and done.json()["status"] == "ready"

        await c.delete(url, headers=h)
        seq = (await _get(c, h, item["id"]))["seq"]
        trashed = await c.patch(url, json={"corrections": {"amount_1": "1"}, "base_seq": seq},
                                headers=h)  # fmt: skip
        assert trashed.status_code == 409 and trashed.json()["code"] == "item_deleted"


async def test_a_late_fragment_does_not_undo_a_correction(db_app):
    app, _, _ = db_app
    audio = {b"frag-0": ("Первая часть, платёж 125 000 тенге.", 0.95),
             b"frag-1": ("Вторая часть без чисел.", 0.95)}  # fmt: skip
    deps = _deps(app, transcriber=Scripted(audio))
    recording = str(uuid.uuid4())
    async with client(app) as c:
        h = await _signed_in(c)
        first = await _fragment(c, h, recording, 0, 1)
        await _drain(app, deps)
        got = await _get(c, h, first["id"])
        assert got["review_fields"]["amount_1"]["value"] == "125 000 тенге"
        r = await c.patch(f"/v1/items/{first['id']}",
                          json={"corrections": {"amount_1": "126 000 тенге"},
                                "base_seq": got["seq"]}, headers=h)  # fmt: skip
        assert r.status_code == 200, r.text
        await _fragment(c, h, recording, 1, 2)
        await _drain(app, deps)
        got = await _get(c, h, first["id"])
    assert got["text"] == "Первая часть, платёж 126 000 тенге."
    field = got["review_fields"]["amount_1"]
    assert (field["value"], field["state"]) == ("126 000 тенге", "verified")
    assert got["review_fields"]["late_fragment_2"]["state"] == "unverified"


async def test_a_passage_is_fixed_in_the_text_not_as_a_value(db_app):
    app, _, s = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        item = await _note(c, h, "Неразборчиво")
        row = await _row(s, item["id"])
        row.review_fields = {"transcript": {"kind": "transcript", "value": None,
                                            "state": "unverified"}}  # fmt: skip
        await s.commit()
        got = await _get(c, h, item["id"])
        r = await c.patch(f"/v1/items/{item['id']}",
                          json={"corrections": {"transcript": "текст"}, "base_seq": got["seq"]},
                          headers=h)  # fmt: skip
    assert r.status_code == 422 and r.json()["code"] == "review_field_not_editable"


async def test_second_account_gets_no_ai_until_its_own_consent(db_app):
    """Signing in to a phone's account from an account with every consent copies nothing."""
    app, sms, s = db_app
    phone = "+77015550077"
    fake = FakeAdapter("anthropic", [envelope(title="Разобрал")])
    router = _router(app, fake)
    deps = _deps(app, router, transcriber=Scripted(AUDIO))

    async def otp(c, headers=None) -> dict:
        req = await c.post("/v1/auth/otp/request", json={"phone": phone}, headers=headers)
        assert req.status_code == 200, req.text
        r = await c.post("/v1/auth/otp/verify", headers=headers, json={
            "challenge_id": req.json()["challenge_id"], "phone": phone,
            "code": sms.last_code_for(phone)})  # fmt: skip
        assert r.status_code == 200, r.text
        return r.json()

    async with client(app) as c:
        second = await otp(c)  # a phone account, never asked for consent
        assert second["app_enabled"] is False and second["ai_enabled"] is False
        h_first = await _signed_in(c)
        pair = await otp(c, h_first)
        assert pair["account_switched"] is True and pair["user"]["id"] == second["user"]["id"]
        assert pair["app_enabled"] is False and pair["ai_enabled"] is False
        assert pair["user"]["is_anonymous"] is False
        h = {"Authorization": f"Bearer {pair['access_token']}"}

        assert (await c.get("/v1/consents", headers=h)).json()["active"] == []
        blocked = await c.post("/v1/items", json={"client_id": str(uuid.uuid4()), "text": LONG},
                               headers=h)  # fmt: skip
        assert blocked.status_code == 403 and blocked.json()["code"] == "consent_required"

        r = await c.post("/v1/consents", json=_grant_body(*BASE), headers=h)
        assert r.json()["app_enabled"] is True and r.json()["ai_enabled"] is False
        note = await _note(c, h)
        voice = await _fragment(c, h, str(uuid.uuid4()), 0, 1)
        await _drain(app, deps)
        row = await _row(s, note["id"])
        assert row.enrich_state == "no_consent"
        maker = app.state.ctx.sessionmaker
        assert await run_enrich(maker, router, row.id, live=True) == "no_consent"
        assert (await _get(c, h, voice["id"]))["status"] == "needs_consent"
        assert fake.calls == 0

        r = await c.post("/v1/consents", json=_grant_body(ConsentKind.AI_CROSS_BORDER), headers=h)
        assert r.json()["ai_enabled"] is True
        await _drain(app, deps)
        assert (await _row(s, note["id"])).title == "Разобрал"
        assert fake.calls >= 1
