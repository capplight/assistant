"""/v1/page-templates and /v1/pages: catalogue, a person's pages, their contents.

Contract: docs/api/pages.md. A page is a view on the shared memory (R-46): removing one leaves the
items alone. Manual order (week 7): `items/move`, `move-to-page`, «Убрать с этой страницы», tab
order; the rules of who wins live in `assistant.actions.manual`. Template editing comes in week 11.
"""

import hashlib
import json
import uuid
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Header, Query, Response
from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.actions import actions_dicts, manual
from assistant.actions.patch import page_patches
from assistant.api.consent_gate import require_base_consent
from assistant.api.deps import CurrentUser, Db
from assistant.api.errors import ApiError
from assistant.api.routes.items import items_out
from assistant.api.schemas import (
    ActionOut,
    HabitOffOut,
    HabitOut,
    HabitsOut,
    ItemMoveIn,
    ItemMoveOut,
    MoveToPageIn,
    MoveToPageOut,
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
    PageRefOut,
    PageReorderIn,
    PageReorderOut,
    RemoveFromPageOut,
    TemplateListOut,
    TemplateOut,
)
from assistant.db.models import Item
from assistant.db.models_habits import HabitKind, HabitStatus, UserHabit
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
    habits,
    latest_template,
    latest_templates,
    lock_user,
    rescue_moved,
)

router = APIRouter(prefix="/pages", tags=["pages"])
templates_router = APIRouter(prefix="/page-templates", tags=["pages"])
items_router = APIRouter(prefix="/items", tags=["pages"])  # /items/{id}/move-to-page
habits_router = APIRouter(prefix="/habits", tags=["pages"])  # learned placement rules (F-29)
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


async def _removed_singleton(db: AsyncSession, user_id: int, key: str) -> Screen | None:
    """The page to bring back. Accounts from before revival can have several: the last removed."""
    return await db.scalar(
        select(Screen)
        .where(Screen.user_id == user_id, Screen.template_key == key,
               Screen.singleton.is_(True), Screen.deleted_at.is_not(None))
        .order_by(Screen.deleted_at.desc(), Screen.id.desc())
        .limit(1)
    )  # fmt: skip


async def _bring_back(db: AsyncSession, page: Screen) -> None:
    """Id, tab position, name, layout and rows stay; what was saved meanwhile is placed."""
    await _check_room(db, page.user_id)
    page.deleted_at = None
    await db.flush()
    await fill_page(db, page)


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
        removed = await _removed_singleton(db, user.id, template.key)
        if removed is not None:
            # The new client_id goes on the page, so a retry of this request finds it above.
            removed.client_id = body.client_id
            await _bring_back(db, removed)
            response.status_code = 200
            return PageCreateOut(page=page_out(removed), created=False, revived=True)
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
        await rescue_moved(db, page)  # a record moved here by hand is never left on no page
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
            raise _singleton_exists(rival)  # only accounts with duplicates from before revival
    await _bring_back(db, page)
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


# --- manual order (week 7) ---


def _manual_error(exc: Exception) -> ApiError:
    if isinstance(exc, manual.NotFound):
        return ApiError(404, "not_found")
    if isinstance(exc, manual.SystemPage):
        return ApiError(403, "page_system")
    if isinstance(exc, manual.ItemDeleted):
        return ApiError(409, "item_deleted")
    return ApiError(422, "validation_error")


_MANUAL = (manual.NotFound, manual.SystemPage, manual.ItemDeleted, manual.Invalid)


async def _action_out(db: AsyncSession, res: manual.Manual, now: datetime) -> ActionOut | None:
    if res.action is None:
        return None
    return ActionOut.model_validate((await actions_dicts(db, [res.action], now))[0])


async def _rows_of(db: AsyncSession, res: manual.Manual) -> list[PageItemOut]:
    """The item's rows on the pages the call touched, as they are now."""
    if res.item_pk is None or not res.touched:
        return []
    rows = await db.execute(
        select(ScreenItem, Screen.public_id, Item.public_id)
        .join(Screen, Screen.id == ScreenItem.screen_id).join(Item, Item.id == ScreenItem.item_id)
        .where(ScreenItem.item_id == res.item_pk, ScreenItem.screen_id.in_(res.touched))
        .execution_options(populate_existing=True)
    )  # fmt: skip
    by_page = {link.screen_id: page_item_out(link, pid, iid) for link, pid, iid in rows}
    return [by_page[s] for s in dict.fromkeys(res.touched) if s in by_page]


@router.post("/reorder", response_model=PageReorderOut)
async def reorder_pages(body: PageReorderIn, user: GatedUser, db: Db) -> PageReorderOut:
    """«Мои страницы»: one page to a new place among the tabs."""
    now = datetime.now(UTC)
    try:
        res = await manual.move_tab(db, user.id, page_id=body.page_id,
                                    after_id=body.after_page_id, before_id=body.before_page_id,
                                    position=body.position, client_id=body.client_id,
                                    client_ts=body.client_ts, now=now)  # fmt: skip
    except _MANUAL as exc:
        raise _manual_error(exc) from exc
    await db.flush()
    assert res.page is not None
    await db.refresh(res.page)
    return PageReorderOut(moved=res.done, reason=res.reason, repeated=res.repeated,
                          page=page_out(res.page), action=await _action_out(db, res, now))


