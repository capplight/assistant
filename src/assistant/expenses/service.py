"""Expenses and categories in the DB (spec 3.12, contract docs/api/expenses.md).

Like a task, an expense has its own record (a note: the person's phrase, or «Бензин — 5 000 ₸»
for keys / form), so it shows on «Расходы» as a page row, is found by search and goes to the trash
with «Отменить». Changes run inside the caller's transaction and return the undo ops (assistant.
actions engine); the caller writes the action and commits. Writers take the per-user sync lock
first. Totals come only from `calc.py`.
"""

import re
import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.actions import engine
from assistant.db.models import Item
from assistant.db.models_actions import Initiator
from assistant.db.models_expenses import (
    TRANSFERS_KEY,
    TRUSTED_SOURCES,
    Direction,
    ExpenseCategory,
    ExpenseEntry,
)
from assistant.db.models_pages import Screen
from assistant.db.models_v2 import RecordKind, RecordSource, RecordStatus
from assistant.expenses import calc
from assistant.expenses.parse import NOTE_MAX
from assistant.pages import lexorank, lock_user, place_item
from assistant.records import content_hash, detect_lang, enqueue_ingest, normalize_text

PAGE_TEMPLATE = "expenses"
FREQUENCY_DAYS = 90
PAYEE_MAX = 120


