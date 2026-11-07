"""The `inverse` engine (spec 3.7): white-listed ops that code runs, each returning its own reverse.

An op is a JSON object with ids as public uuids (strings), never database ids:

- `restore_positions` {page, rows: [{item, position, group_key, manual_order, updated_by?,
  expect?}]}: sets rows of a page.
- `restore_view_state` {page, view_state}: sets the page's view state.
- `add_screen_item` {page, item, position?, group_key?, manual_order?, added_by?}: shows the item on
  the page (inserts the row, or clears «убрано»).
- `remove_screen_item` {page, item, exclude}: `exclude=true` = «убрано с этой страницы» (rules do
  not bring it back); `false` = the row is deleted (it was added by the change being undone).
- `delete_entity_soft` / `restore_entity` {entity: items|screens, id}: trash / back.
- `restore_field` {entity: items, id, field: title, value, expect?}: sets one field.

`apply` runs a list of ops in one transaction (the caller commits) and returns the ops that undo
what it did, newest first, so `apply(apply(x).inverse)` is a round trip. With `check=True` (an
undo) a row or field whose current value is not the `expect` the change left behind was changed by
the person since: it is skipped and counted, never overwritten («Часть уже изменена вами»).
Every changed page gets `view_version + 1`. Unknown ops or entities raise ValueError: nothing
outside the list ever runs.
"""

import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.db.models import Item
from assistant.db.models_pages import MAX_PAGES, AddedBy, Screen, ScreenItem, ScreenKind
from assistant.pages import add_link, lock_user
from assistant.records import restore_item, trash_item

OPS = frozenset({"restore_positions", "restore_view_state", "add_screen_item",
                 "remove_screen_item", "delete_entity_soft", "restore_entity",
                 "restore_field"})  # fmt: skip
ENTITIES = frozenset({"items", "screens"})
ITEM_FIELDS = frozenset({"title"})
ROW_FIELDS = ("position", "group_key", "manual_order")


@dataclass
class Outcome:
    inverse: list[dict[str, Any]] = field(default_factory=list)
    skipped: int = 0
    items: set[str] = field(default_factory=set)  # item public ids whose state changed
    pages: set[int] = field(default_factory=set)  # screen pks whose rows or view changed


def _uuid(value: Any) -> uuid.UUID:
    return value if isinstance(value, uuid.UUID) else uuid.UUID(str(value))


async def _screen(session: AsyncSession, user_id: int, sid: Any) -> Screen | None:
    return await session.scalar(
        select(Screen).where(Screen.user_id == user_id, Screen.public_id == _uuid(sid))
        .with_for_update()
    )  # fmt: skip


async def _items(session: AsyncSession, user_id: int, ids: list[Any]) -> dict[str, Item]:
    if not ids:
        return {}
    rows = await session.scalars(
        select(Item).where(Item.user_id == user_id, Item.public_id.in_([_uuid(i) for i in ids]))
        .with_for_update()
    )  # fmt: skip
    return {str(i.public_id): i for i in rows}


async def _links(session: AsyncSession, screen_id: int,
                 item_pks: list[int]) -> dict[int, ScreenItem]:  # fmt: skip
    if not item_pks:
        return {}
    rows = await session.scalars(
        select(ScreenItem).where(ScreenItem.screen_id == screen_id,
                                 ScreenItem.item_id.in_(item_pks)).with_for_update()
    )  # fmt: skip
    return {r.item_id: r for r in rows}


def _state(link: ScreenItem) -> dict[str, Any]:
    return {"position": link.position, "group_key": link.group_key,
            "manual_order": link.manual_order, "updated_by": link.updated_by,
            "manual_at": link.manual_at.isoformat() if link.manual_at else None}  # fmt: skip


async def _restore_positions(session: AsyncSession, user_id: int, op: dict, out: Outcome, *,
                             by: str, check: bool, now: datetime) -> None:  # fmt: skip
    rows = list(op.get("rows") or [])
    page = await _screen(session, user_id, op["page"])
    if page is None:
        out.skipped += len(rows)
        return
    items = await _items(session, user_id, [r["item"] for r in rows])
    links = await _links(session, page.id, [i.id for i in items.values()])
    back = []
    for r in rows:
        item = items.get(str(r["item"]))
        link = links.get(item.id) if item is not None else None
        if link is None or link.removed_by_user_at is not None:
            out.skipped += 1
            continue
        cur = _state(link)
        expect = r.get("expect")
        if check and expect and any(cur.get(k) != v for k, v in expect.items()):
            out.skipped += 1
            continue
        new = {k: r[k] for k in ROW_FIELDS if k in r}
        if all(cur[k] == v for k, v in new.items()):
            continue
        back.append({"item": str(r["item"]), **{k: cur[k] for k in new},
                     "updated_by": cur["updated_by"], "manual_at": cur["manual_at"],
                     "expect": new})  # fmt: skip
        for k, v in new.items():
            setattr(link, k, v)
        if "manual_at" in r:  # kept with manual_order (a manual row has a manual_at)
            link.manual_at = datetime.fromisoformat(r["manual_at"]) if r["manual_at"] else None
        link.updated_by = r.get("updated_by") or by
        link.updated_at = now
        out.items.add(str(r["item"]))
        out.pages.add(page.id)
    if back:
        out.inverse.append({"op": "restore_positions", "page": str(page.public_id), "rows": back})


