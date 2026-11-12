"""«Расходы 2» (week 13): a receipt photo / screenshot / shared Kaspi receipt, a fiscal QR, a bank
statement as a plan with one «Да» and one «Отменить», and repeats of expenses. Contract:
docs/api/expenses.md (week 13).

Amounts: code checks every number the model gives against the document's own text; QR sums come
from the link; statement rows from the bank's table and its own summary. No transaction stays open
across a model call or the OFD page. Ф-1 (`expenses_rules_first`) is off by default: code then
does not read receipt text itself.
"""

import asyncio
import uuid
from datetime import UTC, date, datetime
from typing import Annotated, Any, Literal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy import delete, select

from assistant.actions import actions_dicts, record
from assistant.actions.patch import page_patches
from assistant.api.consent_gate import AI_CONSENTS, missing_consents, require_base_consent
from assistant.api.deps import Ctx, CurrentUser, Db, get_active_consent_kinds
from assistant.api.errors import ApiError
from assistant.api.routes.expenses import local_today
from assistant.api.schemas import ExpenseOut
from assistant.db.models import Item, User
from assistant.db.models_actions import Action, ActionKind, Initiator
from assistant.db.models_expenses import (
    ExpenseEntry,
    ExpenseSource,
    StatementImport,
    StatementStatus,
)
from assistant.db.models_tasks import PendingAction, PendingStatus
from assistant.db.models_v2 import RecordKind, RecordStatus
from assistant.expenses import calc, imports, ofd, receipts, repeats, service, statements
from assistant.records import original_file

router = APIRouter(prefix="/expenses", tags=["expenses"])
GatedUser = Annotated[CurrentUser, Depends(require_base_consent)]
Kinds = Annotated[frozenset[str], Depends(get_active_consent_kinds)]
RECEIPT_KINDS = frozenset({RecordKind.IMAGE, RecordKind.SCREENSHOT, RecordKind.PDF})
WAITING = frozenset({RecordStatus.PENDING, RecordStatus.PROCESSING})
FORM_RECEIPT = "Не разобрал сумму на чеке — наберите её на клавишах."
FORM_QR = "Не нашёл сумму по QR — наберите её на клавишах."


def _now() -> datetime:
    return datetime.now(UTC)


class FromItemIn(BaseModel):
    client_id: uuid.UUID
    item_id: uuid.UUID
    kind: Literal["receipt", "shared_receipt"] = "receipt"
    save: bool = True


class FromQrIn(BaseModel):
    client_id: uuid.UUID
    url: str = Field(min_length=8, max_length=2048)
    item_id: uuid.UUID | None = None


class StatementIn(BaseModel):
    client_id: uuid.UUID
    item_id: uuid.UUID


class DecideIn(BaseModel):
    client_id: uuid.UUID | None = None


class MergeIn(BaseModel):
    client_id: uuid.UUID | None = None
    keep_id: uuid.UUID | None = None


async def _action_out(db: Db, action: Action | None) -> dict[str, Any] | None:
    if action is None:
        return None
    return (await actions_dicts(db, [action], _now()))[0]


async def _expense_out(db: Db, entry: ExpenseEntry | None) -> dict[str, Any] | None:
    if entry is None:
        return None
    return ExpenseOut.model_validate((await service.expenses_dicts(db, [entry]))[0]).model_dump(
        mode="json")


async def _dup_out(db: Db, dup: Any) -> dict[str, Any] | None:
    if dup is None:
        return None
    return (await repeats.dup_dicts(db, [dup]))[0]


async def _own_item(db: Db, user_id: int, item_id: uuid.UUID) -> Item:
    item = await db.scalar(select(Item).where(Item.user_id == user_id, Item.public_id == item_id,
                                              Item.deleted_at.is_(None)))  # fmt: skip
    if item is None:
        raise ApiError(404, "not_found")
    return item


async def _tz(db: Db, user_id: int) -> ZoneInfo:
    return ZoneInfo(await db.scalar(select(User.tz).where(User.id == user_id)) or "Asia/Almaty")


