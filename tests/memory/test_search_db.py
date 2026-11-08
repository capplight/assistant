"""Search, chunks, purge, page summaries against a real Postgres migrated to head.

Skipped unless DATABASE_URL is set. The embedder is fake: this proves the plumbing and the filters,
not the quality of bge-m3.
"""

import os
import secrets
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import delete, func, select, text, update
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from assistant.api import consent_texts
from assistant.api.app import create_app
from assistant.api.sms import FakeSmsSender
from assistant.db import queue
from assistant.db.models import Item, Job, JobStatus
from assistant.db.models_pages import Screen, ScreenItem
from assistant.db.models_search import Chunk, ScreenSummary
from assistant.db.models_v2 import ConsentKind, File, HiddenReason, RecordStatus, SyncTombstone
from assistant.embeddings import FakeEmbedder
from assistant.memory import enqueue_embed, enqueue_missing, purge_files, run_embed
from assistant.memory.embed_jobs import JOB_EMBED, embed_key
from assistant.memory.fold import fold, translit
from assistant.memory.summaries import rebuild_summaries
from assistant.memory.worker import run_one
from assistant.records import enrich, purge_trashed_items, voice
from assistant.records.ingest import IngestDeps, run_ingest
from assistant.records.worker import purge_once
from tests.api.conftest import client, make_settings, make_storage

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set"),
]

BASE = (ConsentKind.PD_PROCESSING, ConsentKind.TERMS)


@pytest.fixture
async def env(tmp_path: Path):
    """App on a real Postgres in one transaction, rolled back. A fake embedder, no network."""
    engine = create_async_engine(os.environ["DATABASE_URL"])
    embedder = FakeEmbedder(same_meaning={"туфли": "обувь", "ботинки": "обувь"})
    async with engine.connect() as conn:
        trans = await conn.begin()
        maker = async_sessionmaker(bind=conn, expire_on_commit=False,
                                   join_transaction_mode="create_savepoint")  # fmt: skip
        storage = make_storage(tmp_path)
        app = create_app(make_settings(search_vector_min_similarity=0.5), sessionmaker=maker,
                         sms=FakeSmsSender(), storage=storage, embedder=embedder)  # fmt: skip
        async with maker() as s:
            await s.execute(text("DELETE FROM jobs"))
            await s.commit()
        try:
            yield app, maker, embedder, storage
        finally:
            await trans.rollback()
    await engine.dispose()


async def _signed_in(c) -> dict[str, str]:
    r = await c.post("/v1/auth/anonymous", json={"device_key": secrets.token_urlsafe(32)})
    assert r.status_code == 200, r.text
    h = {"Authorization": f"Bearer {r.json()['access_token']}"}
    items = []
    for kind in BASE:
        t = consent_texts.current(kind, "ru")
        assert t is not None
        items.append({"kind": kind, "version": t.version, "text_hash": t.text_hash, "locale": "ru"})
    body = {"consents": items, "screen": "S05", "age_confirmed_18": True}
    r = await c.post("/v1/consents", json=body, headers=h)
    assert r.status_code == 200, r.text
    return h


async def _ready(c, h, maker, body: str, **kw) -> str:
    """A note through the real path: POST, then ingest."""
    r = await c.post("/v1/items", json={"client_id": str(uuid.uuid4()), "text": body, **kw},
                     headers=h)  # fmt: skip
    assert r.status_code == 201, r.text
    item_id = r.json()["item"]["id"]
    await run_ingest(maker, await _internal(maker, item_id), IngestDeps(storage=None))  # type: ignore[arg-type]
    return item_id


async def _internal(maker, public_id: str) -> int:
    async with maker() as s:
        return await s.scalar(select(Item.id).where(Item.public_id == uuid.UUID(public_id)))


async def _embed_all(maker, embedder) -> None:
    while await run_one(maker, embedder):
        pass


async def _find(c, h, q: str, **params) -> dict:
    r = await c.get("/v1/search", params={"q": q, **params}, headers=h)
    assert r.status_code == 200, r.text
    return r.json()


async def _ids(c, h, q: str, **params) -> list[str]:
    return [hit["item_id"] for hit in (await _find(c, h, q, **params))["results"]]


async def test_sql_folding_matches_python(env):
    _, maker, _, _ = env
    sample = "ҚАЛА Өнер ІС ЁЛКА Ұлы әғң үһ ABC xyz ЯЩЪЬ день Kaspi 123 №"
    async with maker() as s:
        row = (await s.execute(text("SELECT search_fold(:t), search_translit(:t)"),
                               {"t": sample})).one()  # fmt: skip
    assert row[0] == fold(sample)
    assert row[1] == translit(sample)


async def test_migration_objects(env):
    _, maker, _, _ = env
    async with maker() as s:
        names = set(await s.scalars(text(
            "SELECT indexname FROM pg_indexes WHERE tablename IN ('items', 'chunks')"
        )))  # fmt: skip
        ext = set(await s.scalars(text("SELECT extname FROM pg_extension")))
    assert {"pg_trgm", "vector"} <= ext
    assert {"ix_items_tsv_simple", "ix_items_tsv_ru", "ix_items_tsv_spelled",
            "ix_items_title_trgm", "ix_chunks_embedding_bge_m3"} <= names  # fmt: skip


# --- search ---


