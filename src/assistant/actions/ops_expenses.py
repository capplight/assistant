"""Engine ops of «Расходы» (week 12, docs/api/expenses.md):

- `set_expense` {id, item, values, expect?}: fields of an expense. Values are JSON: `amount` a
  decimal string, `spent_on` ISO, `category_id` a category public id or null, `review_fields` a
  list; also `currency`, `expression`, `payee`, `method`, `direction`, `note`, `parse_source`.
  `payee_norm` and `dedup_key` follow by code.
- `set_expense_category` {id, values, expect?}: `title`, `title_kk`, `icon`, `pinned`,
  `hidden_at`, `position`, `manual_at` of one of the person's categories (S38, «Отменить» of a
  new one = hidden again, of a reorder = the old positions and `manual_at`).
- `set_expense_live` {id, item, live} (week 13): the expense alone leaves (or comes back), its
  record stays: a receipt photo is the person's record, «Отменить» of «Записал по чеку» must not
  trash the photo.
Each returns its own reverse with `expect` = what it left, so an undo skips what the person
changed since («Часть уже изменена вами»).
"""

from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.actions.engine import Outcome, _owned, _uuid
from assistant.db.models_expenses import (
    AMOUNT_MAX,
    Direction,
    ExpenseCategory,
    ExpenseEntry,
    Method,
    ParseSource,
)
from assistant.pages import lexorank

EXPENSE_FIELDS = frozenset({"amount", "currency", "spent_on", "category_id", "payee", "method",
                            "direction", "note", "expression", "review_fields",
                            "parse_source"})  # fmt: skip
CATEGORY_FIELDS = frozenset({"title", "title_kk", "icon", "pinned", "hidden_at", "position",
                             "manual_at"})  # fmt: skip


def _norm_payee(payee: str | None) -> str | None:
    from assistant.expenses.service import payee_norm

    return payee_norm(payee)


async def _cat_public(session: AsyncSession, cat_id: int | None) -> str | None:
    if cat_id is None:
        return None
    pid = await session.scalar(
        select(ExpenseCategory.public_id).where(ExpenseCategory.id == cat_id))
    return str(pid) if pid else None


async def expense_value(session: AsyncSession, e: ExpenseEntry, name: str) -> Any:
    """A field as JSON (what ops carry and compare)."""
    if name == "amount":
        return f"{Decimal(e.amount):.2f}"
    if name == "spent_on":
        return e.spent_on.isoformat()
    if name == "category_id":
        return await _cat_public(session, e.category_id)
    if name == "review_fields":
        return list(e.review_fields or [])
    return getattr(e, name)


async def _set_value(session: AsyncSession, user_id: int, e: ExpenseEntry, name: str,
                     value: Any) -> None:  # fmt: skip
    if name == "amount":
        amount = Decimal(str(value))
        if amount <= 0 or amount > AMOUNT_MAX:
            raise ValueError("set_expense: amount out of range")
        e.amount = amount
    elif name == "spent_on":
        e.spent_on = date.fromisoformat(str(value))
    elif name == "category_id":
        if value is None:
            e.category_id = None
        else:
            cat = await session.scalar(select(ExpenseCategory).where(
                ExpenseCategory.user_id == user_id,
                ExpenseCategory.public_id == _uuid(value)))  # fmt: skip
            if cat is None:
                raise ValueError("set_expense: unknown category")
            e.category_id = cat.id
    elif name == "method":
        e.method = Method(value) if value is not None else None
    elif name == "direction":
        e.direction = Direction(value)
    elif name == "parse_source":
        e.parse_source = ParseSource(value) if value is not None else None
    elif name == "review_fields":
        e.review_fields = [str(v) for v in value or []]
    elif name == "currency":
        if not (isinstance(value, str) and len(value) == 3 and value.isalpha() and value.isupper()):
            raise ValueError("set_expense: currency")
        e.currency = value
    else:
        setattr(e, name, value)


