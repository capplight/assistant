"""Repeats of expenses (spec 6.13 «Повторы трат»): one payment often comes twice, as a receipt and
as a statement row. Code finds the pairs; merging is only ever the person's «Объединить» (one
action, one «Отменить»). Contract: docs/api/expenses.md «ExpenseDuplicate».

A pair: both live, same currency and amount, days at most 1 apart, the same direction, payees that
do not contradict (one empty, or a word in common, Cyrillic and Latin compared alike). Each runs
inside the caller's transaction.
"""

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.actions import engine, record
from assistant.db.models import Item
from assistant.db.models_actions import Action, ActionKind, Initiator
from assistant.db.models_expenses import (
    DuplicateStatus,
    ExpenseCategory,
    ExpenseDuplicate,
    ExpenseEntry,
    ExpenseSource,
)
from assistant.expenses import calc
from assistant.expenses.documents import words

NEAR_DAYS = 1
_TRANSLIT = str.maketrans({
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ж": "zh", "з": "z", "и": "i",
    "й": "i", "к": "k", "л": "l", "м": "m", "н": "n", "о": "o", "п": "p", "р": "r", "с": "s",
    "т": "t", "у": "u", "ф": "f", "х": "h", "ц": "c", "ч": "ch", "ш": "sh", "щ": "sh", "ы": "y",
    "э": "e", "ю": "u", "я": "ya", "қ": "k", "ғ": "g", "ң": "n", "ү": "u", "ұ": "u", "һ": "h",
    "ө": "o", "ә": "a", "і": "i", "ь": "", "ъ": "",
})  # fmt: skip
_NOISE = {"too", "тоо", "ip", "ип", "ao", "ао", "llp", "kz", "almaty", "алматы", "astana", "астана",
          "pokupka", "oplata", "the", "and", "kaspi"}  # fmt: skip


class RepeatError(ValueError):
    def __init__(self, status: int, code: str) -> None:
        super().__init__(code)
        self.status, self.code = status, code


def payee_words(payee: str | None) -> set[str]:
    out = set()
    for w in words(payee):
        t = w.translate(_TRANSLIT)
        if len(t) >= 3 and t not in _NOISE and not t.isdigit():
            out.add(t)
    return out


def payees_agree(a: str | None, b: str | None) -> bool:
    wa, wb = payee_words(a), payee_words(b)
    return not wa or not wb or bool(wa & wb)


def is_pair(a: ExpenseEntry, b: ExpenseEntry) -> bool:
    return (a.id != b.id and a.currency == b.currency and calc.money(a.amount) ==
            calc.money(b.amount) and abs((a.spent_on - b.spent_on).days) <= NEAR_DAYS
            and a.direction == b.direction and payees_agree(a.payee, b.payee))  # fmt: skip


def order(a: ExpenseEntry, b: ExpenseEntry) -> tuple[ExpenseEntry, ExpenseEntry]:
    """(keep, other): the person's entry or the receipt over a statement row; else the older."""
    def rank(e: ExpenseEntry) -> tuple[int, int]:
        return (0 if e.source == ExpenseSource.STATEMENT_PDF else 1, -e.id)

    return (a, b) if rank(a) >= rank(b) else (b, a)


def reason(keep: ExpenseEntry, other: ExpenseEntry) -> str:
    if ExpenseSource.STATEMENT_PDF in (keep.source, other.source):
        return "statement"
    if {keep.source, other.source} & {ExpenseSource.RECEIPT_OCR, ExpenseSource.RECEIPT_QR,
                                      ExpenseSource.SHARED_RECEIPT}:  # fmt: skip
        return "receipt"
    return "same_day"


TEXT = {"statement": "Похоже, эта трата уже есть (из выписки)",
        "receipt": "Похоже, эта трата уже есть (по чеку)",
        "same_day": "Похоже, эта трата уже есть"}  # fmt: skip


def _live(user_id: int) -> Any:
    return (select(ExpenseEntry).join(Item, Item.id == ExpenseEntry.item_id)
            .where(ExpenseEntry.user_id == user_id, ExpenseEntry.deleted_at.is_(None),
                   Item.deleted_at.is_(None), Item.hidden_reason.is_(None)))  # fmt: skip


