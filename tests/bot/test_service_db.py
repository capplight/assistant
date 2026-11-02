"""Bot DB operations against a real Postgres (migrated). Skipped without DATABASE_URL."""

import os
import random

import pytest
from sqlalchemy import select

from assistant.bot import service
from assistant.bot.dates import TripSpec
from assistant.bot.intake import ItemDraft
from assistant.db.models import Item, ItemKind, ItemSource, ItemStatus, Job, Trip
from assistant.links import url_hash

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


async def _jobs_for(session, item_id: int) -> list[Job]:
    stmt = select(Job).where(Job.payload["item_id"].as_integer() == item_id)
    return list((await session.execute(stmt)).scalars())


def _tg_id() -> int:
    return random.randint(10**12, 10**13)


async def test_update_idempotency(session):
    uid = _tg_id()
    assert await service.mark_update_processed(session, uid)
    assert not await service.mark_update_processed(session, uid)


async def test_ensure_user_upserts(session):
    tg = _tg_id()
    a = await service.ensure_user(session, tg, "A")
    b = await service.ensure_user(session, tg, "B")
    assert a.id == b.id
    assert b.first_name == "B"


async def test_items_pending_until_consent_then_enqueued(session):
    user = await service.ensure_user(session, _tg_id(), "A")
    trip = await service.create_trip(session, user, TripSpec("Бали"))
    url = "https://instagram.com/reel/abc"
    drafts = [ItemDraft(ItemKind.LINK, ItemSource.INSTAGRAM, url=url, url_hash=url_hash(url))]
    (item,) = await service.save_items(session, user, drafts, chat_id=1, message_id=2)
    assert item.trip_id == trip.id
    assert await _jobs_for(session, item.id) == []

    assert await service.existing_url_hashes(session, user.id, [url_hash(url)]) == {url_hash(url)}
    assert await service.give_consent(session, user) == 1
    assert await service.give_consent(session, user) is None
    assert len(await _jobs_for(session, item.id)) == 1
    assert await service.items_this_month(session, user) == 1


async def test_only_one_active_trip(session):
    user = await service.ensure_user(session, _tg_id(), "A")
    t1 = await service.create_trip(session, user, TripSpec("Бали"))
    t2 = await service.create_trip(session, user, TripSpec("Дубай"))
    await session.refresh(t1)
    assert (t1.is_active, t2.is_active) == (False, True)
    assert await service.switch_trip(session, user.id, t1.id) is not None
    active = (
        await session.execute(select(Trip.id).where(Trip.user_id == user.id, Trip.is_active))
    ).scalars().all()
    assert active == [t1.id]
    other = await service.ensure_user(session, _tg_id(), "B")
    assert await service.switch_trip(session, other.id, t1.id) is None


def _link(url: str) -> ItemDraft:
    return ItemDraft(ItemKind.LINK, ItemSource.INSTAGRAM, url=url, url_hash=url_hash(url))


async def test_save_items_skips_conflicting_url(session):
    user = await service.ensure_user(session, _tg_id(), "A")
    d = _link("https://instagram.com/reel/dup")
    assert len(await service.save_items(session, user, [d], chat_id=1, message_id=1)) == 1
    # same link again (e.g. a concurrent update committed first): no IntegrityError
    assert await service.save_items(session, user, [d], chat_id=1, message_id=2) == []
    note = ItemDraft(ItemKind.TEXT, ItemSource.USER, raw_text="адаптер")
    assert len(await service.save_items(session, user, [d, note], chat_id=1, message_id=3)) == 1


async def test_retry_failed_item(session):
    from datetime import UTC, datetime

    user = await service.ensure_user(session, _tg_id(), "A")
    user.consent_at = datetime.now(UTC)
    d = _link("https://instagram.com/reel/broken")
    (item,) = await service.save_items(session, user, [d], chat_id=1, message_id=1)
    item.status, item.error = ItemStatus.FAILED, "boom"
    await session.flush()
    trip = await service.create_trip(session, user, TripSpec("Бали"))

    assert await service.retry_failed_items(session, user, [d.url_hash]) == 1
    await session.refresh(item)
    assert (item.status, item.error, item.trip_id) == (ItemStatus.PENDING, None, trip.id)
    assert len(await _jobs_for(session, item.id)) == 2  # original + retry
    # not FAILED any more: nothing to retry
    assert await service.retry_failed_items(session, user, [d.url_hash]) == 0
    assert (await session.get(Item, item.id)) is not None


async def test_switch_trip_schedules_reminders(session, monkeypatch):
    from datetime import date

    calls = []

    async def schedule_for_trip(s, trip):
        calls.append(trip.id)
        return []

    monkeypatch.setattr(service.scheduler, "schedule_for_trip", schedule_for_trip)
    user = await service.ensure_user(session, _tg_id(), "A")
    t1 = await service.create_trip(
        session, user, TripSpec("Бали", date(2027, 1, 10), date(2027, 1, 20))
    )
    await service.create_trip(session, user, TripSpec("Дубай"))
    await service.switch_trip(session, user.id, t1.id)
    assert calls == [t1.id, t1.id]