async def _restore_view_state(session: AsyncSession, user_id: int, op: dict, out: Outcome, *,
                              by: str, check: bool, now: datetime) -> None:  # fmt: skip
    page = await _screen(session, user_id, op["page"])
    if page is None or page.kind == ScreenKind.SYSTEM_TODAY:
        out.skipped += 1
        return
    new = dict(op.get("view_state") or {})
    if new == (page.view_state or {}):
        return
    out.inverse.append({"op": "restore_view_state", "page": str(page.public_id),
                        "view_state": dict(page.view_state or {})})  # fmt: skip
    page.view_state = new
    out.pages.add(page.id)


async def _add_screen_item(session: AsyncSession, user_id: int, op: dict, out: Outcome, *,
                           by: str, check: bool, now: datetime) -> None:  # fmt: skip
    page = await _screen(session, user_id, op["page"])
    items = await _items(session, user_id, [op["item"]])
    item = items.get(str(op["item"]))
    if page is None or item is None or page.deleted_at is not None \
            or page.kind == ScreenKind.SYSTEM_TODAY:  # fmt: skip
        out.skipped += 1
        return
    link = (await _links(session, page.id, [item.id])).get(item.id)
    if link is not None and link.removed_by_user_at is None:
        return
    if link is not None:  # it was taken off this page: show it again
        out.inverse.append({"op": "remove_screen_item", "page": str(page.public_id),
                            "item": str(item.public_id), "exclude": True})  # fmt: skip
        link.removed_by_user_at = None
    else:
        added = AddedBy.USER if by == "user" else AddedBy.AGENT
        if op.get("added_by") in (AddedBy.RULE, AddedBy.AGENT, AddedBy.USER):
            added = AddedBy(op["added_by"])
        await add_link(session, page, item.id, item.occurred_at or item.created_at, added)
        await session.flush()
        link = (await _links(session, page.id, [item.id]))[item.id]
        out.inverse.append({"op": "remove_screen_item", "page": str(page.public_id),
                            "item": str(item.public_id), "exclude": False})  # fmt: skip
    for k in ROW_FIELDS:
        if k in op and op[k] is not None:
            setattr(link, k, op[k])
    link.updated_by = by
    link.updated_at = now
    out.items.add(str(item.public_id))
    out.pages.add(page.id)


async def _remove_screen_item(session: AsyncSession, user_id: int, op: dict, out: Outcome, *,
                              by: str, check: bool, now: datetime) -> None:  # fmt: skip
    page = await _screen(session, user_id, op["page"])
    items = await _items(session, user_id, [op["item"]])
    item = items.get(str(op["item"]))
    if page is None or item is None:
        out.skipped += 1
        return
    link = (await _links(session, page.id, [item.id])).get(item.id)
    if link is None or link.removed_by_user_at is not None:
        return
    if op.get("exclude"):
        out.inverse.append({"op": "add_screen_item", "page": str(page.public_id),
                            "item": str(item.public_id)})  # fmt: skip
        link.removed_by_user_at = now
        link.updated_by = by
        link.updated_at = now
    else:
        if check and link.updated_by == "user" and link.manual_order:
            out.skipped += 1  # the person placed it by hand since: it stays
            return
        out.inverse.append({"op": "add_screen_item", "page": str(page.public_id),
                            "item": str(item.public_id), "added_by": link.added_by,
                            **{k: getattr(link, k) for k in ROW_FIELDS}})  # fmt: skip
        await session.execute(delete(ScreenItem).where(ScreenItem.screen_id == page.id,
                                                       ScreenItem.item_id == item.id))
    out.items.add(str(item.public_id))
    out.pages.add(page.id)


async def _soft(session: AsyncSession, user_id: int, op: dict, out: Outcome, *,
                by: str, check: bool, now: datetime) -> None:  # fmt: skip
    entity, rid = op["entity"], str(op["id"])
    if entity == "items":
        item = (await _items(session, user_id, [rid])).get(rid)
        if item is None:
            out.skipped += 1
            return
        if item.deleted_at is not None:
            return
        trash_item(item, now)
        out.items.add(rid)
    else:
        page = await _screen(session, user_id, rid)
        if page is None or page.kind == ScreenKind.SYSTEM_TODAY:
            out.skipped += 1
            return
        if page.deleted_at is not None:
            return
        page.deleted_at = now
    out.inverse.append({"op": "restore_entity", "entity": entity, "id": rid})


