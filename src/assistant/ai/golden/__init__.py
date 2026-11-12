"""Golden set (spec 3-engineering 5.8, R-23): cases, a runner and the admission report.

    python -m assistant.ai.golden                      # offline, recorded cassettes (CI)
    python -m assistant.ai.golden --live               # real providers (keys in env), later
    python -m assistant.ai.golden --json out.json      # metrics only, for CI artifacts

Data: `eval/golden/synthetic/*.yaml` (format in `cases.py`, contract `docs/ops/golden.md`).
Only the synthetic part is in the repository; the full anonymised set lives in the KZ bucket
`eval-golden/` and runs on a self-hosted KZ runner (`golden-real`, not set up yet).

Public: `load_cases`, `run_golden` → `Report`, `THRESHOLDS`.
"""

from assistant.ai.golden.cases import Case, load_cases
from assistant.ai.golden.report import THRESHOLDS, Report, build_report, render, to_json
from assistant.ai.golden.runner import run_golden

__all__ = ["THRESHOLDS", "Case", "Report", "build_report", "load_cases", "render", "run_golden",
           "to_json"]