async def test_needs_base_consent(env):
    app, *_ = env
    async with client(app) as c:
        r = await c.post("/v1/auth/anonymous", json={"device_key": secrets.token_urlsafe(32)})
        h = {"Authorization": f"Bearer {r.json()['access_token']}"}
        assert (await c.get("/v1/search?q=x", headers=h)).status_code == 403
        assert (await c.get("/v1/search?q=x")).status_code == 401


async def test_word_forms_case_prefix_and_response_shape(env):
    app, maker, *_ = env
    async with client(app) as c:
        h = await _signed_in(c)
        milk = await _ready(c, h, maker, "Купить молоко и хлеб маме")
        await _ready(c, h, maker, "Записаться к стоматологу")
        out = await _find(c, h, "МОЛОКОМ")
        assert [x["item_id"] for x in out["results"]] == [milk]
        hit = out["results"][0]
        assert hit["kind"] == "note" and hit["status"] == "ready"
        assert "words" in hit["matched_by"]
        start, end = hit["highlights"][0]
        assert hit["snippet"][start:end] == "молоко"
        assert [p["title"] for p in hit["pages"]] == ["Заметки"] or hit["pages"] == []
        assert await _ids(c, h, "стомат") != []  # a word's beginning


@pytest.mark.parametrize("typo", ["молако", "малоко", "молоко", "молокоо", "малако"])
async def test_russian_typos(env, typo):
    app, maker, *_ = env
    async with client(app) as c:
        h = await _signed_in(c)
        milk = await _ready(c, h, maker, "Купить молоко и хлеб маме")
        await _ready(c, h, maker, "Записаться к стоматологу на вторник")
        assert await _ids(c, h, typo) == [milk]


async def test_a_typo_nothing_is_spelled_like_goes_to_the_vocabulary(env):
    app, maker, *_ = env
    async with client(app) as c:
        h = await _signed_in(c)
        phone = await _ready(c, h, maker, "Новый телефон сына")
        await _ready(c, h, maker, "Купить хлеб")
        assert await _ids(c, h, "телефн") == [phone]  # a letter missing
        assert await _ids(c, h, "телефоон") == [phone]  # a letter too many
        assert await _ids(c, h, "хлеп") != [phone]


async def test_a_word_that_exists_is_not_treated_as_a_typo(env):
    app, maker, *_ = env
    async with client(app) as c:
        h = await _signed_in(c)
        house = await _ready(c, h, maker, "Ремонт дом")
        await _ready(c, h, maker, "Подарок для дам")  # spelled alike, but the word is really here
        assert await _ids(c, h, "дом") == [house]


async def test_deleted_words_dont_come_back_as_suggestions(env):
    app, maker, *_ = env
    async with client(app) as c:
        h = await _signed_in(c)
        gone = await _ready(c, h, maker, "Телефон сына")
        await c.delete(f"/v1/items/{gone}", headers=h)
        assert (await _find(c, h, "телефн"))["results"] == []


async def test_typo_is_said_to_be_a_typo(env):
    app, maker, *_ = env
    async with client(app) as c:
        h = await _signed_in(c)
        await _ready(c, h, maker, "Купить молоко и хлеб маме")
        hit = (await _find(c, h, "молако"))["results"][0]
        assert hit["matched_by"] == ["typo"]
        start, end = hit["highlights"][0]
        assert hit["snippet"][start:end] == "молоко"


async def test_kazakh_letters_typed_as_russian_and_suffixes(env):
    app, maker, *_ = env
    async with client(app) as c:
        h = await _signed_in(c)
        city = await _ready(c, h, maker, "Алматы қаласында кездесу өтеді")
        await _ready(c, h, maker, "Купить хлеб")
        assert await _ids(c, h, "қала") == [city]  # suffix: қаласында
        assert await _ids(c, h, "каласында") == [city]  # Russian letters
        assert await _ids(c, h, "ҚАЛАСЫНДА") == [city]
        assert await _ids(c, h, "отеди") == [city]
        assert await _ids(c, h, "кездесуу") == [city]  # and a typo


async def test_latin_and_cyrillic_spelling(env):
    app, maker, *_ = env
    async with client(app) as c:
        h = await _signed_in(c)
        kaspi = await _ready(c, h, maker, "Перевод через Каспи на 5000 тенге")
        assert await _ids(c, h, "kaspi") == [kaspi]


async def test_nothing_found_means_nothing(env):
    app, maker, *_ = env
    async with client(app) as c:
        h = await _signed_in(c)
        await _ready(c, h, maker, "Купить молоко и хлеб маме")
        await _ready(c, h, maker, "Записаться к стоматологу на вторник")
        await _embed_all(maker, app.state.ctx.embedder)
        assert (await _find(c, h, "абырвалг"))["results"] == []
        assert (await _find(c, h, "!!!"))["results"] == []
        r = await c.get("/v1/search?q=", headers=h)
        assert r.status_code == 422


async def test_whole_question_finds_a_note_with_some_of_the_words(env):
    app, maker, *_ = env
    async with client(app) as c:
        h = await _signed_in(c)
        note = await _ready(c, h, maker, "Размер обуви сына: 34")
        await _ready(c, h, maker, "Купить молоко")
        assert (await _ids(c, h, "куда я записала размер обуви сына"))[0] == note


async def test_ranks_more_words_first(env):
    app, maker, *_ = env
    async with client(app) as c:
        h = await _signed_in(c)
        one = await _ready(c, h, maker, "Договор на аренду")
        both = await _ready(c, h, maker, "Договор аренды квартиры в Алматы")
        ids = await _ids(c, h, "договор квартиры")
        assert ids[0] == both and one in ids


