"""Engine ops of the КП (week 14, docs/api/kp.md) and of week 13's «Это разные»:

- `delete_entity_soft` / `restore_entity` take `entity: documents` (the КП and its own record go
  to the trash / come back together; engine.OWNED).
- `revert_document` {id, n, expect_n?}: a new version equal to version `n` («Отменить» of a tap
  edit, «Вернуть версию n»). Its reverse is a revert to the version that was current, with
  `expect_n` = the new one: if the person edited the КП since, an undo skips it («Часть уже
  изменена вами»).
- `set_document` {id, values: {deal_status}, expect?}: the card file's status strip.
- `set_company_profile` {values: <profile snapshot> | null, expect?: {fingerprint}}: the profile
  back (null = there was none). Ciphertext stays ciphertext (base64) inside the action.
- `set_price_list` {id, values: {deleted_at, active}, expect?}: an uploaded price list leaves
  (comes back) with its positions.
- `set_price_item` {id, values: {price, name, unit, review_fields, deleted_at}, expect?}.
- `set_status` also takes `entity: expense_duplicates` (week 13 «Это разные» → «Отменить»).
Each returns its reverse with `expect` = what it left.
"""

from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.actions.engine import Outcome, _uuid
from assistant.db.models import Item
from assistant.db.models_expenses import DuplicateStatus, ExpenseDuplicate
from assistant.db.models_kp import (
    CompanyProfile,
    DealStatus,
    Document,
    DocumentVersion,
    PriceList,
    PriceListItem,
)
from assistant.kp.norm import MONEY_MAX, name_norm, unit_norm

PRICE_ITEM_FIELDS = frozenset({"price", "name", "unit", "review_fields", "deleted_at"})
PRICE_LIST_FIELDS = frozenset({"deleted_at", "active"})
DUP_STATUSES = frozenset(set(DuplicateStatus))


def _iso(value: Any) -> Any:
    return value.isoformat() if isinstance(value, datetime) else value


async def _doc(session: AsyncSession, user_id: int, rid: Any) -> Document | None:
    return await session.scalar(select(Document).where(
        Document.user_id == user_id, Document.public_id == _uuid(rid)).with_for_update())


async def _item_public(session: AsyncSession, doc: Document) -> str:
    return str(await session.scalar(select(Item.public_id).where(Item.id == doc.item_id)))


async def _revert_document(session: AsyncSession, user_id: int, op: dict, out: Outcome, *,
                           by: str, check: bool, now: datetime) -> None:  # fmt: skip
    from assistant.kp import service

    doc = await _doc(session, user_id, op["id"])
    if doc is None or doc.deleted_at is not None or not doc.current_version_n:
        out.skipped += 1
        return
    if check and op.get("expect_n") and doc.current_version_n != op["expect_n"]:
        out.skipped += 1  # the person changed the КП since: their version stays
        return
    src = await session.scalar(select(DocumentVersion).where(
        DocumentVersion.document_id == doc.id, DocumentVersion.n == int(op["n"])))
    if src is None:
        out.skipped += 1
        return
    was = doc.current_version_n
    v = await service.copy_version(session, doc, src, author="revert", now=now)
    out.inverse.append({"op": "revert_document", "id": str(doc.public_id), "n": was,
                        "expect_n": v.n, "item": await _item_public(session, doc)})  # fmt: skip
    out.items.add(await _item_public(session, doc))


async def _set_document(session: AsyncSession, user_id: int, op: dict, out: Outcome, *,
                        by: str, check: bool, now: datetime) -> None:  # fmt: skip
    values = dict(op.get("values") or {})
    if set(values) != {"deal_status"} or values["deal_status"] not in set(DealStatus):
        raise ValueError("set_document: fields not allowed")
    doc = await _doc(session, user_id, op["id"])
    if doc is None:
        out.skipped += 1
        return
    expect = op.get("expect") or {}
    if check and expect and doc.deal_status != expect.get("deal_status"):
        out.skipped += 1
        return
    if doc.deal_status == values["deal_status"]:
        return
    old = doc.deal_status
    doc.deal_status = values["deal_status"]
    doc.version += 1
    doc.updated_at = now
    item = await _item_public(session, doc)
    out.inverse.append({"op": "set_document", "id": str(doc.public_id),
                        "values": {"deal_status": old}, "item": item,
                        "expect": {"deal_status": values["deal_status"]}})  # fmt: skip
    out.items.add(item)


