"""`python -m assistant.kp`: the КП worker (`kp:extract`: KP_EXTRACT in parts, prices by code,
version 1). Without a provider key the router has no adapters and a КП fails with the consent /
unavailable message instead of waiting forever."""

import asyncio
from typing import Any

from assistant.ai import Router, build_router
from assistant.config import Settings, get_settings
from assistant.db.session import get_engine, get_sessionmaker
from assistant.dedup import job_loop
from assistant.kp import JOB_EXTRACT, run_extract
from assistant.logs import configure_logging
from assistant.records.worker import install_signal_handlers


def handlers(maker: Any, router: Router | None, settings: Settings) -> dict[str, Any]:
    async def extract(payload: dict, job_id: int) -> None:
        await run_extract(maker, router, settings, payload, job_id)

    return {JOB_EXTRACT: extract}


async def main() -> None:
    settings = get_settings()
    configure_logging(settings.log_level)
    maker = get_sessionmaker()
    router = build_router(settings, maker)
    stop = asyncio.Event()
    install_signal_handlers(stop)
    try:
        await job_loop(maker, handlers(maker, router if router.adapters else None, settings), stop,
                       settings.worker_poll_seconds)  # fmt: skip
    finally:
        await get_engine().dispose()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
