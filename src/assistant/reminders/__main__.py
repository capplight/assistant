"""Reminder loop for the app: `python -m assistant.reminders`.

Every settings.reminders_tick_seconds: backup push (+3 min without `fired_local`), `missed`
(+30 min), top-up of repeating reminders. Several instances may run (rows are claimed with FOR
UPDATE SKIP LOCKED). Push credentials do not exist yet: LogPushSender only logs (UNVERIFIED
delivery). The Telegram bot's own reminders stay in `python -m assistant.scheduler`.
"""

import asyncio
import contextlib
import logging
import signal

from assistant.chat.push import LogPushSender, PushSender
from assistant.config import get_settings
from assistant.db.session import get_sessionmaker
from assistant.logs import configure_logging, error_text
from assistant.reminders import worker

log = logging.getLogger("assistant.reminders")


async def run(stop: asyncio.Event, sender: PushSender, interval: float) -> None:
    maker = get_sessionmaker()
    while not stop.is_set():
        try:
            res = await worker.tick(maker, sender)
            if res.backup or res.missed or res.topped_up:
                log.info("reminders: %d backup, %d missed, %d topped up", res.backup, res.missed,
                         res.topped_up)  # fmt: skip
        except Exception as exc:
            log.error("reminders tick failed: %s", error_text(exc))
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(stop.wait(), timeout=interval)


async def main() -> None:
    s = get_settings()
    configure_logging(s.log_level)
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        with contextlib.suppress(NotImplementedError, RuntimeError, ValueError):
            loop.add_signal_handler(sig, stop.set)
    log.info("reminders loop started, tick %.0fs", s.reminders_tick_seconds)
    await run(stop, LogPushSender(), s.reminders_tick_seconds)


if __name__ == "__main__":
    with contextlib.suppress(KeyboardInterrupt):
        asyncio.run(main())
