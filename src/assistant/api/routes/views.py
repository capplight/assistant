"""Page views by hand (week 11, S38 «Настроить страницу»; contract docs/api/views.md).

Every call plans its change with `assistant.pages.view.plan_view` (the same function the
assistant's `set_view` tool uses), applies the ops in one transaction and writes one action with
«Отменить» and «Что изменилось». Safe to queue in the outbox: the same `client_id` returns the
first result.
"""

import uuid
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.actions import actions_dicts, engine, record
from assistant.actions.patch import page_patches
from assistant.api.consent_gate import require_base_consent
from assistant.api.deps import CurrentUser, Db
from assistant.api.errors import ApiError
from assistant.api.routes.pages import page_item_out, page_out
from assistant.api.schemas import (
    ActionOut,
    FieldsPutIn,
    PageItemPatchIn,
    PageItemPatchOut,
    ResetIn,
    ViewIn,
    ViewOut,
)
from assistant.db.models import Item
from assistant.db.models_actions import Action, ActionKind, Initiator
from assistant.db.models_pages import ItemFacet, Screen, ScreenItem
from assistant.pages import lock_user
from assistant.pages import view as views

router = APIRouter(prefix="/pages", tags=["pages"])
GatedUser = Annotated[CurrentUser, Depends(require_base_consent)]

VIEW_FIELDS = ("board", "sort", "sort_dir", "group_by", "filters", "period", "today_tile")


def view_error(exc: views.ViewError) -> ApiError:
    if exc.code == "page_system":
        return ApiError(403, "page_system")
    if exc.code == "not_found":
        return ApiError(404, "not_found")
    return ApiError(422, exc.code, details={"reason": str(exc)} if str(exc) != exc.code else None)


def change_of(body: ViewIn) -> views.ViewChange:
    given = body.model_fields_set
    view: dict[str, Any] = {}
    for name in VIEW_FIELDS:
        if name in given:
            value = getattr(body, name)
            if name == "filters" and value is not None:
                value = [f.model_dump(exclude_none=True) for f in value]
            view[name] = value
    return views.ViewChange(
        layout=body.layout, view=view, title=body.title, icon=body.icon,
        fields=[f.model_dump() for f in body.fields] if body.fields is not None else None,
        show=list(body.show_fields), hide=list(body.hide_fields),
        add_fields=[f.model_dump() for f in body.add_fields],
        rename_fields=[f.model_dump() for f in body.rename_fields],
        remove_fields=list(body.remove_fields),
        colors={str(c.item_id): c.color for c in body.colors},
        pins={str(p.item_id): p.pinned for p in body.pins}, reset=body.reset,
    )  # fmt: skip


async def _page(db: AsyncSession, user: CurrentUser, page_id: uuid.UUID) -> Screen:
    page = await db.scalar(select(Screen).where(Screen.user_id == user.id,
                                                Screen.public_id == page_id,
                                                Screen.deleted_at.is_(None)))  # fmt: skip
    if page is None:
        raise ApiError(404, "not_found")
    return page


async def _repeat(db: AsyncSession, user_id: int, client_id: uuid.UUID | None) -> Action | None:
    if client_id is None:
        return None
    return await db.scalar(select(Action).where(Action.user_id == user_id,
                                                Action.client_id == client_id))


async def _action_out(db: AsyncSession, action: Action | None, now: datetime) -> ActionOut | None:
    if action is None:
        return None
    return ActionOut.model_validate((await actions_dicts(db, [action], now))[0])


