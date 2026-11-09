"""/v1/expenses and /v1/expense-categories: «Расходы» (week 12; F-40, US-31, R-36, R-59).
Contract: docs/api/expenses.md.

Every change is an action with «Отменить» (initiated_by `user`, R-33); the undo recipe is run by
assistant.actions. Amounts and totals are computed by code only (`expenses.calc`); the keypad
expression is evaluated by code, never `eval`. The line (`/v1/chat/messages`) adds expenses through
the same `expenses.service.create`.
"""

import uuid
from datetime import UTC, date, datetime
from typing import Annotated, Any
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import select

from assistant.actions import actions_dicts, engine, record
from assistant.actions.patch import page_patches
from assistant.api.consent_gate import AI_CONSENTS, missing_consents, require_base_consent
from assistant.api.deps import Ctx, CurrentUser, Db, get_active_consent_kinds
from assistant.api.errors import ApiError
from assistant.api.schemas import (
    ActionOut,
    AggregateOut,
    CategoriesChangedOut,
    CategoriesOut,
    CategoryChangedOut,
    CategoryIn,
    CategoryPatchIn,
    CategoryReorderIn,
    ExpenseCategoryOut,
    ExpenseChangedOut,
    ExpenseCreatedOut,
    ExpenseIn,
    ExpenseOut,
    ExpenseParseIn,
    ExpenseParseOut,
    ExpensePatchIn,
    ExpensesOut,
)
from assistant.db.models import Item, User
from assistant.db.models_actions import Action, ActionKind, Initiator
from assistant.db.models_expenses import (
    MAX_OWN_CATEGORIES,
    UNHIDEABLE,
    ExpenseCategory,
    ExpenseEntry,
    ParseSource,
)
from assistant.db.models_pages import Screen
from assistant.expenses import calc, parse, service
from assistant.pages import lexorank, lock_user

router = APIRouter(prefix="/expenses", tags=["expenses"])
categories_router = APIRouter(prefix="/expense-categories", tags=["expenses"])
GatedUser = Annotated[CurrentUser, Depends(require_base_consent)]
Kinds = Annotated[frozenset[str], Depends(get_active_consent_kinds)]
TEXT_FORM = "Не понял сумму — наберите её на клавишах."


def _now() -> datetime:
    return datetime.now(UTC)


async def local_today(db: Db, user_id: int, now: datetime | None = None) -> date:
    tz = await db.scalar(select(User.tz).where(User.id == user_id)) or "Asia/Almaty"
    return (now or _now()).astimezone(ZoneInfo(tz)).date()


async def _by_client(db: Db, user_id: int, client_id: uuid.UUID | None) -> Action | None:
    if client_id is None:
        return None
    return await db.scalar(select(Action).where(Action.user_id == user_id,
                                                Action.client_id == client_id))  # fmt: skip


async def _action_out(db: Db, action: Action | None, now: datetime) -> ActionOut | None:
    if action is None:
        return None
    return ActionOut.model_validate((await actions_dicts(db, [action], now))[0])


async def _out(db: Db, entry: ExpenseEntry) -> ExpenseOut:
    return ExpenseOut.model_validate((await service.expenses_dicts(db, [entry]))[0])


async def _own(db: Db, user_id: int, expense_id: uuid.UUID) -> ExpenseEntry:
    entry = await service.get(db, user_id, expense_id)
    if entry is None:
        raise ApiError(404, "not_found")
    return entry


async def _category(db: Db, user_id: int, cid: uuid.UUID | None) -> ExpenseCategory | None:
    if cid is None:
        return None
    await service.ensure_categories(db, user_id)
    cat = await service.category_by_public(db, user_id, cid)
    if cat is None:
        raise ApiError(422, "validation_error", details={"field": "category_id"})
    return cat


def _change_row(entry: ExpenseEntry, item_id: uuid.UUID, kind: str, text: str,
                title: str) -> dict[str, Any]:  # fmt: skip
    return {"item_id": str(item_id), "expense_id": str(entry.public_id), "title": title,
            "kind": kind, "page_id": None, "text": text}  # fmt: skip


# --- expenses ---


