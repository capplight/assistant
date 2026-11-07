"""Week 4 finish criterion: search over 1 000 records under 1 second (spec 11.2). Real Postgres, the
whole HTTP path (auth, consent, all arms, snippets, pages), and other people's records beside them.

The embedder is fake, so the time of the real model is NOT in these numbers: bge-m3 embedding the
query comes on top, capped by `search_embed_timeout_seconds`. The stored vectors are labelled with
the real model's name, so the HNSW index exists and is kept up, as in production.

Numbers print on every run: pytest tests/memory/test_search_perf_db.py
"""

import os
import random
import secrets
import statistics
import time
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import insert, select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from assistant.api import consent_texts
from assistant.api.app import create_app
from assistant.api.sms import FakeSmsSender
from assistant.db.models import Item, User
from assistant.db.models_pages import Screen, ScreenItem
from assistant.db.models_search import Chunk
from assistant.db.models_v2 import ConsentKind
from assistant.embeddings import FakeEmbedder
from assistant.memory.chunking import chunk_text
from tests.api.conftest import client, make_settings, make_storage

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set"),
]

RECORDS = 1000
OTHER_PEOPLE = 20
OTHERS_RECORDS = 100  # each
LONG_SHARE = 0.03  # documents of about 20 000 characters
LIMIT_SECONDS = 1.0

RU = ("купить молоко хлеб лекарства маме врач запись понедельник стоматолог договор аренда "
      "квартира счёт оплата перевод каспи клиент звонок встреча офис документ паспорт ремонт "
      "машина страховка школа сын дочка размер обуви рецепт плов отпуск билет алматы астана "
      "телефон номер "
      "адрес сумма тенге отчёт налоги поставщик цена заказ доставка").split()  # fmt: skip
KK = ("қала кездесу жұмыс бала мектеп дәрігер ақша төлем үй көлік дүкен сатып алу ертең бүгін "
      "хабарласу құжат өтініш шарт тапсырыс бағасы").split()  # fmt: skip


def _vocabulary(rng: random.Random, size: int = 20000) -> list[str]:
    """Words that aren't real but are shaped like real ones: a real person's records have a large
    vocabulary, and the typo arm's cost depends on it."""
    syllables = [c + v for c in "бвгджзклмнпрстфхцчшщ" for v in "аеиоуыэюя"]
    return ["".join(rng.choices(syllables, k=rng.randint(2, 5))) for _ in range(size)]


QUERIES = {
    "one word": ["молоко", "договор", "каспи", "қала", "стоматолог"],
    "word forms": ["лекарствами", "квартиру", "счета"],
    "typos": ["молако", "дагавор", "стамотолог", "кездису", "лекарства маме врачь"],
    "question": ["куда я записала размер обуви сына", "сколько стоит ремонт машины у поставщика"],
    "nothing": ["абырвалг", "зюзюка щавель"],
}


def _text(rng: random.Random, many: list[str]) -> str:
    common = KK if rng.random() < 0.2 else RU
    if rng.random() < LONG_SHARE:
        size = 3000
    else:
        size = rng.choice((5, 12, 30, 60, 150))
    words = [rng.choice(common) if rng.random() < 0.4 else rng.choice(many) for _ in range(size)]
    # Paragraphs, as extracted documents have them.
    return "\n\n".join(" ".join(words[n:n + 40]) for n in range(0, size, 40))  # fmt: skip


async def _seed_user(s, embedder, rng, user_id: int, count: int, page_id: int,
                     many: list[str]) -> None:  # fmt: skip
    rows = []
    start = datetime.now(UTC) - timedelta(days=365)
    for n in range(count):
        body = _text(rng, many)
        rows.append({"user_id": user_id, "kind": "note", "source": "typed", "status": "ready",
                     "title": body[:40], "text": body, "public_id": uuid.uuid4(),
                     "occurred_at": start + timedelta(hours=n)})  # fmt: skip
    ids = list(await s.scalars(insert(Item).returning(Item.id), rows))
    links = []
    chunks = []
    for item_id, row in zip(ids, rows, strict=True):
        links.append({"screen_id": page_id, "item_id": item_id, "user_id": user_id,
                      "public_id": uuid.uuid4(), "position": None})  # fmt: skip
        pieces = chunk_text(row["text"])
        vectors = await embedder.embed([p.text for p in pieces], "document")
        chunks += [{"item_id": item_id, "user_id": user_id, "ord": p.ord, "text": p.text,
                    "token_count": p.token_count, "embedding": v,
                    "embedding_model": embedder.model, "source_sha": "x" * 64}
                   for p, v in zip(pieces, vectors, strict=True)]  # fmt: skip
    await s.execute(insert(ScreenItem), links)
    await s.execute(insert(Chunk), chunks)


async def _new_user(s) -> tuple[int, int]:
    user = User(telegram_id=None)
    s.add(user)
    await s.flush()
    page = await s.scalar(select(Screen.id).where(Screen.user_id == user.id))
    return user.id, page


def _stats(samples: list[float]) -> str:
    ordered = sorted(samples)
    p95 = ordered[min(len(ordered) - 1, int(len(ordered) * 0.95))]
    return (f"n={len(ordered):3d}  p50={statistics.median(ordered) * 1000:6.1f} ms  "
            f"p95={p95 * 1000:6.1f} ms  max={ordered[-1] * 1000:6.1f} ms")  # fmt: skip