def _draft(d: receipts.ReceiptDraft, cat: Any, today: date) -> dict[str, Any]:
    return {"amount": f"{d.amount:.2f}" if d.amount is not None else None,
            "currency": d.currency, "spent_on": (d.spent_on or today).isoformat(),
            "category_id": str(cat.public_id) if cat else None,
            "category_key": service.category_key(cat), "method": None, "direction": "expense",
            "note": None, "payee": d.payee, "line_items": d.line_items,
            "review_fields": list(dict.fromkeys(d.review))}  # fmt: skip


def _result(status: str, **kw: Any) -> dict[str, Any]:
    base = {"status": status, "expense": None, "action": None, "page_patches": [], "draft": None,
            "duplicate": None, "reader": None, "message": None, "retry_after": None,
            "repeated": False}  # fmt: skip
    return {**base, **kw}


async def _repeat(db: Db, user_id: int, client_id: uuid.UUID) -> dict[str, Any] | None:
    found = await db.scalar(select(ExpenseEntry).where(ExpenseEntry.user_id == user_id,
                                                       ExpenseEntry.client_id == client_id))
    if found is None:
        return None
    action = await db.scalar(select(Action).where(Action.user_id == user_id,
                                                  Action.client_id == client_id))  # fmt: skip
    return _result("ok", expense=await _expense_out(db, found),
                   action=await _action_out(db, action), repeated=True)  # fmt: skip


async def _save(db: Db, user_id: int, spec: service.NewExpense, *, client_id: uuid.UUID,
                now: datetime, today: date) -> tuple[service.Created, Action, Any]:  # fmt: skip
    created = await service.create(db, user_id, spec, by=Initiator.USER, now=now, today=today,
                                   client_id=client_id)  # fmt: skip
    action = await record(
        db, user_id=user_id, kind=ActionKind.CREATE_EXPENSE, initiated_by=Initiator.USER,
        summary={"ru": created.sentence, "kk": None}, changes=created.changes,
        inverse=created.inverse, now=now, screen_id=created.page.id if created.page else None,
        source_item_ids=[created.item.id], client_id=client_id,
    )  # fmt: skip
    dup = await repeats.suggest_for(db, user_id, created.entry)
    await db.flush()
    return created, action, dup


async def _drop_dead(db: Db, item: Item) -> ExpenseEntry | None:
    """The record's live expense, or None. A dead one (its «Отменить» ran) is removed, so the
    record can be read again (sync gets a tombstone)."""
    entry = await db.scalar(select(ExpenseEntry).where(ExpenseEntry.item_id == item.id))
    if entry is not None and entry.deleted_at is not None:
        await db.execute(delete(ExpenseEntry).where(ExpenseEntry.id == entry.id))
        return None
    return entry


# --- receipt photo / screenshot / shared receipt ---