async def _restore(session: AsyncSession, user_id: int, op: dict, out: Outcome, *,
                   by: str, check: bool, now: datetime) -> None:  # fmt: skip
    entity, rid = op["entity"], str(op["id"])
    if entity == "items":
        item = (await _items(session, user_id, [rid])).get(rid)
        if item is None:  # purged after 30 days in the trash
            out.skipped += 1
            return
        if item.deleted_at is None:
            return
        restore_item(item)
        out.items.add(rid)
    else:
        page = await _screen(session, user_id, rid)
        if page is None:
            out.skipped += 1
            return
        if page.deleted_at is None:
            return
        live = Screen.user_id == user_id, Screen.deleted_at.is_(None)
        if page.singleton and await session.scalar(select(Screen.id).where(
                *live, Screen.template_key == page.template_key, Screen.id != page.id)):
            out.skipped += 1  # the topic was added again meanwhile
            return  # fmt: skip
        if (await session.scalar(select(func.count()).select_from(Screen).where(*live))
                or 0) >= MAX_PAGES:
            out.skipped += 1
            return  # fmt: skip
        page.deleted_at = None
    out.inverse.append({"op": "delete_entity_soft", "entity": entity, "id": rid})


async def _restore_field(session: AsyncSession, user_id: int, op: dict, out: Outcome, *,
                         by: str, check: bool, now: datetime) -> None:  # fmt: skip
    if op.get("entity") != "items" or op.get("field") not in ITEM_FIELDS:
        raise ValueError("restore_field: entity/field not allowed")
    rid, name = str(op["id"]), op["field"]
    item = (await _items(session, user_id, [rid])).get(rid)
    if item is None:
        out.skipped += 1
        return
    cur = getattr(item, name)
    if check and "expect" in op and cur != op["expect"]:
        out.skipped += 1
        return
    if cur == op["value"]:
        return
    out.inverse.append({"op": "restore_field", "entity": "items", "id": rid, "field": name,
                        "value": cur, "expect": op["value"]})  # fmt: skip
    setattr(item, name, op["value"])
    out.items.add(rid)


_HANDLERS = {
    "restore_positions": _restore_positions,
    "restore_view_state": _restore_view_state,
    "add_screen_item": _add_screen_item,
    "remove_screen_item": _remove_screen_item,
    "delete_entity_soft": _soft,
    "restore_entity": _restore,
    "restore_field": _restore_field,
}


def validate(ops: list[dict[str, Any]]) -> None:
    for op in ops:
        if not isinstance(op, dict) or op.get("op") not in OPS:
            raise ValueError(f"op not allowed: {op.get('op') if isinstance(op, dict) else op}")
        if op["op"] in ("delete_entity_soft", "restore_entity", "restore_field") \
                and op.get("entity") not in ENTITIES:  # fmt: skip
            raise ValueError("entity not allowed")


async def apply(session: AsyncSession, user_id: int, ops: list[dict[str, Any]], *, by: str,
                check: bool, now: datetime) -> Outcome:  # fmt: skip
    """Run `ops` in order inside the caller's transaction. Returns their undo, newest first."""
    validate(ops)
    await lock_user(session, user_id)
    out = Outcome()
    for op in ops:
        await _HANDLERS[op["op"]](session, user_id, op, out, by=by, check=check, now=now)
    await session.flush()
    if out.pages:
        await session.execute(update(Screen).where(Screen.id.in_(out.pages))
                              .values(view_version=Screen.view_version + 1, updated_at=now))
    out.inverse.reverse()
    return out


def op_items(op: dict[str, Any]) -> set[str]:
    """Item ids an op is about (empty: a page-level op)."""
    if op["op"] == "restore_positions":
        return {str(r["item"]) for r in op.get("rows") or []}
    if op["op"] in ("add_screen_item", "remove_screen_item"):
        return {str(op["item"])}
    if op.get("entity") == "items":
        return {str(op["id"])}
    return set()


def select_ops(ops: list[dict[str, Any]], *, only: set[str] | None,
               without: set[str]) -> list[dict[str, Any]]:  # fmt: skip
    """The ops (and rows) for some items. `only=None`: everything except `without`."""
    out = []
    for op in ops:
        ids = op_items(op)
        if not ids:
            if only is None:
                out.append(op)
            continue
        keep = (ids & only if only is not None else ids) - without
        if not keep:
            continue
        if op["op"] == "restore_positions":
            out.append({**op, "rows": [r for r in op["rows"] if str(r["item"]) in keep]})
        else:
            out.append(op)
    return out
