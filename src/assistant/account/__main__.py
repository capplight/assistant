"""`python -m assistant.account`: worker-account (export archives, account purge)."""

import asyncio

from assistant.config import get_settings
from assistant.db.session import get_engine, get_sessionmaker
from assistant.logs import configure_logging
from assistant.records.worker import install_signal_handlers


async def main() -> None:
    from assistant.account.worker import worker_loop
    from assistant.api.app import storage_from_settings
    from assistant.chat.push import LogPushSender
    from assistant.kp.secret import FieldCipher

    settings = get_settings()
    configure_logging(settings.log_level)
    stop = asyncio.Event()
    install_signal_handlers(stop)
    try:
        await worker_loop(get_sessionmaker(), storage_from_settings(settings),
                          FieldCipher.from_settings(settings), settings, stop,
                          settings.worker_poll_seconds, push=LogPushSender())  # fmt: skip
    finally:
        await get_engine().dispose()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
