"""Job worker: `python -m assistant.worker`.

Runs settings.worker_concurrency loops; each claims one process_item job at a time from the
Postgres queue, runs it (process_item manages its own short transactions and never keeps one
open across network calls) and records the result. Error text stored in jobs.last_error goes
through assistant.logs.error_text(): Bot API URLs contain the bot token.
"""

import asyncio
import logging
import signal

from assistant.config import get_settings
from assistant.db import queue
from assistant.db.models import Job
from assistant.db.session import get_engine, get_sessionmaker
from assistant.logs import configure_logging, error_text
from assistant.notify import Notifier, TelegramNotifier
from assistant.pipeline import JOB_PROCESS_ITEM
from assistant.pipeline.deps import Deps, build_deps, set_deps
from assistant.pipeline.service import fail_item, process_item

log = logging.getLogger("assistant.worker")


def job_item_id(job: Job) -> int | None:
    value = (job.payload or {}).get("item_id")
    try:
        return int(value) if value is not None else None
    except (TypeError, ValueError):
        return None


async def run_one(notifier: Notifier, deps: Deps) -> bool:
    """Claim and run one job. Returns False when the queue was empty."""
    sessionmaker = get_sessionmaker()
    async with sessionmaker() as s:
        job = await queue.claim(s, [JOB_PROCESS_ITEM])
        await s.commit()
    if job is None:
        return False

    job_id, item_id = job.id, job_item_id(job)
    error: str | None = None
    if item_id is None:
        error = "bad payload: no item_id"
    else:
        try:
            async with sessionmaker() as s:
                await process_item(s, item_id, notifier, deps)  # commits itself
        except Exception as e:
            error = error_text(e)
            log.exception("job %s (item %s) failed: %s", job_id, item_id, error)  # redacted

    async with sessionmaker() as s:
        job = await s.get(Job, job_id, with_for_update=True)
        if job is None:
            return True
        if error is None:
            await queue.complete(s, job)
            await s.commit()
            return True
        gave_up = await queue.fail(s, job, error)
        await s.commit()
    if gave_up and item_id is not None:
        try:
            async with sessionmaker() as s:
                await fail_item(s, item_id, error, notifier)  # commits FAILED, then sends
        except Exception as e:
            log.warning("could not mark item %s failed: %s", item_id, error_text(e))
    return True


async def worker_loop(n: int, stop: asyncio.Event, notifier: Notifier, deps: Deps) -> None:
    poll = get_settings().worker_poll_seconds
    while not stop.is_set():
        try:
            busy = await run_one(notifier, deps)
        except Exception:  # DB down etc.: keep the loop alive
            log.exception("worker %s: loop error", n)
            busy = False
        if not busy:
            try:
                await asyncio.wait_for(stop.wait(), timeout=poll)
            except TimeoutError:
                pass


def make_bot(token: str, api_base: str):
    from aiogram import Bot

    if api_base:
        from aiogram.client.session.aiohttp import AiohttpSession
        from aiogram.client.telegram import TelegramAPIServer

        session = AiohttpSession(api=TelegramAPIServer.from_base(api_base.rstrip("/")))
        return Bot(token, session=session)
    return Bot(token)


def install_signal_handlers(stop: asyncio.Event) -> None:
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except (NotImplementedError, RuntimeError, ValueError):
            # Windows: no loop signal handlers; fall back to the C-level handler.
            signal.signal(sig, lambda *_: loop.call_soon_threadsafe(stop.set))


async def main() -> None:
    settings = get_settings()
    configure_logging(settings.log_level)  # redacts tokens, silences httpx request logs
    bot = make_bot(settings.bot_token.get_secret_value(), settings.telegram_api_base)
    notifier = TelegramNotifier(bot)
    deps = build_deps(settings)
    set_deps(deps)  # handle_choice/confirm_booking in this process share the clients

    stop = asyncio.Event()
    install_signal_handlers(stop)
    n = max(1, settings.worker_concurrency)
    log.info("worker started: %s loops", n)
    try:
        await asyncio.gather(*(worker_loop(i, stop, notifier, deps) for i in range(n)))
    finally:
        log.info("worker stopping")
        await deps.aclose()
        await bot.session.close()
        await get_engine().dispose()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
