"""`python -m assistant.records`: the ingest worker (OCR, STT, document text; no AI calls)."""

import asyncio

from assistant.config import get_settings
from assistant.db.session import get_engine, get_sessionmaker
from assistant.logs import configure_logging
from assistant.records.adapters import make_ocr, make_transcriber
from assistant.records.ingest import IngestDeps
from assistant.records.worker import install_signal_handlers, worker_loop


async def main() -> None:
    from assistant.api import storage_from_settings  # the same object store the API writes to

    settings = get_settings()
    configure_logging(settings.log_level)
    deps = IngestDeps(storage=storage_from_settings(settings), ocr=make_ocr(settings.ocr_provider),
                      transcriber=make_transcriber(settings.stt_provider),
                      ocr_langs=settings.ocr_langs)  # fmt: skip
    stop = asyncio.Event()
    install_signal_handlers(stop)
    maker = get_sessionmaker()
    n = max(1, settings.worker_concurrency)
    try:
        await asyncio.gather(*(worker_loop(maker, deps, stop, settings.worker_poll_seconds)
                               for _ in range(n)))  # fmt: skip
    finally:
        await get_engine().dispose()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