async def test_another_persons_records_are_never_found(env):
    app, maker, *_ = env
    async with client(app) as c:
        a, b = await _signed_in(c), await _signed_in(c)
        await _ready(c, a, maker, "Секретный код от сейфа")
        await _embed_all(maker, app.state.ctx.embedder)
        assert await _ids(c, a, "сейфа") != []
        out = await _find(c, b, "сейфа")
        assert out["results"] == [] and out["semantic"] is True


async def test_trashed_merged_and_fragments_are_not_found(env):
    app, maker, embedder, _ = env
    async with client(app) as c:
        h = await _signed_in(c)
        gone = await _ready(c, h, maker, "Удалённая заметка про рецепт плова")
        kept = await _ready(c, h, maker, "Записка про рецепт борща")
        twin = await _ready(c, h, maker, "Записка про рецепт борща")  # an exact repeat
        fragment = await _ready(c, h, maker, "Скрытый фрагмент про рецепт манты")
        async with maker() as s:
            await s.execute(update(Item).where(Item.public_id == uuid.UUID(fragment))
                            .values(hidden_reason=HiddenReason.VOICE_FRAGMENT))  # fmt: skip
            await s.commit()
        await _embed_all(maker, embedder)

        assert (await c.delete(f"/v1/items/{gone}", headers=h)).status_code == 200
        ids = await _ids(c, h, "рецепт")
        assert ids == [kept]
        assert twin not in ids and gone not in ids and fragment not in ids
        for word in ("плова", "манты"):
            assert await _ids(c, h, word) == []

        # Back from the trash, found again with no work: its chunks waited.
        await c.post(f"/v1/items/{gone}/restore", headers=h)
        assert gone in await _ids(c, h, "плова")
        assert await _chunks(maker, await _internal(maker, gone)) != []


async def test_page_filter_and_taken_off_a_page(env):
    app, maker, *_ = env
    async with client(app) as c:
        h = await _signed_in(c)
        r = await c.post("/v1/pages", json={"client_id": str(uuid.uuid4()),
                                            "template_key": "custom"}, headers=h)  # fmt: skip
        page = r.json()["page"]["id"]
        on = await _ready(c, h, maker, "Лекарства маме на этой странице")
        off = await _ready(c, h, maker, "Лекарства папе не на странице")
        r = await c.post(f"/v1/pages/{page}/items", json={"item_id": on}, headers=h)
        assert r.status_code == 201
        assert set(await _ids(c, h, "лекарства")) == {on, off}
        assert await _ids(c, h, "лекарства", page_id=page) == [on]
        hit = (await _find(c, h, "лекарства", page_id=page))["results"][0]
        assert page in [p["id"] for p in hit["pages"]]
        unknown = await c.get(f"/v1/search?q=x&page_id={uuid.uuid4()}", headers=h)
        assert unknown.status_code == 404

        async with maker() as s:
            await s.execute(
                update(ScreenItem)
                .where(ScreenItem.item_id == await _internal(maker, on),
                       ScreenItem.screen_id == await s.scalar(
                           select(Screen.id).where(Screen.public_id == uuid.UUID(page))))
                .values(removed_by_user_at=datetime.now(UTC))
            )  # fmt: skip
            await s.commit()
        assert await _ids(c, h, "лекарства", page_id=page) == []
        assert on in await _ids(c, h, "лекарства")  # the page is a view: the record stays

        other = await _signed_in(c)  # another person's page is no page at all
        assert (await c.get(f"/v1/search?q=x&page_id={page}", headers=other)).status_code == 404


async def test_kind_and_dates(env):
    app, maker, *_ = env
    async with client(app) as c:
        h = await _signed_in(c)
        old = await _ready(c, h, maker, "Счёт за март", occurred_at="2026-03-01T00:00:00Z")
        new = await _ready(c, h, maker, "Счёт за октябрь", occurred_at="2026-10-01T00:00:00Z")
        assert await _ids(c, h, "счёт", kind="pdf") == []
        assert set(await _ids(c, h, "счет", kind="note")) == {old, new}
        assert await _ids(c, h, "счет", **{"from": "2026-06-01T00:00:00Z"}) == [new]
        assert await _ids(c, h, "счет", to="2026-06-01T00:00:00") == [old]
        assert (await c.get("/v1/search?q=x&kind=bad", headers=h)).status_code == 422


# --- meaning ---


async def test_match_by_meaning_only(env):
    app, maker, embedder, _ = env
    async with client(app) as c:
        h = await _signed_in(c)
        note = await _ready(c, h, maker, "туфли")
        await _ready(c, h, maker, "Купить молоко")
        await _embed_all(maker, embedder)
        out = await _find(c, h, "ботинки")
        assert out["semantic"] is True
        assert [x["item_id"] for x in out["results"]] == [note]
        assert out["results"][0]["matched_by"] == ["meaning"]
        assert out["results"][0]["highlights"] == []