async def _set_expense(session: AsyncSession, user_id: int, op: dict, out: Outcome, *,
                       by: str, check: bool, now: datetime) -> None:  # fmt: skip
    from assistant.expenses.service import dedup_key

    values = dict(op.get("values") or {})
    if not values or set(values) - EXPENSE_FIELDS:
        raise ValueError("set_expense: fields not allowed")
    entry, item = await _owned(session, user_id, "expenses", op["id"])
    if entry is None or item is None:
        out.skipped += 1
        return
    expect = op.get("expect")
    if check and expect:
        for k, v in expect.items():
            if await expense_value(session, entry, k) != v:
                out.skipped += 1  # the person changed it since: theirs stays
                return
    changed: dict[str, Any] = {}
    for k, v in values.items():
        if await expense_value(session, entry, k) != v:
            changed[k] = v
    if not changed:
        return
    old = {k: await expense_value(session, entry, k) for k in changed}
    for k, v in changed.items():
        await _set_value(session, user_id, entry, k, v)
    entry.payee_norm = _norm_payee(entry.payee)
    entry.dedup_key = dedup_key(entry.amount, entry.spent_on, entry.payee)
    entry.version += 1
    entry.updated_at = now
    out.inverse.append({"op": "set_expense", "id": str(entry.public_id),
                        "item": str(item.public_id), "values": old,
                        "expect": {k: await expense_value(session, entry, k)
                                   for k in changed}})  # fmt: skip
    out.items.add(str(item.public_id))


def category_value(c: ExpenseCategory, name: str) -> Any:
    value = getattr(c, name)
    return value.isoformat() if isinstance(value, datetime) else value


async def _set_expense_category(session: AsyncSession, user_id: int, op: dict, out: Outcome, *,
                                by: str, check: bool, now: datetime) -> None:  # fmt: skip
    values = dict(op.get("values") or {})
    if not values or set(values) - CATEGORY_FIELDS:
        raise ValueError("set_expense_category: fields not allowed")
    cat = await session.scalar(
        select(ExpenseCategory).where(ExpenseCategory.user_id == user_id,
                                      ExpenseCategory.public_id == _uuid(op["id"]))
        .with_for_update()
    )  # fmt: skip
    if cat is None:
        out.skipped += 1
        return
    expect = op.get("expect")
    if check and expect and any(category_value(cat, k) != v for k, v in expect.items()):
        out.skipped += 1
        return
    changed = {k: v for k, v in values.items() if category_value(cat, k) != v}
    if not changed:
        return
    old = {k: category_value(cat, k) for k in changed}
    for k, v in changed.items():
        if k in ("hidden_at", "manual_at"):
            v = datetime.fromisoformat(v) if v else None
        elif k == "position":
            if not lexorank.is_valid(str(v)):
                raise ValueError("set_expense_category: position")
        elif k == "title" and not (isinstance(v, str) and 1 <= len(v) <= 40):
            raise ValueError("set_expense_category: title")
        setattr(cat, k, v)
    cat.version += 1
    cat.updated_at = now
    out.inverse.append({"op": "set_expense_category", "id": str(cat.public_id), "values": old,
                        "expect": {k: category_value(cat, k) for k in changed}})  # fmt: skip


async def _set_expense_live(session: AsyncSession, user_id: int, op: dict, out: Outcome, *,
                            by: str, check: bool, now: datetime) -> None:  # fmt: skip
    entry, item = await _owned(session, user_id, "expenses", op["id"])
    if entry is None or item is None:
        out.skipped += 1
        return
    live = bool(op.get("live"))
    if (entry.deleted_at is None) == live:
        return
    entry.deleted_at = None if live else now
    entry.version += 1
    entry.updated_at = now
    out.inverse.append({"op": "set_expense_live", "id": str(entry.public_id),
                        "item": str(item.public_id), "live": not live})  # fmt: skip
    out.items.add(str(item.public_id))


HANDLERS = {
    "set_expense_live": _set_expense_live,
    "set_expense": _set_expense,
    "set_expense_category": _set_expense_category,
}

__all__ = ["CATEGORY_FIELDS", "EXPENSE_FIELDS", "HANDLERS", "category_value", "expense_value"]
