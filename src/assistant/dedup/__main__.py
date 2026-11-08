"""`python -m assistant.dedup`: repeat scans (`dedup:scan`, DUP_JUDGE for borderline pairs) and
stack rebuilds (`stacks:rebuild`, STACK_NAME). No router without a provider key: scans then use
code thresholds only, and stacks wait (unless `stacks_names_by_code`)."""

import asyncio
from typing import Any

from assistant.ai import Router, build_router
from assistant.config import get_settings
from assistant.db.session import get_engine, get_sessionmaker
from assistant.dedup import JOB_SCAN, job_loop, run_scan_job
from assistant.logs import configure_logging
from assistant.records.worker import install_signal_handlers
from assistant.stacks import JOB_REBUILD, rebuild_user


def handlers(maker: Any, router: Router | None) -> dict[str, Any]:
    async def scan(payload: dict, job_id: int) -> None:
        await run_scan_job(maker, router, payload, job_id)

    async def stacks(payload: dict, job_id: int) -> None:
        await rebuild_user(maker, router, int(payload["user_id"]))

    return {JOB_SCAN: scan, JOB_REBUILD: stacks}


async def main() -> None:
    settings = get_settings()
    configure_logging(settings.log_level)
    maker = get_sessionmaker()
    router = build_router(settings, maker)
    stop = asyncio.Event()
    install_signal_handlers(stop)
    try:
        await job_loop(maker, handlers(maker, router if router.adapters else None), stop,
                       settings.worker_poll_seconds)  # fmt: skip
    finally:
        await get_engine().dispose()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