async def _set_company_profile(session: AsyncSession, user_id: int, op: dict, out: Outcome, *,
                               by: str, check: bool, now: datetime) -> None:  # fmt: skip
    from assistant.kp import profile

    cur = await session.scalar(select(CompanyProfile).where(CompanyProfile.user_id == user_id)
                               .with_for_update())  # fmt: skip
    expect = op.get("expect") or {}
    before = await profile.snapshot(session, cur)
    if check and expect and profile.fingerprint(before) != expect.get("fingerprint"):
        out.skipped += 1  # changed by the person since
        return
    after = await profile.restore(session, user_id, op.get("values"), now)
    out.inverse.append({"op": "set_company_profile", "values": before, "expect": {
        "fingerprint": profile.fingerprint(await profile.snapshot(session, after))}})


async def _set_price_list(session: AsyncSession, user_id: int, op: dict, out: Outcome, *,
                          by: str, check: bool, now: datetime) -> None:  # fmt: skip
    values = dict(op.get("values") or {})
    if not values or set(values) - PRICE_LIST_FIELDS:
        raise ValueError("set_price_list: fields not allowed")
    pl = await session.scalar(select(PriceList).where(
        PriceList.user_id == user_id, PriceList.public_id == _uuid(op["id"])).with_for_update())
    if pl is None:
        out.skipped += 1
        return
    expect = op.get("expect") or {}
    if check and any(_iso(getattr(pl, k)) != v for k, v in expect.items()):
        out.skipped += 1
        return
    old = {k: _iso(getattr(pl, k)) for k in values}
    if old == values:
        return
    for k, v in values.items():
        setattr(pl, k, datetime.fromisoformat(v) if k == "deleted_at" and v else v)
    pl.updated_at = now
    out.inverse.append({"op": "set_price_list", "id": str(pl.public_id), "values": old,
                        "expect": {k: _iso(getattr(pl, k)) for k in values}})  # fmt: skip


def _price_value(it: PriceListItem, k: str) -> Any:
    if k == "price":
        return f"{Decimal(it.price):.2f}"
    if k == "review_fields":
        return list(it.review_fields or [])
    return _iso(getattr(it, k))


async def _set_price_item(session: AsyncSession, user_id: int, op: dict, out: Outcome, *,
                          by: str, check: bool, now: datetime) -> None:  # fmt: skip
    values = dict(op.get("values") or {})
    if not values or set(values) - PRICE_ITEM_FIELDS:
        raise ValueError("set_price_item: fields not allowed")
    it = await session.scalar(select(PriceListItem).where(
        PriceListItem.user_id == user_id, PriceListItem.public_id == _uuid(op["id"]))
        .with_for_update())  # fmt: skip
    if it is None:
        out.skipped += 1
        return
    expect = op.get("expect") or {}
    if check and any(_price_value(it, k) != v for k, v in expect.items()):
        out.skipped += 1
        return
    old = {k: _price_value(it, k) for k in values}
    if old == values:
        return
    for k, v in values.items():
        if k == "price":
            price = Decimal(str(v))
            if price < 0 or price > MONEY_MAX:
                raise ValueError("set_price_item: price")
            it.price = price
        elif k == "deleted_at":
            it.deleted_at = datetime.fromisoformat(v) if v else None
        elif k == "name":
            it.name, it.name_norm = str(v)[:300], name_norm(str(v))
        elif k == "unit":
            it.unit = unit_norm(v)
        else:
            it.review_fields = [str(x) for x in v or []]
    it.updated_at = now
    out.inverse.append({"op": "set_price_item", "id": str(it.public_id), "values": old,
                        "expect": {k: _price_value(it, k) for k in values}})  # fmt: skip


async def set_dup_status(session: AsyncSession, user_id: int, op: dict, out: Outcome, *,
                         check: bool, now: datetime) -> None:  # fmt: skip
    """`set_status` for `entity: expense_duplicates` (called from ops_dedup._set_status)."""
    if op.get("value") not in DUP_STATUSES:
        raise ValueError("set_status: value not allowed")
    dup = await session.scalar(select(ExpenseDuplicate).where(
        ExpenseDuplicate.user_id == user_id, ExpenseDuplicate.public_id == _uuid(op["id"]))
        .with_for_update())  # fmt: skip
    if dup is None:
        out.skipped += 1
        return
    if check and op.get("expect") and dup.status != op["expect"]:
        out.skipped += 1
        return
    if dup.status == op["value"]:
        return
    out.inverse.append({"op": "set_status", "entity": "expense_duplicates",
                        "id": str(dup.public_id), "value": dup.status,
                        "expect": op["value"]})  # fmt: skip
    dup.status = op["value"]
    dup.decided_at = now if op["value"] != DuplicateStatus.SUGGESTED else None


HANDLERS = {
    "revert_document": _revert_document,
    "set_document": _set_document,
    "set_company_profile": _set_company_profile,
    "set_price_list": _set_price_list,
    "set_price_item": _set_price_item,
}

__all__ = ["HANDLERS", "set_dup_status"]
