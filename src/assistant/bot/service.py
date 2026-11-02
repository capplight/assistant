"""DB operations the bot handlers need. Plain async functions over an AsyncSession."""

import logging
from collections.abc import Sequence
from datetime import UTC, datetime

from sqlalchemy import delete, func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from assistant import scheduler
from assistant.bot.dates import TripSpec, guess_tz
from assistant.bot.intake import ItemDraft
from assistant.bot.limits import free_tier_allows, month_start_utc
from assistant.db import queue
from assistant.db.models import Booking, Item, ItemStatus, ProcessedUpdate, Trip, User
from assistant.pipeline import JOB_PROCESS_ITEM

log = logging.getLogger(__name__)


async def mark_update_processed(session: AsyncSession, update_id: int) -> bool:
    """Record the update_id. False if it was already there (a retry: skip handling)."""
    stmt = (
        pg_insert(ProcessedUpdate)
        .values(update_id=update_id)
        .on_conflict_do_nothing(index_elements=[ProcessedUpdate.update_id])
        .returning(ProcessedUpdate.update_id)
    )
    return (await session.execute(stmt)).scalar_one_or_none() is not None


async def ensure_user(session: AsyncSession, telegram_id: int, first_name: str | None) -> User:
    """Upsert by telegram_id and return the ORM row."""
    stmt = (
        pg_insert(User)
        .values(telegram_id=telegram_id, first_name=first_name)
        .on_conflict_do_update(
            index_elements=[User.telegram_id], set_={"first_name": first_name}
        )
        .returning(User.id)
    )
    user_id = (await session.execute(stmt)).scalar_one()
    user = await session.get(User, user_id, populate_existing=True)
    assert user is not None
    return user