async def test_search_over_1000_records_under_a_second(tmp_path, capsys):
    rng = random.Random(4)
    embedder = FakeEmbedder(model="BAAI/bge-m3")
    engine = create_async_engine(os.environ["DATABASE_URL"])
    async with engine.connect() as conn:
        trans = await conn.begin()
        maker = async_sessionmaker(bind=conn, expire_on_commit=False,
                                   join_transaction_mode="create_savepoint")  # fmt: skip
        app = create_app(make_settings(), sessionmaker=maker, sms=FakeSmsSender(),
                         storage=make_storage(tmp_path), embedder=embedder)  # fmt: skip
        async with client(app) as c:
            r = await c.post("/v1/auth/anonymous", json={"device_key": secrets.token_urlsafe(32)})
            h = {"Authorization": f"Bearer {r.json()['access_token']}"}
            consents = []
            for kind in (ConsentKind.PD_PROCESSING, ConsentKind.TERMS):
                t = consent_texts.current(kind, "ru")
                consents.append({"kind": kind, "version": t.version, "text_hash": t.text_hash,
                                 "locale": "ru"})  # fmt: skip
            r = await c.post("/v1/consents", headers=h, json={
                "consents": consents, "screen": "S05", "age_confirmed_18": True})  # fmt: skip
            assert r.status_code == 200, r.text

            started = time.perf_counter()
            async with maker() as s:
                user_id = await s.scalar(text(
                    "SELECT user_id FROM auth_identities ORDER BY id DESC LIMIT 1"))  # fmt: skip
                page = await s.scalar(select(Screen.id).where(Screen.user_id == user_id))
                many = _vocabulary(rng)
                await _seed_user(s, embedder, rng, user_id, RECORDS, page, many)
                for _ in range(OTHER_PEOPLE):
                    other, other_page = await _new_user(s)
                    await _seed_user(s, embedder, rng, other, OTHERS_RECORDS, other_page, many)
                await s.commit()
                await s.execute(text("ANALYZE items"))
                await s.execute(text("ANALYZE chunks"))
                await s.execute(text("ANALYZE screen_items"))
                await s.commit()
                n_chunks = await s.scalar(text("SELECT count(*) FROM chunks WHERE user_id = :u"),
                                          {"u": user_id})  # fmt: skip
            seeded = time.perf_counter() - started

            for queries in QUERIES.values():  # warm the caches, as a live server's are
                for q in queries:
                    await c.get("/v1/search", params={"q": q}, headers=h)
            everything: list[float] = []
            report = []
            for name, queries in QUERIES.items():
                samples = []
                for _ in range(5):
                    for q in queries:
                        began = time.perf_counter()
                        r = await c.get("/v1/search", params={"q": q}, headers=h)
                        samples.append(time.perf_counter() - began)
                        assert r.status_code == 200, r.text
                everything += samples
                report.append(f"  {name:12s} {_stats(samples)}")

            page_public = await _page_public(maker, page)
            samples = []
            for _ in range(10):
                began = time.perf_counter()
                r = await c.get("/v1/search", params={"q": "молоко", "page_id": page_public},
                                headers=h)  # fmt: skip
                samples.append(time.perf_counter() - began)
                assert r.status_code == 200 and r.json()["results"]
            report.append(f"  {'on a page':12s} {_stats(samples)}")
            everything += samples

            # A small account among big ones: the planner must not punish it.
            r = await c.post("/v1/auth/anonymous", json={"device_key": secrets.token_urlsafe(32)})
            small = {"Authorization": f"Bearer {r.json()['access_token']}"}
            r = await c.post("/v1/consents", headers=small, json={
                "consents": consents, "screen": "S05", "age_confirmed_18": True})  # fmt: skip
            assert r.status_code == 200, r.text
            for body in ("Купить молоко", "Телефон сына", "Записаться к врачу"):
                r = await c.post("/v1/items", headers=small,
                                 json={"client_id": str(uuid.uuid4()), "text": body})  # fmt: skip
                assert r.status_code == 201, r.text
            samples = []
            for q in ("молоко", "молако", "телефн", "абырвалг", "куда записала телефон") * 3:
                began = time.perf_counter()
                r = await c.get("/v1/search", params={"q": q}, headers=small)
                samples.append(time.perf_counter() - began)
                assert r.status_code == 200, r.text
            report.append(f"  {'small acct':12s} {_stats(samples)}")

            # Sanity: the numbers are about a search that found things, and only this person's.
            found = (await c.get("/v1/search", params={"q": "молоко"}, headers=h)).json()
            assert found["semantic"] is True and len(found["results"]) == 20
            assert (await c.get("/v1/search", params={"q": "абырвалг"},
                                headers=h)).json()["results"] == []  # fmt: skip

        with capsys.disabled():
            print(f"\nSearch, {RECORDS} records ({n_chunks} chunks), "
                  f"{OTHER_PEOPLE * OTHERS_RECORDS} other people's records beside them, "
                  f"seeded in {seeded:.1f} s. "
                  "FAKE embedder: the real model's time is NOT included.")  # fmt: skip
            print("\n".join(report))
            print(f"  {'all':12s} {_stats(everything)}")
        await trans.rollback()
    await engine.dispose()

    assert sorted(everything)[int(len(everything) * 0.95)] < LIMIT_SECONDS


async def _page_public(maker, page: int) -> str:
    async with maker() as s:
        return str(await s.scalar(select(Screen.public_id).where(Screen.id == page)))
