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

from assistant.actions import actions_dicts, engine, manual, record
from assistant.actions.patch import page_patches
from assistant.api.consent_gate import require_base_consent
from assistant.api.deps import CurrentUser, Db
from assistant.api.errors import ApiError
from assistant.api.routes.items import items_out
from assistant.api.schemas import (
    ActionOut,
    DocumentRowOut,
    ExpenseOut,
    HabitOffOut,
    HabitOut,
    HabitPatchIn,
    HabitPatchOut,
    HabitsOut,
    ItemMoveIn,
    ItemMoveOut,
    ItemPlaceIn,
    ItemPlaceOut,
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
    PageWithActionOut,
    RemoveFromPageOut,
    TaskOut,
    TemplateListOut,
    TemplateOut,
)
from assistant.db.models import Item
from assistant.db.models_actions import Action, ActionKind, Initiator
from assistant.db.models_expenses import ExpenseCategory, ExpenseEntry
from assistant.db.models_habits import HabitKind, HabitStatus, UserHabit
from assistant.db.models_kp import Document
from assistant.db.models_pages import (
    MAX_PAGES,
    AddedBy,
    ItemFacet,
    Screen,
    ScreenCreatedBy,
    ScreenItem,
    ScreenKind,
    ScreenTemplate,
    UpdatedBy,
)
from assistant.db.models_tasks import Task
from assistant.expenses import service as expenses_service
from assistant.kp import service as kp_service
from assistant.pages import (
    add_link,
    create_page,
    fill_page,
    habits,
    latest_template,
    latest_templates,
    lock_user,
    view,
)
from assistant.tasks import service as tasks_service

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
        appearance=dict(link.appearance or {}), board_x=link.board_x, board_y=link.board_y,
        board_z=link.board_z, board_manual=bool(link.board_manual), done_at=link.done_at,
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


async def _record(db: AsyncSession, user_id: int, kind: str, sentence: str, page: Screen,
                  inverse: list[dict[str, Any]], *, changes: list[dict[str, Any]] | None = None,
                  extra: dict[str, Any] | None = None) -> ActionOut | None:  # fmt: skip
    """The person's own change of a page, in «Что я сделал» with «Отменить» (R-33, week 9)."""
    if not inverse:
        return None
    now = datetime.now(UTC)
    action = await record(db, user_id=user_id, kind=kind, initiated_by=Initiator.USER,
                          summary={"ru": sentence, "kk": None},
                          changes=changes if changes is not None else [
                              {"item_id": None, "title": page.title, "kind": "create_page",
                               "page_id": str(page.public_id), "text": sentence}],
                          inverse=inverse, now=now, screen_id=page.id, extra=extra)  # fmt: skip
    await db.flush()
    return ActionOut.model_validate((await actions_dicts(db, [action], now))[0])


EXCLUSIONS_SHOWN = 100


def _item_name(item: Item) -> str:
    return " ".join((item.title or item.text or item.raw_text or "запись").split())[:60]


def _with_action(page: Screen, action: ActionOut | None) -> PageWithActionOut:
    return PageWithActionOut(**page_out(page).model_dump(), action=action)


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
            action = await _record(db, user.id, ActionKind.CREATE_SCREEN,
                                   f"Вернул страницу «{removed.title}»", removed,
                                   [{"op": "delete_entity_soft", "entity": "screens",
                                     "id": str(removed.public_id)}])  # fmt: skip
            return PageCreateOut(page=page_out(removed), created=False, revived=True,
                                 action=action)  # fmt: skip
    await _check_room(db, user.id)

    page = await create_page(db, user.id, template, client_id=body.client_id, title=title,
                             icon=body.icon, layout=body.layout,
                             created_by=ScreenCreatedBy(body.created_by))  # fmt: skip
    await fill_page(db, page)
    action = await _record(db, user.id, ActionKind.CREATE_SCREEN,
                           f"Добавил страницу «{page.title}»", page,
                           [{"op": "delete_entity_soft", "entity": "screens",
                             "id": str(page.public_id)}],
                           extra={"created_page_id": str(page.public_id)})  # fmt: skip
    return PageCreateOut(page=page_out(page), created=True, action=action)


