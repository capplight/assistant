"""DB-bound implementation of the pipeline contract (see assistant.pipeline.__init__).

Transaction shape (CLAUDE.md): no transaction stays open across network calls, results are
committed before any Telegram message is sent, and a failed send never re-raises.
Every public function here commits the session it is given.
"""

import logging
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from assistant import scheduler
from assistant.db.models import Booking, BookingType, Category, Item, ItemStatus, Trip, User
from assistant.logs import error_text, redact
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

# PROCESSING is deliberately not here: a retried job (crash, transient error) runs again.
SKIP_STATUSES = (ItemStatus.DONE, ItemStatus.NEEDS_INPUT)

ALREADY_CONFIRMED_TEXT = "Эта бронь уже сохранена."
REJECTED_TEXT = "Хорошо, не сохраняю. Пришли скриншот получше или напиши детали текстом."
NO_PLACE_TEXT = "Хорошо, сохранил без точного места. Если знаешь название — пришли его сообщением."


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


async def send_safely(notifier: Notifier, message: OutMessage | None) -> None:
    """Send after commit. Blocked bot, flood limits, network: log and move on, never raise,
    so the queue does not re-run (and re-pay for) work that is already saved."""
    if message is None:
        return
    try:
        await notifier.send(message)
    except Exception as e:
        log.warning("could not notify chat %s: %s", message.chat_id, error_text(e))


