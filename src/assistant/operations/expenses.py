"""Operations of «Расходы» (phase 0): delete an expense (with its record, as the screen does)."""

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.db.models_actions import ActionKind
from assistant.db.models_expenses import ExpenseCategory, ExpenseEntry
from assistant.expenses import calc
from assistant.expenses import service as expenses
from assistant.operations.registry import Built, Operation, OpError, register


def change_row(entry: ExpenseEntry, item_id: uuid.UUID, kind: str, text: str,
               title: str) -> dict[str, Any]:  # fmt: skip
    return {"item_id": str(item_id), "expense_id": str(entry.public_id), "title": title,
            "kind": kind, "page_id": None, "text": text}  # fmt: skip


class ExpenseRef(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expense_id: uuid.UUID


async def trash_parts(session: AsyncSession, entry: ExpenseEntry) -> tuple[
        list[dict[str, Any]], dict[str, Any], str]:  # fmt: skip
    """(ops, «Что изменилось» row, sentence) of an expense going to the trash."""
    item_pid = await expenses.item_public_id(session, entry)
    cat = await session.get(ExpenseCategory, entry.category_id) if entry.category_id else None
    title = expenses.label(entry.note, entry.payee, cat)
    text = f"Убрал в корзину: {calc.format_money(entry.amount, entry.currency)} · {title}"
    ops = [{"op": "delete_entity_soft", "entity": "expenses", "id": str(entry.public_id),
            "item": str(item_pid)}]  # fmt: skip
    return ops, change_row(entry, item_pid, "trash", text, title), text


async def _delete(session: AsyncSession, user_id: int, args: ExpenseRef, *,
                  now: datetime) -> Built:  # fmt: skip
    entry = await session.scalar(select(ExpenseEntry).where(
        ExpenseEntry.user_id == user_id, ExpenseEntry.public_id == args.expense_id))
    if entry is None:
        raise OpError("not_found", 404)
    ops, row, text = await trash_parts(session, entry)
    return Built(ops=ops, kind=ActionKind.DELETE_ITEM, sentence=text, changes=[row],
                 source_item_ids=[entry.item_id], touched=("expenses", "budget"),
                 data={"expense": entry})  # fmt: skip


register(Operation("expenses.delete", "expenses", "safe", ExpenseRef, build=_delete,
                   description="an expense and its record to the trash"))