class ExpenseError(ValueError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


# --- categories ---


async def ensure_categories(session: AsyncSession, user_id: int) -> None:
    """The person's copy of the 8 system categories + «Переводы» (once; safe to repeat)."""
    await lock_user(session, user_id)
    have = await session.scalar(select(func.count()).select_from(ExpenseCategory).where(
        ExpenseCategory.user_id == user_id, ExpenseCategory.created_by == "system"))  # fmt: skip
    if have:
        return
    await session.execute(text("""
        INSERT INTO expense_categories (public_id, user_id, key, title, title_kk, icon, position,
                                        service, created_by)
        SELECT gen_random_uuid(), :u, key, title, title_kk, icon, position, service, 'system'
        FROM expense_categories WHERE user_id IS NULL
        ON CONFLICT (user_id, key) WHERE user_id IS NOT NULL DO NOTHING
    """), {"u": user_id})  # fmt: skip


async def categories(session: AsyncSession, user_id: int) -> list[ExpenseCategory]:
    await ensure_categories(session, user_id)
    return list(await session.scalars(select(ExpenseCategory).where(
        ExpenseCategory.user_id == user_id).order_by(ExpenseCategory.position,
                                                     ExpenseCategory.id)))  # fmt: skip


def is_manual(rows: Sequence[ExpenseCategory]) -> bool:
    return any(c.manual_at is not None for c in rows)


async def chip_order(session: AsyncSession, user_id: int,
                     today: date) -> tuple[str, list[ExpenseCategory]]:  # fmt: skip
    """(`manual` | `frequency`, all categories: chips first, then hidden, then service). The same
    rule as the phone (docs/api/expenses.md)."""
    rows = await categories(session, user_id)
    manual = is_manual(rows)
    uses: dict[int, int] = {}
    if not manual:
        uses = dict((await session.execute(
            select(ExpenseEntry.category_id, func.count())
            .join(Item, Item.id == ExpenseEntry.item_id)
            .where(ExpenseEntry.user_id == user_id, ExpenseEntry.deleted_at.is_(None),
                   Item.deleted_at.is_(None), ExpenseEntry.category_id.is_not(None),
                   ExpenseEntry.spent_on >= today - timedelta(days=FREQUENCY_DAYS))
            .group_by(ExpenseEntry.category_id))).tuples().all())  # fmt: skip

    def key(c: ExpenseCategory) -> tuple:
        band = 2 if c.service else 1 if c.hidden_at is not None else 0
        if manual:
            return (band, c.position, c.id)
        own = 0 if c.created_by == "system" else 1
        return (band, own, -uses.get(c.id, 0), c.position, c.id)

    return ("manual" if manual else "frequency"), sorted(rows, key=key)


def category_key(c: ExpenseCategory | None) -> str | None:
    return c.key if c is not None else None


def category_dict(c: ExpenseCategory) -> dict[str, Any]:
    return {"id": c.public_id, "client_id": c.client_id, "key": c.key, "title": c.title,
            "title_kk": c.title_kk, "icon": c.icon, "system": c.created_by == "system",
            "service": c.service, "position": c.position, "manual": c.manual_at is not None,
            "pinned": c.pinned, "hidden": c.hidden_at is not None, "hidden_at": c.hidden_at,
            "version": c.version, "seq": c.seq, "updated_at": c.updated_at}  # fmt: skip


async def category_by_public(session: AsyncSession, user_id: int,
                             public_id: uuid.UUID | str | None
                             ) -> ExpenseCategory | None:  # fmt: skip
    if public_id is None:
        return None
    pid = public_id if isinstance(public_id, uuid.UUID) else uuid.UUID(str(public_id))
    return await session.scalar(select(ExpenseCategory).where(
        ExpenseCategory.user_id == user_id, ExpenseCategory.public_id == pid))  # fmt: skip


async def category_by_key(session: AsyncSession, user_id: int,
                          key: str | None) -> ExpenseCategory | None:  # fmt: skip
    if not key:
        return None
    await ensure_categories(session, user_id)
    return await session.scalar(select(ExpenseCategory).where(
        ExpenseCategory.user_id == user_id, ExpenseCategory.key == key,
        ExpenseCategory.hidden_at.is_(None)))  # fmt: skip


async def reader_categories(session: AsyncSession, user_id: int) -> list[tuple[str, str]]:
    """(key, title) of the live chips, for the model to choose from («Переводы» is not one)."""
    rows = await categories(session, user_id)
    return [(c.key, c.title) for c in rows if c.hidden_at is None and not c.service]


def clean_title(value: str | None) -> str:
    title = " ".join((value or "").split())
    if not 1 <= len(title) <= 40:
        raise ExpenseError("validation_error")
    return title


def own_key() -> str:
    return "own_" + uuid.uuid4().hex[:12]


def position_after(rows: Sequence[ExpenseCategory]) -> str:
    last = max((c.position for c in rows if not c.service), default=None)
    service = min((c.position for c in rows if c.service), default=None)
    if last is not None and service is not None and last < service:
        return lexorank.between(last, service)
    return lexorank.between(last, None)


# --- expenses ---


def payee_norm(payee: str | None) -> str | None:
    if not payee:
        return None
    return re.sub(r"[^\w]+", " ", payee.lower().replace("ё", "е")).strip() or None


def dedup_key(amount: Decimal, spent_on: date, payee: str | None) -> str:
    return f"{calc.money(amount):.2f}|{spent_on.isoformat()}|{payee_norm(payee) or ''}"


def clean_note(value: str | None) -> str | None:
    note = " ".join((value or "").split()) or None
    if note is not None and len(note) > NOTE_MAX:
        raise ExpenseError("validation_error")
    return note


def clean_payee(value: str | None) -> str | None:
    payee = " ".join((value or "").split()) or None
    if payee is not None and len(payee) > PAYEE_MAX:
        raise ExpenseError("validation_error")
    return payee


def resolve_amount(amount: str | None, expression: str | None) -> tuple[Decimal, str | None]:
    """(amount, canonical expression) from the keys or a decimal string. Code only."""
    from assistant.expenses.amounts import parse_decimal

    value: Decimal | None = None
    canonical = None
    if expression is not None and expression.strip():
        try:
            ev = calc.evaluate(expression)
        except calc.CalcError as exc:
            raise ExpenseError(exc.code) from exc
        value, canonical = ev.amount, ev.canonical if ev.terms > 1 else None
    if amount is not None and str(amount).strip():
        given = parse_decimal(str(amount))
        if given is None:
            raise ExpenseError("validation_error")
        if value is not None and given != value:
            raise ExpenseError("amount_mismatch")
        value = given
    if value is None:
        raise ExpenseError("validation_error")
    if value <= 0:
        raise ExpenseError("amount_not_positive")
    if value > calc.AMOUNT_MAX:
        raise ExpenseError("amount_too_large")
    return calc.money(value), canonical


@dataclass
class NewExpense:
    amount: Decimal
    currency: str = "KZT"
    spent_on: date | None = None
    category: ExpenseCategory | None = None
    note: str | None = None
    payee: str | None = None
    method: str | None = None
    direction: str = Direction.EXPENSE
    source: str = "form"
    parse_source: str | None = None
    expression: str | None = None
    phrase: str | None = None  # the person's words (the line): the record's text


@dataclass
class Created:
    entry: ExpenseEntry
    item: Item
    inverse: list[dict[str, Any]] = field(default_factory=list)
    changes: list[dict[str, Any]] = field(default_factory=list)
    pages: set[int] = field(default_factory=set)
    items: set[str] = field(default_factory=set)
    page: Screen | None = None
    sentence: str = ""


async def expenses_page(session: AsyncSession, user_id: int) -> Screen | None:
    return await session.scalar(
        select(Screen).where(Screen.user_id == user_id, Screen.template_key == PAGE_TEMPLATE,
                             Screen.deleted_at.is_(None)).order_by(Screen.id).limit(1)
    )  # fmt: skip


def label(entry_note: str | None, payee: str | None, category: ExpenseCategory | None) -> str:
    """The line title in the feed: note → payee → category title."""
    return entry_note or payee or (category.title if category else "Трата")


def sentence(amount: Decimal, currency: str, category: ExpenseCategory | None,
             direction: str = Direction.EXPENSE) -> str:  # fmt: skip
    money_text = calc.format_money(amount, currency)
    verb = {Direction.REFUND: "Записал возврат", Direction.INCOME: "Записал доход",
            Direction.TRANSFER_OWN: "Записал перевод"}.get(direction, "Записал")  # fmt: skip
    return f"{verb} {money_text}" + (f" · {category.title}" if category else "")


def review_for(source: str) -> list[str]:
    """R-36: the amount is always «Проверьте» unless the person typed it."""
    return [] if source in TRUSTED_SOURCES else ["amount"]


async def create(session: AsyncSession, user_id: int, spec: NewExpense, *, by: str,
                 now: datetime, today: date,
                 client_id: uuid.UUID | None = None) -> Created:  # fmt: skip
    await lock_user(session, user_id)
    await ensure_categories(session, user_id)
    spent_on = spec.spent_on or today
    body_text = spec.phrase or (f"{label(spec.note, spec.payee, spec.category)} — "
                                f"{calc.format_money(spec.amount, spec.currency)}")  # fmt: skip
    body = normalize_text(body_text)
    item = Item(user_id=user_id, client_id=uuid.uuid4(), kind=RecordKind.NOTE,
                source=RecordSource.MIC if spec.source == "voice" else RecordSource.TYPED,
                status=RecordStatus.PENDING, title=None, text=body,
                text_lang=detect_lang(body), content_hash=content_hash(body),
                source_meta={"expense": True}, ai_generated=by == Initiator.AGENT)  # fmt: skip
    session.add(item)
    await session.flush()
    item.occurred_at = item.created_at
    entry = ExpenseEntry(
        user_id=user_id, item_id=item.id, client_id=client_id, amount=spec.amount,
        currency=spec.currency, expression=spec.expression, spent_on=spent_on,
        category_id=spec.category.id if spec.category else None, payee=spec.payee,
        payee_norm=payee_norm(spec.payee), method=spec.method, direction=spec.direction,
        note=spec.note, source=spec.source, parse_source=spec.parse_source,
        review_fields=review_for(spec.source),
        dedup_key=dedup_key(spec.amount, spent_on, spec.payee),
        ai_generated=by == Initiator.AGENT,
    )  # fmt: skip
    session.add(entry)
    await session.flush()
    await enqueue_ingest(session, item)
    await place_item(session, item)  # «Расходы» takes it; «Заметки» leaves it then (rules.py)
    out = Created(entry=entry, item=item)
    out.page = await expenses_page(session, user_id)
    out.inverse = [{"op": "delete_entity_soft", "entity": "expenses", "id": str(entry.public_id),
                    "item": str(item.public_id)}]  # fmt: skip
    if out.page is not None:
        res = await engine.apply(session, user_id, [
            {"op": "add_screen_item", "page": str(out.page.public_id),
             "item": str(item.public_id)}], by=by, check=False, now=now)  # fmt: skip
        out.pages |= res.pages | {out.page.id}
    out.items.add(str(item.public_id))
    out.sentence = sentence(spec.amount, spec.currency, spec.category, spec.direction)
    out.changes = [{"item_id": str(item.public_id), "expense_id": str(entry.public_id),
                    "title": label(spec.note, spec.payee, spec.category), "kind": "create",
                    "page_id": str(out.page.public_id) if out.page else None,
                    "text": out.sentence}]  # fmt: skip
    return out


async def get(session: AsyncSession, user_id: int, public_id: uuid.UUID) -> ExpenseEntry | None:
    return await session.scalar(select(ExpenseEntry).where(ExpenseEntry.user_id == user_id,
                                                           ExpenseEntry.public_id == public_id))


async def is_live(session: AsyncSession, entry: ExpenseEntry) -> bool:
    deleted = await session.scalar(select(Item.deleted_at).where(Item.id == entry.item_id))
    return entry.deleted_at is None and deleted is None


async def item_public_id(session: AsyncSession, entry: ExpenseEntry) -> uuid.UUID:
    pid = await session.scalar(select(Item.public_id).where(Item.id == entry.item_id))
    assert pid is not None
    return pid


async def expenses_dicts(session: AsyncSession,
                         rows: Sequence[ExpenseEntry]) -> list[dict[str, Any]]:  # fmt: skip
    items: dict[int, uuid.UUID] = {}
    cats: dict[int, ExpenseCategory] = {}
    if rows:
        items = dict((await session.execute(select(Item.id, Item.public_id).where(
            Item.id.in_({r.item_id for r in rows})))).tuples().all())  # fmt: skip
        ids = {r.category_id for r in rows if r.category_id}
        if ids:
            cats = {c.id: c for c in await session.scalars(
                select(ExpenseCategory).where(ExpenseCategory.id.in_(ids)))}  # fmt: skip
    return [expense_dict(r, items.get(r.item_id), cats.get(r.category_id or 0)) for r in rows]


def expense_dict(e: ExpenseEntry, item_id: uuid.UUID | None,
                 cat: ExpenseCategory | None) -> dict[str, Any]:  # fmt: skip
    return {
        "id": e.public_id, "client_id": e.client_id, "item_id": item_id,
        "amount": f"{calc.money(e.amount):.2f}", "currency": e.currency,
        "expression": e.expression, "spent_on": e.spent_on.isoformat(), "spent_at": e.spent_at,
        "category_id": cat.public_id if cat else None, "category_key": category_key(cat),
        "payee": e.payee, "method": e.method, "direction": e.direction, "note": e.note,
        "source": e.source, "parse_source": e.parse_source,
        "review_fields": list(e.review_fields or []), "ai_generated": e.ai_generated,
        "version": e.version, "seq": e.seq, "created_at": e.created_at,
        "updated_at": e.updated_at, "deleted_at": e.deleted_at,
    }  # fmt: skip


def field_values(entry: ExpenseEntry, cat: ExpenseCategory | None) -> dict[str, Any]:
    """Page fields from the expense (the template's `expense.*` sources)."""
    values = {"amount": f"{calc.money(entry.amount):.2f}", "date": entry.spent_on.isoformat(),
              "category": cat.title if cat else None, "merchant": entry.payee or entry.note,
              "method": entry.method}  # fmt: skip
    return {k: v for k, v in values.items() if v is not None}


# --- totals (calc.py does the arithmetic) ---


@dataclass
class Totals:
    bounds: tuple[date | None, date | None]
    result: calc.Result
    titles: dict[str, str]  # category public id → title
    ids: dict[str, uuid.UUID]  # row id → expense public id


async def totals(session: AsyncSession, user_id: int, *, period: str, day: date,
                 start: date | None = None, end: date | None = None,
                 group_by: str | None = None, currency: str | None = None,
                 category: ExpenseCategory | None = None) -> Totals:  # fmt: skip
    bounds = calc.period_bounds(period, day, start=start, end=end)
    q = (select(ExpenseEntry, ExpenseCategory)
         .join(Item, Item.id == ExpenseEntry.item_id)
         .outerjoin(ExpenseCategory, ExpenseCategory.id == ExpenseEntry.category_id)
         .where(ExpenseEntry.user_id == user_id, ExpenseEntry.deleted_at.is_(None),
                Item.deleted_at.is_(None)))  # fmt: skip
    lo, hi = bounds
    if lo is not None:
        q = q.where(ExpenseEntry.spent_on >= lo)
    if hi is not None:
        q = q.where(ExpenseEntry.spent_on <= hi)
    if currency:
        q = q.where(ExpenseEntry.currency == currency)
    if category is not None:
        q = q.where(ExpenseEntry.category_id == category.id)
    rows = (await session.execute(q.order_by(ExpenseEntry.spent_on, ExpenseEntry.id))).all()
    calc_rows = []
    titles: dict[str, str] = {}
    ids: dict[str, uuid.UUID] = {}
    for e, c in rows:
        rid = str(e.id)
        ids[rid] = e.public_id
        if c is not None:
            titles[str(c.public_id)] = c.title
        calc_rows.append(calc.Row(
            id=rid, amount=e.amount, currency=e.currency, direction=e.direction,
            spent_on=e.spent_on, category=str(c.public_id) if c else None,
            service=bool(c and (c.service or c.key == TRANSFERS_KEY)), payee=e.payee,
            method=e.method, review="amount" in (e.review_fields or [])))  # fmt: skip
    return Totals(bounds, calc.aggregate(calc_rows, group_by=group_by), titles, ids)