@router.get("", response_model=ExpensesOut)
async def list_expenses(
    user: GatedUser, db: Db,
    from_: Annotated[date | None, Query(alias="from")] = None,
    to: date | None = None, category_id: uuid.UUID | None = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 200, before: uuid.UUID | None = None,
) -> ExpensesOut:  # fmt: skip
    q = (select(ExpenseEntry).join(Item, Item.id == ExpenseEntry.item_id)
         .where(ExpenseEntry.user_id == user.id, ExpenseEntry.deleted_at.is_(None),
                Item.deleted_at.is_(None)))  # fmt: skip
    if from_ is not None:
        q = q.where(ExpenseEntry.spent_on >= from_)
    if to is not None:
        q = q.where(ExpenseEntry.spent_on <= to)
    if category_id is not None:
        cat = await _category(db, user.id, category_id)
        q = q.where(ExpenseEntry.category_id == cat.id)  # type: ignore[union-attr]
    if before is not None:
        last = await _own(db, user.id, before)
        q = q.where((ExpenseEntry.spent_on < last.spent_on)
                    | ((ExpenseEntry.spent_on == last.spent_on) & (ExpenseEntry.id < last.id)))
    rows = list(await db.scalars(q.order_by(ExpenseEntry.spent_on.desc(),
                                            ExpenseEntry.id.desc()).limit(limit + 1)))
    more = len(rows) > limit
    rows = rows[:limit]
    return ExpensesOut(expenses=[ExpenseOut.model_validate(d)
                                 for d in await service.expenses_dicts(db, rows)],
                       next_before=rows[-1].public_id if more and rows else None)  # fmt: skip


@router.post("", response_model=ExpenseCreatedOut, status_code=201)
async def create_expense(body: ExpenseIn, user: GatedUser, db: Db,
                         response: Response) -> ExpenseCreatedOut:  # fmt: skip
    now = _now()
    await lock_user(db, user.id)
    found = await db.scalar(select(ExpenseEntry).where(ExpenseEntry.user_id == user.id,
                                                       ExpenseEntry.client_id == body.client_id))
    if found is not None:
        response.status_code = 200
        return ExpenseCreatedOut(expense=await _out(db, found),
                                 action=await _action_out(db, await _by_client(
                                     db, user.id, body.client_id), now),
                                 repeated=True)  # fmt: skip
    try:
        amount, expression = service.resolve_amount(body.amount, body.expression)
        spec = service.NewExpense(
            amount=amount, currency=body.currency,
            spent_on=date.fromisoformat(body.spent_on) if body.spent_on else None,
            category=await _category(db, user.id, body.category_id),
            note=service.clean_note(body.note), payee=service.clean_payee(body.payee),
            method=body.method, direction=body.direction, source=body.source,
            expression=expression,
        )  # fmt: skip
    except service.ExpenseError as exc:
        raise ApiError(422, exc.code) from exc
    except ValueError as exc:
        raise ApiError(422, "validation_error") from exc
    created = await service.create(db, user.id, spec, by=Initiator.USER, now=now,
                                   today=await local_today(db, user.id, now),
                                   client_id=body.client_id)  # fmt: skip
    action = await record(
        db, user_id=user.id, kind=ActionKind.CREATE_EXPENSE, initiated_by=Initiator.USER,
        summary={"ru": created.sentence, "kk": None}, changes=created.changes,
        inverse=created.inverse, now=now, screen_id=created.page.id if created.page else None,
        source_item_ids=[created.item.id], client_id=body.client_id,
    )  # fmt: skip
    await db.flush()
    return ExpenseCreatedOut(expense=await _out(db, created.entry),
                             action=await _action_out(db, action, now),
                             page_patches=await page_patches(db, user.id, created.pages,
                                                             created.items))  # fmt: skip