@router.post("/from-item")
async def from_item(body: FromItemIn, user: GatedUser, db: Db, ctx: Ctx, kinds: Kinds,
                    response: Response) -> dict[str, Any]:  # fmt: skip
    now = _now()
    if (first := await _repeat(db, user.id, body.client_id)) is not None:
        return first
    item = await _own_item(db, user.id, body.item_id)
    if item.kind not in RECEIPT_KINDS:
        raise ApiError(422, "item_kind")
    if (live := await _drop_dead(db, item)) is not None:
        return _result("exists", expense=await _expense_out(db, live), repeated=True)
    if item.status in WAITING:
        return _result("waiting", retry_after=2)
    today = await local_today(db, user.id, now)
    tz = await _tz(db, user.id)
    taken_on = (item.occurred_at or item.created_at).astimezone(tz).date()
    text = item.text or ""
    cats = await service.reader_categories(db, user.id)
    router_ = ctx.ai_router if not missing_consents(kinds, AI_CONSENTS) else None
    item_pk = item.id
    await db.commit()  # no transaction stays open across the model call

    draft: receipts.ReceiptDraft | None = None
    if text and ctx.settings.expenses_rules_first:
        draft = receipts.rules_read(text, today)
    if (draft is None or draft.amount is None) and text and router_ is not None:
        draft = await receipts.read_with_model(text, router=router_, user_id=user.id,
                                               today=today, categories=cats)  # fmt: skip
    draft = draft or receipts.ReceiptDraft(amount=None)
    cat = await service.category_by_key(db, user.id, draft.category_key)
    if draft.amount is None:
        return _result("form", draft=_draft(draft, cat, taken_on), message=FORM_RECEIPT,
                       reader=draft.reader)  # fmt: skip
    if not body.save:
        return _result("ok", draft=_draft(draft, cat, taken_on), reader=draft.reader)
    await service.lock_user(db, user.id)
    if (first := await _repeat(db, user.id, body.client_id)) is not None:
        return first
    item = await db.get(Item, item_pk, with_for_update=True)
    if item is None or item.deleted_at is not None:
        raise ApiError(404, "not_found")
    if (live := await _drop_dead(db, item)) is not None:
        return _result("exists", expense=await _expense_out(db, live), repeated=True)
    source = (ExpenseSource.SHARED_RECEIPT if body.kind == "shared_receipt"
              else ExpenseSource.RECEIPT_OCR)  # fmt: skip
    method = "kaspi" if "kaspi" in text.lower() and body.kind == "shared_receipt" else None
    spec = service.NewExpense(
        amount=draft.amount, currency=draft.currency, spent_on=draft.spent_on or taken_on,
        category=cat, payee=service.clean_payee(draft.payee), method=method, source=source,
        parse_source=draft.reader, review=list(dict.fromkeys(draft.review)),
        line_items=draft.line_items, item=item,
    )  # fmt: skip
    created, action, dup = await _save(db, user.id, spec, client_id=body.client_id, now=now,
                                       today=today)  # fmt: skip
    response.status_code = 201
    return _result("ok", expense=await _expense_out(db, created.entry),
                   action=await _action_out(db, action), reader=draft.reader,
                   page_patches=await page_patches(db, user.id, created.pages, created.items),
                   duplicate=await _dup_out(db, dup))  # fmt: skip


# --- fiscal QR ---


