"""`python -m assistant.chat`: chat worker (spec 6.11): finishes answers nobody finished
(`chat:complete`, push «Ответ готов») and folds old messages (`chat:summarize`)."""

import asyncio

from assistant.ai import build_router
from assistant.chat.jobs import worker_loop
from assistant.chat.push import LogPushSender
from assistant.chat.service import ChatService
from assistant.config import get_settings
from assistant.db.session import get_engine, get_sessionmaker
from assistant.embeddings import chunk_embedder_from_settings
from assistant.logs import configure_logging
from assistant.records.worker import install_signal_handlers


async def main() -> None:
    settings = get_settings()
    configure_logging(settings.log_level)
    maker = get_sessionmaker()
    embedder = chunk_embedder_from_settings(settings,
                                            timeout=settings.search_embed_timeout_seconds)
    service = ChatService(settings, maker, build_router(settings, maker), embedder,
                          push=LogPushSender())  # fmt: skip
    stop = asyncio.Event()
    install_signal_handlers(stop)
    try:
        await worker_loop(service, stop, settings.worker_poll_seconds)
    finally:
        await service.drain()
        await get_engine().dispose()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