async def test_without_an_embedder_words_still_answer(tmp_path):
    engine = create_async_engine(os.environ["DATABASE_URL"])
    async with engine.connect() as conn:
        trans = await conn.begin()
        maker = async_sessionmaker(bind=conn, expire_on_commit=False,
                                   join_transaction_mode="create_savepoint")  # fmt: skip
        app = create_app(make_settings(), sessionmaker=maker, sms=FakeSmsSender(),
                         storage=make_storage(tmp_path))  # fmt: skip
        async with client(app) as c:
            h = await _signed_in(c)
            note = await _ready(c, h, maker, "Купить молоко")
            out = await _find(c, h, "молоко")
            assert out["semantic"] is False and out["results"][0]["item_id"] == note
        await trans.rollback()
    await engine.dispose()


async def test_chunks_of_another_model_are_ignored(env):
    app, maker, embedder, _ = env
    async with client(app) as c:
        h = await _signed_in(c)
        await _ready(c, h, maker, "туфли")
        await run_one(maker, FakeEmbedder(model="old-model"))
        assert await run_one(maker, embedder) is False
        assert (await _find(c, h, "ботинки"))["results"] == []
        # The backfill sees a record without chunks of the current model.
        async with maker() as s:
            assert await enqueue_missing(s, embedder.model) >= 1
            await s.commit()
        await _embed_all(maker, embedder)
        assert len((await _find(c, h, "ботинки"))["results"]) == 1


# --- chunks and the job ---


async def _chunks(maker, item_id: int) -> list[Chunk]:
    async with maker() as s:
        return list(await s.scalars(select(Chunk).where(Chunk.item_id == item_id)
                                    .order_by(Chunk.ord)))  # fmt: skip


async def test_ingest_queues_one_job_and_repeats_cost_nothing(env):
    app, maker, embedder, _ = env
    async with client(app) as c:
        h = await _signed_in(c)
        public = await _ready(c, h, maker, "Купить молоко")
        item_id = await _internal(maker, public)
        async with maker() as s:
            seq_before = await s.scalar(select(Item.seq).where(Item.id == item_id))
            jobs = (await s.execute(select(Job).where(Job.kind == JOB_EMBED))).scalars().all()
        assert [j.idempotency_key for j in jobs] == [embed_key(item_id)]

        assert await run_one(maker, embedder) is True
        chunks = await _chunks(maker, item_id)
        assert [c_.text for c_ in chunks] == ["Купить молоко"]
        assert chunks[0].embedding_model == embedder.model and chunks[0].token_count > 0
        assert chunks[0].user_id is not None
        async with maker() as s:  # phones aren't told anything: no seq change
            assert await s.scalar(select(Item.seq).where(Item.id == item_id)) == seq_before

        calls = len(embedder.calls)
        assert await run_embed(maker, embedder, item_id) is None  # same text: not embedded again
        assert len(embedder.calls) == calls


async def test_edit_embeds_again_and_back_again(env):
    app, maker, embedder, _ = env
    async with client(app) as c:
        h = await _signed_in(c)
        public = await _ready(c, h, maker, "Первый текст")
        item_id = await _internal(maker, public)
        await _embed_all(maker, embedder)

        for body in ("Второй текст", "Первый текст"):  # A -> B -> A
            r = await c.patch(f"/v1/items/{public}", json={"text": body}, headers=h)
            assert r.status_code == 200
            await _embed_all(maker, embedder)
            assert [x.text for x in await _chunks(maker, item_id)] == [body]

        async with maker() as s:  # still one job row for the record
            count = await s.scalar(select(func.count()).select_from(Job)
                                   .where(Job.kind == JOB_EMBED))  # fmt: skip
        assert count == 1

        sha = (await _chunks(maker, item_id))[0].source_sha
        await c.patch(f"/v1/items/{public}", json={"title": "Новое имя"}, headers=h)
        await _embed_all(maker, embedder)
        chunks = await _chunks(maker, item_id)
        assert chunks[0].source_sha != sha and chunks[0].text == "Первый текст"
        assert embedder.calls[-1] == ["Новое имя\nПервый текст"]


async def test_text_edited_during_embedding_is_not_lost(env):
    app, maker, embedder, _ = env

    class EditsMeanwhile(FakeEmbedder):
        edited = False

        async def embed(self, texts, input_type):
            out = await super().embed(texts, input_type)
            if not self.edited:
                self.edited = True
                async with maker() as s:
                    await s.execute(update(Item).where(Item.id == item_id).values(text="Новее"))
                    await s.commit()
            return out

    async with client(app) as c:
        h = await _signed_in(c)
        item_id = await _internal(maker, await _ready(c, h, maker, "Старое"))
        assert await run_embed(maker, EditsMeanwhile(), item_id) == 1
        assert [x.text for x in await _chunks(maker, item_id)] == ["Новее"]


async def test_job_queued_anew_while_running_stays_queued(env):
    app, maker, embedder, _ = env

    class RequeuesMeanwhile(FakeEmbedder):
        async def embed(self, texts, input_type):
            async with maker() as s:
                item = await s.get(Item, item_id)
                await enqueue_embed(s, item)
                await s.commit()
            return await super().embed(texts, input_type)

    async with client(app) as c:
        h = await _signed_in(c)
        item_id = await _internal(maker, await _ready(c, h, maker, "Текст"))
        assert await run_one(maker, RequeuesMeanwhile()) is True
        async with maker() as s:
            job = await s.scalar(select(Job).where(Job.idempotency_key == embed_key(item_id)))
        assert job.status == JobStatus.QUEUED