@router.get("/{page_id}", response_model=PageOut)
async def get_page(page_id: uuid.UUID, user: GatedUser, db: Db) -> PageOut:
    return page_out(await _get(db, user, page_id))


@router.patch("/{page_id}", response_model=PageWithActionOut)
async def patch_page(page_id: uuid.UUID, body: PagePatchIn, user: GatedUser,
                     db: Db) -> PageWithActionOut:  # fmt: skip
    """Name, icon, layout. Week 11: planned by `set_view` (pages/view.py), like S38."""
    from assistant.api.routes.views import apply_by_hand  # views imports this module

    await lock_user(db, user.id)  # all writers of a user's pages: this lock, then the rows
    page = await _get(db, user, page_id)
    _editable(page)
    if body.client_id is not None:  # an outbox repeat: the first result
        first = await db.scalar(select(Action).where(Action.user_id == user.id,
                                                     Action.client_id == body.client_id))
        if first is not None:
            return _with_action(page, ActionOut.model_validate(
                (await actions_dicts(db, [first], datetime.now(UTC)))[0]))
    stale = body.base_view_version is not None and body.base_view_version != page.view_version
    if body.layout is not None and body.layout != page.layout and stale:
        raise ApiError(409, "conflict", details={"view_version": page.view_version})
    title = body.title.strip() if body.title is not None else None
    if body.title is not None and not title:
        raise ApiError(422, "validation_error")
    change = view.ViewChange(title=title, icon=body.icon, layout=body.layout)
    sentence = (f"Переименовал страницу в «{title}»" if title and title != page.title
                else f"Изменил вид страницы «{page.title}»")  # fmt: skip
    action, _, _ = await apply_by_hand(db, user, page, change, kind=ActionKind.SCREEN_CUSTOMIZE,
                                       client_id=body.client_id, now=datetime.now(UTC),
                                       sentence=sentence)  # fmt: skip
    await db.refresh(page)
    out = None
    if action is not None:
        out = ActionOut.model_validate((await actions_dicts(db, [action], datetime.now(UTC)))[0])
    return _with_action(page, out)


@router.delete("/{page_id}", response_model=PageWithActionOut)
async def remove_page(page_id: uuid.UUID, user: GatedUser, db: Db) -> PageWithActionOut:
    """«Убрать страницу»: soft, the items and this page's links stay (R-50). A record moved here
    by hand is never left on no page (the engine's soft delete runs `rescue_moved`)."""
    await lock_user(db, user.id)
    page = await _get(db, user, page_id, include_removed=True)
    _editable(page)
    action = None
    if page.deleted_at is None:
        out = await engine.apply(db, user.id, [{"op": "delete_entity_soft", "entity": "screens",
                                                "id": str(page.public_id)}],
                                 by=Initiator.USER, check=False, now=datetime.now(UTC))  # fmt: skip
        await db.refresh(page)
        action = await _record(db, user.id, ActionKind.DELETE_SCREEN,
                               f"Страница «{page.title}» убрана. Записи остались", page,
                               out.inverse)  # fmt: skip
    return _with_action(page, action)


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


VIEW_SORT_CAP = 5000  # rows a page sorted or filtered by a field is read in full (week 11)


def _cell(value: Any) -> Any:
    if isinstance(value, list):
        return [str(v).lower() for v in value]
    return str(value).lower() if value is not None else None


def _passes(fields: dict[str, Any], filters: list[dict[str, Any]]) -> bool:
    for f in filters:
        value = fields.get(f.get("field", ""))
        empty = value in (None, "", [])
        if f.get("op") == "empty" and not empty:
            return False
        if f.get("op") == "not_empty" and empty:
            return False
        if f.get("op", "eq") == "eq":
            want, have = _cell(f.get("value")), _cell(value)
            if (want not in have) if isinstance(have, list) else have != want:
                return False
    return True


