"""Operations of «Расходы» (Ф-95): fix an expense (amount, category, day, note…), delete it (with
its record, as the screen does)."""

import uuid
from datetime import date, datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.db.models_actions import ActionKind
from assistant.db.models_expenses import ExpenseCategory, ExpenseEntry, ParseSource
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


class ExpenseUpdate(BaseModel):
    """Only the fields given change (`model_fields_set`, like `PATCH /v1/expenses/{id}`)."""

    model_config = ConfigDict(extra="forbid")
    expense_id: uuid.UUID
    amount: str | None = None
    expression: str | None = None
    currency: str | None = None
    spent_on: str | None = None  # YYYY-MM-DD
    category_id: uuid.UUID | None = None
    note: str | None = None
    payee: str | None = None
    method: str | None = None
    direction: str | None = None
    confirm: list[str] = Field(default_factory=list)


async def _update(session: AsyncSession, user_id: int, args: ExpenseUpdate, *,
                  now: datetime) -> Built:  # fmt: skip
    entry = await expenses.get(session, user_id, args.expense_id)
    if entry is None:
        raise OpError("not_found", 404)
    sent = args.model_fields_set - {"expense_id", "confirm"}
    values: dict[str, Any] = {}
    review = [f for f in entry.review_fields or [] if f not in args.confirm]
    try:
        if "amount" in sent or "expression" in sent:
            amount, expression = expenses.resolve_amount(
                args.amount if "amount" in sent else None,
                args.expression if "expression" in sent else None)  # fmt: skip
            if calc.money(entry.amount) != amount:
                values["amount"] = f"{amount:.2f}"
                values["parse_source"] = ParseSource.USER_EDIT.value
            values["expression"] = expression
            review = [f for f in review if f != "amount"]  # the person typed it: theirs
        if "currency" in sent and args.currency:
            values["currency"] = args.currency
        if "spent_on" in sent and args.spent_on:
            values["spent_on"] = date.fromisoformat(args.spent_on).isoformat()
            review = [f for f in review if f != "spent_on"]  # the person set the day
        if "category_id" in sent:
            cat = None
            if args.category_id is not None:
                await expenses.ensure_categories(session, user_id)
                cat = await expenses.category_by_public(session, user_id, args.category_id)
                if cat is None:
                    raise OpError("validation_error", details={"field": "category_id"})
            values["category_id"] = str(cat.public_id) if cat else None
        if "note" in sent:
            values["note"] = expenses.clean_note(args.note)
        if "payee" in sent:
            values["payee"] = expenses.clean_payee(args.payee)
            review = [f for f in review if f != "payee"]
        if "method" in sent:
            values["method"] = args.method
        if "direction" in sent and args.direction:
            values["direction"] = args.direction
    except expenses.ExpenseError as exc:
        raise OpError(exc.code) from exc
    except OpError:
        raise
    except ValueError as exc:
        raise OpError("validation_error") from exc
    if review != list(entry.review_fields or []):
        values["review_fields"] = review
    item_pid = await expenses.item_public_id(session, entry)
    ops = [{"op": "set_expense", "id": str(entry.public_id), "item": str(item_pid),
            "values": values}] if values else []  # fmt: skip
    only_confirm = set(values) == {"review_fields"} and "amount" in args.confirm
    return Built(ops=ops, kind=ActionKind.EDIT_EXPENSE, sentence="",
                 changes=[], source_item_ids=[entry.item_id], touched=("expenses", "budget"),
                 data={"expense": entry, "item_pid": item_pid, "only_confirm": only_confirm})


async def sentence_after(session: AsyncSession, built: Built) -> None:
    """The action's text reads the expense as changed (new amount, new category)."""
    entry: ExpenseEntry = built.data["expense"]
    cat = await session.get(ExpenseCategory, entry.category_id) if entry.category_id else None
    title = expenses.label(entry.note, entry.payee, cat)
    money = calc.format_money(entry.amount, entry.currency)
    built.sentence = (f"Сумма верна: {money}" if built.data["only_confirm"]
                      else f"Изменил трату: {money} · {title}")  # fmt: skip
    built.changes = [change_row(entry, built.data["item_pid"], "edit", built.sentence, title)]


register(Operation("expenses.update", "expenses", "safe", ExpenseUpdate, build=_update,
                   after=sentence_after,
                   description="fix an expense: amount, category, day, note, payee"))
register(Operation("expenses.delete", "expenses", "safe", ExpenseRef, build=_delete,
                   description="an expense and its record to the trash"))