async def test_failed_embedding_retries_later_and_the_record_is_still_found(env):
    app, maker, embedder, _ = env

    class Down(FakeEmbedder):
        async def embed(self, texts, input_type):
            raise RuntimeError("TEI is down")

    async with client(app) as c:
        h = await _signed_in(c)
        public = await _ready(c, h, maker, "Купить молоко")
        item_id = await _internal(maker, public)
        assert await run_one(maker, Down()) is True
        async with maker() as s:
            job = await s.scalar(select(Job).where(Job.idempotency_key == embed_key(item_id)))
            assert job.status == JobStatus.QUEUED and "TEI" in job.last_error
            assert job.run_after > datetime.now(UTC)
        assert await _chunks(maker, item_id) == []
        assert await _ids(c, h, "молоко") == [public]


async def test_enrichment_embeds_again_with_the_new_title(env, monkeypatch):
    app, maker, embedder, _ = env

    def fake_apply(item, env_, **kw):
        item.title = "Заголовок от помощника"
        item.enrich_state = "done"

    monkeypatch.setattr(enrich, "apply_envelope", fake_apply)
    async with client(app) as c:
        h = await _signed_in(c)
        item_id = await _internal(maker, await _ready(c, h, maker, "Текст записи подлиннее"))
        await _embed_all(maker, embedder)
        before = (await _chunks(maker, item_id))[0].source_sha
        sha = enrich.text_fingerprint("Текст записи подлиннее")
        assert await enrich.store_envelope(maker, item_id, sha, None, provider="fake",
                                           model="fake", escalated=False) == "done"  # fmt: skip
        await _embed_all(maker, embedder)
        assert (await _chunks(maker, item_id))[0].source_sha != before
        assert embedder.calls[-1] == ["Заголовок от помощника\nТекст записи подлиннее"]


async def test_voice_is_embedded_once_whole_and_fragments_get_nothing(env):
    app, maker, embedder, _ = env
    async with client(app) as c:
        h = await _signed_in(c)
        first = await _internal(maker, await _ready(c, h, maker, "заготовка"))
        recording = uuid.uuid4()
        async with maker() as s:
            await s.execute(delete(Job).where(Job.kind == JOB_EMBED))
            record = await s.get(Item, first)
            done = {"state": "done", "confidence": 0.9, "lang": "ru"}
            record.text, record.recording_id, record.fragment_no = None, recording, 0
            record.source_meta = {
                "fragments": 2, "fragment_result": {**done, "text": "первая половина"},
            }  # fmt: skip
            await s.flush()
            # One fragment in: the text so far can be searched, but it isn't embedded yet.
            await voice.assemble(s, await voice.siblings(s, record.user_id, recording),
                                 datetime.now(UTC))  # fmt: skip
            await s.flush()
            assert await s.scalar(select(func.count()).select_from(Job)
                                  .where(Job.kind == JOB_EMBED)) == 0  # fmt: skip
            second = Item(user_id=record.user_id, kind="voice", source="mic", status="ready",
                          recording_id=recording, fragment_no=1, canonical_item_id=record.id,
                          hidden_reason=HiddenReason.VOICE_FRAGMENT,
                          source_meta={"fragment_result": {**done,
                                                           "text": "вторая половина"}})  # fmt: skip
            s.add(second)
            await s.flush()
            await voice.assemble(s, await voice.siblings(s, record.user_id, recording),
                                 datetime.now(UTC))  # fmt: skip
            second_id = second.id
            await s.commit()
        await _embed_all(maker, embedder)
        chunks = await _chunks(maker, first)
        assert [x.text for x in chunks] == ["первая половина\n\nвторая половина"]
        assert await _chunks(maker, second_id) == []


async def test_hidden_record_loses_its_chunks(env):
    app, maker, embedder, _ = env
    async with client(app) as c:
        h = await _signed_in(c)
        item_id = await _internal(maker, await _ready(c, h, maker, "Текст"))
        await _embed_all(maker, embedder)
        assert await _chunks(maker, item_id) != []
        async with maker() as s:
            await s.execute(update(Item).where(Item.id == item_id)
                            .values(hidden_reason=HiddenReason.DUPLICATE_MERGED))  # fmt: skip
            await s.commit()
        assert await run_embed(maker, embedder, item_id) is None
        assert await _chunks(maker, item_id) == []


async def test_a_merged_repeat_gets_no_embed_job_until_unmerged(env):
    app, maker, embedder, _ = env
    async with client(app) as c:
        h = await _signed_in(c)
        await _ready(c, h, maker, "Одинаковый текст")
        r = await c.post("/v1/items", json={"client_id": str(uuid.uuid4()),
                                            "text": "Одинаковый текст"}, headers=h)  # fmt: skip
        twin = r.json()["item"]
        assert r.json()["auto_merged"] is True
        twin_id = await _internal(maker, twin["id"])
        await _embed_all(maker, embedder)
        assert await _chunks(maker, twin_id) == []
        assert (await c.post(f"/v1/items/{twin['id']}/unmerge", headers=h)).status_code == 200
        await _embed_all(maker, embedder)
        assert len(await _chunks(maker, twin_id)) == 1


async def test_backfill_leaves_jobs_in_progress_alone(env):
    app, maker, embedder, _ = env
    async with client(app) as c:
        h = await _signed_in(c)
        item_id = await _internal(maker, await _ready(c, h, maker, "Текст"))
        async with maker() as s:
            job = await queue.claim(s, [JOB_EMBED])
            assert job is not None
            await s.commit()
        async with maker() as s:
            await enqueue_missing(s, embedder.model)
            await s.commit()
        async with maker() as s:
            job = await s.scalar(select(Job).where(Job.idempotency_key == embed_key(item_id)))
            assert job.status == JobStatus.RUNNING


