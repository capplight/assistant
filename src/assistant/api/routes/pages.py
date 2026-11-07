"""/v1/page-templates and /v1/pages: catalogue, a person's pages, their contents.

Contract: docs/api/pages.md. A page is a view on the shared memory (R-46): removing one leaves the
items alone. Manual reordering comes in week 7 and template editing in week 11.
"""

import hashlib
import json
import uuid
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, Query, Response
from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.api.consent_gate import require_base_consent
from assistant.api.deps import CurrentUser, Db
from assistant.api.errors import ApiError
from assistant.api.routes.items import items_out
from assistant.api.schemas import (
    PageCreateIn,
    PageCreateOut,
    PageEntryOut,
    PageItemAddIn,
    PageItemAddOut,
    PageItemOut,
    PageItemsOut,
    PageListOut,
    PageOut,
    PagePatchIn,
    TemplateListOut,
    TemplateOut,
)
from assistant.db.models import Item
from assistant.db.models_pages import (
    MAX_PAGES,
    AddedBy,
    Screen,
    ScreenCreatedBy,
    ScreenItem,
    ScreenKind,
    ScreenTemplate,
    UpdatedBy,
)
from assistant.pages import (
    add_link,
    create_page,
    fill_page,
    latest_template,
    latest_templates,
    lock_user,
)

router = APIRouter(prefix="/pages", tags=["pages"])
templates_router = APIRouter(prefix="/page-templates", tags=["pages"])
GatedUser = Annotated[CurrentUser, Depends(require_base_consent)]

_AFTER_ALL_KEYS = "~"  # sorts after every LexoRank key: rows with no position go last


def page_out(page: Screen) -> PageOut:
    return PageOut(
        id=page.public_id, client_id=page.client_id, kind=str(page.kind),
        template_key=page.template_key, template_version=page.template_version, title=page.title,
        title_kk=page.title_kk, icon=page.icon, position=page.position, layout=page.layout,
        view_state=page.view_state, field_prefs=page.field_prefs,
        custom_fields=page.custom_fields, customized=page.customized,
        view_version=page.view_version, created_by=str(page.created_by), hidden_at=page.hidden_at,
        last_opened_at=page.last_opened_at, seq=page.seq, created_at=page.created_at,
        updated_at=page.updated_at, deleted_at=page.deleted_at,
    )  # fmt: skip


def page_item_out(link: ScreenItem, page_id: uuid.UUID, item_id: uuid.UUID) -> PageItemOut:
    return PageItemOut(
        id=link.public_id, page_id=page_id, item_id=item_id, position=link.position,
        group_key=link.group_key, manual_order=link.manual_order, manual_at=link.manual_at,
        pinned=link.pinned, added_by=str(link.added_by), removed_at=link.removed_by_user_at,
        seq=link.seq, updated_at=link.updated_at, updated_by=str(link.updated_by),
    )  # fmt: skip


def _template_out(t: ScreenTemplate) -> TemplateOut:
    return TemplateOut(
        key=t.key, version=t.version, title=t.title, description=t.description, icon=t.icon,
        preview_ref=t.preview_ref, singleton=t.singleton, facet=t.facet, fields=t.fields,
        layouts=t.layouts, default_layout=t.default_layout, default_view=t.default_view,
        aggregates=t.aggregates, auto_rule=t.auto_rule, min_app_version=t.min_app_version,
    )  # fmt: skip


def field_values(fields: list[dict[str, Any]], item: Item) -> dict[str, Any]:
    """Values of a template's fields that this item has. Other sources have no data yet."""
    envelope = item.envelope or {}
    out: dict[str, Any] = {}
    for field in fields:
        scope, _, name = str(field.get("source", "")).partition(".")
        value: Any = None
        if scope == "envelope":
            value = envelope.get(name)
        elif scope == "item":
            if name == "text":
                value = item.text if item.text is not None else item.raw_text
            elif name in ("title", "source"):
                value = getattr(item, name)
            elif name == "occurred_at":
                when = item.occurred_at or item.created_at
                value = when.isoformat() if when else None
        if value not in (None, "", []):
            out[str(field["id"])] = str(value) if name == "source" else value
    return out


# --- catalogue ---


@templates_router.get("", response_model=TemplateListOut)
async def list_templates(
    user: GatedUser, db: Db,
    if_none_match: Annotated[str | None, Header()] = None,
) -> TemplateListOut | Response:  # fmt: skip
    body = TemplateListOut(templates=[_template_out(t) for t in await latest_templates(db)])
    raw = json.dumps(body.model_dump(mode="json"), ensure_ascii=False, sort_keys=True)
    etag = f'"{hashlib.sha256(raw.encode()).hexdigest()[:32]}"'
    headers = {"ETag": etag, "Cache-Control": "private, no-cache"}
    if if_none_match == etag:
        return Response(status_code=304, headers=headers)
    return Response(raw, media_type="application/json", headers=headers)


