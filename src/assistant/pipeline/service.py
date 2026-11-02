"""DB-bound implementation of the pipeline contract (see assistant.pipeline.__init__)."""

import logging
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from assistant import scheduler
from assistant.db.models import Booking, BookingType, Category, Item, ItemStatus, Trip, User
from assistant.notify import Notifier, OutMessage
from assistant.pipeline import CB_BOOKING, CB_PICK
from assistant.pipeline.core import Outcome, PipelineContext, run_pipeline
from assistant.pipeline.deps import Deps, get_deps
from assistant.pipeline.errors import is_permanent
from assistant.pipeline.inputs import ItemData
from assistant.pipeline.logic import (
    ASK_PLACE_TEXT,
    FAILED_TEXT,
    TripInfo,
    ask_buttons,
    booking_buttons,
    booking_text,
    note_text,
    saved_text,
)
from assistant.pipeline.places import ResolvedPlace, link_item_place

log = logging.getLogger(__name__)

SKIP_STATUSES = (ItemStatus.DONE, ItemStatus.NEEDS_INPUT)


def _msg(item: Item, text: str, buttons=None) -> OutMessage:
    return OutMessage(
        chat_id=item.telegram_chat_id,
        text=text,
        reply_to_message_id=item.telegram_message_id,
        buttons=buttons or [],
    )


def item_data(item: Item) -> ItemData:
    return ItemData(
        id=item.id,
        kind=item.kind,
        source=item.source,
        raw_text=item.raw_text,
        url=item.url,
        telegram_file_id=item.telegram_file_id,
    )


def trip_info(t: Trip) -> TripInfo:
    return TripInfo(
        id=t.id, title=t.title, destination=t.destination, starts_on=t.starts_on,
        ends_on=t.ends_on, tz=t.tz, is_active=t.is_active,
    )  # fmt: skip


async def _load_trips(session: AsyncSession, user_id: int, existing: int | None) -> list[Trip]:
    stmt = select(Trip).where(Trip.user_id == user_id)
    stmt = stmt.where(Trip.is_active.is_(True) | (Trip.id == existing)) if existing else stmt.where(
        Trip.is_active.is_(True)
    )
    return list((await session.execute(stmt.order_by(Trip.id))).scalars())


async def process_item(
    session: AsyncSession, item_id: int, notifier: Notifier, deps: Deps | None = None
) -> None:
    deps = deps or get_deps()
    item = (
        await session.execute(select(Item).where(Item.id == item_id).with_for_update())
    ).scalar_one_or_none()
    if item is None:
        log.warning("process_item: item %s not found", item_id)
        return
    if item.status in SKIP_STATUSES:
        log.info("process_item: item %s already %s", item_id, item.status)
        return
    user = await session.get(User, item.user_id)
    if user is None or user.consent_at is None:
        log.info("process_item: item %s skipped, no consent", item_id)
        return

    trips = await _load_trips(session, user.id, item.trip_id)
    item.status = ItemStatus.PROCESSING

    async def resolve(query: str, country: str | None) -> ResolvedPlace | None:
        return await deps.places.resolve(session, query, country)

    ctx = PipelineContext(
        item=item_data(item),
        user_tz=user.tz,
        trips=[trip_info(t) for t in trips],
        existing_trip_id=item.trip_id,
        now=deps.clock(),
    )
    try:
        outcome = await run_pipeline(
            ctx,
            gatherer=deps.gatherer,
            extractor=deps.extractor,
            resolve_place=resolve,
            threshold=deps.threshold,
            zone_loader=deps.zone_loader,
        )
    except Exception as e:
        if not is_permanent(e):
            raise  # transient or unknown: the queue retries with backoff
        log.warning("item %s failed permanently: %r", item_id, e)
        await mark_failed(session, item, repr(e), notifier, deps)
        return

    message = await apply_outcome(session, item, user, outcome, deps)
    await session.flush()
    await notifier.send(message)


async def apply_outcome(
    session: AsyncSession, item: Item, user: User, out: Outcome, deps: Deps
) -> OutMessage:
    item.processed_at = deps.clock()
    ex = out.extraction
    if ex is None:  # nothing readable: ask the user
        item.status = out.status
        item.error = out.error
        return _msg(item, out.user_text or FAILED_TEXT)

    item.title = ex.title
    item.summary = ex.summary_ru
    item.category = Category(ex.category)
    item.city = (out.place.city if out.place else None) or ex.city
    item.country = (out.place.country if out.place else None) or ex.country
    item.confidence = ex.confidence
    item.extracted = {**ex.model_dump(mode="json"), "options": out.options,
                      "escalated": out.escalated}  # fmt: skip
    item.error = None
    if out.trip is not None:
        item.trip_id = out.trip.id
    item.status = out.status

    if out.place is not None:
        await link_item_place(session, item.id, out.place.place_id)
    await _embed(item, deps)

    if out.decision == "ask":
        return _msg(item, ASK_PLACE_TEXT, ask_buttons(item.id, out.options, CB_PICK))

    if out.booking is not None:
        d = out.booking
        booking = Booking(
            user_id=user.id,
            trip_id=item.trip_id,
            item_id=item.id,
            type=BookingType(d.type),
            title=d.title,
            confirmation_code=d.confirmation_code,
            starts_at=d.starts_at,
            ends_at=d.ends_at,
            tz=d.tz,
            details={**d.details, "issues": d.issues} if d.issues else d.details,
        )
        session.add(booking)
        await session.flush()
        return _msg(item, booking_text(d, out.trip), booking_buttons(booking.id, CB_BOOKING))

    if ex.kind in ("tip", "note"):
        return _msg(item, note_text(ex.title, ex.kind, out.trip))
    return _msg(item, saved_text(ex.title, item.city, ex.category, out.trip))