# --- trash and purge ---


async def _expire(maker, public_id: str) -> None:
    async with maker() as s:
        await s.execute(update(Item).where(Item.public_id == uuid.UUID(public_id))
                        .values(purge_after=datetime.now(UTC) - timedelta(seconds=1)))  # fmt: skip
        await s.commit()


async def test_purge_removes_chunks_links_repeats_job_and_leaves_tombstones(env):
    app, maker, embedder, _ = env
    async with client(app) as c:
        h = await _signed_in(c)
        public = await _ready(c, h, maker, "Запись, которой скоро не будет")
        item_id = await _internal(maker, public)
        r = await c.post("/v1/items", json={"client_id": str(uuid.uuid4()),
                                            "text": "Запись, которой скоро не будет"},
                         headers=h)  # fmt: skip
        twin = r.json()["item"]["id"]
        twin_id = await _internal(maker, twin)
        await _embed_all(maker, embedder)
        assert await _chunks(maker, item_id) != []
        since = (await c.get("/v1/sync?limit=500", headers=h)).json()["next_since"]

        await c.delete(f"/v1/items/{public}", headers=h)
        # Not yet: 30 days aren't over, restoring still works.
        async with maker() as s:
            assert await purge_trashed_items(s) == 0
            await s.commit()
        await _expire(maker, public)
        assert await purge_once(maker) >= 2

        async with maker() as s:
            assert await s.get(Item, item_id) is None
            assert await s.get(Item, twin_id) is None  # a repeat must not outlive its record
            assert await s.scalar(select(func.count()).select_from(Chunk)
                                  .where(Chunk.item_id == item_id)) == 0  # fmt: skip
            assert await s.scalar(select(func.count()).select_from(ScreenItem)
                                  .where(ScreenItem.item_id == item_id)) == 0  # fmt: skip
            job = await s.scalar(select(Job).where(Job.idempotency_key == embed_key(item_id)))
            assert job is None
            tombs = list(await s.scalars(select(SyncTombstone).where(SyncTombstone.seq > since)))
        assert {(t.entity, str(t.public_id)) for t in tombs} >= {("item", public), ("item", twin)}

        changes = (await c.get(f"/v1/sync?since={since}&limit=500", headers=h)).json()
        assert public in [t["id"] for t in changes["tombstones"] if t["entity"] == "item"]
        assert (await c.get(f"/v1/items/{public}", headers=h)).status_code == 404
        assert await _ids(c, h, "запись") == []


async def _with_file(c, h, maker, storage, *, state: str = "active",
                     trash_until: datetime | None = None,
                     pinned_by: str | None = None) -> tuple:  # fmt: skip
    public = await _ready(c, h, maker, f"Запись с файлом {uuid.uuid4().hex}")
    item_id = await _internal(maker, public)
    key = f"u/test/{uuid.uuid4().hex}"
    await storage.put(key, b"original")
    async with maker() as s:
        user_id = await s.scalar(select(Item.user_id).where(Item.id == item_id))
        file = File(user_id=user_id, item_id=item_id, role="original", storage_key=key,
                    mime="image/png", bytes=8, sha256="a" * 64, state=state,
                    trash_until=trash_until, pinned_by=pinned_by)  # fmt: skip
        s.add(file)
        await s.commit()
        return public, file.id, key


async def test_file_purge_after_trash_days_keeps_the_row_and_the_text(env):
    app, maker, _, storage = env
    now = datetime.now(UTC)
    async with client(app) as c:
        h = await _signed_in(c)
        public, due, due_key = await _with_file(c, h, maker, storage, state="trash",
                                                trash_until=now - timedelta(seconds=1))  # fmt: skip
        _, waiting, waiting_key = await _with_file(c, h, maker, storage, state="trash",
                                                   trash_until=now + timedelta(days=3))  # fmt: skip
        _, kept, kept_key = await _with_file(c, h, maker, storage, state="pinned", pinned_by="user")
        assert await purge_files(maker, storage, now) == 1
        assert await storage.get(due_key) is None
        assert await storage.get(waiting_key) is not None
        assert await storage.get(kept_key) is not None
        async with maker() as s:
            row = await s.get(File, due)
            assert row.state == "purged" and row.purged_at is not None
            assert (await s.get(File, waiting)).state == "trash"
            assert (await s.get(File, kept)).state == "pinned"
        item = (await c.get(f"/v1/items/{public}", headers=h)).json()
        assert item["text"] and item["files"][0]["state"] == "purged"


async def test_file_purge_retries_a_failed_delete(env):
    app, maker, _, storage = env
    now = datetime.now(UTC)

    class Failing:
        async def delete(self, key):
            raise OSError("S3 is down")

    async with client(app) as c:
        h = await _signed_in(c)
        _, file_id, key = await _with_file(c, h, maker, storage, state="trash",
                                           trash_until=now - timedelta(seconds=1))  # fmt: skip
        assert await purge_files(maker, Failing(), now) == 0
        async with maker() as s:
            row = await s.get(File, file_id)
            assert row.state == "purged" and row.purged_at is None  # not confirmed: nobody can pin
        assert await purge_files(maker, storage, now) == 1
        assert await storage.get(key) is None
        async with maker() as s:
            assert (await s.get(File, file_id, populate_existing=True)).purged_at is not None