async def apply_by_hand(db: AsyncSession, user: CurrentUser, page: Screen,
                        change: views.ViewChange, *, kind: str, client_id: uuid.UUID | None,
                        now: datetime, sentence: str | None = None
                        ) -> tuple[Action | None, set[int], set[str]]:  # fmt: skip
    """Plan, apply and record the person's own view change. (action, pages, items)."""
    template = await views.template_of(db, page)
    try:
        plan = await views.plan_view(db, page, template, change, by="user")
    except views.ViewError as exc:
        raise view_error(exc) from exc
    if not plan.ops:
        return None, set(), set()
    out = await engine.apply(db, user.id, plan.ops, by=Initiator.USER, check=False, now=now)
    if not out.inverse:
        return None, out.pages, out.items
    if change.reset:
        kind = ActionKind.SCREEN_RESET
    action = await record(db, user_id=user.id, kind=kind, initiated_by=Initiator.USER,
                          summary={"ru": sentence or plan.sentence, "kk": None},
                          changes=plan.changes, inverse=out.inverse, now=now, screen_id=page.id,
                          client_id=client_id)  # fmt: skip
    await db.flush()
    return action, out.pages | {page.id}, out.items


async def _view_out(db: AsyncSession, user: CurrentUser, page: Screen, action: Action | None,
                    pages: set[int], items: set[str], *, repeated: bool,
                    now: datetime) -> ViewOut:  # fmt: skip
    await db.flush()
    await db.refresh(page)
    patch = (await page_patches(db, user.id, pages | {page.id}, items))
    mine = next(p for p in patch if p["page_id"] == str(page.public_id))
    return ViewOut(page=page_out(page), changed=action is not None and not repeated,
                   repeated=repeated, action=await _action_out(db, action, now),
                   page_patch=mine)  # fmt: skip


@router.post("/{page_id}/view", response_model=ViewOut)
async def set_view(page_id: uuid.UUID, body: ViewIn, user: GatedUser, db: Db) -> ViewOut:
    """S38: any view setting of one page, at once, with «Отменить» (R-51 extended)."""
    now = datetime.now(UTC)
    await lock_user(db, user.id)
    page = await _page(db, user, page_id)
    first = await _repeat(db, user.id, body.client_id)
    if first is not None:
        return await _view_out(db, user, page, first, set(), set(), repeated=True, now=now)
    change = change_of(body)
    action, pages, items = await apply_by_hand(db, user, page, change,
                                               kind=ActionKind.SCREEN_VIEW_CHANGE,
                                               client_id=body.client_id, now=now)  # fmt: skip
    return await _view_out(db, user, page, action, pages, items, repeated=False, now=now)


@router.put("/{page_id}/fields", response_model=ViewOut)
async def put_fields(page_id: uuid.UUID, body: FieldsPutIn, user: GatedUser, db: Db) -> ViewOut:
    """Visibility and order of the fields, own fields (≤5). ★ cannot be hidden."""
    return await set_view(page_id, ViewIn(**body.model_dump(exclude_unset=True)), user, db)


@router.post("/{page_id}/reset", response_model=ViewOut)
async def reset_page(page_id: uuid.UUID, user: GatedUser, db: Db,
                     body: ResetIn | None = None) -> ViewOut:  # fmt: skip
    """«Вернуть как было» (the phone asked S25 first). Own fields hide, their values stay."""
    return await set_view(page_id, ViewIn(client_id=(body or ResetIn()).client_id, reset=True),
                          user, db)  # fmt: skip


def _value_ok(ftype: str, value: Any) -> bool:
    if value is None:
        return True
    if ftype == "bool":
        return isinstance(value, bool)
    if ftype in ("number", "money"):
        if isinstance(value, bool):
            return False
        if isinstance(value, int | float):
            return True
        try:
            float(str(value).replace(" ", "").replace(",", "."))
        except ValueError:
            return False
        return len(str(value)) <= 32
    if ftype == "date":
        try:
            datetime.fromisoformat(str(value))
        except ValueError:
            return False
        return True
    return isinstance(value, str) and len(value) <= 500


