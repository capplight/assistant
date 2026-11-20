"""Engine ops of the calendar (0035, docs/api/calendar.md):

- `set_occurrence` {task, item, occurrence_at, values: {start_at?, duration_min?, done_at?,
  skipped?}, expect?}: one occurrence of a repeating task gets its own time / done / skip (the
  row is made on first use). Its reverse sets the old values back; a row that did not exist goes
  back to «no own values» (`remove: true` deletes it). `expect` = what this op left: a later
  change by the person makes the undo skip it.
- `set_reminder_time` {id, due_at, duration_min?, rrule?, expect?}: a reminder linked to a
  moved task moves with it (fires planned again; `rrule` follows a repeating task); the reverse
  is `restore_reminder`.
"""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.actions.engine import Outcome, _reminder, _task, reminder_state
from assistant.db.models_tasks import TaskOccurrence

OCC_FIELDS = frozenset({"start_at", "duration_min", "done_at", "skipped"})


def _iso(value: Any) -> Any:
    return value.isoformat() if isinstance(value, datetime) else value


def occ_values(row: TaskOccurrence | None) -> dict[str, Any]:
    if row is None:
        return {"start_at": None, "duration_min": None, "done_at": None, "skipped": False}
    return {"start_at": _iso(row.start_at), "duration_min": row.duration_min,
            "done_at": _iso(row.done_at), "skipped": bool(row.skipped)}  # fmt: skip


async def occurrence(session: AsyncSession, task_id: int, at: datetime,
                     lock: bool = True) -> TaskOccurrence | None:  # fmt: skip
    q = select(TaskOccurrence).where(TaskOccurrence.task_id == task_id,
                                     TaskOccurrence.occurrence_at == at)  # fmt: skip
    return await session.scalar(q.with_for_update() if lock else q)


async def _set_occurrence(session: AsyncSession, user_id: int, op: dict, out: Outcome, *,
                          by: str, check: bool, now: datetime) -> None:  # fmt: skip
    values = dict(op.get("values") or {})
    if (not values and not op.get("remove")) or set(values) - OCC_FIELDS:
        raise ValueError("set_occurrence: fields not allowed")
    task, item = await _task(session, user_id, op["task"])
    if task is None or item is None:
        out.skipped += 1
        return
    at = datetime.fromisoformat(op["occurrence_at"])
    row = await occurrence(session, task.id, at)
    cur = occ_values(row)
    expect = op.get("expect")
    if check and isinstance(expect, dict) and any(cur.get(k) != v for k, v in expect.items()):
        out.skipped += 1  # the person changed this occurrence since: theirs stays
        return
    if op.get("remove"):
        if row is None:
            return
        out.inverse.append({"op": "set_occurrence", "task": str(task.public_id),
                            "item": str(item.public_id), "occurrence_at": op["occurrence_at"],
                            "values": cur, "expect": occ_values(None)})  # fmt: skip
        await session.delete(row)
        out.items.add(str(item.public_id))
        return
    changed = {k: v for k, v in values.items() if cur.get(k) != v}
    if not changed:
        return
    new = row is None
    if new:
        row = TaskOccurrence(user_id=user_id, task_id=task.id, occurrence_at=at,
                             public_id=uuid.uuid4(), skipped=False, version=1)  # fmt: skip
        session.add(row)
    for k, v in changed.items():
        if k in ("start_at", "done_at"):
            v = datetime.fromisoformat(v) if v else None
        setattr(row, k, v)
    if not new:
        row.version += 1
    row.updated_at = now
    left = {**cur, **changed}
    back: dict[str, Any] = {"op": "set_occurrence", "task": str(task.public_id),
                            "item": str(item.public_id), "occurrence_at": op["occurrence_at"],
                            "expect": left}  # fmt: skip
    if new:
        back["remove"] = True
    else:
        back["values"] = {k: cur[k] for k in changed}
    out.inverse.append(back)
    out.items.add(str(item.public_id))


async def _set_reminder_time(session: AsyncSession, user_id: int, op: dict, out: Outcome, *,
                             by: str, check: bool, now: datetime) -> None:  # fmt: skip
    r = await _reminder(session, user_id, op["id"])
    if r is None or r.deleted_at is not None:
        out.skipped += 1
        return
    if check and "expect" in op and r.version != op["expect"]:
        out.skipped += 1
        return
    due = datetime.fromisoformat(op["due_at"])
    duration = op.get("duration_min", r.duration_min)
    rrule = op.get("rrule", r.rrule) if "rrule" in op else r.rrule
    if due == r.due_at and duration == r.duration_min and rrule == r.rrule:
        return
    back = reminder_state(r)
    from assistant.reminders import service as reminders  # reminders -> chat -> actions

    if not rrule and due <= now:
        out.skipped += 1  # a one-off cannot ring in the past
        return
    r.due_at, r.duration_min, r.rrule = due, duration, rrule
    r.version += 1
    r.snooze_until = None
    await session.flush()
    await reminders.plan_fires(session, r, now)
    out.inverse.append({"op": "restore_reminder", "id": str(r.public_id), "state": back,
                        "expect": r.version})  # fmt: skip


HANDLERS = {"set_occurrence": _set_occurrence, "set_reminder_time": _set_reminder_time}