@router.post("/from-qr")
async def from_qr(body: FromQrIn, user: GatedUser, db: Db, ctx: Ctx, kinds: Kinds,
                  response: Response) -> dict[str, Any]:  # fmt: skip
    if not ctx.settings.feature_receipt_qr:  # Ф-37: after the beta
        raise ApiError(403, "feature_off", details={"feature": "receipt_qr"})
    now = _now()
    try:
        fiscal = ofd.parse_link(body.url, ctx.settings.expenses_ofd_domains)
    except ofd.QrError as exc:
        raise ApiError(422, exc.code) from exc
    info = {"domain": fiscal.domain, "sign": fiscal.sign, "register": fiscal.register,
            "amount": f"{fiscal.amount:.2f}" if fiscal.amount is not None else None,
            "at": fiscal.at.isoformat() if fiscal.at else None, "page": "skipped"}  # fmt: skip
    if (first := await _repeat(db, user.id, body.client_id)) is not None:
        return {**first, "fiscal": info}
    photo = await _own_item(db, user.id, body.item_id) if body.item_id else None
    if photo is not None and photo.kind not in RECEIPT_KINDS:
        raise ApiError(422, "item_kind")
    if fiscal.ref:
        same = await db.scalar(select(ExpenseEntry).join(Item, Item.id == ExpenseEntry.item_id)
                               .where(ExpenseEntry.user_id == user.id,
                                      ExpenseEntry.source_ref == fiscal.ref,
                                      ExpenseEntry.deleted_at.is_(None),
                                      Item.deleted_at.is_(None)))  # fmt: skip
        if same is not None:
            return {**_result("exists", expense=await _expense_out(db, same), repeated=True),
                    "fiscal": info}
    today = await local_today(db, user.id, now)
    tz = await _tz(db, user.id)
    cats = await service.reader_categories(db, user.id)
    router_ = ctx.ai_router if not missing_consents(kinds, AI_CONSENTS) else None
    photo_pk = photo.id if photo else None
    await db.commit()  # no transaction open across the OFD page or the model

    page = None
    reader = getattr(ctx, "ofd", None)
    if ctx.settings.expenses_ofd_fetch and reader is not None:
        page = await reader.read(fiscal.url)
        info["page"] = "read" if page else "failed"
    draft = receipts.ReceiptDraft(amount=fiscal.amount)
    if page and router_ is not None:
        got = await receipts.read_with_model(page, router=router_, user_id=user.id, today=today,
                                             categories=cats,
                                             known_total=fiscal.amount)  # fmt: skip
        if got is not None and got.amount is not None:
            draft = got
    if draft.amount is None and page and ctx.settings.expenses_rules_first:
        draft = receipts.rules_read(page, today) or draft
    spent_on = fiscal.at.astimezone(tz).date() if fiscal.at else None
    if draft.amount is None:
        return {**_result("form", message=FORM_QR,
                          draft=_draft(draft, None, spent_on or today)), "fiscal": info}
    cat = await service.category_by_key(db, user.id, draft.category_key)
    await service.lock_user(db, user.id)
    if (first := await _repeat(db, user.id, body.client_id)) is not None:
        return {**first, "fiscal": info}
    item = None
    if photo_pk is not None:
        item = await db.get(Item, photo_pk, with_for_update=True)
        if item is not None and await _drop_dead(db, item) is not None:
            item = None  # that photo already has its expense: this one gets its own record
    payee = service.clean_payee(draft.payee)
    phrase = (f"Чек ОФД{' · ' + payee if payee else ''} — "
              f"{calc.format_money(draft.amount, draft.currency)}")  # fmt: skip
    review = ["amount"] + [f for f in draft.review if f not in ("amount", "spent_on")]
    if spent_on is None:
        review.append("spent_on")
    spec = service.NewExpense(
        amount=draft.amount, currency=draft.currency, spent_on=spent_on or today,
        spent_at=fiscal.at, category=cat, payee=payee, source=ExpenseSource.RECEIPT_QR,
        parse_source="llm" if draft.reader == "llm" else None, review=review,
        line_items=draft.line_items, source_ref=fiscal.ref, item=item, phrase=phrase,
        record_meta={"fiscal_url": fiscal.url},
    )  # fmt: skip
    created, action, dup = await _save(db, user.id, spec, client_id=body.client_id, now=now,
                                       today=today)  # fmt: skip
    response.status_code = 201
    return {**_result("ok", expense=await _expense_out(db, created.entry),
                      action=await _action_out(db, action), reader=draft.reader,
                      page_patches=await page_patches(db, user.id, created.pages, created.items),
                      duplicate=await _dup_out(db, dup)), "fiscal": info}  # fmt: skip


# --- bank statements ---


def _pending_out(p: PendingAction | None) -> dict[str, Any] | None:
    if p is None:
        return None
    return {"id": str(p.public_id), "kind": p.kind, "status": p.status, "preview": p.preview,
            "expires_at": p.expires_at.isoformat(), "message_id": None, "action_id": None,
            "seq": p.seq, "created_at": p.created_at.isoformat(),
            "decided_at": p.decided_at.isoformat() if p.decided_at else None}  # fmt: skip


async def _statement(db: Db, user_id: int, sid: uuid.UUID, lock: bool = False) -> StatementImport:
    q = select(StatementImport).where(StatementImport.user_id == user_id,
                                      StatementImport.public_id == sid)
    st = await db.scalar(q.with_for_update() if lock else q)
    if st is None:
        raise ApiError(404, "not_found")
    return st


