"""/v1/collections: stacks (spec 4.6, 6.4), shown as groups inside pages. Contract:
docs/api/stacks.md. Every change is an action with «Отменить»; records are never touched."""

import uuid
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from assistant.actions import actions_dicts, engine, record
from assistant.analytics import server_event
from assistant.api.consent_gate import require_base_consent
from assistant.api.deps import CurrentUser, Db
from assistant.api.errors import ApiError
from assistant.db.models import Item
from assistant.db.models_actions import Action, ActionKind, Initiator
from assistant.db.models_dedup import Collection, CollectionItem
from assistant.db.models_pages import Screen, ScreenItem
from assistant.pages import lock_user
from assistant.stacks import group_rows_ops, refresh_count

router = APIRouter(prefix="/collections", tags=["collections"])
BaseUser = Annotated[CurrentUser, Depends(require_base_consent)]
ICONS = {"people", "documents", "shopping", "money", "health", "home", "work", "other"}
PREVIEW = 200


class CollectionPatchIn(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=40)
    icon: str | None = None
    hidden: bool | None = None


class AddIn(BaseModel):
    item_id: uuid.UUID


def _now() -> datetime:
    return datetime.now(UTC)


async def stacks_out(db: Db, cols: list[Collection]) -> list[dict[str, Any]]:
    pages = {pk: pid for pk, pid in await db.execute(select(Screen.id, Screen.public_id).where(
        Screen.id.in_([c.screen_id for c in cols if c.screen_id])))} if cols else {}
    acts = {pk: pid for pk, pid in await db.execute(select(Action.id, Action.public_id).where(
        Action.id.in_([c.action_id for c in cols if c.action_id])))} if cols else {}
    return [{
        "id": str(c.public_id), "kind": c.kind, "title": c.title, "title_kk": c.title_kk,
        "icon": c.icon, "page_id": str(pages[c.screen_id]) if c.screen_id in pages else None,
        "group_key": c.title, "item_count": c.item_count, "created_by": c.created_by,
        "action_id": str(acts[c.action_id]) if c.action_id in acts else None,
        "hidden_at": c.hidden_at.isoformat() if c.hidden_at else None,
        "last_opened_at": c.last_opened_at.isoformat() if c.last_opened_at else None,
        "seq": c.seq, "created_at": c.created_at.isoformat(),
        "updated_at": c.updated_at.isoformat(),
    } for c in cols]  # fmt: skip


async def _own(db: Db, user: CurrentUser, cid: uuid.UUID) -> Collection:
    c = await db.scalar(select(Collection).where(Collection.user_id == user.id,
                                                 Collection.public_id == cid,
                                                 Collection.deleted_at.is_(None))
                        .with_for_update())  # fmt: skip
    if c is None:
        raise ApiError(404, "not_found")
    return c


async def _item(db: Db, user: CurrentUser, iid: uuid.UUID) -> Item:
    it = await db.scalar(select(Item).where(Item.user_id == user.id, Item.public_id == iid))
    if it is None:
        raise ApiError(404, "not_found")
    return it


async def _write(db: Db, user: CurrentUser, c: Collection, kind: str, sentence: str,
                 ops: list[dict[str, Any]],
                 changes: list[dict[str, Any]]) -> dict[str, Any]:  # fmt: skip
    now = _now()
    out = await engine.apply(db, user.id, ops, by=Initiator.USER, check=False, now=now)
    action = await record(db, user_id=user.id, kind=kind, initiated_by=Initiator.USER,
                          summary={"ru": sentence, "kk": None}, changes=changes,
                          inverse=out.inverse, now=now, screen_id=c.screen_id,
                          extra={"collection_id": str(c.public_id)})  # fmt: skip
    await refresh_count(db, c)
    await db.flush()
    return (await actions_dicts(db, [action], now))[0]


