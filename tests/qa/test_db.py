"""Retrieval against a real Postgres with PostGIS + pgvector. Rolled back after."""

import os

import pytest

from assistant.db.models import (
    Category,
    Item,
    ItemKind,
    ItemPlace,
    ItemSource,
    ItemStatus,
    Place,
    User,
)

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="needs DATABASE_URL"),
]


@pytest.fixture
async def session():
    from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

    engine = create_async_engine(os.environ["DATABASE_URL"])
    async with engine.connect() as conn:
        trans = await conn.begin()
        async with AsyncSession(bind=conn, expire_on_commit=False) as s:
            yield s
        await trans.rollback()
    await engine.dispose()


async def _seed(session):
    user = User(telegram_id=990000002)  # no consent: no model, no embeddings
    session.add(user)
    await session.flush()
    item = Item(
        user_id=user.id,
        kind=ItemKind.LINK,
        source=ItemSource.INSTAGRAM,
        status=ItemStatus.DONE,
        url="https://www.instagram.com/reel/test/",
        telegram_chat_id=1,
        telegram_message_id=1,
        title="Bánh Mì Phượng",
        summary="Знаменитый бань ми",
        category=Category.FOOD,
        city="Hoi An",
        country="VN",
    )
    place = Place(
        provider="test",
        provider_place_id="bmp-1",
        name="Bánh Mì Phượng",
        geom="SRID=4326;POINT(108.3346 15.8790)",
    )
    session.add_all([item, place])
    await session.flush()
    session.add(ItemPlace(item_id=item.id, place_id=place.id))
    await session.flush()
    return user, item


async def test_nearby_and_plain_answer(session):
    from assistant.qa import Location, answer, nearby

    user, item = await _seed(session)
    near = await nearby(session, user.id, Location(lat=15.8815, lon=108.3346))
    assert near.item_ids == [item.id]
    assert "Bánh Mì Phượng" in near.text and " м" in near.text

    ans = await answer(session, user.id, "где бань ми?")
    assert item.id in ans.item_ids
