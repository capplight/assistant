"""Repeats (spec 6.3): similar-record groups, «Объединить?», the cleanup plan «37 → 1».

Public surface for other modules:
- `schedule_scan(session, user_id, origin=, import_id=)`: after records were saved or changed.
- `record_exact_merge`, `on_unmerged`, `exact_merge_action_id`: the automatic exact merge on save.
- `merge_group`, `merge_groups` (several at once), `dismiss_group`, `plan_cleanup`,
  `run_cleanup`, `groups_dicts`, `DedupError`.
- `scan_user`, `run_scan_job`, `JOB_SCAN`; `similarity` (pure code).
- `job_loop`, `drain`, `run_one`: the small job loop of the week-10 workers.
Worker entry: `python -m assistant.dedup` (scans and stack rebuilds).
Contract: docs/api/duplicates.md.
"""

from assistant.dedup import similarity
from assistant.dedup.jobs import JOB_SCAN, run_scan_job, schedule_scan
from assistant.dedup.scan import ScanResult, scan_user
from assistant.dedup.service import (
    DedupError,
    dismiss_group,
    exact_merge_action_id,
    get_group,
    groups_dicts,
    merge_group,
    merge_groups,
    on_unmerged,
    open_near_groups,
    plan_cleanup,
    record_exact_merge,
    run_cleanup,
)
from assistant.dedup.worker import drain, job_loop, run_one

__all__ = [
    "JOB_SCAN", "DedupError", "ScanResult", "dismiss_group", "drain", "exact_merge_action_id",
    "get_group", "groups_dicts", "job_loop", "merge_group", "merge_groups", "on_unmerged",
    "open_near_groups",
    "plan_cleanup", "record_exact_merge", "run_cleanup", "run_one", "run_scan_job", "scan_user",
    "schedule_scan", "similarity",
]  # fmt: skip