@router.post("/parse", response_model=ExpenseParseOut)
async def parse_expense(body: ExpenseParseIn, user: GatedUser, db: Db, ctx: Ctx,
                        kinds: Kinds) -> ExpenseParseOut:  # fmt: skip
    """«Как понял»: a phrase → a draft for the form. Nothing is saved."""
    rules_first = ctx.settings.expenses_rules_first
    ai_allowed = not missing_consents(kinds, AI_CONSENTS)
    today = await local_today(db, user.id)
    cats = await service.reader_categories(db, user.id)
    on_page = False
    if body.page_id is not None:
        key = await db.scalar(select(Screen.template_key).where(
            Screen.user_id == user.id, Screen.public_id == body.page_id))  # fmt: skip
        on_page = key == service.PAGE_TEMPLATE
    await db.commit()  # no transaction stays open across the model call
    draft = await parse.read_phrase(
        body.text, today=today, rules_first=rules_first,
        router=ctx.ai_router if ai_allowed else None, user_id=user.id, categories=cats,
        on_page=on_page)  # fmt: skip
    parser = "rules_first" if rules_first else "llm"
    if draft is None:
        return ExpenseParseOut(status="form", source=None, parser=parser, draft=None,
                               message=TEXT_FORM)  # fmt: skip
    cat = await service.category_by_key(db, user.id, draft.category_key)
    return ExpenseParseOut(status="ok", source=draft.source, parser=parser, message=None, draft={
        "amount": f"{draft.amount:.2f}", "currency": draft.currency,
        "spent_on": (draft.spent_on or today).isoformat(),
        "category_id": cat.public_id if cat else None, "category_key": service.category_key(cat),
        "method": draft.method, "direction": str(draft.direction), "note": draft.note,
        "payee": draft.payee,
        "review_fields": ["amount"] if body.input_kind == "voice" else [],
    })  # type: ignore[arg-type]  # fmt: skip


@router.get("/aggregate", response_model=AggregateOut, response_model_by_alias=True)
async def aggregate(
    user: GatedUser, db: Db,
    period: calc.PeriodStr = "month",
    day: Annotated[date | None, Query(alias="date")] = None,
    from_: Annotated[date | None, Query(alias="from")] = None,
    to: date | None = None,
    group_by: calc.GroupByStr | None = None,
    currency: Annotated[str | None, Query(pattern=r"^[A-Z]{3}$")] = None,
    category_id: uuid.UUID | None = None,
) -> AggregateOut:  # fmt: skip
    """Totals per currency and groups, computed by `calc.py` (R-59)."""
    today = await local_today(db, user.id)
    cat = await _category(db, user.id, category_id)
    try:
        t = await service.totals(db, user.id, period=period, day=day or today, start=from_,
                                 end=to, group_by=group_by, currency=currency,
                                 category=cat)  # fmt: skip
    except ValueError as exc:
        raise ApiError(422, "validation_error", details={"field": "period"}) from exc
    return aggregate_out(t, period, group_by)


def aggregate_out(t: service.Totals, period: str, group_by: str | None) -> AggregateOut:
    lo, hi = t.bounds
    res = t.result
    return AggregateOut.model_validate({
        "calc_version": res.calc_version,
        "period": {"kind": period, "from": lo.isoformat() if lo else None,
                   "to": hi.isoformat() if hi else None},
        "group_by": group_by,
        "totals": [{"currency": x.currency, "total": f"{x.total:.2f}",
                    "expense": f"{x.expense:.2f}", "refund": f"{x.refund:.2f}",
                    "income": f"{x.income:.2f}", "count": x.count} for x in res.totals],
        "groups": [{"key": g.key, "currency": g.currency, "total": f"{g.total:.2f}",
                    "count": g.count,
                    "title": t.titles.get(g.key or "") if group_by == "category" else g.key}
                   for g in res.groups],
        "review_count": res.review_count,
        "basis_ids": [t.ids[i] for i in res.basis[:1000]],
    })  # fmt: skip


