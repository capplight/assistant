"""Operations of «Дела» / «Покупки» (phase 0): delete, done / not done, clear the done ones.
`api/routes/tasks.py` and the assistant line call these (registry.py)."""

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.db.models import Item
from assistant.db.models_actions import ActionKind
from assistant.db.models_tasks import Task
from assistant.operations.registry import Built, Operation, OpError, register
from assistant.tasks import calendar as cal
from assistant.tasks import service

CLEARED_RU = {"shopping": "Убрал купленное", "todo": "Убрал сделанное"}


def change_row(task: Task, item_id: uuid.UUID, kind: str, text: str,
               page_id: uuid.UUID | None = None) -> dict[str, Any]:  # fmt: skip
    return {"item_id": str(item_id), "task_id": str(task.public_id), "title": task.title,
            "kind": kind, "page_id": str(page_id) if page_id else None, "text": text}


async def _task(session: AsyncSession, user_id: int, task_id: uuid.UUID) -> Task:
    task = await service.get(session, user_id, task_id)
    if task is None:
        raise OpError("not_found", 404)
    return task


class TaskRef(BaseModel):
    model_config = ConfigDict(extra="forbid")
    task_id: uuid.UUID


async def trash_ops(session: AsyncSession, user_id: int, task: Task,
                    item_pid: uuid.UUID) -> list[dict[str, Any]]:  # fmt: skip
    """The to-do and its record to the trash, its linked reminders cancelled (as the screen)."""
    return [*await cal.linked_reminder_cancels(session, user_id, task),
            {"op": "delete_entity_soft", "entity": "tasks", "id": str(task.public_id),
             "item": str(item_pid)}]  # fmt: skip


async def _delete(session: AsyncSession, user_id: int, args: TaskRef, *, now: datetime) -> Built:
    task = await _task(session, user_id, args.task_id)
    item_pid = await service.item_public_id(session, task)
    return Built(
        ops=await trash_ops(session, user_id, task, item_pid), kind=ActionKind.DELETE_ITEM,
        sentence=f"Убрал в корзину: {service.lower_first(task.title)}",
        changes=[change_row(task, item_pid, "trash", f"«{task.title}» — в корзине")],
        source_item_ids=[task.item_id], touched=("tasks", "calendar", "reminders"),
        data={"task": task})  # fmt: skip


class SetDone(BaseModel):
    model_config = ConfigDict(extra="forbid")
    task_id: uuid.UUID
    done: bool = True
    occurrence_at: datetime | None = None  # checked by the caller (a start of the series)


async def _set_done(session: AsyncSession, user_id: int, args: SetDone, *,
                    now: datetime) -> Built:  # fmt: skip
    task = await _task(session, user_id, args.task_id)
    if not await service.is_live(session, task):
        raise OpError("not_found", 404)
    if task.rrule and args.occurrence_at is None:
        raise OpError("validation_error")  # a repeat is done one occurrence at a time
    item_pid = await service.item_public_id(session, task)
    done_at = now.isoformat() if args.done else None
    if args.occurrence_at is not None:
        op: dict[str, Any] = {"op": "set_occurrence", "task": str(task.public_id),
                              "item": str(item_pid),
                              "occurrence_at": args.occurrence_at.isoformat(),
                              "values": {"done_at": done_at}}  # fmt: skip
    else:
        op = {"op": "set_task", "id": str(task.public_id), "item": str(item_pid),
              "values": {"done_at": done_at}}
    sentence = service.done_sentence(task, args.done)
    return Built(ops=[op], kind=ActionKind.FACET_EDIT, sentence=sentence,
                 changes=[change_row(task, item_pid, "done", sentence)],
                 source_item_ids=[task.item_id], touched=("tasks", "calendar"),
                 data={"task": task})  # fmt: skip


class ClearDone(BaseModel):
    model_config = ConfigDict(extra="forbid")
    list_key: str
    task_ids: list[uuid.UUID] | None = None


async def _clear_done(session: AsyncSession, user_id: int, args: ClearDone, *,
                      now: datetime) -> Built:  # fmt: skip
    q = (select(Task).join(Item, Item.id == Task.item_id)
         .where(Task.user_id == user_id, Task.list_key == args.list_key,
                Task.done_at.is_not(None), Task.deleted_at.is_(None),
                Item.deleted_at.is_(None)))  # fmt: skip
    if args.task_ids is not None:
        q = q.where(Task.public_id.in_(args.task_ids))
    done = list(await session.scalars(q.order_by(Task.id).limit(500)))
    pids = {t.id: await service.item_public_id(session, t) for t in done}
    titles = ", ".join(service.lower_first(t.title) for t in done[:5])
    more = f" и ещё {len(done) - 5}" if len(done) > 5 else ""
    return Built(
        ops=[{"op": "delete_entity_soft", "entity": "tasks", "id": str(t.public_id),
              "item": str(pids[t.id])} for t in done],
        kind=ActionKind.DELETE_ITEM,
        sentence=f"{CLEARED_RU.get(args.list_key, 'Убрал')}: {titles}{more}.",
        changes=[change_row(t, pids[t.id], "trash", f"«{t.title}» — в корзине") for t in done],
        source_item_ids=[t.item_id for t in done], touched=("tasks",), data={"tasks": done})


register(Operation("tasks.delete", "tasks", "safe", TaskRef, build=_delete,
                   description="a to-do and its record to the trash, its reminder cancelled"))
register(Operation("tasks.set_done", "tasks", "safe", SetDone, build=_set_done,
                   description="tick a to-do (or one occurrence of a repeat), or untick it"))
register(Operation("tasks.clear_done", "tasks", "bulk", ClearDone, build=_clear_done,
                   description="the done to-dos of a list to the trash"))