def _sort_value(entry: tuple[Any, Any, dict[str, Any]], sort: str) -> Any:
    _link, item, fields = entry
    if sort == "date":
        return (item.occurred_at or item.created_at).timestamp()
    v = fields.get(sort)
    if isinstance(v, bool | int | float):
        return float(v)
    if isinstance(v, list):
        v = ", ".join(map(str, v))
    if isinstance(v, str):
        try:
            return float(v.replace(" ", "").replace(",", "."))
        except ValueError:
            return v.lower()
    return v


def _sorted_by_field(entries: list[tuple[Any, Any, dict[str, Any]]], sort: str,
                     direction: str | None) -> list[tuple[Any, Any, dict[str, Any]]]:  # fmt: skip
    """Pinned first; then by the field (empty last whatever the direction); ties keep page
    order. `date` sorts by the record's date, newest first unless `sort_dir: asc`."""
    desc = (direction or ("desc" if sort == "date" else "asc")) == "desc"
    present = [e for e in entries if _sort_value(e, sort) is not None]
    missing = [e for e in entries if _sort_value(e, sort) is None]
    try:
        present.sort(key=lambda e: _sort_value(e, sort), reverse=desc)
    except TypeError:  # numbers and words in one field: compare as text
        present.sort(key=lambda e: str(_sort_value(e, sort)), reverse=desc)
    out = present + missing
    return [e for e in out if e[0].pinned] + [e for e in out if not e[0].pinned]