@router.patch("/{expense_id}", response_model=ExpenseChangedOut)
async def patch_expense(expense_id: uuid.UUID, body: ExpensePatchIn, user: GatedUser,
                        db: Db) -> ExpenseChangedOut:  # fmt: skip
    now = _now()
    await lock_user(db, user.id)
    entry = await _own(db, user.id, expense_id)
    first = await _by_client(db, user.id, body.client_id)
    if first is not None:
        return ExpenseChangedOut(expense=await _out(db, entry),
                                 action=await _action_out(db, first, now), repeated=True)
    if not await service.is_live(db, entry):
        raise ApiError(404, "not_found")
    if entry.version != body.version:
        raise ApiError(409, "conflict", details={"version": entry.version})
    sent = body.model_fields_set - {"version", "client_id", "confirm"}
    values: dict[str, Any] = {}
    review = [f for f in entry.review_fields or [] if f not in body.confirm]
    try:
        if "amount" in sent or "expression" in sent:
            amount, expression = service.resolve_amount(
                body.amount if "amount" in sent else None,
                body.expression if "expression" in sent else None)  # fmt: skip
            if calc.money(entry.amount) != amount:
                values["amount"] = f"{amount:.2f}"
                values["parse_source"] = ParseSource.USER_EDIT.value
            values["expression"] = expression
            review = [f for f in review if f != "amount"]  # the person typed it: theirs
        if "currency" in sent and body.currency:
            values["currency"] = body.currency
        if "spent_on" in sent and body.spent_on:
            values["spent_on"] = date.fromisoformat(body.spent_on).isoformat()
            review = [f for f in review if f != "spent_on"]  # the person set the day
        if "category_id" in sent:
            cat = await _category(db, user.id, body.category_id)
            values["category_id"] = str(cat.public_id) if cat else None
        if "note" in sent:
            values["note"] = service.clean_note(body.note)
        if "payee" in sent:
            values["payee"] = service.clean_payee(body.payee)
            review = [f for f in review if f != "payee"]
        if "method" in sent:
            values["method"] = body.method
        if "direction" in sent and body.direction:
            values["direction"] = body.direction
    except service.ExpenseError as exc:
        raise ApiError(422, exc.code) from exc
    except ValueError as exc:
        raise ApiError(422, "validation_error") from exc
    if review != list(entry.review_fields or []):
        values["review_fields"] = review
    item_pid = await service.item_public_id(db, entry)
    out = engine.Outcome()
    if values:
        out = await engine.apply(db, user.id, [{"op": "set_expense", "id": str(entry.public_id),
                                                "item": str(item_pid), "values": values}],
                                 by=Initiator.USER, check=False, now=now)  # fmt: skip
    action = None
    if out.inverse:
        cat = await db.get(ExpenseCategory, entry.category_id) if entry.category_id else None
        title = service.label(entry.note, entry.payee, cat)
        only_confirm = set(values) == {"review_fields"} and "amount" in body.confirm
        text_ = (f"Сумма верна: {calc.format_money(entry.amount, entry.currency)}" if only_confirm
                 else f"Изменил трату: {calc.format_money(entry.amount, entry.currency)} · "
                      f"{title}")  # fmt: skip
        action = await record(
            db, user_id=user.id, kind=ActionKind.EDIT_EXPENSE, initiated_by=Initiator.USER,
            summary={"ru": text_, "kk": None},
            changes=[_change_row(entry, item_pid, "edit", text_, title)],
            inverse=out.inverse, now=now, source_item_ids=[entry.item_id],
            client_id=body.client_id,
        )  # fmt: skip
    await db.flush()
    return ExpenseChangedOut(expense=await _out(db, entry),
                             action=await _action_out(db, action, now))  # fmt: skip


@router.delete("/{expense_id}", response_model=ExpenseChangedOut)
async def delete_expense(expense_id: uuid.UUID, user: GatedUser, db: Db,
                         client_id: uuid.UUID | None = None) -> ExpenseChangedOut:  # fmt: skip
    now = _now()
    await lock_user(db, user.id)
    entry = await _own(db, user.id, expense_id)
    first = await _by_client(db, user.id, client_id)
    if first is not None:
        return ExpenseChangedOut(expense=await _out(db, entry),
                                 action=await _action_out(db, first, now), repeated=True)
    item_pid = await service.item_public_id(db, entry)
    out = await engine.apply(db, user.id, [
        {"op": "delete_entity_soft", "entity": "expenses", "id": str(entry.public_id),
         "item": str(item_pid)}], by=Initiator.USER, check=False, now=now)  # fmt: skip
    action = None
    if out.inverse:
        cat = await db.get(ExpenseCategory, entry.category_id) if entry.category_id else None
        title = service.label(entry.note, entry.payee, cat)
        text_ = f"Убрал в корзину: {calc.format_money(entry.amount, entry.currency)} · {title}"
        action = await record(
            db, user_id=user.id, kind=ActionKind.DELETE_ITEM, initiated_by=Initiator.USER,
            summary={"ru": text_, "kk": None},
            changes=[_change_row(entry, item_pid, "trash", text_, title)],
            inverse=out.inverse, now=now, source_item_ids=[entry.item_id], client_id=client_id,
        )  # fmt: skip
    await db.flush()
    return ExpenseChangedOut(expense=await _out(db, entry),
                             action=await _action_out(db, action, now))  # fmt: skip