async def _paired_before(session: AsyncSession, user_id: int, a: int, b: int) -> bool:
    return await session.scalar(select(ExpenseDuplicate.id).where(
        ExpenseDuplicate.user_id == user_id,
        or_((ExpenseDuplicate.keep_id == a) & (ExpenseDuplicate.other_id == b),
            (ExpenseDuplicate.keep_id == b) & (ExpenseDuplicate.other_id == a)))) is not None


async def suggest_for(
    session: AsyncSession, user_id: int, entry: ExpenseEntry, *,
    among: list[ExpenseEntry] | None = None,
) -> ExpenseDuplicate | None:
    """A new pair for `entry` with one live expense already there (the closest day, then the
    newest), or None. `among`: candidates the caller already loaded."""
    if among is None:
        q = _live(user_id)
        among = list(await session.scalars(q.where(
            ExpenseEntry.id != entry.id, ExpenseEntry.currency == entry.currency,
            ExpenseEntry.amount == entry.amount,
            ExpenseEntry.spent_on >= entry.spent_on - timedelta(days=NEAR_DAYS),
            ExpenseEntry.spent_on <= entry.spent_on + timedelta(days=NEAR_DAYS))))  # fmt: skip
    found = sorted((c for c in among if is_pair(entry, c)),
                   key=lambda c: (abs((c.spent_on - entry.spent_on).days), -c.id))  # fmt: skip
    for cand in found:
        if await _paired_before(session, user_id, entry.id, cand.id):
            continue
        keep, other = order(entry, cand)
        dup = ExpenseDuplicate(user_id=user_id, keep_id=keep.id, other_id=other.id,
                               reason=reason(keep, other))  # fmt: skip
        session.add(dup)
        await session.flush()
        return dup
    return None


# --- out ---


async def status_of(session: AsyncSession, dup: ExpenseDuplicate) -> str:
    if dup.status == DuplicateStatus.MERGED and dup.action_id:
        undone = await session.scalar(select(Action.undone_at).where(Action.id == dup.action_id))
        if undone is not None:
            return "undone"
    return str(dup.status)


async def dup_dicts(session: AsyncSession, rows: list[ExpenseDuplicate]) -> list[dict[str, Any]]:
    from assistant.expenses.service import expenses_dicts

    if not rows:
        return []
    ids = {r.keep_id for r in rows} | {r.other_id for r in rows}
    entries = {e.id: e for e in await session.scalars(
        select(ExpenseEntry).where(ExpenseEntry.id.in_(ids)))}  # fmt: skip
    dicts = dict(zip([e.id for e in entries.values()],
                     await expenses_dicts(session, list(entries.values())), strict=True))
    actions = {a.id: a.public_id for a in await session.scalars(
        select(Action).where(Action.id.in_({r.action_id for r in rows if r.action_id})))}
    return [{"id": r.public_id, "status": await status_of(session, r), "keep": dicts[r.keep_id],
             "other": dicts[r.other_id], "text_ru": TEXT.get(r.reason, TEXT["same_day"]),
             "action_id": actions.get(r.action_id or 0), "created_at": r.created_at,
             "decided_at": r.decided_at} for r in rows]  # fmt: skip


async def is_live(session: AsyncSession, entry: ExpenseEntry) -> bool:
    gone = await session.scalar(
        select(Item.deleted_at.is_not(None) | Item.hidden_reason.is_not(None))
        .where(Item.id == entry.item_id))  # fmt: skip
    return entry.deleted_at is None and not gone


async def open_list(session: AsyncSession, user_id: int, status: str,
                    limit: int) -> list[ExpenseDuplicate]:  # fmt: skip
    q = select(ExpenseDuplicate).where(ExpenseDuplicate.user_id == user_id)
    if status in ("suggested", "merged", "dismissed"):
        q = q.where(ExpenseDuplicate.status == status)
    rows = list(await session.scalars(q.order_by(ExpenseDuplicate.id.desc()).limit(limit * 3)))
    out = []
    for r in rows:
        st = await status_of(session, r)
        if status == "undone" and st != "undone":
            continue
        if status == "merged" and st != "merged":
            continue
        if st == "suggested":
            a = await session.get(ExpenseEntry, r.keep_id)
            b = await session.get(ExpenseEntry, r.other_id)
            if a is None or b is None or not (await is_live(session, a)
                                              and await is_live(session, b)):  # fmt: skip
                continue
        out.append(r)
        if len(out) >= limit:
            break
    return out


