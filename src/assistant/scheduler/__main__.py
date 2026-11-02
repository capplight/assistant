"""Reminder loop: `python -m assistant.scheduler`.

Every settings.scheduler_tick_seconds sends due reminders in one transaction. Several
instances may run at once (rows are claimed with FOR UPDATE SKIP LOCKED).
"""

import asyncio
import contextlib
import logging
import signal

from assistant.config import get_settings
from assistant.db.session import session_scope
from assistant.notify import Notifier, TelegramNotifier
from assistant.scheduler import send_due

log = logging.getLogger("assistant.scheduler")


def make_bot():
    from aiogram import Bot
    from aiogram.client.session.aiohttp import AiohttpSession
    from aiogram.client.telegram import TelegramAPIServer

    s = get_settings()
    session = None
    if s.telegram_api_base:
        session = AiohttpSession(api=TelegramAPIServer.from_base(s.telegram_api_base))
    return Bot(token=s.bot_token.get_secret_value(), session=session)


async def tick(notifier: Notifier) -> int:
    async with session_scope() as session:
        return await send_due(session, notifier)


async def run(stop: asyncio.Event, notifier: Notifier, interval: float) -> None:
    while not stop.is_set():
        try:
            sent = await tick(notifier)
            if sent:
                log.info("sent %d reminders", sent)
        except Exception:
            log.exception("scheduler tick failed")
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(stop.wait(), timeout=interval)


def _install_signal_handlers(stop: asyncio.Event) -> None:
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except (NotImplementedError, RuntimeError, ValueError):
            # Windows: no loop signal handlers; Ctrl+C arrives as KeyboardInterrupt instead.
            pass


async def main() -> None:
    s = get_settings()
    logging.basicConfig(level=s.log_level, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    stop = asyncio.Event()
    _install_signal_handlers(stop)
    bot = make_bot()
    try:
        log.info("scheduler started, tick %.0fs", s.scheduler_tick_seconds)
        await run(stop, TelegramNotifier(bot), s.scheduler_tick_seconds)
    finally:
        await bot.session.close()
        log.info("scheduler stopped")


if __name__ == "__main__":
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(main())
