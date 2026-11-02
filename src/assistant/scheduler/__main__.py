"""Reminder loop: `python -m assistant.scheduler`.

Every settings.scheduler_tick_seconds sends due reminders, each in its own short
transactions (see assistant.scheduler.service). Several instances may run at once (rows are
claimed with FOR UPDATE SKIP LOCKED plus a short lease). Once an hour it also deletes
processed_updates rows older than 7 days.
"""

import asyncio
import contextlib
import logging
import signal
import time

from assistant.config import get_settings
from assistant.db.session import get_sessionmaker, session_scope
from assistant.logs import configure_logging, error_text
from assistant.notify import Notifier, TelegramNotifier
from assistant.scheduler import send_due
from assistant.scheduler.service import cleanup_processed_updates

log = logging.getLogger("assistant.scheduler")

CLEANUP_EVERY_SECONDS = 3600.0


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
    return await send_due(None, notifier, sessionmaker=get_sessionmaker())


async def cleanup() -> int:
    async with session_scope() as session:
        return await cleanup_processed_updates(session)


class _Every:
    """True at most once per `seconds` (monotonic clock); the first call is True."""

    def __init__(self, seconds: float, clock=time.monotonic) -> None:
        self._seconds, self._clock = seconds, clock
        self._last: float | None = None

    def due(self) -> bool:
        now = self._clock()
        if self._last is not None and now - self._last < self._seconds:
            return False
        self._last = now
        return True


async def run(stop: asyncio.Event, notifier: Notifier, interval: float) -> None:
    cleanup_timer = _Every(CLEANUP_EVERY_SECONDS)
    while not stop.is_set():
        try:
            sent = await tick(notifier)
            if sent:
                log.info("sent %d reminders", sent)
        except Exception as exc:
            log.error("scheduler tick failed: %s", error_text(exc))
        if cleanup_timer.due():
            try:
                deleted = await cleanup()
                if deleted:
                    log.info("deleted %d old processed_updates", deleted)
            except Exception as exc:
                log.error("processed_updates cleanup failed: %s", error_text(exc))
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
    configure_logging(s.log_level)
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
