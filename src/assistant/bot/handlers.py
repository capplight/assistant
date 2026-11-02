"""aiogram handlers. Thin: parse with plain functions, act through `service`, reply with `texts`.

Handlers never call Telegram directly: replies are queued in the per-update `outbox` and go
out only after the update's transaction committed (see `middleware.DbSessionMiddleware`).
"""

import logging
from collections.abc import Awaitable, Callable
from functools import partial

from aiogram import Bot, F, Router
from aiogram.filters import Command, CommandObject, CommandStart
from aiogram.types import (
    CallbackQuery,
    ErrorEvent,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    Message,
)
from sqlalchemy.ext.asyncio import AsyncSession

from assistant import pipeline, qa
from assistant.bot import callbacks as cb
from assistant.bot import service, texts
from assistant.bot.dates import DateParseError, format_range, local_today, parse_trip_args
from assistant.bot.intake import Action, classify
from assistant.bot.middleware import SessionFactory
from assistant.bot.outbox import Outbox
from assistant.config import get_settings
from assistant.db.models import User
from assistant.logs import error_text
from assistant.notify import TelegramNotifier

log = logging.getLogger(__name__)


def _kb(*rows: list[tuple[str, str]]) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text=t, callback_data=d) for t, d in row] for row in rows
        ]
    )


def consent_kb() -> InlineKeyboardMarkup:
    return _kb([(texts.CONSENT_BUTTON, cb.CONSENT_YES)])


# --- commands ---------------------------------------------------------------------------


async def on_start(message: Message, user: User, outbox: Outbox) -> None:
    outbox.answer(message, texts.START)
    if user.consent_at is None:
        outbox.answer(message, texts.CONSENT, reply_markup=consent_kb())


async def on_help(message: Message, outbox: Outbox) -> None:
    outbox.answer(message, texts.HELP)


async def on_trip(
    message: Message, command: CommandObject, session: AsyncSession, user: User, outbox: Outbox
) -> None:
    if not (command.args or "").strip():
        outbox.answer(message, texts.TRIP_USAGE)
        return
    try:
        spec = parse_trip_args(command.args, local_today(user.tz))
    except DateParseError:
        outbox.answer(message, texts.TRIP_BAD_DATES)
        return
    trip = await service.create_trip(session, user, spec)
    if trip.starts_on and trip.ends_on:
        text = texts.TRIP_CREATED_DATES.format(
            title=trip.title, dates=format_range(trip.starts_on, trip.ends_on)
        )
    else:
        text = texts.TRIP_CREATED.format(title=trip.title)
    outbox.answer(message, text)


async def on_trips(message: Message, session: AsyncSession, user: User, outbox: Outbox) -> None:
    trips = await service.list_trips(session, user.id)
    if not trips:
        outbox.answer(message, texts.TRIPS_EMPTY)
        return
    rows = []
    for t in trips:
        label = t.title
        if t.starts_on and t.ends_on:
            label += f" ({format_range(t.starts_on, t.ends_on)})"
        if t.is_active:
            label = "✓ " + label
        rows.append([(label[:60], cb.trip_cb(t.id))])
    outbox.answer(message, texts.TRIPS_HEADER, reply_markup=_kb(*rows))


async def on_delete_all(message: Message, outbox: Outbox) -> None:
    outbox.answer(
        message,
        texts.DELETE_CONFIRM,
        reply_markup=_kb([(texts.DELETE_YES, cb.DELETE_YES), (texts.DELETE_NO, cb.DELETE_NO)]),
    )


# --- intake -----------------------------------------------------------------------------

Ask = Callable[[AsyncSession], Awaitable[qa.Answer]]


async def _ask(message: Message, session_factory: SessionFactory, ask: Ask) -> None:
    """Runs from the outbox, after the update's transaction committed.

    qa makes LLM/embedding calls, so it gets its own short session instead of the update's
    one (which held the users row lock from the upsert).
    """
    try:
        async with session_factory() as session:
            answer = await ask(session)
    except NotImplementedError:
        text = texts.QA_NOT_READY
    except Exception as exc:
        log.error("question from chat %s failed: %s", message.chat.id, error_text(exc))
        text = texts.ERROR
    else:
        text = answer.text or texts.QA_EMPTY
    await message.reply(text)