def _ungroup_ops(page: Screen, title: str, item_pubs: list[str],
                 drop_group: bool) -> list[dict[str, Any]]:  # fmt: skip
    ops: list[dict[str, Any]] = []
    if item_pubs:
        ops.append({"op": "restore_positions", "page": str(page.public_id),
                    "rows": [{"item": i, "group_key": None, "expect": {"group_key": title}}
                             for i in item_pubs]})  # fmt: skip
    if drop_group:
        view = dict(page.view_state or {})
        if title in (view.get("groups") or []):
            view["groups"] = [g for g in view["groups"] if g != title]
            ops.append({"op": "restore_view_state", "page": str(page.public_id),
                        "view_state": view})  # fmt: skip
    return ops


async def _grouped_rows(db: Db, c: Collection, item_ids: list[int] | None = None) -> list[str]:
    if c.screen_id is None:
        return []
    q = (select(Item.public_id).join(ScreenItem, ScreenItem.item_id == Item.id)
         .where(ScreenItem.screen_id == c.screen_id, ScreenItem.group_key == c.title))
    if item_ids is not None:
        q = q.where(Item.id.in_(item_ids))
    return [str(x) for x in await db.scalars(q)]


@router.get("")
async def list_stacks(user: BaseUser, db: Db, page_id: uuid.UUID | None = None,
                      include_hidden: bool = False,
                      limit: Annotated[int, Query(ge=1, le=200)] = 100,
                      ) -> dict[str, Any]:  # fmt: skip
    q = select(Collection).where(Collection.user_id == user.id, Collection.deleted_at.is_(None))
    if page_id is not None:
        q = q.join(Screen, Screen.id == Collection.screen_id).where(Screen.public_id == page_id)
    if not include_hidden:
        q = q.where(Collection.hidden_at.is_(None))
    rows = list(await db.scalars(q.order_by(Collection.item_count.desc(), Collection.id)
                                 .limit(limit)))
    return {"collections": await stacks_out(db, rows)}


@router.get("/{collection_id}")
async def open_stack(collection_id: uuid.UUID, user: BaseUser, db: Db) -> dict[str, Any]:
    """Opening a stack also brings a hidden one back (hidden = not opened for 30 days)."""
    c = await _own(db, user, collection_id)
    c.last_opened_at, c.hidden_at = _now(), None
    rows = await db.execute(
        select(Item, CollectionItem.added_by)
        .join(CollectionItem, CollectionItem.item_id == Item.id)
        .where(CollectionItem.collection_id == c.id, CollectionItem.removed_by_user_at.is_(None),
               Item.deleted_at.is_(None), Item.hidden_reason.is_(None))
        .order_by(func.coalesce(Item.occurred_at, Item.created_at).desc(),
                  Item.id.desc()))  # fmt: skip
    items = [{"item_id": str(it.public_id), "title": it.title,
              "preview": ((it.text if it.text is not None else it.raw_text) or "")[:PREVIEW],
              "added_by": by, "occurred_at": (it.occurred_at or it.created_at).isoformat()}
             for it, by in rows]  # fmt: skip
    await db.flush()
    await server_event(db, user.id, "stack_opened", {"items_count": len(items)})
    return {"collection": (await stacks_out(db, [c]))[0], "items": items}


@router.patch("/{collection_id}")
async def patch_stack(collection_id: uuid.UUID, body: CollectionPatchIn, user: BaseUser,
                      db: Db) -> dict[str, Any]:  # fmt: skip
    await lock_user(db, user.id)
    c = await _own(db, user, collection_id)
    state: dict[str, Any] = {}
    if body.title is not None and " ".join(body.title.split()) != c.title:
        state["title"] = " ".join(body.title.split())
    if body.icon is not None:
        if body.icon not in ICONS:
            raise ApiError(422, "validation_error")
        if body.icon != c.icon:
            state["icon"] = body.icon
    if body.hidden is not None and body.hidden != (c.hidden_at is not None):
        state["hidden_at"] = _now().isoformat() if body.hidden else None
    if not state:
        return {"collection": (await stacks_out(db, [c]))[0], "action": None}
    sentence = (f"Переименовал стопку в «{state['title']}»" if "title" in state
                else "Скрыл стопку" if state.get("hidden_at") else "Изменил стопку")
    action = await _write(db, user, c, ActionKind.USER_EDIT, sentence,
                          [{"op": "restore_collection", "id": str(c.public_id), "state": state}],
                          [])  # fmt: skip
    return {"collection": (await stacks_out(db, [c]))[0], "action": action}