# --- categories ---


def _cat_out(c: ExpenseCategory) -> ExpenseCategoryOut:
    return ExpenseCategoryOut.model_validate(service.category_dict(c))


@categories_router.get("", response_model=CategoriesOut)
async def list_categories(user: GatedUser, db: Db) -> CategoriesOut:
    order, rows = await service.chip_order(db, user.id, await local_today(db, user.id))
    await db.commit()  # the first call made the person's copy of the categories
    return CategoriesOut(order=order, categories=[_cat_out(c) for c in rows])  # type: ignore[arg-type]


async def _cat_action(db: Db, user_id: int, text_: str, inverse: list[dict[str, Any]],
                      now: datetime, client_id: uuid.UUID | None) -> Action | None:  # fmt: skip
    if not inverse:
        return None
    return await record(db, user_id=user_id, kind=ActionKind.USER_EDIT,
                        initiated_by=Initiator.USER, summary={"ru": text_, "kk": None},
                        changes=[{"item_id": None, "kind": "edit", "title": text_,
                                  "page_id": None, "text": text_}],
                        inverse=inverse, now=now, client_id=client_id)  # fmt: skip


@categories_router.post("", response_model=CategoryChangedOut, status_code=201)
async def create_category(body: CategoryIn, user: GatedUser, db: Db,
                          response: Response) -> CategoryChangedOut:  # fmt: skip
    now = _now()
    await lock_user(db, user.id)
    rows = await service.categories(db, user.id)
    found = next((c for c in rows if c.client_id == body.client_id), None)
    if found is not None:
        response.status_code = 200
        return CategoryChangedOut(category=_cat_out(found), repeated=True,
                                  action=await _action_out(db, await _by_client(
                                      db, user.id, body.client_id), now))  # fmt: skip
    try:
        title = service.clean_title(body.title)
    except service.ExpenseError as exc:
        raise ApiError(422, exc.code) from exc
    if any(c.title.lower() == title.lower() and c.hidden_at is None for c in rows):
        raise ApiError(409, "category_exists")
    if sum(1 for c in rows if c.created_by != "system") >= MAX_OWN_CATEGORIES:
        raise ApiError(422, "too_many")
    cat = ExpenseCategory(user_id=user.id, client_id=body.client_id, key=service.own_key(),
                          title=title, icon=body.icon, created_by="user",
                          position=service.position_after(rows),
                          manual_at=now if service.is_manual(rows) else None)  # fmt: skip
    db.add(cat)
    await db.flush()
    inverse = [{"op": "set_expense_category", "id": str(cat.public_id),
                "values": {"hidden_at": now.isoformat()}}]  # fmt: skip
    action = await _cat_action(db, user.id, f"Добавил категорию: {title}", inverse, now,
                               body.client_id)  # fmt: skip
    await db.flush()
    return CategoryChangedOut(category=_cat_out(cat), action=await _action_out(db, action, now))