async def on_message(
    message: Message,
    session: AsyncSession,
    user: User,
    outbox: Outbox,
    session_factory: SessionFactory,
) -> None:
    if message.text and message.text.startswith("/"):  # unknown command
        outbox.answer(message, texts.HELP)
        return
    intake = classify(message)
    user_id = user.id

    if intake.action is Action.LOCATION:
        assert intake.lat is not None and intake.lon is not None
        loc = qa.Location(intake.lat, intake.lon)
        outbox.add(partial(_ask, message, session_factory, lambda s: qa.nearby(s, user_id, loc)))
        return
    if intake.action is Action.QUESTION:
        question = intake.question
        assert question is not None
        outbox.add(
            partial(_ask, message, session_factory, lambda s: qa.answer(s, user_id, question))
        )
        return
    if intake.action is Action.IGNORE:
        outbox.reply(message, texts.NOTHING_TO_SAVE)
        return

    drafts = intake.drafts
    hashes = [d.url_hash for d in drafts if d.url_hash]
    existing = await service.existing_url_hashes(session, user_id, hashes)
    new = [d for d in drafts if d.url_hash is None or d.url_hash not in existing]
    # A link that failed before is retried instead of being reported as already saved.
    retried = await service.retry_failed_items(session, user, sorted(existing))

    saved = 0
    if new:
        limit = get_settings().free_items_per_month
        if not await service.can_save_more(session, user, limit):
            outbox.reply(message, texts.FREE_LIMIT_REACHED.format(limit=limit))
            return
        # Fewer rows than drafts if a concurrent message saved the same link first.
        items = await service.save_items(
            session, user, new, chat_id=message.chat.id, message_id=message.message_id
        )
        saved = len(items)

    if saved + retried == 0:
        outbox.reply(message, texts.ALREADY_SAVED)
    elif user.consent_at is None:
        outbox.reply(message, texts.SAVED_WAITING_CONSENT, reply_markup=consent_kb())
    elif saved + retried < len(drafts):
        outbox.reply(message, texts.ACCEPTED_SOME_DUPLICATES)
    else:
        outbox.reply(message, texts.ACCEPTED)


# --- callbacks --------------------------------------------------------------------------


async def on_callback(
    query: CallbackQuery, session: AsyncSession, user: User | None, bot: Bot, outbox: Outbox
) -> None:
    parsed = cb.parse_callback(query.data)
    if parsed is None or user is None:
        outbox.answer_callback(query, texts.CALLBACK_UNKNOWN)
        return
    chat_id = query.message.chat.id if query.message else user.telegram_id
    # pipeline sends through this notifier; its messages also go out only after commit.
    notifier = outbox.notifier(TelegramNotifier(bot))

    def send(text: str) -> None:
        outbox.add(partial(bot.send_message, chat_id, text))

    match parsed:
        case cb.Consent():
            n = await service.give_consent(session, user)
            outbox.answer_callback(query, texts.CALLBACK_DONE)
            if n is None:
                send(texts.CONSENT_ALREADY)
            elif n:
                send(texts.CONSENT_THANKS_PENDING.format(n=n))
            else:
                send(texts.CONSENT_THANKS)

        case cb.SwitchTrip(trip_id=trip_id):
            trip = await service.switch_trip(session, user.id, trip_id)
            if trip is None:
                outbox.answer_callback(query, texts.TRIP_NOT_FOUND)
                return
            outbox.answer_callback(query, texts.CALLBACK_DONE)
            send(texts.TRIP_SWITCHED.format(title=trip.title))

        case cb.Pick(item_id=item_id, option_index=idx):
            if not await service.owns_item(session, user.id, item_id):
                outbox.answer_callback(query, texts.CALLBACK_NOT_FOUND)
                return
            outbox.answer_callback(query, texts.CALLBACK_DONE)
            try:
                await pipeline.handle_choice(session, item_id, idx, notifier)
            except NotImplementedError:
                log.warning("pipeline.handle_choice not implemented yet")

        case cb.BookingAnswer(booking_id=booking_id, ok=ok):
            if not await service.owns_booking(session, user.id, booking_id):
                outbox.answer_callback(query, texts.CALLBACK_NOT_FOUND)
                return
            outbox.answer_callback(query, texts.CALLBACK_DONE)
            try:
                await pipeline.confirm_booking(session, booking_id, ok, notifier)
            except NotImplementedError:
                log.warning("pipeline.confirm_booking not implemented yet")

        case cb.DeleteAll(confirmed=confirmed):
            outbox.answer_callback(query, texts.CALLBACK_DONE)
            if confirmed:
                await service.delete_user(session, user.id)
                send(texts.DELETE_DONE)
            else:
                send(texts.DELETE_CANCELLED)


# --- errors -----------------------------------------------------------------------------


async def on_error(event: ErrorEvent, bot: Bot) -> bool:
    """Runs after the update's transaction rolled back (its outbox was dropped).

    Returns True (handled): the webhook answers 200 and Telegram does not redeliver.
    """
    log.exception("update %s failed", event.update.update_id, exc_info=event.exception)
    chat_id = None
    if event.update.message:
        chat_id = event.update.message.chat.id
    elif event.update.callback_query:
        q = event.update.callback_query
        chat_id = q.message.chat.id if q.message else q.from_user.id
        try:
            await q.answer()
        except Exception:  # query may already be answered or expired
            pass
    if chat_id is not None:
        try:
            await bot.send_message(chat_id, texts.ERROR)
        except Exception as exc:
            log.warning("could not report error to chat %s: %s", chat_id, error_text(exc))
    return True


def build_router() -> Router:
    """A fresh router per Dispatcher (an aiogram router can be attached only once)."""
    router = Router(name="assistant")
    router.message.filter(F.chat.type == "private")
    router.message.register(on_start, CommandStart())
    router.message.register(on_help, Command("help"))
    router.message.register(on_trip, Command("trip"))
    router.message.register(on_trips, Command("trips"))
    router.message.register(on_delete_all, Command("delete_all"))
    router.message.register(on_message)
    router.callback_query.register(on_callback)
    router.errors.register(on_error)
    return router
