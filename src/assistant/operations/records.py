"""Operations of records (phase 0): `records.trash` — what «удали …» does to records in the line,
exactly as the screens do it for what each record is: a to-do's record → `tasks.delete` (with its
reminders), an expense's record → `expenses.delete`, any other record → the record itself."""

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.db.models import Item
from assistant.db.models_actions import ActionKind
from assistant.db.models_expenses import ExpenseEntry
from assistant.db.models_tasks import Task
from assistant.operations import expenses as expense_ops
from assistant.operations import tasks as task_ops
from assistant.operations.registry import Built, Operation, register

MAX_RECORDS = 50


class RecordsRef(BaseModel):
    model_config = ConfigDict(extra="forbid")
    item_ids: list[uuid.UUID] = Field(min_length=1, max_length=MAX_RECORDS)


async def _trash(session: AsyncSession, user_id: int, args: RecordsRef, *,
                 now: datetime) -> Built:  # fmt: skip
    items = {i.public_id: i for i in await session.scalars(select(Item).where(
        Item.user_id == user_id, Item.public_id.in_(args.item_ids)))}  # fmt: skip
    pks = [i.id for i in items.values()]
    tasks = {t.item_id: t for t in await session.scalars(select(Task).where(
        Task.user_id == user_id, Task.item_id.in_(pks or [0]), Task.deleted_at.is_(None)))}
    spends = {e.item_id: e for e in await session.scalars(select(ExpenseEntry).where(
        ExpenseEntry.user_id == user_id, ExpenseEntry.item_id.in_(pks or [0]),
        ExpenseEntry.deleted_at.is_(None)))}  # fmt: skip
    ops: list[dict[str, Any]] = []
    changes: list[dict[str, Any]] = []
    touched: set[str] = {"records"}
    for pid in dict.fromkeys(args.item_ids):
        item = items.get(pid)
        if item is None:
            continue
        if (task := tasks.get(item.id)) is not None:
            ops += await task_ops.trash_ops(session, user_id, task, pid)
            changes.append(task_ops.change_row(task, pid, "trash", f"«{task.title}» — в корзине"))
            touched |= {"tasks", "calendar", "reminders"}
        elif (entry := spends.get(item.id)) is not None:
            more, row, _ = await expense_ops.trash_parts(session, entry)
            ops += more
            changes.append(row)
            touched |= {"expenses", "budget"}
        else:
            ops.append({"op": "delete_entity_soft", "entity": "items", "id": str(pid)})
            changes.append({"item_id": str(pid), "title": item.title or "", "kind": "trash",
                            "page_id": None, "text": f"«{item.title or 'Запись'}» — в корзине"})
    n = len(changes)
    return Built(ops=ops, kind=ActionKind.DELETE_ITEM,
                 sentence=f"Убрал в корзину: {n} " + ("запись" if n == 1 else "записей"),
                 changes=changes, source_item_ids=pks, touched=tuple(sorted(touched)))


register(Operation("records.trash", "records", "safe", RecordsRef, build=_trash,
                   description="records to the trash; a to-do's or an expense's record as their "
                               "own screens delete it (with its reminder)"))
