"""`python -m assistant.memory`: worker-embed (chunks + bge-m3 through local TEI, spec 1)."""

import asyncio

from assistant.config import get_settings
from assistant.db.session import get_engine, get_sessionmaker
from assistant.embeddings import make_chunk_embedder
from assistant.logs import configure_logging
from assistant.memory.worker import worker_loop
from assistant.records.worker import install_signal_handlers


async def main() -> None:
    settings = get_settings()
    configure_logging(settings.log_level)
    embedder = make_chunk_embedder(settings.chunk_embedder, url=settings.tei_url,
                                   model=settings.chunk_embedding_model,
                                   dim=settings.embeddings_dim)  # fmt: skip
    stop = asyncio.Event()
    install_signal_handlers(stop)
    try:
        await worker_loop(get_sessionmaker(), embedder, stop, settings.worker_poll_seconds)
    finally:
        await get_engine().dispose()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
