"""Run golden cases one after another against cassettes (offline) or live providers."""

import logging
from pathlib import Path

from assistant.ai.golden.cases import CassetteAdapter, cassette_router, live_router, load_cases
from assistant.ai.golden.report import Report, build_report
from assistant.ai.golden.suites import run_case
from assistant.config import Settings


async def run_golden(path: Path | str | None = None, *, live: bool = False,
                     kinds: set[str] | None = None,
                     settings: Settings | None = None) -> Report:  # fmt: skip
    cases = [c for c in load_cases(path) if kinds is None or c.kind in kinds]
    adapter = CassetteAdapter(live=live)
    router, store = live_router(settings) if live else cassette_router(adapter)
    # Code paths log what they drop (number checks, …): quiet during a run, never case text.
    quiet = logging.getLogger("assistant")
    level = quiet.level
    quiet.setLevel(logging.ERROR)
    try:
        outs = [await run_case(c, router, adapter) for c in cases]
    finally:
        quiet.setLevel(level)
    return build_report(outs, store.usage, mode="live" if live else "cassette")
