"""Stacks (spec 6.4): groups of records by an envelope key, shown as groups inside pages.

Public surface: `schedule_rebuild(session, user_id)` (after anything new is known about a
person's records), `rebuild_user`, `JOB_REBUILD`, `group_rows_ops`, `refresh_count`,
`get_stack`. The API is in `assistant.api.routes.collections` (contract: docs/api/stacks.md).
Jobs run in `python -m assistant.dedup`.
"""

from assistant.stacks.service import (
    JOB_REBUILD,
    get_stack,
    group_rows_ops,
    keys_of,
    rebuild_user,
    refresh_count,
    schedule_rebuild,
)

__all__ = ["JOB_REBUILD", "get_stack", "group_rows_ops", "keys_of", "rebuild_user",
           "refresh_count", "schedule_rebuild"]  # fmt: skip
