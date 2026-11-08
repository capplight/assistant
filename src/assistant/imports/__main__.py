"""`python -m assistant.imports`: worker-import (Telegram export files; spec 1.2). Reads uploads
from the object store, writes records; no provider calls of its own (enrichment is queued)."""

import asyncio

from assistant.config import get_settings
from assistant.db.session import get_engine, get_sessionmaker
from assistant.dedup import job_loop
from assistant.imports import handlers
from assistant.logs import configure_logging
from assistant.records.worker import install_signal_handlers


async def main() -> None:
    from assistant.api import storage_from_settings  # the same object store the API writes to

    settings = get_settings()
    configure_logging(settings.log_level)
    maker = get_sessionmaker()
    stop = asyncio.Event()
    install_signal_handlers(stop)
    try:
        await job_loop(maker, handlers(maker, storage_from_settings(settings)), stop,
                       settings.worker_poll_seconds)  # fmt: skip
    finally:
        await get_engine().dispose()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