async def _embed(item: Item, deps: Deps) -> None:
    if deps.embedder.dim == 0:
        return
    text = "\n".join(x for x in (item.title, item.summary, item.city, item.raw_text) if x)
    if not text:
        return
    try:
        vectors = await deps.embedder.embed([text[:8000]], "document")
    except Exception as e:  # search falls back to full-text; never fail the item for this
        log.warning("embedding failed for item %s: %r", item.id, e)
        return
    if vectors:
        item.embedding = vectors[0]


async def mark_failed(
    session: AsyncSession, item: Item, error: str, notifier: Notifier, deps: Deps | None = None
) -> None:
    item.status = ItemStatus.FAILED
    item.error = error[:4000]
    item.processed_at = deps.clock() if deps else datetime.now(UTC)
    await session.flush()
    await notifier.send(_msg(item, FAILED_TEXT))


async def fail_item(session: AsyncSession, item_id: int, error: str, notifier: Notifier) -> None:
    """Worker gave up on the job: mark the item FAILED and tell the user once."""
    item = await session.get(Item, item_id)
    if item is None or item.status in (ItemStatus.DONE, ItemStatus.FAILED):
        return
    item.status = ItemStatus.FAILED
    item.error = error[:4000]
    await session.flush()
    await notifier.send(_msg(item, FAILED_TEXT))


async def handle_choice(
    session: AsyncSession,
    item_id: int,
    option_index: int,
    notifier: Notifier,
    deps: Deps | None = None,
) -> None:
    deps = deps or get_deps()
    item = (
        await session.execute(select(Item).where(Item.id == item_id).with_for_update())
    ).scalar_one_or_none()
    if item is None or item.status is not ItemStatus.NEEDS_INPUT:
        log.info("handle_choice: item %s not waiting for input", item_id)
        return
    options: list[str] = list((item.extracted or {}).get("options") or [])
    trip = await session.get(Trip, item.trip_id) if item.trip_id else None
    trip_i = trip_info(trip) if trip else None
    item.status = ItemStatus.DONE
    item.processed_at = deps.clock()

    if not 0 <= option_index < len(options):
        await session.flush()
        await notifier.send(_msg(
            item,
            "Хорошо, сохранил без точного места. Если знаешь название — пришли его сообщением.",
        ))  # fmt: skip
        return

    choice = options[option_index]
    query = choice if not item.city or item.city.casefold() in choice.casefold() else (
        f"{choice}, {item.city}"
    )
    place = await deps.places.resolve(session, query, item.country)
    item.title = place.name if place else choice
    if place is not None:
        await link_item_place(session, item.id, place.place_id)
        item.city = place.city or item.city
        item.country = place.country or item.country
    item.confidence = 1.0
    await session.flush()
    category = item.category.value if item.category else None
    await notifier.send(_msg(item, saved_text(item.title, item.city, category, trip_i)))


async def confirm_booking(
    session: AsyncSession, booking_id: int, ok: bool, notifier: Notifier
) -> None:
    booking = await session.get(Booking, booking_id)
    if booking is None:
        log.info("confirm_booking: booking %s not found", booking_id)
        return
    chat_id, reply_to = await _booking_chat(session, booking)

    if not ok:
        await session.delete(booking)  # cascades to its reminders
        await session.flush()
        text = "Хорошо, не сохраняю. Пришли скриншот получше или напиши детали текстом."
        await notifier.send(OutMessage(chat_id, text, reply_to))
        return

    if booking.confirmed_at is not None:
        await notifier.send(OutMessage(chat_id, "Эта бронь уже сохранена.", reply_to))
        return
    booking.confirmed_at = datetime.now(UTC)
    await session.flush()
    reminders = []
    try:
        reminders = await scheduler.schedule_for_booking(session, booking)
    except NotImplementedError:
        log.warning("scheduler.schedule_for_booking not implemented yet; booking %s confirmed "
                    "without reminders", booking.id)  # fmt: skip
    text = "Готово, бронь сохранена." + (" Напомню заранее." if reminders else "")
    await notifier.send(OutMessage(chat_id, text, reply_to))


async def _booking_chat(session: AsyncSession, booking: Booking) -> tuple[int, int | None]:
    if booking.item_id is not None:
        item = await session.get(Item, booking.item_id)
        if item is not None:
            return item.telegram_chat_id, item.telegram_message_id
    user = await session.get(User, booking.user_id)
    return (user.telegram_id if user else 0), None