async def test_record_purge_hands_originals_to_the_file_purge_but_keeps_pinned(env):
    app, maker, _, storage = env
    async with client(app) as c:
        h = await _signed_in(c)
        public, active, a_key = await _with_file(c, h, maker, storage)
        pinned_public, pinned, p_key = await _with_file(c, h, maker, storage, state="pinned",
                                                        pinned_by="user")  # fmt: skip
        for one in (public, pinned_public):
            await c.delete(f"/v1/items/{one}", headers=h)
            await _expire(maker, one)
        await purge_once(maker, IngestDeps(storage=storage))
        assert await storage.get(a_key) is None
        # founder 2026-11-09: an original the person pinned is not purged with its record
        assert await storage.get(p_key) is not None
        async with maker() as s:
            row = await s.get(File, active, populate_existing=True)
            assert row.state == "purged" and row.item_id is None
            row = await s.get(File, pinned, populate_existing=True)
            assert row.state == "pinned" and row.item_id is None


async def test_orphan_upload_goes_after_a_week(env):
    app, maker, _, storage = env
    now = datetime.now(UTC)
    async with client(app) as c:
        h = await _signed_in(c)
        public, file_id, key = await _with_file(c, h, maker, storage)
        async with maker() as s:
            await s.execute(update(File).where(File.id == file_id).values(item_id=None))
            await s.commit()
        await purge_files(maker, storage, now)
        assert await storage.get(key) is not None  # fresh: it may be attached yet
        await purge_files(maker, storage, now + timedelta(days=8))
        assert await storage.get(key) is None


async def test_pin_and_unpin_an_original(env):
    app, maker, _, storage = env
    async with client(app) as c:
        h = await _signed_in(c)
        public, file_id, _ = await _with_file(
            c, h, maker, storage, state="trash", trash_until=datetime.now(UTC) + timedelta(days=1)
        )
        pinned = await c.post(f"/v1/items/{public}/original/pin", headers=h)
        assert pinned.status_code == 200 and pinned.json()["state"] == "pinned"
        assert pinned.json()["trash_until"] is None and pinned.json()["keep_reason"] == "user_pin"
        assert (await c.post(f"/v1/items/{public}/original/pin", headers=h)).status_code == 200

        out = await c.delete(f"/v1/items/{public}/original/pin", headers=h)
        assert out.status_code == 200 and out.json()["state"] == "trash"
        days = datetime.fromisoformat(out.json()["trash_until"]) - datetime.now(UTC)
        assert timedelta(days=6) < days <= timedelta(days=7)
        assert (await c.delete(f"/v1/items/{public}/original/pin", headers=h)).status_code == 200

        async with maker() as s:
            await s.execute(update(File).where(File.id == file_id).values(state="purged"))
            await s.commit()
        late = await c.post(f"/v1/items/{public}/original/pin", headers=h)
        assert late.status_code == 409 and late.json()["code"] == "original_purged"

        no_file = await _ready(c, h, maker, "Без файла")
        assert (await c.post(f"/v1/items/{no_file}/original/pin", headers=h)).status_code == 404
        other = await _signed_in(c)
        assert (await c.post(f"/v1/items/{public}/original/pin", headers=other)).status_code == 404


async def test_unpinning_keeps_an_unconfirmed_original(env):
    app, maker, _, storage = env
    async with client(app) as c:
        h = await _signed_in(c)
        public, _, _ = await _with_file(c, h, maker, storage, state="pinned", pinned_by="user")
        async with maker() as s:
            await s.execute(update(Item).where(Item.public_id == uuid.UUID(public))
                            .values(confidence=0.4, status=RecordStatus.NEEDS_REVIEW))  # fmt: skip
            await s.commit()
        out = (await c.delete(f"/v1/items/{public}/original/pin", headers=h)).json()
        assert out["state"] == "active" and out["keep_reason"] == "low_confidence"


async def test_system_files_cannot_be_unpinned(env):
    app, maker, _, storage = env
    async with client(app) as c:
        h = await _signed_in(c)
        public, _, _ = await _with_file(c, h, maker, storage, state="pinned", pinned_by="policy")
        out = await c.delete(f"/v1/items/{public}/original/pin", headers=h)
        assert out.status_code == 409 and out.json()["code"] == "original_system"


# --- page summaries ---


async def _new_page(c, h) -> str:
    r = await c.post("/v1/pages", json={"client_id": str(uuid.uuid4()), "template_key": "custom"},
                     headers=h)  # fmt: skip
    assert r.status_code == 201, r.text
    return r.json()["page"]["id"]


async def _summary(c, h, page: str) -> dict:
    r = await c.get(f"/v1/pages/{page}/summary", headers=h)
    assert r.status_code == 200, r.text
    return r.json()