@router.post("/{page_id}/items/move", response_model=ItemMoveOut)
async def move_item(page_id: uuid.UUID, body: ItemMoveIn, user: GatedUser, db: Db) -> ItemMoveOut:
    """«Выше / Ниже / перетащил»: the person's place for the row; it wins over the assistant."""
    now = datetime.now(UTC)
    kw: dict[str, Any] = {}
    if "group_key" in body.model_fields_set:
        kw["group_key"] = body.group_key
    try:
        res = await manual.move_row(
            db, user.id, page_id=page_id, item_id=body.item_id, after_id=body.after_item_id,
            before_id=body.before_item_id, position=body.position, base_seq=body.base_seq,
            base_view_version=body.base_view_version, client_id=body.client_id,
            client_ts=body.client_ts, now=now, **kw,
        )  # fmt: skip
    except _MANUAL as exc:
        raise _manual_error(exc) from exc
    await db.flush()
    patch = (await page_patches(db, user.id, res.pages, res.items))[0]
    links = await _rows_of(db, res)
    return ItemMoveOut(moved=res.done, reason=res.reason, repeated=res.repeated,
                       rebased=res.rebased, link=links[0],
                       action=await _action_out(db, res, now), page_patch=patch)  # fmt: skip


@router.delete("/{page_id}/items/{item_id}", response_model=RemoveFromPageOut)
async def remove_item_from_page(
    page_id: uuid.UUID, item_id: uuid.UUID, user: GatedUser, db: Db,
    client_id: uuid.UUID | None = None,
) -> RemoveFromPageOut:  # fmt: skip
    """«Убрать с этой страницы»: the record stays in memory and on its other pages; this page
    keeps a hidden row, so nothing brings it back here but the person."""
    now = datetime.now(UTC)
    try:
        res = await manual.remove_row(db, user.id, page_id=page_id, item_id=item_id,
                                      client_id=client_id, now=now)  # fmt: skip
    except _MANUAL as exc:
        raise _manual_error(exc) from exc
    await db.flush()
    patch = (await page_patches(db, user.id, res.pages, res.items))[0]
    links = await _rows_of(db, res)
    still = await db.execute(
        select(Screen.public_id, Screen.title, Screen.icon)
        .join(ScreenItem, ScreenItem.screen_id == Screen.id)
        .where(ScreenItem.item_id == res.item_pk, ScreenItem.removed_by_user_at.is_(None),
               Screen.deleted_at.is_(None), Screen.kind != ScreenKind.SYSTEM_TODAY)
        .order_by(Screen.position, Screen.public_id)
    )  # fmt: skip
    return RemoveFromPageOut(
        removed=res.done, repeated=res.repeated, link=links[0],
        action=await _action_out(db, res, now), page_patch=patch,
        still_on=[PageRefOut(id=pid, title=title, icon=icon) for pid, title, icon in still],
    )  # fmt: skip


@items_router.post("/{item_id}/move-to-page", response_model=MoveToPageOut)
async def move_to_page(item_id: uuid.UUID, body: MoveToPageIn, user: GatedUser,
                       db: Db) -> MoveToPageOut:  # fmt: skip
    """«Переместить на страницу…» / «Показать ещё на…» (S39). Teaches `placement_rule`."""
    now = datetime.now(UTC)
    try:
        res = await manual.move_to_page(db, user.id, item_id=item_id, mode=body.mode,
                                        from_page_id=body.from_page_id,
                                        to_page_ids=body.to_page_ids, client_id=body.client_id,
                                        now=now)  # fmt: skip
    except _MANUAL as exc:
        raise _manual_error(exc) from exc
    await db.flush()
    return MoveToPageOut(
        moved=res.done, reason=res.reason, repeated=res.repeated, links=await _rows_of(db, res),
        action=await _action_out(db, res, now),
        page_patches=await page_patches(db, user.id, res.pages, res.items),
        learned_ru=habits.TEXT_LEARNED if res.learned else None,
    )  # fmt: skip


@habits_router.get("", response_model=HabitsOut)
async def list_habits(user: GatedUser, db: Db) -> HabitsOut:
    """«Что я для вас настроил»: rules in use whose page is live. Week 9 adds the other kinds."""
    rows = await db.scalars(
        select(UserHabit).where(UserHabit.user_id == user.id,
                                UserHabit.kind == HabitKind.PLACEMENT_RULE,
                                UserHabit.status == HabitStatus.ACTIVE)
        .order_by(UserHabit.updated_at.desc(), UserHabit.id.desc())
    )  # fmt: skip
    rules = list(rows)
    wanted = {uuid.UUID(h.value["page_id"]) for h in rules}
    pages = {p.public_id: p for p in await db.scalars(
        select(Screen).where(Screen.user_id == user.id, Screen.public_id.in_(wanted),
                             Screen.deleted_at.is_(None)))} if wanted else {}  # fmt: skip
    out = []
    for h in rules:
        page = pages.get(uuid.UUID(h.value["page_id"]))
        if page is not None:
            kind = h.value.get("envelope_type")
            out.append(HabitOut(
                id=h.public_id, kind=h.kind, text_ru=habits.describe(kind, page.title),
                page=PageRefOut(id=page.public_id, title=page.title, icon=page.icon),
                envelope_type=kind, evidence_count=h.evidence_count, updated_at=h.updated_at,
            ))  # fmt: skip
    return HabitsOut(habits=out)


@habits_router.delete("/{habit_id}", response_model=HabitOffOut)
async def turn_off_habit(habit_id: uuid.UUID, user: GatedUser, db: Db,
                         client_id: uuid.UUID | None = None) -> HabitOffOut:  # fmt: skip
    """«Убрать»: records already placed stay; new ones are no longer placed by this rule."""
    now = datetime.now(UTC)
    try:
        res = await manual.turn_off_rule(db, user.id, habit_id=habit_id, client_id=client_id,
                                         now=now)  # fmt: skip
    except _MANUAL as exc:
        raise _manual_error(exc) from exc
    await db.flush()
    return HabitOffOut(removed=res.done, repeated=res.repeated,
                       action=await _action_out(db, res, now))  # fmt: skip