@categories_router.patch("/reorder", response_model=CategoriesChangedOut)
async def reorder_categories(body: CategoryReorderIn, user: GatedUser,
                             db: Db) -> CategoriesChangedOut:  # fmt: skip
    """S38 ↑ ↓: from now on the order is the person's (`manual`)."""
    now = _now()
    await lock_user(db, user.id)
    first = await _by_client(db, user.id, body.client_id)
    _, rows = await service.chip_order(db, user.id, await local_today(db, user.id, now))
    if first is not None:
        return CategoriesChangedOut(categories=[_cat_out(c) for c in rows],
                                    action=await _action_out(db, first, now), repeated=True)
    by_id = {c.public_id: c for c in rows}
    if any(i not in by_id for i in body.ids) or len(set(body.ids)) != len(body.ids):
        raise ApiError(422, "validation_error", details={"field": "ids"})
    chips = [c for c in rows if not c.service]
    listed = [by_id[i] for i in body.ids if not by_id[i].service]
    rest = [c for c in chips if c not in listed]
    order = listed + rest + [c for c in rows if c.service]
    keys = lexorank.sequence(len(order))
    ops = [{"op": "set_expense_category", "id": str(c.public_id),
            "values": {"position": key, "manual_at": c.manual_at.isoformat() if c.manual_at
                       else now.isoformat()}} for c, key in zip(order, keys, strict=True)]
    out = await engine.apply(db, user.id, ops, by=Initiator.USER, check=False, now=now)
    action = await _cat_action(db, user.id, "Изменил порядок категорий", out.inverse, now,
                               body.client_id)  # fmt: skip
    await db.flush()
    _, rows = await service.chip_order(db, user.id, await local_today(db, user.id, now))
    return CategoriesChangedOut(categories=[_cat_out(c) for c in rows],
                                action=await _action_out(db, action, now))  # fmt: skip


@categories_router.patch("/{category_id}", response_model=CategoryChangedOut)
async def patch_category(category_id: uuid.UUID, body: CategoryPatchIn, user: GatedUser,
                         db: Db) -> CategoryChangedOut:  # fmt: skip
    now = _now()
    await lock_user(db, user.id)
    rows = await service.categories(db, user.id)
    cat = next((c for c in rows if c.public_id == category_id), None)
    if cat is None:
        raise ApiError(404, "not_found")
    first = await _by_client(db, user.id, body.client_id)
    if first is not None:
        return CategoryChangedOut(category=_cat_out(cat), action=await _action_out(db, first, now),
                                  repeated=True)  # fmt: skip
    if cat.version != body.version:
        raise ApiError(409, "conflict", details={"version": cat.version})
    sent = body.model_fields_set - {"version", "client_id"}
    values: dict[str, Any] = {}
    words: list[str] = []
    if "title" in sent and body.title is not None:
        try:
            title = service.clean_title(body.title)
        except service.ExpenseError as exc:
            raise ApiError(422, exc.code) from exc
        if any(c.id != cat.id and c.title.lower() == title.lower() and c.hidden_at is None
               for c in rows):  # fmt: skip
            raise ApiError(409, "category_exists")
        values["title"] = title
        words.append(f"Переименовал категорию: {cat.title} → {title}")
    if "icon" in sent:
        values["icon"] = body.icon
    if "pinned" in sent and body.pinned is not None:
        values["pinned"] = body.pinned
    if "hidden" in sent and body.hidden is not None:
        if body.hidden and cat.key in UNHIDEABLE:
            raise ApiError(422, "validation_error", details={"field": "hidden"})
        values["hidden_at"] = now.isoformat() if body.hidden else None
        if body.hidden and cat.hidden_at is None:
            words.append(f"Скрыл категорию: {cat.title}")
        elif not body.hidden and cat.hidden_at is not None:
            words.append(f"Вернул категорию: {cat.title}")
        if cat.hidden_at is not None and body.hidden:
            values.pop("hidden_at")
    out = engine.Outcome()
    if values:
        out = await engine.apply(db, user.id, [{"op": "set_expense_category",
                                                "id": str(cat.public_id), "values": values}],
                                 by=Initiator.USER, check=False, now=now)  # fmt: skip
    action = await _cat_action(db, user.id, "; ".join(words) or f"Изменил категорию: {cat.title}",
                               out.inverse, now, body.client_id)  # fmt: skip
    await db.flush()
    return CategoryChangedOut(category=_cat_out(cat), action=await _action_out(db, action, now))


__all__ = ["aggregate_out", "categories_router", "local_today", "router"]
