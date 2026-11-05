"""Integration tests against a real Postgres (postgis + pgvector, migrated with alembic).

Skipped unless DATABASE_URL is set. Each test runs in a transaction that is rolled back.
"""

import os

import pytest

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set"),
]


@pytest.fixture
async def session():
    from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

    engine = create_async_engine(os.environ["DATABASE_URL"])
    async with engine.connect() as conn:
        trans = await conn.begin()
        s = AsyncSession(bind=conn, expire_on_commit=False)
        try:
            yield s
        finally:
            await s.close()
            await trans.rollback()
    await engine.dispose()


async def _require_postgis(session):
    from sqlalchemy import text

    # PostGIS is optional (migration 0001); the CI image pgvector/pgvector has none.
    if not await session.scalar(text("SELECT 1 FROM pg_extension WHERE extname = 'postgis'")):
        pytest.skip("needs PostGIS")


async def test_place_resolver_caches_and_upserts(session):
    await _require_postgis(session)
    from assistant.pipeline.places import PlaceHit, PlaceResolver

    class Client:
        provider = "google"
        calls = 0

        async def search(self, query):
            Client.calls += 1
            return [PlaceHit("google", "test-place-1", "Sao Beach", "Phu Quoc", 10.05, 104.03,
                             "Фукуок", "VN", {})]  # fmt: skip

    resolver = PlaceResolver(Client())
    a = await resolver.resolve(session, "Sao Beach, Phu Quoc", "VN")
    b = await resolver.resolve(session, "  sao beach,   PHU QUOC ", "VN")
    assert a is not None and b is not None and a.place_id == b.place_id
    assert a.tz == "Asia/Ho_Chi_Minh"
    assert Client.calls == 1


async def test_process_item_idempotent(session):
    from datetime import UTC, datetime

    from assistant.db.models import Item, ItemKind, ItemSource, ItemStatus, User
    from assistant.notify import FakeNotifier
    from assistant.pipeline.deps import Deps
    from assistant.pipeline.places import PlaceResolver
    from assistant.pipeline.service import process_item
    from tests.pipeline.conftest import FakeExtractor, make_extraction, make_gatherer

    user = User(telegram_id=990000001, consent_at=datetime.now(UTC))
    session.add(user)
    await session.flush()
    item = Item(user_id=user.id, kind=ItemKind.TEXT, source=ItemSource.USER, raw_text="кафе",
                telegram_chat_id=1, telegram_message_id=1)  # fmt: skip
    session.add(item)
    await session.flush()

    from assistant.embeddings import NullEmbedder

    fx = FakeExtractor(make_extraction(kind="tip", place_query=None))
    d = Deps(gatherer=make_gatherer(), extractor=fx, places=PlaceResolver(None),
             embedder=NullEmbedder())  # fmt: skip
    notifier = FakeNotifier()
    await process_item(session, item.id, notifier, d)
    await process_item(session, item.id, notifier, d)
    assert item.status is ItemStatus.DONE
    assert len(fx.calls) == 1 and len(notifier.sent) == 1