@router.post("/statements", status_code=201)
async def create_statement(body: StatementIn, user: GatedUser, db: Db, ctx: Ctx, kinds: Kinds,
                           response: Response) -> dict[str, Any]:  # fmt: skip
    if not ctx.settings.feature_statements_pdf:  # Ф-37: after the beta
        raise ApiError(403, "feature_off", details={"feature": "statements_pdf"})
    now = _now()
    first = await db.scalar(select(StatementImport).where(
        StatementImport.user_id == user.id, StatementImport.client_id == body.client_id))
    if first is not None:
        response.status_code = 200
        return {"statement": await imports.statement_dict(db, first),
                "pending_action": _pending_out(await db.get(PendingAction,
                                                            first.pending_action_id or 0)),
                "repeated": True}  # fmt: skip
    item = await _own_item(db, user.id, body.item_id)
    if item.kind != RecordKind.PDF:
        raise ApiError(422, "item_kind")
    file = await original_file(db, item.id)
    if file is None or file.purged_at is not None:
        raise ApiError(422, "statement_original_gone")
    key = file.storage_key
    item_pk = item.id
    router_ = ctx.ai_router if not missing_consents(kinds, AI_CONSENTS) else None
    await db.commit()  # no transaction open while reading storage, parsing, or the model

    data = await ctx.storage.get(key)
    if data is None:
        raise ApiError(422, "statement_original_gone")
    try:
        parsed = await asyncio.to_thread(statements.parse, data)
    except statements.StatementError as exc:
        if exc.code != "statement_unknown_format":
            raise ApiError(422, exc.code) from exc
        got = None
        if router_ is not None:
            got = await imports.read_unknown(exc.lines, router=router_, user_id=user.id)
        if got is None:
            raise ApiError(422, "statement_unknown_format") from exc
        parsed = got
    await service.lock_user(db, user.id)
    first = await db.scalar(select(StatementImport).where(
        StatementImport.user_id == user.id, StatementImport.client_id == body.client_id))
    if first is not None:  # the same call raced in meanwhile
        response.status_code = 200
        return {"statement": await imports.statement_dict(db, first),
                "pending_action": _pending_out(await db.get(PendingAction,
                                                            first.pending_action_id or 0)),
                "repeated": True}  # fmt: skip
    item = await db.get(Item, item_pk)
    if item is None or item.deleted_at is not None:
        raise ApiError(404, "not_found")
    st, pending = await imports.plan(db, user.id, item, parsed, now=now, client_id=body.client_id,
                                     rules_first=ctx.settings.expenses_rules_first)  # fmt: skip
    return {"statement": await imports.statement_dict(db, st),
            "pending_action": _pending_out(pending), "repeated": False}


@router.get("/statements")
async def list_statements(
    user: GatedUser, db: Db, limit: Annotated[int, Query(ge=1, le=50)] = 10,
) -> dict[str, Any]:
    rows = list(await db.scalars(select(StatementImport).where(StatementImport.user_id == user.id)
                                 .order_by(StatementImport.id.desc()).limit(limit)))
    return {"statements": [await imports.statement_dict(db, st) for st in rows]}


@router.get("/statements/{statement_id}")
async def get_statement(statement_id: uuid.UUID, user: GatedUser, db: Db) -> dict[str, Any]:
    st = await _statement(db, user.id, statement_id)
    status = await imports.status_of(db, st)
    return {"statement": await imports.statement_dict(db, st),
            "rows": imports.rows_out(st) if status == StatementStatus.PROPOSED else []}


async def confirm_statement(db: Db, user_id: int, st: StatementImport,
                            now: datetime) -> dict[str, Any]:  # fmt: skip
    """«Да» on a statement plan (also called by /v1/pending-actions/{id}/confirm)."""
    pending = await db.get(PendingAction, st.pending_action_id or 0, with_for_update=True)
    if pending is None:
        raise ApiError(404, "not_found")
    if pending.status == PendingStatus.EXECUTED:
        action = await db.get(Action, pending.action_id) if pending.action_id else None
        return {"statement": await imports.statement_dict(db, st),
                "pending_action": _pending_out(pending), "action": await _action_out(db, action),
                "created": (pending.result or {}).get("created", 0), "duplicates": [],
                "repeated": True}  # fmt: skip
    if pending.status != PendingStatus.PROPOSED or st.status != StatementStatus.PROPOSED:
        raise ApiError(409, "pending_closed")
    if pending.expires_at <= now:
        pending.status, pending.decided_at = PendingStatus.EXPIRED, now
        st.status, st.decided_at, st.rows = StatementStatus.EXPIRED, now, []
        await db.commit()
        raise ApiError(410, "pending_expired")
    done = await imports.confirm(db, user_id, st, pending, now=now,
                                 today=await local_today(db, user_id, now))  # fmt: skip
    return {"statement": await imports.statement_dict(db, st),
            "pending_action": _pending_out(pending), "action": await _action_out(db, done.action),
            "created": done.created, "duplicates": await repeats.dup_dicts(db, done.duplicates),
            "repeated": False}  # fmt: skip