async def test_summary_follows_the_page_in_the_same_transaction(env):
    app, maker, *_ = env
    async with client(app) as c:
        h = await _signed_in(c)
        page = await _new_page(c, h)
        empty = await _summary(c, h, page)
        assert (empty["item_count"], empty["last_titles"], empty["aggregates"]) == (0, [], {})

        one = await _ready(c, h, maker, "Первая", occurred_at="2026-10-01T00:00:00Z")
        two = await _ready(c, h, maker, "Вторая", occurred_at="2026-10-02T00:00:00Z")
        for i in (one, two):
            await c.post(f"/v1/pages/{page}/items", json={"item_id": i}, headers=h)
        s = await _summary(c, h, page)
        assert s["item_count"] == 2 and s["last_titles"] == ["Вторая", "Первая"]

        await c.patch(f"/v1/items/{two}", json={"title": "Новое имя"}, headers=h)
        assert (await _summary(c, h, page))["last_titles"] == ["Новое имя", "Первая"]

        await c.delete(f"/v1/items/{two}", headers=h)
        s = await _summary(c, h, page)
        assert s["item_count"] == 1 and s["last_titles"] == ["Первая"]

        await c.post(f"/v1/items/{two}/restore", headers=h)
        assert (await _summary(c, h, page))["item_count"] == 2

        await c.delete(f"/v1/items/{two}", headers=h)
        await _expire(maker, two)
        await purge_once(maker)
        assert (await _summary(c, h, page))["item_count"] == 1

        async with maker() as session:  # taken off the page by hand
            await session.execute(
                update(ScreenItem).where(ScreenItem.item_id == await _internal(maker, one))
                .values(removed_by_user_at=datetime.now(UTC))
            )  # fmt: skip
            await session.commit()
        s = await _summary(c, h, page)
        assert s["item_count"] == 0 and s["last_titles"] == []


async def test_summary_keeps_five_titles_and_hidden_ones_stay_out(env):
    app, maker, *_ = env
    async with client(app) as c:
        h = await _signed_in(c)
        page = await _new_page(c, h)
        ids = []
        for n in range(7):
            ids.append(await _ready(c, h, maker, f"Запись номер {n}",
                                    occurred_at=f"2026-10-0{n + 1}T00:00:00Z"))  # fmt: skip
            await c.post(f"/v1/pages/{page}/items", json={"item_id": ids[-1]}, headers=h)
        s = await _summary(c, h, page)
        assert s["item_count"] == 7
        assert s["last_titles"] == [f"Запись номер {n}" for n in (6, 5, 4, 3, 2)]
        async with maker() as session:
            await session.execute(update(Item).where(Item.public_id == uuid.UUID(ids[6]))
                                  .values(hidden_reason=HiddenReason.DUPLICATE_MERGED))  # fmt: skip
            await session.commit()
        assert (await _summary(c, h, page))["item_count"] == 6


async def test_summary_404s_and_belongs_to_its_owner(env):
    app, *_ = env
    async with client(app) as c:
        h = await _signed_in(c)
        page = await _new_page(c, h)
        assert (await c.get(f"/v1/pages/{uuid.uuid4()}/summary", headers=h)).status_code == 404
        other = await _signed_in(c)
        assert (await c.get(f"/v1/pages/{page}/summary", headers=other)).status_code == 404
        await c.delete(f"/v1/pages/{page}", headers=h)
        assert (await c.get(f"/v1/pages/{page}/summary", headers=h)).status_code == 404


async def test_summaries_reach_the_phone_only_when_they_change(env):
    app, maker, *_ = env
    async with client(app) as c:
        h = await _signed_in(c)
        page = await _new_page(c, h)
        first = (await c.get("/v1/sync?limit=500", headers=h)).json()
        rows = {x["page_id"]: x for x in first["screen_summaries"]}
        assert page in rows and rows[page]["item_count"] == 0

        since = first["next_since"]
        await rebuild_summaries(maker)  # nothing changed: a nightly run sends nothing
        quiet = (await c.get(f"/v1/sync?since={since}&limit=500", headers=h)).json()
        assert quiet["screen_summaries"] == []

        item = await _ready(c, h, maker, "Новая запись")
        await c.post(f"/v1/pages/{page}/items", json={"item_id": item}, headers=h)
        delta = (await c.get(f"/v1/sync?since={since}&limit=500", headers=h)).json()
        changed = {x["page_id"]: x for x in delta["screen_summaries"]}
        assert changed[page]["item_count"] == 1


async def test_nightly_rebuild_repairs_a_wrong_row(env):
    app, maker, *_ = env
    async with client(app) as c:
        h = await _signed_in(c)
        page = await _new_page(c, h)
        async with maker() as s:
            screen = await s.scalar(select(Screen.id).where(Screen.public_id == uuid.UUID(page)))
            await s.execute(update(ScreenSummary).where(ScreenSummary.screen_id == screen)
                            .values(item_count=99, aggregates={"stale": 1}))  # fmt: skip
            await s.commit()
        assert await rebuild_summaries(maker) >= 1
        row = await _summary(c, h, page)
        assert row["item_count"] == 0 and row["aggregates"] == {}


async def test_deleting_an_account_leaves_nothing(env):
    app, maker, embedder, _ = env
    async with client(app) as c:
        h = await _signed_in(c)
        public = await _ready(c, h, maker, "Запись")
        await _embed_all(maker, embedder)
        item_id = await _internal(maker, public)
        async with maker() as s:
            user_id = await s.scalar(select(Item.user_id).where(Item.id == item_id))
            await s.execute(text("DELETE FROM users WHERE id = :u"), {"u": user_id})
            await s.commit()
        async with maker() as s:
            for table in ("items", "chunks", "screens", "screen_items", "screen_summaries"):
                n = await s.scalar(text(f"SELECT count(*) FROM {table} WHERE user_id = :u"),
                                   {"u": user_id})  # fmt: skip
                assert n == 0, table