async def _lock_item(session: AsyncSession, item_id: int) -> Item | None:
    stmt = (
        select(Item)
        .where(Item.id == item_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    return (await session.execute(stmt)).scalar_one_or_none()


async def _load_trips(session: AsyncSession, user_id: int, existing: int | None) -> list[Trip]:
    stmt = select(Trip).where(Trip.user_id == user_id)
    stmt = stmt.where(Trip.is_active.is_(True) | (Trip.id == existing)) if existing else stmt.where(
        Trip.is_active.is_(True)
    )
    return list((await session.execute(stmt.order_by(Trip.id))).scalars())


# ---------------------------------------------------------------- process_item


async def process_item(
    session: AsyncSession, item_id: int, notifier: Notifier, deps: Deps | None = None
) -> None:
    """Claim (short tx) -> network work with no open tx -> store (short tx) -> send.

    Commits `session` itself; any pending changes of the caller are committed with the claim.
    """
    deps = deps or get_deps()
    ctx = await _claim(session, item_id, deps)
    if ctx is None:
        return

    async def resolve(query: str, country: str | None) -> ResolvedPlace | None:
        # PlaceResolver.resolve ends its own transactions around the provider call.
        return await deps.places.resolve(session, query, country)

    try:
        outcome = await run_pipeline(
            ctx,
            gatherer=deps.gatherer,
            extractor=deps.extractor,
            resolve_place=resolve,
            threshold=deps.threshold,
            zone_loader=deps.zone_loader,
        )
        vector = await _embed(ctx.item, outcome, deps)
    except Exception as e:
        await session.rollback()  # a failed place upsert may have left a transaction open
        if not is_permanent(e):
            raise  # transient or unknown: the queue retries with backoff
        err = error_text(e)
        log.warning("item %s failed permanently: %s", item_id, err)
        await send_safely(notifier, await _store_failure(session, item_id, err, deps.clock()))
        return

    await send_safely(notifier, await _store_outcome(session, item_id, outcome, vector, deps))


async def _claim(session: AsyncSession, item_id: int, deps: Deps) -> PipelineContext | None:
    """Short transaction: check the item and mark it PROCESSING. Returns plain data only."""
    item = await _lock_item(session, item_id)
    ctx = None
    if item is None:
        log.warning("process_item: item %s not found", item_id)
    elif item.status in SKIP_STATUSES:
        log.info("process_item: item %s already %s", item_id, item.status)
    else:
        user = await session.get(User, item.user_id)
        if user is None or user.consent_at is None:
            log.info("process_item: item %s skipped, no consent", item_id)
        else:
            trips = await _load_trips(session, user.id, item.trip_id)
            item.status = ItemStatus.PROCESSING
            ctx = PipelineContext(
                item=item_data(item),
                user_tz=user.tz,
                trips=[trip_info(t) for t in trips],
                existing_trip_id=item.trip_id,
                now=deps.clock(),
            )
    await session.commit()
    return ctx


async def _embed(item: ItemData, out: Outcome, deps: Deps) -> list[float] | None:
    ex = out.extraction
    if ex is None or deps.embedder.dim == 0:
        return None
    city = (out.place.city if out.place else None) or ex.city
    text = "\n".join(x for x in (ex.title, ex.summary_ru, city, item.raw_text) if x)
    if not text:
        return None
    try:
        vectors = await deps.embedder.embed([text[:8000]], "document")
    except Exception as e:  # search falls back to full-text; never fail the item for this
        log.warning("embedding failed for item %s: %s", item.id, error_text(e))
        return None
    return vectors[0] if vectors else None


async def _store_outcome(
    session: AsyncSession, item_id: int, out: Outcome, vector: list[float] | None, deps: Deps
) -> OutMessage | None:
    item = await _lock_item(session, item_id)
    if item is None or item.status is not ItemStatus.PROCESSING:
        # Deleted by the user meanwhile, or finished by another run: drop silently.
        log.info("process_item: item %s gone or no longer processing, result dropped", item_id)
        await session.commit()
        return None
    if out.trip is not None and await session.get(Trip, out.trip.id) is None:
        out.trip = None  # trip deleted while we were working
    message = await apply_outcome(session, item, out, vector, deps)
    await session.commit()
    return message


async def _store_failure(
    session: AsyncSession, item_id: int, error: str, now: datetime
) -> OutMessage | None:
    item = await _lock_item(session, item_id)
    if item is None or item.status is not ItemStatus.PROCESSING:
        await session.commit()
        return None
    item.status = ItemStatus.FAILED
    item.error = redact(error)[:4000]
    item.processed_at = now
    message = _msg(item, FAILED_TEXT)
    await session.commit()
    return message


async def apply_outcome(
    session: AsyncSession, item: Item, out: Outcome, vector: list[float] | None, deps: Deps
) -> OutMessage:
    """Write the outcome onto the locked item (DB only, no network). Caller commits."""
    item.processed_at = deps.clock()
    ex = out.extraction
    if ex is None:  # nothing readable: ask the user
        item.status = out.status
        item.error = redact(out.error)[:4000] if out.error else None
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
    if vector is not None:
        item.embedding = vector

    if out.place is not None:
        await link_item_place(session, item.id, out.place.place_id)

    if out.decision == "ask":
        return _msg(item, ASK_PLACE_TEXT, ask_buttons(item.id, out.options, CB_PICK))

    if out.booking is not None:
        d = out.booking
        booking = Booking(
            user_id=item.user_id,
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
        buttons = booking_buttons(booking.id, CB_BOOKING, no_date=d.starts_at is None)
        return _msg(item, booking_text(d, out.trip), buttons)

    if ex.kind in ("tip", "note"):
        return _msg(item, note_text(ex.title, ex.kind, out.trip))
    return _msg(item, saved_text(ex.title, item.city, ex.category, out.trip))


async def fail_item(session: AsyncSession, item_id: int, error: str, notifier: Notifier) -> None:
    """Worker gave up on the job: commit FAILED first, then tell the user once.
    Commits `session` itself; a failed send is logged, never raised."""
    item = await _lock_item(session, item_id)
    if item is None or item.status in (ItemStatus.DONE, ItemStatus.FAILED,
                                       ItemStatus.NEEDS_INPUT):  # fmt: skip
        await session.commit()
        return
    item.status = ItemStatus.FAILED
    item.error = redact(error)[:4000]
    item.processed_at = datetime.now(UTC)
    message = _msg(item, FAILED_TEXT)
    await session.commit()
    await send_safely(notifier, message)


# ---------------------------------------------------------------- handle_choice


async def handle_choice(
    session: AsyncSession,
    item_id: int,
    option_index: int,
    notifier: Notifier,
    deps: Deps | None = None,
) -> None:
    """Commits `session` itself. The place lookup runs with no transaction open."""
    deps = deps or get_deps()
    item = await _lock_item(session, item_id)
    if item is None or item.status is not ItemStatus.NEEDS_INPUT:
        log.info("handle_choice: item %s not waiting for input", item_id)
        await session.commit()
        return
    options: list[str] = list((item.extracted or {}).get("options") or [])

    if not 0 <= option_index < len(options):
        item.status = ItemStatus.DONE
        item.processed_at = deps.clock()
        message = _msg(item, NO_PLACE_TEXT)
        await session.commit()
        await send_safely(notifier, message)
        return

    choice = options[option_index]
    query = choice if not item.city or item.city.casefold() in choice.casefold() else (
        f"{choice}, {item.city}"
    )
    country = item.country
    await session.commit()  # release the row lock before the network call

    try:
        place = await deps.places.resolve(session, query, country)
    except Exception:
        await session.rollback()
        raise

    item = await _lock_item(session, item_id)
    if item is None or item.status is not ItemStatus.NEEDS_INPUT:
        log.info("handle_choice: item %s changed meanwhile (double press?)", item_id)
        await session.commit()
        return
    item.status = ItemStatus.DONE
    item.processed_at = deps.clock()
    item.title = place.name if place else choice
    if place is not None:
        await link_item_place(session, item.id, place.place_id)
        item.city = place.city or item.city
        item.country = place.country or item.country
    item.confidence = 1.0
    trip = await session.get(Trip, item.trip_id) if item.trip_id else None
    trip_i = trip_info(trip) if trip else None
    category = item.category.value if item.category else None
    message = _msg(item, saved_text(item.title, item.city, category, trip_i))
    await session.commit()
    await send_safely(notifier, message)


# ---------------------------------------------------------------- confirm_booking


async def confirm_booking(
    session: AsyncSession, booking_id: int, ok: bool, notifier: Notifier
) -> None:
    """Commits `session` itself, then replies."""
    booking = await session.get(Booking, booking_id, with_for_update=True)
    if booking is None:
        log.info("confirm_booking: booking %s not found", booking_id)
        await session.commit()
        return
    chat_id, reply_to = await _booking_chat(session, booking)

    if booking.confirmed_at is not None:
        # "Да" pressed twice, or "Нет" after "Да": never delete a confirmed booking.
        await session.commit()
        await send_safely(notifier, OutMessage(chat_id, ALREADY_CONFIRMED_TEXT, reply_to))
        return

    if not ok:
        await session.delete(booking)  # cascades to its reminders
        await session.commit()
        await send_safely(notifier, OutMessage(chat_id, REJECTED_TEXT, reply_to))
        return

    booking.confirmed_at = datetime.now(UTC)
    await session.flush()
    reminders = []
    try:
        reminders = await scheduler.schedule_for_booking(session, booking)
    except NotImplementedError:
        log.warning("scheduler.schedule_for_booking not implemented yet; booking %s confirmed "
                    "without reminders", booking.id)  # fmt: skip
    if reminders:
        text = "Готово, бронь сохранена. Напомню заранее."
    elif booking.starts_at is None:
        text = "Готово, бронь сохранена. Даты нет, поэтому напоминания не будет."
    else:
        text = "Готово, бронь сохранена."
    await session.commit()
    await send_safely(notifier, OutMessage(chat_id, text, reply_to))


async def _booking_chat(session: AsyncSession, booking: Booking) -> tuple[int, int | None]:
    if booking.item_id is not None:
        item = await session.get(Item, booking.item_id)
        if item is not None:
            return item.telegram_chat_id, item.telegram_message_id
    user = await session.get(User, booking.user_id)
    return (user.telegram_id if user else 0), None