@router.post("/{collection_id}/items", status_code=201)
async def add_to_stack(collection_id: uuid.UUID, body: AddIn, user: BaseUser,
                       db: Db) -> dict[str, Any]:  # fmt: skip
    await lock_user(db, user.id)
    c = await _own(db, user, collection_id)
    it = await _item(db, user, body.item_id)
    if it.deleted_at is not None:
        raise ApiError(409, "item_deleted")
    ops: list[dict[str, Any]] = [{"op": "add_collection_item", "collection": str(c.public_id),
                                  "item": str(it.public_id)}]  # fmt: skip
    page = await db.get(Screen, c.screen_id) if c.screen_id else None
    if page is not None and page.deleted_at is None:
        ops += await group_rows_ops(db, page, c.title, [it.id], _now())
    action = await _write(db, user, c, ActionKind.STACK_ADD, f"Добавил в стопку «{c.title}»", ops,
                          [{"item_id": str(it.public_id), "title": it.title or "", "kind": "group",
                            "page_id": str(page.public_id) if page else None,
                            "text": f"→ {c.title}"}])  # fmt: skip
    return {"collection": (await stacks_out(db, [c]))[0], "action": action}


@router.delete("/{collection_id}/items/{item_id}")
async def remove_from_stack(collection_id: uuid.UUID, item_id: uuid.UUID, user: BaseUser,
                            db: Db) -> dict[str, Any]:  # fmt: skip
    """The record leaves the stack and does not come back into it (spec 6.4: stack_exclusion)."""
    await lock_user(db, user.id)
    c = await _own(db, user, collection_id)
    it = await _item(db, user, item_id)
    member = await db.get(CollectionItem, (c.id, it.id))
    if member is None or member.removed_by_user_at is not None:
        raise ApiError(404, "not_found")
    ops: list[dict[str, Any]] = [{"op": "remove_collection_item", "collection": str(c.public_id),
                                  "item": str(it.public_id), "by_user": True}]  # fmt: skip
    page = await db.get(Screen, c.screen_id) if c.screen_id else None
    if page is not None:
        ops += _ungroup_ops(page, c.title, await _grouped_rows(db, c, [it.id]), False)
    action = await _write(db, user, c, ActionKind.STACK_REMOVE, f"Убрал из стопки «{c.title}»",
                          ops, [{"item_id": str(it.public_id), "title": it.title or "",
                                 "kind": "remove", "page_id": str(page.public_id) if page else None,
                                 "text": f"{c.title} → без стопки"}])  # fmt: skip
    return {"collection": (await stacks_out(db, [c]))[0], "action": action}


@router.delete("/{collection_id}")
async def delete_stack(collection_id: uuid.UUID, user: BaseUser, db: Db) -> dict[str, Any]:
    """The stack goes (with «Отменить»); its records stay where they are, out of the group."""
    await lock_user(db, user.id)
    c = await _own(db, user, collection_id)
    ops: list[dict[str, Any]] = [{"op": "restore_collection", "id": str(c.public_id),
                                  "state": {"deleted_at": _now().isoformat()}}]  # fmt: skip
    page = await db.get(Screen, c.screen_id) if c.screen_id else None
    if page is not None:
        ops += _ungroup_ops(page, c.title, await _grouped_rows(db, c), True)
    action = await _write(db, user, c, ActionKind.DELETE_STACK,
                          f"Убрал стопку «{c.title}». Записи остались", ops, [])  # fmt: skip
    return {"collection": (await stacks_out(db, [c]))[0], "action": action}