async def _own_values(db: AsyncSession, page: Screen, item_pks: list[int]) -> dict[int, dict]:
    """Values of the page's own fields that are live now (a removed field's values stay
    stored but are not shown)."""
    live = {str(c["id"]) for c in page.custom_fields or []}
    if not live or not item_pks:
        return {}
    rows = await db.execute(select(ItemFacet.item_id, ItemFacet.data).where(
        ItemFacet.screen_id == page.id, ItemFacet.item_id.in_(item_pks)))  # fmt: skip
    return {pk: {k: v for k, v in (data or {}).items() if k in live} for pk, data in rows}


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
    vs = page.view_state or {}
    sort = vs.get("sort")
    filters = vs.get("filters") or []
    by_field = sort not in (None, "position") or bool(filters)
    template_fields = await db.scalar(
        select(ScreenTemplate.fields).where(ScreenTemplate.key == page.template_key,
                                            ScreenTemplate.version == page.template_version)
    ) or []  # fmt: skip
    # week 11а: pinned rows first («Приколотые всегда идут первыми»), then page order
    pinned = ScreenItem.pinned
    if by_field:
        ordered = stmt.order_by(pinned.desc(), rank.asc(), when.desc(), public.asc())
        rows = (await db.execute(ordered.limit(VIEW_SORT_CAP))).all()
    else:
        if cursor is not None:
            after = (
                await db.execute(
                    select(pinned, rank, when, public)
                    .select_from(ScreenItem)
                    .join(Item, Item.id == ScreenItem.item_id)
                    .where(ScreenItem.screen_id == page.id, ScreenItem.public_id == cursor)
                )
            ).first()
            if after is None:
                raise ApiError(404, "not_found")
            same = pinned.is_(True) if after[0] else pinned.is_(False)
            stmt = stmt.where(or_(
                *([pinned.is_(False)] if after[0] else []),
                and_(same, rank > after[1]),
                and_(same, rank == after[1], when < after[2]),
                and_(same, rank == after[1], when == after[2], public > after[3]),
            ))  # fmt: skip
        rows = (await db.execute(stmt.order_by(pinned.desc(), rank.asc(), when.desc(),
                                               public.asc()).limit(limit + 1))).all()  # fmt: skip
    candidates = rows if by_field else rows[:limit]
    task_of: dict[int, Task] = {}
    if page.template_key in tasks_service.LIST_OF_TEMPLATE and candidates:
        rows_t = list(await db.scalars(select(Task).where(
            Task.user_id == user.id, Task.item_id.in_([item.id for _, item in candidates]))))
        task_of = {t.item_id: t for t in rows_t}
    expense_of: dict[int, tuple[ExpenseEntry, ExpenseCategory | None]] = {}
    if page.template_key == expenses_service.PAGE_TEMPLATE and candidates:
        expense_of = {e.item_id: (e, c) for e, c in await db.execute(
            select(ExpenseEntry, ExpenseCategory)
            .outerjoin(ExpenseCategory, ExpenseCategory.id == ExpenseEntry.category_id)
            .where(ExpenseEntry.user_id == user.id,
                   ExpenseEntry.item_id.in_([item.id for _, item in candidates])))}  # fmt: skip
    doc_of: dict[int, dict[str, Any]] = {}
    if page.template_key == kp_service.PAGE_TEMPLATE and candidates:  # week 14: КП cards
        docs = list(await db.scalars(select(Document).where(
            Document.user_id == user.id,
            Document.item_id.in_([item.id for _, item in candidates]))))  # fmt: skip
        doc_of = {d.item_id: r for d, r in zip(docs, await kp_service.rows_dicts(db, docs),
                                               strict=True)}  # fmt: skip
    own = await _own_values(db, page, [item.id for _, item in candidates])
    entries = [(link, item, {**field_values(template_fields, item),
                             **(kp_service.field_values(doc_of[item.id]) if item.id in doc_of
                                else kp_service.other_field_values(item)
                                if page.template_key == kp_service.PAGE_TEMPLATE else {}),
                             **(tasks_service.field_values(page.template_key, task_of[item.id])
                                if item.id in task_of else {}),
                             **(expenses_service.field_values(*expense_of[item.id])
                                if item.id in expense_of else {}),
                             **own.get(item.id, {})})
               for link, item in candidates]  # fmt: skip
    more = len(rows) > limit
    if by_field:
        entries = [e for e in entries if _passes(e[2], filters)]
        if sort not in (None, "position"):
            entries = _sorted_by_field(entries, str(sort), vs.get("sort_dir"))
        if cursor is not None:
            at = next((i for i, e in enumerate(entries) if e[0].public_id == cursor), None)
            if at is None:
                raise ApiError(404, "not_found")
            entries = entries[at + 1:]
        more = len(entries) > limit
        entries = entries[:limit]
    task_out: dict[int, TaskOut] = {}
    shown_tasks = [task_of[item.id] for _, item, _ in entries if item.id in task_of]
    if shown_tasks:
        task_out = {t.item_id: TaskOut.model_validate(d) for t, d in
                    zip(shown_tasks, await tasks_service.tasks_dicts(db, shown_tasks),
                        strict=True)}  # fmt: skip
    expense_out: dict[int, ExpenseOut] = {}
    shown_expenses = [expense_of[item.id][0] for _, item, _ in entries if item.id in expense_of]
    if shown_expenses:
        dicts = await expenses_service.expenses_dicts(db, shown_expenses)
        expense_out = {e.item_id: ExpenseOut.model_validate(d)
                       for e, d in zip(shown_expenses, dicts, strict=True)}
    items = await items_out(db, [item for _, item, _ in entries])
    out = [
        PageEntryOut(link=page_item_out(link, page.public_id, item.public_id), item=io,
                     fields=fields, task=task_out.get(item.id),
                     expense=expense_out.get(item.id),
                     document=DocumentRowOut.model_validate(doc_of[item.id])
                     if item.id in doc_of else None)
        for (link, item, fields), io in zip(entries, items, strict=True)
    ]  # fmt: skip
    return PageItemsOut(entries=out, next_cursor=out[-1].link.id if more and out else None)


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
    name = _item_name(item)
    sentence = f"Показал «{name}» на странице «{page.title}»"
    row = {"item_id": str(item.public_id), "title": name, "kind": "show",
           "page_id": str(page.public_id), "text": sentence}
    if created:
        action = await _record(db, user.id, ActionKind.SCREEN_ADD_ITEM, sentence, page,
                               [{"op": "remove_screen_item", "page": str(page.public_id),
                                 "item": str(item.public_id), "exclude": False}],
                               changes=[row])  # fmt: skip
        return PageItemAddOut(link=page_item_out(link, page.public_id, item.public_id),
                              created=True, action=action)  # fmt: skip
    response.status_code = 200
    action = None
    if link.removed_by_user_at is not None:
        link.removed_by_user_at = None
        link.added_by = AddedBy.USER
        link.updated_by = UpdatedBy.USER
        link.updated_at = func.now()
        await db.flush()
        await db.refresh(link)
        action = await _record(db, user.id, ActionKind.SCREEN_ADD_ITEM, sentence, page,
                               [{"op": "remove_screen_item", "page": str(page.public_id),
                                 "item": str(item.public_id), "exclude": True}],
                               changes=[row])  # fmt: skip
    return PageItemAddOut(link=page_item_out(link, page.public_id, item.public_id), created=False,
                          action=action)  # fmt: skip


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


