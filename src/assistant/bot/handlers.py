"""aiogram handlers. Thin: parse with plain functions, act through `service`, reply with `texts`."""

import logging
from collections.abc import Awaitable

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
from assistant.config import get_settings
from assistant.db.models import User
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


async def on_start(message: Message, user: User) -> None:
    await message.answer(texts.START)
    if user.consent_at is None:
        await message.answer(texts.CONSENT, reply_markup=consent_kb())


async def on_help(message: Message) -> None:
    await message.answer(texts.HELP)


async def on_trip(
    message: Message, command: CommandObject, session: AsyncSession, user: User
) -> None:
    if not (command.args or "").strip():
        await message.answer(texts.TRIP_USAGE)
        return
    try:
        spec = parse_trip_args(command.args, local_today(user.tz))
    except DateParseError:
        await message.answer(texts.TRIP_BAD_DATES)
        return
    trip = await service.create_trip(session, user, spec)
    if trip.starts_on and trip.ends_on:
        text = texts.TRIP_CREATED_DATES.format(
            title=trip.title, dates=format_range(trip.starts_on, trip.ends_on)
        )
    else:
        text = texts.TRIP_CREATED.format(title=trip.title)
    await message.answer(text)


async def on_trips(message: Message, session: AsyncSession, user: User) -> None:
    trips = await service.list_trips(session, user.id)
    if not trips:
        await message.answer(texts.TRIPS_EMPTY)
        return
    rows = []
    for t in trips:
        label = t.title
        if t.starts_on and t.ends_on:
            label += f" ({format_range(t.starts_on, t.ends_on)})"
        if t.is_active:
            label = "✓ " + label
        rows.append([(label[:60], cb.trip_cb(t.id))])
    await message.answer(texts.TRIPS_HEADER, reply_markup=_kb(*rows))


async def on_delete_all(message: Message) -> None:
    await message.answer(
        texts.DELETE_CONFIRM,
        reply_markup=_kb([(texts.DELETE_YES, cb.DELETE_YES), (texts.DELETE_NO, cb.DELETE_NO)]),
    )


# --- intake -----------------------------------------------------------------------------


async def _ask(message: Message, coro: Awaitable[qa.Answer]) -> None:
    try:
        answer = await coro
    except NotImplementedError:
        await message.reply(texts.QA_NOT_READY)
        return
    await message.reply(answer.text or texts.QA_EMPTY)


async def on_message(message: Message, session: AsyncSession, user: User) -> None:
    if message.text and message.text.startswith("/"):  # unknown command
        await message.answer(texts.HELP)
        return
    intake = classify(message)

    if intake.action is Action.LOCATION:
        assert intake.lat is not None and intake.lon is not None
        await _ask(message, qa.nearby(session, user.id, qa.Location(intake.lat, intake.lon)))
        return
    if intake.action is Action.QUESTION:
        assert intake.question is not None
        await _ask(message, qa.answer(session, user.id, intake.question))
        return
    if intake.action is Action.IGNORE:
        await message.reply(texts.NOTHING_TO_SAVE)
        return

    drafts = intake.drafts
    hashes = [d.url_hash for d in drafts if d.url_hash]
    existing = await service.existing_url_hashes(session, user.id, hashes)
    new = [d for d in drafts if d.url_hash is None or d.url_hash not in existing]
    if not new:
        await message.reply(texts.ALREADY_SAVED)
        return

    limit = get_settings().free_items_per_month
    if not await service.can_save_more(session, user, limit):
        await message.reply(texts.FREE_LIMIT_REACHED.format(limit=limit))
        return

    await service.save_items(
        session, user, new, chat_id=message.chat.id, message_id=message.message_id
    )
    if user.consent_at is None:
        await message.reply(texts.SAVED_WAITING_CONSENT, reply_markup=consent_kb())
    elif len(new) < len(drafts):
        await message.reply(texts.ACCEPTED_SOME_DUPLICATES)
    else:
        await message.reply(texts.ACCEPTED)


# --- callbacks --------------------------------------------------------------------------


async def on_callback(
    query: CallbackQuery, session: AsyncSession, user: User | None, bot: Bot
) -> None:
    parsed = cb.parse_callback(query.data)
    if parsed is None or user is None:
        await query.answer(texts.CALLBACK_UNKNOWN)
        return
    chat_id = query.message.chat.id if query.message else user.telegram_id
    notifier = TelegramNotifier(bot)

    match parsed:
        case cb.Consent():
            n = await service.give_consent(session, user)
            await query.answer(texts.CALLBACK_DONE)
            if n is None:
                text = texts.CONSENT_ALREADY
            elif n:
                text = texts.CONSENT_THANKS_PENDING.format(n=n)
            else:
                text = texts.CONSENT_THANKS
            await bot.send_message(chat_id, text)

        case cb.SwitchTrip(trip_id=trip_id):
            trip = await service.switch_trip(session, user.id, trip_id)
            if trip is None:
                await query.answer(texts.TRIP_NOT_FOUND)
                return
            await query.answer(texts.CALLBACK_DONE)
            await bot.send_message(chat_id, texts.TRIP_SWITCHED.format(title=trip.title))

        case cb.Pick(item_id=item_id, option_index=idx):
            if not await service.owns_item(session, user.id, item_id):
                await query.answer(texts.CALLBACK_NOT_FOUND)
                return
            await query.answer(texts.CALLBACK_DONE)
            try:
                await pipeline.handle_choice(session, item_id, idx, notifier)
            except NotImplementedError:
                log.warning("pipeline.handle_choice not implemented yet")

        case cb.BookingAnswer(booking_id=booking_id, ok=ok):
            if not await service.owns_booking(session, user.id, booking_id):
                await query.answer(texts.CALLBACK_NOT_FOUND)
                return
            await query.answer(texts.CALLBACK_DONE)
            try:
                await pipeline.confirm_booking(session, booking_id, ok, notifier)
            except NotImplementedError:
                log.warning("pipeline.confirm_booking not implemented yet")

        case cb.DeleteAll(confirmed=confirmed):
            await query.answer(texts.CALLBACK_DONE)
            if confirmed:
                await service.delete_user(session, user.id)
                await bot.send_message(chat_id, texts.DELETE_DONE)
            else:
                await bot.send_message(chat_id, texts.DELETE_CANCELLED)


# --- errors -----------------------------------------------------------------------------


async def on_error(event: ErrorEvent, bot: Bot) -> bool:
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
        except Exception:
            log.exception("could not report error to chat %s", chat_id)
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