async def get(session: AsyncSession, user_id: int, public_id: uuid.UUID,
              lock: bool = False) -> ExpenseDuplicate:  # fmt: skip
    q = select(ExpenseDuplicate).where(ExpenseDuplicate.user_id == user_id,
                                       ExpenseDuplicate.public_id == public_id)
    dup = await session.scalar(q.with_for_update() if lock else q)
    if dup is None:
        raise RepeatError(404, "not_found")
    return dup


@dataclass
class Merged:
    dup: ExpenseDuplicate
    keep: ExpenseEntry
    action: Action | None
    repeated: bool = False


async def merge(session: AsyncSession, user_id: int, dup: ExpenseDuplicate, *,
                keep_id: uuid.UUID | None, now: datetime,
                client_id: uuid.UUID | None) -> Merged:  # fmt: skip
    from assistant.expenses.service import label

    a = await session.get(ExpenseEntry, dup.keep_id)
    b = await session.get(ExpenseEntry, dup.other_id)
    assert a is not None and b is not None
    if dup.status == DuplicateStatus.MERGED:
        act = await session.get(Action, dup.action_id) if dup.action_id else None
        if act is not None and act.undone_at is None:
            return Merged(dup, a, act, repeated=True)
        raise RepeatError(409, "duplicate_closed")
    if dup.status != DuplicateStatus.SUGGESTED:
        raise RepeatError(409, "duplicate_closed")
    if keep_id is not None:
        if keep_id == b.public_id:
            a, b = b, a
        elif keep_id != a.public_id:
            raise RepeatError(422, "validation_error")
    if not (await is_live(session, a) and await is_live(session, b)):
        raise RepeatError(409, "duplicate_stale")
    keep_item = await session.get(Item, a.item_id)
    other_item = await session.get(Item, b.item_id)
    assert keep_item is not None and other_item is not None
    take: dict[str, Any] = {}
    for name in ("payee", "note", "method"):
        if getattr(a, name) is None and getattr(b, name) is not None:
            take[name] = getattr(b, name)
    if a.category_id is None and b.category_id is not None:
        cat = await session.get(ExpenseCategory, b.category_id)
        if cat is not None:
            take["category_id"] = str(cat.public_id)
    ops: list[dict[str, Any]] = []
    if take:
        ops.append({"op": "set_expense", "id": str(a.public_id), "item": str(keep_item.public_id),
                    "values": take})  # fmt: skip
    if (other_item.source_meta or {}).get("expense"):  # its own note: both to the trash
        ops.append({"op": "delete_entity_soft", "entity": "expenses", "id": str(b.public_id),
                    "item": str(other_item.public_id)})  # fmt: skip
    else:  # a receipt photo: the person's record stays, the expense leaves
        ops.append({"op": "set_expense_live", "id": str(b.public_id),
                    "item": str(other_item.public_id), "live": False})  # fmt: skip
    out = await engine.apply(session, user_id, ops, by=Initiator.USER, check=False, now=now)
    cat = await session.get(ExpenseCategory, a.category_id) if a.category_id else None
    title = label(a.note, a.payee, cat)
    text = f"Объединил траты: {calc.format_money(a.amount, a.currency)} · {title}"
    action = await record(
        session, user_id=user_id, kind=ActionKind.MERGE_EXPENSES, initiated_by=Initiator.USER,
        summary={"ru": text, "kk": None},
        changes=[{"item_id": str(other_item.public_id), "expense_id": str(b.public_id),
                  "title": title, "kind": "merge", "page_id": None, "text": text}],
        inverse=out.inverse, now=now, source_item_ids=[keep_item.id, other_item.id],
        client_id=client_id,
    )  # fmt: skip
    dup.status, dup.decided_at, dup.action_id = DuplicateStatus.MERGED, now, action.id
    if dup.keep_id != a.id:
        dup.keep_id, dup.other_id = a.id, b.id
    await session.flush()
    return Merged(dup, a, action)


async def dismiss(session: AsyncSession, dup: ExpenseDuplicate, now: datetime) -> None:
    if dup.status == DuplicateStatus.DISMISSED:
        return
    if dup.status != DuplicateStatus.SUGGESTED:
        raise RepeatError(409, "duplicate_closed")
    dup.status, dup.decided_at = DuplicateStatus.DISMISSED, now
    await session.flush()


__all__ = ["Merged", "RepeatError", "dismiss", "dup_dicts", "get", "is_pair", "merge",
           "open_list", "order", "payees_agree", "suggest_for"]  # fmt: skip