# --- pages ---


async def _get(db: AsyncSession, user: CurrentUser, page_id: uuid.UUID, *,
               include_removed: bool = False) -> Screen:  # fmt: skip
    stmt = select(Screen).where(Screen.user_id == user.id, Screen.public_id == page_id)
    if not include_removed:
        stmt = stmt.where(Screen.deleted_at.is_(None))
    page = await db.scalar(stmt)
    if page is None:
        raise ApiError(404, "not_found")
    return page


def _editable(page: Screen) -> None:
    if page.kind == ScreenKind.SYSTEM_TODAY:
        raise ApiError(403, "page_system")


async def _check_room(db: AsyncSession, user_id: int) -> None:
    count = await db.scalar(
        select(func.count()).select_from(Screen)
        .where(Screen.user_id == user_id, Screen.deleted_at.is_(None))
    )  # fmt: skip
    if (count or 0) >= MAX_PAGES:
        raise ApiError(422, "pages_limit")


async def _live_singleton(db: AsyncSession, user_id: int, key: str) -> Screen | None:
    return await db.scalar(
        select(Screen).where(Screen.user_id == user_id, Screen.template_key == key,
                             Screen.singleton.is_(True), Screen.deleted_at.is_(None))
    )  # fmt: skip


def _singleton_exists(existing: Screen) -> ApiError:
    return ApiError(409, "singleton_exists", details={"page_id": str(existing.public_id)})


@router.get("", response_model=PageListOut)
async def list_pages(user: GatedUser, db: Db) -> PageListOut:
    rows = await db.scalars(
        select(Screen)
        .where(Screen.user_id == user.id, Screen.deleted_at.is_(None))
        .order_by((Screen.kind == ScreenKind.SYSTEM_TODAY).desc(), Screen.position,
                  Screen.public_id)
    )  # fmt: skip
    return PageListOut(pages=[page_out(p) for p in rows])


@router.post("", response_model=PageCreateOut, status_code=201)
async def add_page(body: PageCreateIn, user: GatedUser, db: Db,
                   response: Response) -> PageCreateOut:  # fmt: skip
    # Under the user's lock: a parallel retry or a parallel add can't slip past these checks.
    await lock_user(db, user.id)
    existing = await db.scalar(
        select(Screen).where(Screen.user_id == user.id, Screen.client_id == body.client_id)
    )
    if existing is not None:
        response.status_code = 200
        return PageCreateOut(page=page_out(existing), created=False)

    template = await latest_template(db, body.template_key)
    if template is None:
        raise ApiError(422, "template_unknown")
    if body.layout is not None and body.layout not in template.layouts:
        raise ApiError(422, "layout_not_allowed")
    title = body.title.strip() if body.title else None
    if body.title is not None and not title:
        raise ApiError(422, "validation_error")
    if template.singleton:
        rival = await _live_singleton(db, user.id, template.key)
        if rival is not None:
            raise _singleton_exists(rival)
    await _check_room(db, user.id)

    page = await create_page(db, user.id, template, client_id=body.client_id, title=title,
                             icon=body.icon, layout=body.layout,
                             created_by=ScreenCreatedBy(body.created_by))  # fmt: skip
    await fill_page(db, page)
    return PageCreateOut(page=page_out(page), created=True)


@router.get("/{page_id}", response_model=PageOut)
async def get_page(page_id: uuid.UUID, user: GatedUser, db: Db) -> PageOut:
    return page_out(await _get(db, user, page_id))


@router.patch("/{page_id}", response_model=PageOut)
async def patch_page(page_id: uuid.UUID, body: PagePatchIn, user: GatedUser, db: Db) -> PageOut:
    await lock_user(db, user.id)  # all writers of a user's pages: this lock, then the rows
    page = await _get(db, user, page_id)
    _editable(page)
    if body.title is not None:
        title = body.title.strip()
        if not title:
            raise ApiError(422, "validation_error")
        page.title, page.title_kk = title, None
    if body.icon is not None:
        page.icon = body.icon
    if body.layout is not None and body.layout != page.layout:
        if body.base_view_version is not None and body.base_view_version != page.view_version:
            raise ApiError(409, "conflict", details={"view_version": page.view_version})
        allowed = await db.scalar(
            select(ScreenTemplate.layouts).where(ScreenTemplate.key == page.template_key,
                                                 ScreenTemplate.version == page.template_version)
        )  # fmt: skip
        if body.layout not in (allowed or []):
            raise ApiError(422, "layout_not_allowed")
        page.layout = body.layout
        page.customized = True
        page.view_version += 1
    await db.flush()
    return page_out(page)


