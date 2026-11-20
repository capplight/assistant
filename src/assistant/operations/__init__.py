"""Operations shared by the screens (REST) and the assistant line (Ф-95, phase 0 of
docs/spec/proposals/chat-full-control.md; contract notes: docs/api/actions.md «Operations»).

Public surface: `run(name, session, user_id, args, by=, now=)` → `OpResult` (one action with
its undo, in the caller's transaction), `build(name, …)` → `Built` (the engine ops without
writing, for the line's own action), `get`, `names`, `REGISTRY`, `OpError`.

Registered (see `names()`): tasks (create, update, reschedule, remove_occurrence, set_done,
delete, clear_done), `calendar.shift_many`, expenses (update, delete), reminders (create, update,
delete), `records.trash`, plans on the calendar (`plans.to_calendar`, `calendar.remove_plan`,
`calendar.shift_plan`). The line's domain tools are built from these (`chat/ops_line.py`).
"""

from assistant.operations import expenses, plans, records, reminders, tasks
from assistant.operations.registry import (
    REGISTRY,
    Built,
    Operation,
    OpError,
    OpResult,
    build,
    get,
    names,
    register,
    run,
)

__all__ = ["REGISTRY", "Built", "OpError", "OpResult", "Operation", "build", "expenses", "get",
           "names", "plans", "records", "register", "reminders", "run", "tasks"]  # fmt: skip