@router.post("/{page_id}/items/place", response_model=ItemPlaceOut)
async def place_items(page_id: uuid.UUID, body: ItemPlaceIn, user: GatedUser,
                      db: Db) -> ItemPlaceOut:  # fmt: skip
    """The free board of «Заметки» (weeks 16а–16б): the person's own place for stickers; the
    later place of a sticker wins (views.md «Доска»)."""
    now = datetime.now(UTC)
    try:
        res = await manual.place_stickers(
            db, user.id, page_id=page_id, places=body.all_places(),
            base_view_version=body.base_view_version, client_id=body.client_id,
            client_ts=body.client_ts, now=now,
        )  # fmt: skip
    except _MANUAL as exc:
        raise _manual_error(exc) from exc
    await db.flush()
    assert res.page is not None
    patch = (await page_patches(db, user.id, res.pages, res.items))[0]
    rows = await db.execute(
        select(ScreenItem, Item.public_id).join(Item, Item.id == ScreenItem.item_id)
        .where(ScreenItem.screen_id == res.page.id, ScreenItem.item_id.in_(res.item_pks))
        .execution_options(populate_existing=True)
    )  # fmt: skip
    by_pk = {link.item_id: page_item_out(link, res.page.public_id, iid) for link, iid in rows}
    return ItemPlaceOut(placed=res.done,
                        reason=res.reason, repeated=res.repeated, rebased=res.rebased,
                        links=[by_pk[pk] for pk in res.item_pks if pk in by_pk],
                        kept_item_ids=[uuid.UUID(i) for i in res.kept],
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
    # «Убрал со страницы — не возвращать» (screen_exclusion): the hidden row is the rule itself.
    for link, item, page in await db.execute(
            select(ScreenItem, Item, Screen)
            .join(Item, Item.id == ScreenItem.item_id)
            .join(Screen, Screen.id == ScreenItem.screen_id)
            .where(ScreenItem.user_id == user.id, ScreenItem.removed_by_user_at.is_not(None),
                   Screen.deleted_at.is_(None), Item.deleted_at.is_(None),
                   Item.hidden_reason.is_(None))
            .order_by(ScreenItem.removed_by_user_at.desc(), ScreenItem.public_id.desc())
            .limit(EXCLUSIONS_SHOWN)):  # fmt: skip
        name = _item_name(item)
        out.append(HabitOut(
            id=link.public_id, kind="screen_exclusion",
            text_ru=f"Не показываю «{name}» на странице «{page.title}»",
            page=PageRefOut(id=page.public_id, title=page.title, icon=page.icon),
            envelope_type=None, evidence_count=1, updated_at=link.removed_by_user_at,
            item_id=item.public_id,
        ))  # fmt: skip
    return HabitsOut(habits=out)


@habits_router.delete("/{habit_id}", response_model=HabitOffOut)
async def turn_off_habit(habit_id: uuid.UUID, user: GatedUser, db: Db,
                         client_id: uuid.UUID | None = None) -> HabitOffOut:  # fmt: skip
    """«Убрать»: records already placed stay; new ones are no longer placed by this rule. On a
    `screen_exclusion` (a page row's id): the record is shown on that page again."""
    now = datetime.now(UTC)
    found = (await db.execute(
        select(ScreenItem, Item, Screen)
        .join(Item, Item.id == ScreenItem.item_id).join(Screen, Screen.id == ScreenItem.screen_id)
        .where(ScreenItem.user_id == user.id, ScreenItem.public_id == habit_id)
    )).first()  # fmt: skip
    if found is not None:
        link, item, page = found
        if link.removed_by_user_at is None or page.deleted_at is not None:
            return HabitOffOut(removed=False, repeated=True, action=None)
        await lock_user(db, user.id)
        res = await engine.apply(db, user.id, [{"op": "add_screen_item",
                                                "page": str(page.public_id),
                                                "item": str(item.public_id)}],
                                 by=Initiator.USER, check=False, now=now)  # fmt: skip
        name = _item_name(item)
        sentence = f"Снова показываю «{name}» на странице «{page.title}»"
        action = await _record(db, user.id, ActionKind.SCREEN_ADD_ITEM, sentence, page,
                               res.inverse, changes=[{"item_id": str(item.public_id),
                                                      "title": name, "kind": "show",
                                                      "page_id": str(page.public_id),
                                                      "text": sentence}])  # fmt: skip
        return HabitOffOut(removed=True, repeated=False, action=action)
    try:
        res = await manual.turn_off_rule(db, user.id, habit_id=habit_id, client_id=client_id,
                                         now=now)  # fmt: skip
    except _MANUAL as exc:
        raise _manual_error(exc) from exc
    await db.flush()
    return HabitOffOut(removed=res.done, repeated=res.repeated,
                       action=await _action_out(db, res, now))  # fmt: skip


@habits_router.patch("/{habit_id}", response_model=HabitPatchOut)
async def change_habit(habit_id: uuid.UUID, body: HabitPatchIn, user: GatedUser,
                       db: Db) -> HabitPatchOut:  # fmt: skip
    """S30 «Изменить» (week 9): a learned placement rule puts such records on another page from
    now on. Records already placed stay where they are; «Отменить» moves the rule back."""
    now = datetime.now(UTC)
    await lock_user(db, user.id)
    habit = await db.scalar(select(UserHabit).where(
        UserHabit.user_id == user.id, UserHabit.public_id == habit_id,
        UserHabit.kind == HabitKind.PLACEMENT_RULE).with_for_update())  # fmt: skip
    if habit is None or habit.status != HabitStatus.ACTIVE:
        raise ApiError(404, "not_found")
    page = await _get(db, user, body.page_id)
    _editable(page)
    kind = (habit.value or {}).get("envelope_type")
    first = None
    if body.client_id is not None:
        first = await db.scalar(select(Action).where(Action.user_id == user.id,
                                                     Action.client_id == body.client_id))
    if first is None and str(page.public_id) != (habit.value or {}).get("page_id"):
        key = f"{page.public_id}:envelope_type:{kind}"
        rival = await db.scalar(select(UserHabit.id).where(
            UserHabit.user_id == user.id, UserHabit.kind == HabitKind.PLACEMENT_RULE,
            UserHabit.key == key, UserHabit.id != habit.id))  # fmt: skip
        if rival is not None:
            raise ApiError(409, "conflict", details={"reason": "habit_exists"})
        state = {**habits.state_of(habit), "key": key,
                 "value": {**(habit.value or {}), "page_id": str(page.public_id)}}
        res = await engine.apply(db, user.id, [{"op": "restore_habit", "id": str(habit.public_id),
                                                "state": state}],
                                 by=Initiator.USER, check=False, now=now)  # fmt: skip
        sentence = habits.describe(kind, page.title)
        action = await record(db, user_id=user.id, kind=ActionKind.HABIT_CHANGE,
                              initiated_by=Initiator.USER,
                              summary={"ru": "Теперь: " + sentence[:1].lower() + sentence[1:],
                                       "kk": None}, changes=[], inverse=res.inverse, now=now,
                              screen_id=page.id, client_id=body.client_id)  # fmt: skip
        await db.flush()
    else:
        action = first
    out = HabitOut(id=habit.public_id, kind=habit.kind, text_ru=habits.describe(kind, page.title),
                   page=PageRefOut(id=page.public_id, title=page.title, icon=page.icon),
                   envelope_type=kind, evidence_count=habit.evidence_count,
                   updated_at=habit.updated_at)  # fmt: skip
    action_out = None
    if action is not None:
        action_out = ActionOut.model_validate((await actions_dicts(db, [action], now))[0])
    return HabitPatchOut(habit=out, action=action_out, repeated=first is not None)
