"""Imports (spec 6.10): Telegram Desktop export file → records on pages, repeats left out.

Public surface: `telegram` (pure parser), `enqueue_import`, `run_import`, `run_enrich_wave`,
`JOB_IMPORT`, `JOB_ENRICH_WAVE`, `handlers(maker, storage)`. API: `assistant.api.routes.imports`
(contract: docs/api/import.md). Worker entry: `python -m assistant.imports` (spec 1.2:
worker-import, its own queue).
"""

from typing import Any

from assistant.imports import telegram
from assistant.imports.service import (
    JOB_ENRICH_WAVE,
    JOB_IMPORT,
    enqueue_import,
    run_enrich_wave,
    run_import,
)


def handlers(maker: Any, storage: Any) -> dict[str, Any]:
    async def imp(payload: dict, job_id: int) -> None:
        await run_import(maker, storage, int(payload["import_id"]))

    async def wave(payload: dict, job_id: int) -> None:
        await run_enrich_wave(maker, int(payload["import_id"]), int(payload.get("wave", 0)),
                              int(payload.get("checks", 0)))

    return {JOB_IMPORT: imp, JOB_ENRICH_WAVE: wave}


__all__ = ["JOB_ENRICH_WAVE", "JOB_IMPORT", "enqueue_import", "handlers", "run_enrich_wave",
           "run_import", "telegram"]  # fmt: skip