async def active_trip(session: AsyncSession, user_id: int) -> Trip | None:
    stmt = (
        select(Trip)
        .where(Trip.user_id == user_id, Trip.is_active.is_(True))
        .order_by(Trip.created_at.desc())
        .limit(1)
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def items_this_month(session: AsyncSession, user: User, now: datetime | None = None) -> int:
    since = month_start_utc(now or datetime.now(UTC), user.tz)
    stmt = select(func.count(Item.id)).where(Item.user_id == user.id, Item.created_at >= since)
    return int((await session.execute(stmt)).scalar_one())


async def can_save_more(session: AsyncSession, user: User, limit: int) -> bool:
    return free_tier_allows(await items_this_month(session, user), limit)


async def existing_url_hashes(
    session: AsyncSession, user_id: int, hashes: Sequence[str]
) -> set[str]:
    if not hashes:
        return set()
    stmt = select(Item.url_hash).where(Item.user_id == user_id, Item.url_hash.in_(list(hashes)))
    return {h for h in (await session.execute(stmt)).scalars() if h}


async def save_items(
    session: AsyncSession,
    user: User,
    drafts: Sequence[ItemDraft],
    *,
    chat_id: int,
    message_id: int,
) -> list[Item]:
    """Insert items (attached to the active trip) and, with consent, enqueue processing.

    Returns only the rows actually inserted: a link that a concurrent update of the same
    user already saved hits `uq_items_user_url` and is skipped (ON CONFLICT DO NOTHING)
    instead of failing the whole update. Everything happens in the caller's transaction.
    """
    if not drafts:
        return []
    trip = await active_trip(session, user.id)
    rows = [
        {
            "user_id": user.id,
            "trip_id": trip.id if trip else None,
            "kind": d.kind,
            "source": d.source,
            "status": ItemStatus.PENDING,
            "raw_text": d.raw_text,
            "url": d.url,
            "url_hash": d.url_hash,
            "telegram_file_id": d.telegram_file_id,
            "telegram_chat_id": chat_id,
            "telegram_message_id": message_id,
        }
        for d in drafts
    ]
    stmt = (
        pg_insert(Item)
        .values(rows)
        .on_conflict_do_nothing(index_elements=[Item.user_id, Item.url_hash])
        .returning(Item)
    )
    items = list((await session.scalars(stmt)).all())
    if user.consent_at is not None:
        for item in items:
            await queue.enqueue(session, JOB_PROCESS_ITEM, {"item_id": item.id})
    return items


async def retry_failed_items(session: AsyncSession, user: User, hashes: Sequence[str]) -> int:
    """Reset the user's FAILED items with these url hashes to PENDING and re-enqueue them.

    Items without a trip are attached to the active trip. Returns how many were reset.
    """
    if not hashes:
        return 0
    stmt = (
        select(Item)
        .where(
            Item.user_id == user.id,
            Item.url_hash.in_(list(hashes)),
            Item.status == ItemStatus.FAILED,
        )
        .with_for_update()
    )
    items = list((await session.scalars(stmt)).all())
    if not items:
        return 0
    trip = await active_trip(session, user.id)
    for item in items:
        item.status = ItemStatus.PENDING
        item.error = None
        if item.trip_id is None and trip is not None:
            item.trip_id = trip.id
    await session.flush()
    if user.consent_at is not None:
        for item in items:
            await queue.enqueue(session, JOB_PROCESS_ITEM, {"item_id": item.id})
    return len(items)


async def give_consent(session: AsyncSession, user: User) -> int | None:
    """Set consent and enqueue PENDING items saved before it.

    Returns the number of enqueued items, or None if consent had already been given.
    """
    if user.consent_at is not None:
        return None
    user.consent_at = datetime.now(UTC)
    stmt = select(Item.id).where(Item.user_id == user.id, Item.status == ItemStatus.PENDING)
    ids = list((await session.execute(stmt)).scalars())
    for item_id in ids:
        await queue.enqueue(session, JOB_PROCESS_ITEM, {"item_id": item_id})
    await session.flush()
    return len(ids)


async def create_trip(session: AsyncSession, user: User, spec: TripSpec) -> Trip:
    """Create the trip, make it the only active one, schedule its reminders if it has dates."""
    await session.execute(
        update(Trip).where(Trip.user_id == user.id, Trip.is_active.is_(True)).values(
            is_active=False
        )
    )
    trip = Trip(
        user_id=user.id,
        title=spec.title,
        destination=spec.title,
        starts_on=spec.starts_on,
        ends_on=spec.ends_on,
        tz=guess_tz(spec.title),
        is_active=True,
    )
    session.add(trip)
    await session.flush()
    await _schedule_trip(session, trip)
    return trip


async def _schedule_trip(session: AsyncSession, trip: Trip) -> None:
    """(Re)create the trip's reminders if it has dates. Idempotent on the scheduler side."""
    if not (trip.starts_on and trip.ends_on):
        return
    try:
        await scheduler.schedule_for_trip(session, trip)
    except NotImplementedError:
        log.warning("scheduler.schedule_for_trip not implemented yet; trip %s", trip.id)


async def list_trips(session: AsyncSession, user_id: int) -> list[Trip]:
    stmt = select(Trip).where(Trip.user_id == user_id).order_by(Trip.created_at.desc()).limit(20)
    return list((await session.execute(stmt)).scalars())


async def switch_trip(session: AsyncSession, user_id: int, trip_id: int) -> Trip | None:
    trip = await session.get(Trip, trip_id)
    if trip is None or trip.user_id != user_id:
        return None
    await session.execute(
        update(Trip).where(Trip.user_id == user_id, Trip.id != trip_id).values(is_active=False)
    )
    trip.is_active = True
    await session.flush()
    await _schedule_trip(session, trip)
    return trip


async def owns_item(session: AsyncSession, user_id: int, item_id: int) -> bool:
    stmt = select(Item.id).where(Item.id == item_id, Item.user_id == user_id)
    return (await session.execute(stmt)).scalar_one_or_none() is not None


async def owns_booking(session: AsyncSession, user_id: int, booking_id: int) -> bool:
    stmt = select(Booking.id).where(Booking.id == booking_id, Booking.user_id == user_id)
    return (await session.execute(stmt)).scalar_one_or_none() is not None


async def delete_user(session: AsyncSession, user_id: int) -> None:
    """Delete the user row; FKs with ON DELETE CASCADE remove everything else."""
    await session.execute(delete(User).where(User.id == user_id))