@router.patch("/{page_id}/items/{item_id}", response_model=PageItemPatchOut)
async def patch_row(page_id: uuid.UUID, item_id: uuid.UUID, body: PageItemPatchIn,
                    user: GatedUser, db: Db) -> PageItemPatchOut:  # fmt: skip
    """A row of this page: sticker colour, «приколоть», values of the page's own fields."""
    now = datetime.now(UTC)
    await lock_user(db, user.id)
    page = await _page(db, user, page_id)
    found = (await db.execute(
        select(ScreenItem, Item).join(Item, Item.id == ScreenItem.item_id)
        .where(ScreenItem.screen_id == page.id, Item.user_id == user.id,
               Item.public_id == item_id, ScreenItem.removed_by_user_at.is_(None))
    )).first()  # fmt: skip
    if found is None:
        raise ApiError(404, "not_found")
    link, item = found
    first = await _repeat(db, user.id, body.client_id)
    action: Action | None = first
    pages: set[int] = {page.id}
    items: set[str] = {str(item.public_id)}
    if first is None:
        given = body.model_fields_set
        change = views.ViewChange()
        if "color" in given:
            change.colors[str(item.public_id)] = body.color
        if "pinned" in given and body.pinned is not None:
            change.pins[str(item.public_id)] = body.pinned
        ops: list[dict[str, Any]] = []
        changes: list[dict[str, Any]] = []
        sentence = ""
        if not change.empty():
            template = await views.template_of(db, page)
            try:
                plan = await views.plan_view(db, page, template, change, by="user")
            except views.ViewError as exc:
                raise view_error(exc) from exc
            ops += plan.ops
            changes += plan.changes
            sentence = plan.sentence
        name = " ".join((item.title or item.text or item.raw_text or "запись").split())[:60]
        if body.done is not None and body.done != (link.done_at is not None):
            # the checklist tick: on the row, synced to every phone, with «Отменить»
            ops.append({"op": "set_appearance", "page": str(page.public_id),
                        "item": str(item.public_id),
                        "values": {"done_at": now.isoformat() if body.done else None}})
            text = f"{'Отметил' if body.done else 'Вернул'}: {name}"
            changes.append({"item_id": str(item.public_id), "title": name, "kind": "done",
                            "page_id": str(page.public_id), "text": text})  # fmt: skip
            sentence = sentence or text
        if body.values:
            own = {str(c["id"]): c for c in page.custom_fields or []}
            for fid, value in body.values.items():
                c = own.get(fid)
                if c is None:
                    raise ApiError(422, "field_unknown")
                if not _value_ok(str(c.get("type")), value):
                    raise ApiError(422, "validation_error", details={"field": fid})
                ops.append({"op": "set_facet", "page": str(page.public_id),
                            "item": str(item.public_id), "field": fid, "value": value})
                changes.append({"item_id": str(item.public_id), "title": name, "kind": "edit",
                                "page_id": str(page.public_id),
                                "text": f"«{name}»: {c.get('title')} — "
                                        f"{'пусто' if value is None else value}"})  # fmt: skip
            if not sentence:
                sentence = changes[-1]["text"] if len(changes) == 1 else \
                    f"Изменил «{name}»"  # fmt: skip
        if ops:
            out = await engine.apply(db, user.id, ops, by=Initiator.USER, check=False, now=now)
            if out.inverse:
                kind = ActionKind.FACET_EDIT if body.values or (
                    body.done is not None and not change.colors and not change.pins
                ) else ActionKind.SCREEN_VIEW_CHANGE
                action = await record(db, user_id=user.id, kind=kind, initiated_by=Initiator.USER,
                                      summary={"ru": sentence, "kk": None}, changes=changes,
                                      inverse=out.inverse, now=now, screen_id=page.id,
                                      client_id=body.client_id)  # fmt: skip
    await db.flush()
    await db.refresh(link)
    facet = await db.scalar(select(ItemFacet).where(ItemFacet.screen_id == page.id,
                                                    ItemFacet.item_id == item.id))  # fmt: skip
    patch = (await page_patches(db, user.id, pages, items))[0]
    return PageItemPatchOut(link=page_item_out(link, page.public_id, item.public_id),
                            values=dict(facet.data or {}) if facet else {},
                            repeated=first is not None, action=await _action_out(db, action, now),
                            page_patch=patch)  # fmt: skip