@router.post("/statements/{statement_id}/confirm")
async def confirm(statement_id: uuid.UUID, user: GatedUser, db: Db,
                  body: DecideIn | None = None) -> dict[str, Any]:  # fmt: skip
    await service.lock_user(db, user.id)
    st = await _statement(db, user.id, statement_id, lock=True)
    return await confirm_statement(db, user.id, st, _now())


@router.post("/statements/{statement_id}/reject")
async def reject(statement_id: uuid.UUID, user: GatedUser, db: Db,
                 body: DecideIn | None = None) -> dict[str, Any]:  # fmt: skip
    st = await _statement(db, user.id, statement_id, lock=True)
    if st.status not in (StatementStatus.PROPOSED, StatementStatus.REJECTED):
        raise ApiError(409, "pending_closed")
    await imports.reject(db, st, _now())
    pending = await db.get(PendingAction, st.pending_action_id or 0)
    return {"statement": await imports.statement_dict(db, st),
            "pending_action": _pending_out(pending)}


# --- repeats of expenses ---


@router.get("/duplicates")
async def list_duplicates(
    user: GatedUser, db: Db,
    status: Literal["suggested", "merged", "dismissed", "undone"] = "suggested",
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> dict[str, Any]:
    rows = await repeats.open_list(db, user.id, status, limit)
    return {"duplicates": await repeats.dup_dicts(db, rows)}


@router.post("/duplicates/{dup_id}/merge")
async def merge_duplicate(dup_id: uuid.UUID, user: GatedUser, db: Db,
                          body: MergeIn | None = None) -> dict[str, Any]:  # fmt: skip
    body = body or MergeIn()
    await service.lock_user(db, user.id)
    if body.client_id is not None:
        first = await db.scalar(select(Action).where(Action.user_id == user.id,
                                                     Action.client_id == body.client_id))
        if first is not None:
            dup = await db.scalar(select(repeats.ExpenseDuplicate).where(
                repeats.ExpenseDuplicate.action_id == first.id))  # fmt: skip
            keep = await db.get(ExpenseEntry, dup.keep_id) if dup else None
            return {"duplicate": await _dup_out(db, dup), "expense": await _expense_out(db, keep),
                    "action": await _action_out(db, first), "repeated": True}  # fmt: skip
    try:
        dup = await repeats.get(db, user.id, dup_id, lock=True)
        out = await repeats.merge(db, user.id, dup, keep_id=body.keep_id, now=_now(),
                                  client_id=body.client_id)  # fmt: skip
    except repeats.RepeatError as exc:
        raise ApiError(exc.status, exc.code) from exc
    return {"duplicate": await _dup_out(db, out.dup), "expense": await _expense_out(db, out.keep),
            "action": await _action_out(db, out.action), "repeated": out.repeated}  # fmt: skip


@router.post("/duplicates/{dup_id}/dismiss")
async def dismiss_duplicate(dup_id: uuid.UUID, user: GatedUser, db: Db,
                            body: DecideIn | None = None) -> dict[str, Any]:  # fmt: skip
    body = body or DecideIn()
    await service.lock_user(db, user.id)
    try:
        dup = await repeats.get(db, user.id, dup_id, lock=True)
        action, repeated = await repeats.dismiss(db, user.id, dup, now=_now(),
                                                 client_id=body.client_id)  # fmt: skip
    except repeats.RepeatError as exc:
        raise ApiError(exc.status, exc.code) from exc
    return {"duplicate": await _dup_out(db, dup), "action": await _action_out(db, action),
            "repeated": repeated}  # fmt: skip


__all__ = ["confirm_statement", "router"]
