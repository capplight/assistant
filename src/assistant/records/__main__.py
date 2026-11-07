"""`python -m assistant.records`: the records worker (OCR, STT, document and link text, enrichment
through the AI router; no router when no AI provider has a key)."""

import asyncio

from assistant.ai import build_router
from assistant.config import get_settings
from assistant.db.session import get_engine, get_sessionmaker
from assistant.logs import configure_logging
from assistant.pipeline import LinkMetadataClient
from assistant.records.adapters import make_ocr, make_transcriber
from assistant.records.ingest import IngestDeps
from assistant.records.links import WebLinkReader
from assistant.records.worker import install_signal_handlers, worker_loop


async def main() -> None:
    from assistant.api import storage_from_settings  # the same object store the API writes to

    settings = get_settings()
    configure_logging(settings.log_level)
    maker = get_sessionmaker()
    router = build_router(settings, maker)
    token = settings.instagram_oembed_token.get_secret_value() or None
    links = LinkMetadataClient(instagram_access_token=token)
    deps = IngestDeps(storage=storage_from_settings(settings), ocr=make_ocr(settings.ocr_provider),
                      transcriber=make_transcriber(settings.stt_provider),
                      ocr_langs=settings.ocr_langs, links=WebLinkReader(links),
                      router=router if router.adapters else None, settings=settings)  # fmt: skip
    stop = asyncio.Event()
    install_signal_handlers(stop)
    n = max(1, settings.worker_concurrency)
    try:
        await asyncio.gather(*(worker_loop(maker, deps, stop, settings.worker_poll_seconds)
                               for _ in range(n)))  # fmt: skip
    finally:
        await links.aclose()
        await get_engine().dispose()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