@router.delete("/{page_id}", response_model=PageOut)
async def remove_page(page_id: uuid.UUID, user: GatedUser, db: Db) -> PageOut:
    """«Убрать страницу»: soft, the items and this page's links stay (R-50)."""
    await lock_user(db, user.id)
    page = await _get(db, user, page_id, include_removed=True)
    _editable(page)
    if page.deleted_at is None:
        page.deleted_at = datetime.now(UTC)
        await db.flush()
    return page_out(page)


@router.post("/{page_id}/restore", response_model=PageOut)
async def restore_page(page_id: uuid.UUID, user: GatedUser, db: Db) -> PageOut:
    await lock_user(db, user.id)
    page = await _get(db, user, page_id, include_removed=True)
    if page.deleted_at is None:
        return page_out(page)
    if page.singleton:
        rival = await _live_singleton(db, user.id, page.template_key)
        if rival is not None:
            raise _singleton_exists(rival)
    await _check_room(db, user.id)
    page.deleted_at = None
    await db.flush()
    await fill_page(db, page)  # what was saved while the page was gone
    return page_out(page)


# --- contents ---


def _sort_columns():  # type: ignore[no-untyped-def]
    return (func.coalesce(ScreenItem.position, _AFTER_ALL_KEYS),
            func.coalesce(Item.occurred_at, Item.created_at), Item.public_id)  # fmt: skip


@router.get("/{page_id}/items", response_model=PageItemsOut)
async def page_items(
    page_id: uuid.UUID, user: GatedUser, db: Db,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    cursor: uuid.UUID | None = None,
    group: Annotated[str | None, Query(max_length=64)] = None,
) -> PageItemsOut:  # fmt: skip
    page = await _get(db, user, page_id)
    rank, when, public = _sort_columns()
    stmt = (
        select(ScreenItem, Item)
        .join(Item, Item.id == ScreenItem.item_id)
        .where(ScreenItem.screen_id == page.id, ScreenItem.removed_by_user_at.is_(None),
               Item.deleted_at.is_(None), Item.hidden_reason.is_(None))
    )  # fmt: skip
    if group is not None:
        stmt = stmt.where(ScreenItem.group_key == group)
    if cursor is not None:
        after = (
            await db.execute(
                select(rank, when, public)
                .select_from(ScreenItem)
                .join(Item, Item.id == ScreenItem.item_id)
                .where(ScreenItem.screen_id == page.id, ScreenItem.public_id == cursor)
            )
        ).first()
        if after is None:
            raise ApiError(404, "not_found")
        stmt = stmt.where(or_(
            rank > after[0],
            and_(rank == after[0], when < after[1]),
            and_(rank == after[0], when == after[1], public > after[2]),
        ))  # fmt: skip
    rows = (
        await db.execute(stmt.order_by(rank.asc(), when.desc(), public.asc()).limit(limit + 1))
    ).all()
    shown = rows[:limit]
    template_fields = await db.scalar(
        select(ScreenTemplate.fields).where(ScreenTemplate.key == page.template_key,
                                            ScreenTemplate.version == page.template_version)
    ) or []  # fmt: skip
    items = await items_out(db, [item for _, item in shown])
    entries = [
        PageEntryOut(link=page_item_out(link, page.public_id, item.public_id), item=out,
                     fields=field_values(template_fields, item))
        for (link, item), out in zip(shown, items, strict=True)
    ]  # fmt: skip
    return PageItemsOut(entries=entries,
                        next_cursor=entries[-1].link.id if len(rows) > limit else None)  # fmt: skip


@router.post("/{page_id}/items", response_model=PageItemAddOut, status_code=201)
async def add_page_item(page_id: uuid.UUID, body: PageItemAddIn, user: GatedUser, db: Db,
                        response: Response) -> PageItemAddOut:  # fmt: skip
    """Show an item on this page too. The person asked for it, so it also lifts an earlier
    "removed from this page"; it never changes where other rows stand."""
    await lock_user(db, user.id)
    page = await _get(db, user, page_id)
    _editable(page)
    item = await db.scalar(
        select(Item).where(Item.user_id == user.id, Item.public_id == body.item_id)
    )
    if item is None:
        raise ApiError(404, "not_found")
    if item.deleted_at is not None:
        raise ApiError(409, "item_deleted")
    when = item.occurred_at or item.created_at
    created = await add_link(db, page, item.id, when, AddedBy.USER)
    link = await db.scalar(
        select(ScreenItem)
        .where(ScreenItem.screen_id == page.id, ScreenItem.item_id == item.id)
        .execution_options(populate_existing=True)
    )
    assert link is not None
    if created:
        return PageItemAddOut(link=page_item_out(link, page.public_id, item.public_id),
                              created=True)  # fmt: skip
    response.status_code = 200
    if link.removed_by_user_at is not None:
        link.removed_by_user_at = None
        link.added_by = AddedBy.USER
        link.updated_by = UpdatedBy.USER
        link.updated_at = func.now()
        await db.flush()
        await db.refresh(link)
    return PageItemAddOut(link=page_item_out(link, page.public_id, item.public_id), created=False)
