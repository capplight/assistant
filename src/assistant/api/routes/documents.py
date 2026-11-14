"""КП documents (week 14; F-13, F-34, US-12, S16, S17; spec 4.7, 6.7). Contract: docs/api/kp.md.

`POST /v1/documents/kp` queues KP_EXTRACT (job `kp:extract`, worker `python -m assistant.kp`);
the phone follows `GET /v1/documents/{id}/progress`. Every number of a КП is code's: totals,
VAT and the sum in words from kp/calc.py and kp/words.py; prices come from the price list, past
КП or the person, each line with its `price_source`; a line without one asks «укажите цену».
Tap edits are JSON Patch without the model; each edit is a new version and one action whose
«Отменить» is a revert to the version before. Week 15: phrase edits (KP_EDIT → the same white
list, applied at once, all or nothing), the versions sheet, DOCX, sending through the phone
(`send` → pending «Да» → the phone's share sheet / `wa.me`) and «Отправили?»
(`…/versions/{n}/sent`: the version is frozen with its files, `send_external` without «Отменить»).
"""

import asyncio
import hashlib
import json
import uuid
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query, Response
from fastapi.encoders import jsonable_encoder
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select

from assistant.actions import actions_dicts, engine, record
from assistant.ai import AIConsentRequired, AIError
from assistant.api.consent_gate import AI_CONSENTS, missing_consents, require_base_consent
from assistant.api.deps import Ctx, CurrentUser, Db, get_active_consent_kinds
from assistant.api.errors import ApiError
from assistant.db.models import Item
from assistant.db.models_actions import Action, ActionKind, Initiator
from assistant.db.models_kp import DealStatus, DocStatus, Document, DocumentVersion
from assistant.db.models_tasks import PendingAction, PendingStatus
from assistant.db.models_v2 import File, FileRole
from assistant.kp import docx_render, edit, jobs, patch, pricelist, profile, render, send, service
from assistant.kp.calc import format_money, money
from assistant.kp.render import RendererUnavailable
from assistant.pages import lock_user

router = APIRouter(prefix="/documents", tags=["kp"])
GatedUser = Annotated[CurrentUser, Depends(require_base_consent)]
Kinds = Annotated[frozenset[str], Depends(get_active_consent_kinds)]
WAITING = service.WAITING
SOURCE_KINDS = service.SOURCE_KINDS
PROGRESS_POLL_S = 1.0
PROGRESS_MAX_S = 180


def _now() -> datetime:
    return datetime.now(UTC)


def _err(exc: service.KpError | patch.PatchError) -> ApiError:
    if isinstance(exc, patch.PatchError):
        return ApiError(422, exc.code, details={"path": exc.path} if exc.path else None)
    return ApiError(exc.status, exc.code, details=exc.details)


async def _action_out(db: Db, action: Action | None) -> dict[str, Any] | None:
    if action is None:
        return None
    return (await actions_dicts(db, [action], _now()))[0]


async def _first(db: Db, user_id: int, client_id: uuid.UUID | None) -> Action | None:
    if client_id is None:
        return None
    return await db.scalar(select(Action).where(Action.user_id == user_id,
                                                Action.client_id == client_id))


async def _row(db: Db, doc: Document) -> dict[str, Any]:
    return (await service.rows_dicts(db, [doc]))[0]


async def _doc(db: Db, user_id: int, doc_id: uuid.UUID, lock: bool = False) -> Document:
    try:
        return await service.get(db, user_id, doc_id, lock=lock)
    except service.KpError as exc:
        raise _err(exc) from exc


async def _profile(db: Db, ctx: Ctx, user_id: int) -> dict[str, Any]:
    return await profile.profile_dict(db, await profile.get(db, user_id), ctx.kp_cipher)


async def _full(db: Db, ctx: Ctx, doc: Document, n: int | None = None) -> dict[str, Any]:
    tz = await service.user_tz(db, doc.user_id)
    prof = await _profile(db, ctx, doc.user_id)
    out: dict[str, Any] = {"document": await _row(db, doc), "version": None,
                           "needs_profile": not prof["complete"]}  # fmt: skip
    if doc.current_version_n:
        v = await service.version(db, doc, n)
        out["version"] = await service.version_dict(db, doc, v, tz=tz, profile=prof,
                                                    required=ctx.settings.kp_required_fields)
    out["versions"] = await service.versions_rows(db, doc)
    return out


# --- a new КП from a ТЗ ---


class NewKpIn(BaseModel):
    client_id: uuid.UUID
    # the ТЗ: records («Сделать КП из этого» on a card / a shared file) and/or `text`
    item_ids: list[uuid.UUID] = Field(default_factory=list, max_length=10)
    text: str | None = Field(default=None, max_length=service.REQUEST_MAX)  # the ТЗ said/typed
    wishes: str | None = Field(default=None, max_length=1000)  # the person's words, if any


@router.post("/kp", status_code=202)
async def new_kp(body: NewKpIn, user: GatedUser, db: Db, ctx: Ctx, kinds: Kinds,
                 response: Response) -> dict[str, Any]:  # fmt: skip
    now = _now()
    await lock_user(db, user.id)
    first = await db.scalar(select(Document).where(Document.user_id == user.id,
                                                    Document.client_id == body.client_id))
    if first is not None:
        response.status_code = 200
        return {**await _full(db, ctx, first), "repeated": True}
    text = (body.text or "").strip()
    if not body.item_ids and not text:
        raise ApiError(422, "validation_error", details={"field": "item_ids"})
    missing = missing_consents(kinds, AI_CONSENTS)
    if missing or ctx.ai_router is None:
        raise ApiError(403, "consent_required", details={"missing": missing or
                                                         ["ai_cross_border"]})
    items = list(await db.scalars(select(Item).where(
        Item.user_id == user.id, Item.public_id.in_(body.item_ids), Item.deleted_at.is_(None))))
    if len(items) != len(set(body.item_ids)):
        raise ApiError(404, "not_found")
    order = {pid: i for i, pid in enumerate(body.item_ids)}
    items.sort(key=lambda i: order[i.public_id])
    try:
        if text:
            items.append(await service.request_record(db, user.id, text))
        created = await service.start(db, user.id, sources=items, wishes=body.wishes,
                                      client_id=body.client_id, now=now,
                                      per_day=ctx.settings.kp_per_day)  # fmt: skip
    except service.KpError as exc:
        raise _err(exc) from exc
    await jobs.enqueue(db, created.doc)
    await db.flush()
    return {**await _full(db, ctx, created.doc), "repeated": False}


@router.get("")
async def list_documents(user: GatedUser, db: Db,
                         limit: Annotated[int, Query(ge=1, le=200)] = 50,
                         before: int | None = None) -> dict[str, Any]:  # fmt: skip
    q = select(Document).where(Document.user_id == user.id, Document.deleted_at.is_(None))
    if before is not None:
        q = q.where(Document.id < before)
    rows = list(await db.scalars(q.order_by(Document.id.desc()).limit(limit + 1)))
    return {"documents": await service.rows_dicts(db, rows[:limit]),
            "next_before": rows[limit - 1].id if len(rows) > limit else None}


@router.get("/summary")
async def summary(user: GatedUser, db: Db) -> dict[str, Any]:
    """The card file's dividers and folders («КП 4 · Договоры 2 · Чеки 23»), counted by code over
    the «Документы» page."""
    from assistant.db.models_pages import Screen, ScreenItem

    page = await db.scalar(select(Screen).where(
        Screen.user_id == user.id, Screen.template_key == service.PAGE_TEMPLATE,
        Screen.deleted_at.is_(None)).limit(1))  # fmt: skip
    by_type = {"kp": 0, "contract": 0, "receipt": 0, "other": 0}
    clients: dict[str, int] = {}
    deals = {k: 0 for k in DealStatus}
    if page is not None:
        rows = list(await db.scalars(
            select(Item).join(ScreenItem, ScreenItem.item_id == Item.id)
            .where(ScreenItem.screen_id == page.id, ScreenItem.removed_by_user_at.is_(None),
                   Item.deleted_at.is_(None), Item.hidden_reason.is_(None))))  # fmt: skip
        docs = {d.item_id: d for d in await db.scalars(select(Document).where(
            Document.item_id.in_([i.id for i in rows]))) } if rows else {}  # fmt: skip
        for it in rows:
            d = docs.get(it.id)
            if d is not None:
                by_type["kp"] += 1
                deals[d.deal_status] += 1
                who = (d.client or {}).get("name")
            else:
                vals = service.other_field_values(it)
                by_type[vals["doc_type"]] = by_type.get(vals["doc_type"], 0) + 1
                who = vals.get("client")
            key = who or ""
            clients[key] = clients.get(key, 0) + 1
    return {"by_type": by_type, "deal_status": deals,
            "clients": [{"name": k or None, "count": v}
                        for k, v in sorted(clients.items(), key=lambda kv: (not kv[0], kv[0]))]}


@router.get("/{doc_id}")
async def get_document(doc_id: uuid.UUID, user: GatedUser, db: Db, ctx: Ctx) -> dict[str, Any]:
    return await _full(db, ctx, await _doc(db, user.id, doc_id))


def _progress(doc: Document) -> dict[str, Any]:
    p = dict(doc.progress or {})
    return {"document_id": str(doc.public_id), "status": doc.status,
            "state": p.get("state"), "done": p.get("done", 0), "total": p.get("total", 0),
            "parts_done": p.get("parts_done", 0), "parts_total": p.get("parts_total", 0),
            "partial": bool(p.get("partial")), "message": p.get("message"),
            "error": doc.error}  # fmt: skip


@router.get("/{doc_id}/progress", response_model=None)
async def progress(doc_id: uuid.UUID, user: GatedUser, db: Db, ctx: Ctx,
                   once: bool = False) -> Any:  # fmt: skip
    """SSE `event: progress` with {done, total, message «Обработал 120 из 240»} until
    `state` is `done` or `failed`; `?once=true` answers one JSON object."""
    doc = await _doc(db, user.id, doc_id)
    if once:
        return _progress(doc)
    pk, uid = doc.id, user.id
    await db.commit()

    async def stream():  # type: ignore[no-untyped-def]
        last = None
        loop = asyncio.get_running_loop()
        end = loop.time() + PROGRESS_MAX_S
        while True:
            async with ctx.sessionmaker() as s:
                row = await s.get(Document, pk)
            if row is None or row.user_id != uid:
                yield "event: end\ndata: {}\n\n"
                return
            data = _progress(row)
            if data != last:
                yield f"event: progress\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"
                last = data
            if data["state"] in ("done", "failed") or row.status != DocStatus.EXTRACTING \
                    or loop.time() > end:  # fmt: skip
                yield "event: end\ndata: {}\n\n"
                return
            await asyncio.sleep(PROGRESS_POLL_S)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache"})  # fmt: skip


@router.get("/{doc_id}/versions")
async def versions(doc_id: uuid.UUID, user: GatedUser, db: Db,
                   limit: Annotated[int, Query(ge=1, le=200)] = 50) -> dict[str, Any]:  # fmt: skip
    """The versions sheet: who changed what, totals, sent and frozen ones, their files."""
    doc = await _doc(db, user.id, doc_id)
    return {"versions": await service.versions_rows(db, doc, limit),
            "sent_version_n": doc.sent_version_n}  # fmt: skip


@router.get("/{doc_id}/versions/{n}")
async def get_version(doc_id: uuid.UUID, n: int, user: GatedUser, db: Db,
                      ctx: Ctx) -> dict[str, Any]:  # fmt: skip
    doc = await _doc(db, user.id, doc_id)
    try:
        return await _full(db, ctx, doc, n)
    except service.KpError as exc:
        raise _err(exc) from exc


# --- tap edits, revert, status, trash ---


class PatchIn(BaseModel):
    client_id: uuid.UUID
    base_version: int  # `current_version_n` the phone edited
    ops: list[dict[str, Any]] = Field(min_length=1, max_length=200)
    save_prices: bool = False  # «Сохранить в прайс ☑»: changed prices also go to «Мой прайс»


class RevertIn(BaseModel):
    client_id: uuid.UUID
    n: int = Field(ge=1)


class StatusIn(BaseModel):
    client_id: uuid.UUID
    deal_status: Literal["draft", "sent", "seen", "accepted", "declined"]


def _change_text(before: dict[str, Any] | None, after_total: str, currency: str) -> str:
    if before and before.get("total") != after_total:
        old = format_money(before["total"], currency).removesuffix(" ₸")
        return f"Итого: {old} → {format_money(after_total, currency)}"
    return "Изменил КП"


async def _offers(db: Db, user_id: int, old: dict[str, Any],
                  new: dict[str, Any]) -> list[dict[str, Any]]:  # fmt: skip
    """US-21 «Обновить в прайсе?»: prices the person just typed that «Мой прайс» does not have
    (or has with another price). Lump-sum lines («за всё», `kind: "lump"`) are never offered:
    founder 2026-11-11, a price per building differs every time."""
    before = {it["id"]: it.get("unit_price") for it in old.get("items") or []}
    out = []
    for it in new.get("items") or []:
        price = it.get("unit_price")
        if it.get("kind") == "lump":
            continue
        if it.get("price_source") != "manual" or price is None or before.get(it["id"]) == price:
            continue
        same = await pricelist.find_same(db, user_id, it["name"], it.get("unit"))
        if same is not None and f"{money(same.price):.2f}" == price:
            continue
        out.append({"line_id": it["id"], "name": it["name"], "unit": it.get("unit"),
                    "price": price, "price_item_id": str(same.public_id) if same else None,
                    "old_price": f"{money(same.price):.2f}" if same else None})  # fmt: skip
    return out


@router.post("/{doc_id}/patch")
async def patch_document(doc_id: uuid.UUID, body: PatchIn, user: GatedUser, db: Db,
                         ctx: Ctx) -> dict[str, Any]:  # fmt: skip
    now = _now()
    await lock_user(db, user.id)
    if (first := await _first(db, user.id, body.client_id)) is not None:
        doc = await _doc(db, user.id, doc_id)
        return {**await _full(db, ctx, doc), "action": await _action_out(db, first),
                "change_text": (first.summary or {}).get("ru"), "price_offers": [],
                "repeated": True}  # fmt: skip
    doc = await _doc(db, user.id, doc_id, lock=True)
    if doc.deleted_at is not None:
        raise ApiError(409, "item_deleted")
    if not doc.current_version_n:
        raise ApiError(409, "kp_not_ready")
    if body.base_version != doc.current_version_n:
        raise ApiError(409, "conflict", details=jsonable_encoder(await _full(db, ctx, doc)))
    out = await _apply_edit(db, ctx, user.id, doc, body.ops, author="tap_edit", request_text=None,
                            client_id=body.client_id, save_prices=body.save_prices,
                            by=Initiator.USER, now=now)  # fmt: skip
    return {**out, "repeated": False}


async def _apply_edit(db: Db, ctx: Ctx, user_id: int, doc: Document, ops: list[dict[str, Any]], *,
                      author: str, request_text: str | None, client_id: uuid.UUID,
                      save_prices: bool, by: str, now: datetime) -> dict[str, Any]:  # fmt: skip
    """A tap or phrase edit: a new version with code's totals, one action whose «Отменить» is a
    revert to the version before. The caller holds the user lock and the document row."""
    cur = await service.version(db, doc)
    try:
        data, changed, applied = patch.apply_patch(cur.data, ops)
        saved = await service.save_version(db, doc, data, author=author, now=now,
                                           settings=ctx.settings, patch=applied,
                                           changed_paths=changed,
                                           request_text=request_text)  # fmt: skip
    except (patch.PatchError, service.KpError) as exc:
        raise _err(exc) from exc
    item = await db.get(Item, doc.item_id)
    assert item is not None
    inverse = [{"op": "revert_document", "id": str(doc.public_id), "n": cur.n,
                "expect_n": saved.version.n, "item": str(item.public_id)}]
    offers = await _offers(db, user_id, cur.data, data)
    if save_prices and offers:
        rows = [pricelist.Row(name=o["name"], unit=o["unit"], price=money(o["price"]))
                for o in offers]  # fmt: skip
        _, inv = await pricelist.add_typed(db, user_id, rows, now=now)
        inverse = [*inv, *inverse]
        offers = []
    text = _change_text(saved.before, saved.version.totals["total"], data.get("currency") or "KZT")
    action = await record(
        db, user_id=user_id, kind=ActionKind.EDIT_KP, initiated_by=by,
        summary={"ru": text, "kk": None},
        changes=[{"item_id": str(item.public_id), "document_id": str(doc.public_id),
                  "title": doc.title, "kind": "edit", "page_id": None, "text": text,
                  "changed_paths": changed}],
        inverse=inverse, now=now, source_item_ids=[item.id], client_id=client_id,
        extra={"request_text": request_text} if request_text else None,
    )  # fmt: skip
    return {**await _full(db, ctx, doc), "action": await _action_out(db, action),
            "change_text": text, "price_offers": offers}  # fmt: skip


@router.post("/{doc_id}/revert")
async def revert(doc_id: uuid.UUID, body: RevertIn, user: GatedUser, db: Db,
                 ctx: Ctx) -> dict[str, Any]:  # fmt: skip
    """«Вернуть версию n»: a new version equal to n (one action, «Отменить» = back)."""
    now = _now()
    await lock_user(db, user.id)
    if (first := await _first(db, user.id, body.client_id)) is not None:
        doc = await _doc(db, user.id, doc_id)
        return {**await _full(db, ctx, doc), "action": await _action_out(db, first),
                "repeated": True}  # fmt: skip
    doc = await _doc(db, user.id, doc_id, lock=True)
    if not doc.current_version_n or body.n > doc.current_version_n:
        raise ApiError(404, "not_found")
    if body.n == doc.current_version_n:
        return {**await _full(db, ctx, doc), "action": None, "repeated": False}
    out = await engine.apply(db, user.id, [{"op": "revert_document", "id": str(doc.public_id),
                                            "n": body.n}],
                             by=Initiator.USER, check=False, now=now)  # fmt: skip
    item = await db.get(Item, doc.item_id)
    assert item is not None
    text = f"Вернул версию {body.n}"
    action = await record(
        db, user_id=user.id, kind=ActionKind.EDIT_KP, initiated_by=Initiator.USER,
        summary={"ru": text, "kk": None},
        changes=[{"item_id": str(item.public_id), "document_id": str(doc.public_id),
                  "title": doc.title, "kind": "revert", "page_id": None, "text": text}],
        inverse=out.inverse, now=now, source_item_ids=[item.id], client_id=body.client_id,
    )  # fmt: skip
    return {**await _full(db, ctx, doc), "action": await _action_out(db, action),
            "repeated": False}  # fmt: skip


@router.post("/{doc_id}/status")
async def set_status(doc_id: uuid.UUID, body: StatusIn, user: GatedUser, db: Db,
                     ctx: Ctx) -> dict[str, Any]:  # fmt: skip
    """The status strip («Клиент принял?» [Да]): set by the person, with «Отменить»."""
    now = _now()
    await lock_user(db, user.id)
    if (first := await _first(db, user.id, body.client_id)) is not None:
        doc = await _doc(db, user.id, doc_id)
        return {"document": await _row(db, doc), "action": await _action_out(db, first),
                "repeated": True}  # fmt: skip
    doc = await _doc(db, user.id, doc_id, lock=True)
    out = await engine.apply(db, user.id, [{"op": "set_document", "id": str(doc.public_id),
                                            "values": {"deal_status": body.deal_status}}],
                             by=Initiator.USER, check=False, now=now)  # fmt: skip
    action = None
    if out.inverse:
        item = await db.get(Item, doc.item_id)
        assert item is not None
        text = f"{doc.title}: {service.DEAL_TEXT[body.deal_status].lower()}"
        action = await record(
            db, user_id=user.id, kind=ActionKind.EDIT_KP, initiated_by=Initiator.USER,
            summary={"ru": text, "kk": None},
            changes=[{"item_id": str(item.public_id), "document_id": str(doc.public_id),
                      "title": doc.title, "kind": "status", "page_id": None, "text": text}],
            inverse=out.inverse, now=now, source_item_ids=[item.id], client_id=body.client_id,
        )  # fmt: skip
    await db.refresh(doc)
    return {"document": await _row(db, doc), "action": await _action_out(db, action),
            "repeated": False}  # fmt: skip


@router.delete("/{doc_id}")
async def trash(doc_id: uuid.UUID, user: GatedUser, db: Db,
                client_id: uuid.UUID | None = None) -> dict[str, Any]:  # fmt: skip
    now = _now()
    await lock_user(db, user.id)
    if (first := await _first(db, user.id, client_id)) is not None:
        doc = await _doc(db, user.id, doc_id)
        return {"document": await _row(db, doc), "action": await _action_out(db, first),
                "repeated": True}  # fmt: skip
    doc = await _doc(db, user.id, doc_id, lock=True)
    item = await db.get(Item, doc.item_id)
    assert item is not None
    out = await engine.apply(db, user.id, [{"op": "delete_entity_soft", "entity": "documents",
                                            "id": str(doc.public_id),
                                            "item": str(item.public_id)}],
                             by=Initiator.USER, check=False, now=now)  # fmt: skip
    text = f"Убрал в удалённые: {doc.title}"
    action = await record(
        db, user_id=user.id, kind=ActionKind.DELETE_ITEM, initiated_by=Initiator.USER,
        summary={"ru": text, "kk": None},
        changes=[{"item_id": str(item.public_id), "document_id": str(doc.public_id),
                  "title": doc.title, "kind": "delete", "page_id": None, "text": text}],
        inverse=out.inverse, now=now, source_item_ids=[item.id], client_id=client_id,
    )  # fmt: skip
    await db.refresh(doc)
    return {"document": await _row(db, doc), "action": await _action_out(db, action),
            "repeated": False}  # fmt: skip


# --- phrase edits (KP_EDIT, week 15) ---


class EditIn(BaseModel):
    client_id: uuid.UUID
    base_version: int  # `current_version_n` the phone showed
    text: str = Field(min_length=1, max_length=edit.PHRASE_MAX)


def _unchanged(out: dict[str, Any], status: str, message: str,
               refused: list[dict[str, str]] | None = None) -> dict[str, Any]:  # fmt: skip
    return {**out, "status": status, "action": None, "change_text": None, "price_offers": [],
            "message": message, "refused": refused or [], "repeated": False}  # fmt: skip


@router.post("/{doc_id}/edit")
async def edit_document(doc_id: uuid.UUID, body: EditIn, user: GatedUser, db: Db, ctx: Ctx,
                        kinds: Kinds) -> dict[str, Any]:  # fmt: skip
    """«убери доставку», «скидка 5% на всё»: KP_EDIT → ops on the tap-edit white list → code's
    checks (numbers only from the phrase) → applied at once as one new version, or nothing."""
    now = _now()
    await lock_user(db, user.id)
    if (first := await _first(db, user.id, body.client_id)) is not None:
        doc = await _doc(db, user.id, doc_id)
        return {**await _full(db, ctx, doc), "status": "applied",
                "action": await _action_out(db, first),
                "change_text": (first.summary or {}).get("ru"), "price_offers": [],
                "message": None, "refused": [], "repeated": True}  # fmt: skip
    doc = await _doc(db, user.id, doc_id, lock=True)
    if doc.deleted_at is not None:
        raise ApiError(409, "item_deleted")
    if not doc.current_version_n:
        raise ApiError(409, "kp_not_ready")
    if body.base_version != doc.current_version_n:
        raise ApiError(409, "conflict", details=jsonable_encoder(await _full(db, ctx, doc)))
    missing = missing_consents(kinds, AI_CONSENTS)
    if missing or ctx.ai_router is None:
        raise ApiError(403, "consent_required", details={"missing": missing or
                                                         ["ai_cross_border"]})
    data = dict((await service.version(db, doc)).data)
    phrase = " ".join(body.text.split())
    await db.commit()  # no transaction stays open across the model call
    try:
        reply, _cost = await edit.read_phrase(ctx.ai_router, user.id, data, phrase)
    except AIConsentRequired as exc:
        raise ApiError(403, "consent_required", details={"missing": ["ai_cross_border"]}) from exc
    except AIError as exc:
        raise ApiError(503, "kp_edit_unavailable") from exc
    await lock_user(db, user.id)
    doc = await _doc(db, user.id, doc_id, lock=True)
    if doc.current_version_n != body.base_version or doc.deleted_at is not None:
        raise ApiError(409, "conflict", details=jsonable_encoder(await _full(db, ctx, doc)))
    if not reply.understood or not reply.ops:
        return _unchanged(await _full(db, ctx, doc), "not_understood", edit.TEXT_NOT_UNDERSTOOD)
    checked = edit.check_ops(reply, data, phrase)
    if checked.refused or not checked.ops:
        return _unchanged(await _full(db, ctx, doc), "refused",
                          checked.message or edit.TEXT_REFUSED, checked.refused)  # fmt: skip
    out = await _apply_edit(db, ctx, user.id, doc, checked.ops, author="agent_request",
                            request_text=phrase, client_id=body.client_id, save_prices=False,
                            by=Initiator.AGENT, now=now)  # fmt: skip
    return {**out, "status": "applied", "message": None, "refused": [], "repeated": False}


# --- the file (PDF by default, DOCX on request) ---


async def _image(ctx: Ctx, db: Db, file_pk: int | None) -> str | None:
    if not file_pk:
        return None
    f = await db.get(File, file_pk)
    if f is None or f.purged_at is not None:
        return None
    data = await ctx.storage.get(f.storage_key)
    return render.data_uri(f.mime, data) if data else None


FORMATS = {"pdf": ("render_file_id", "application/pdf"),
           "docx": ("docx_file_id", service.DOCX_MIME)}  # fmt: skip


async def _stored(db: Db, v: DocumentVersion, fmt: str) -> File | None:
    pk = getattr(v, FORMATS[fmt][0])
    f = await db.get(File, pk) if pk else None
    return f if f is not None and f.purged_at is None else None


async def ensure_file(db: Db, ctx: Ctx, user: Any, doc: Document, v: DocumentVersion,
                      fmt: str) -> tuple[Document, DocumentVersion, File]:  # fmt: skip
    """The file of version `v` in `fmt`: the stored one of a sent (frozen) version, the same one
    if the data and profile did not change, else a new render. May commit (no transaction stays
    open while rendering); returns the rows reloaded and locked."""
    if v.sent_at is not None and (frozen := await _stored(db, v, fmt)) is not None:
        return doc, v, frozen
    if not v.totals.get("complete"):
        raise ApiError(422, "kp_prices_missing", details={
            "lines": [t["id"] for t in v.totals["lines"] if t["amount"] is None]})
    p = await profile.get(db, user.id)
    prof = await profile.profile_dict(db, p, ctx.kp_cipher)
    missing = service.missing_required(v.data, v.totals, prof, ctx.settings.kp_required_fields)
    if missing:
        raise ApiError(422, "kp_fields_missing", details={"fields": missing})
    images = {"logo": await _image(ctx, db, p.logo_file_id if p else None),
              "signature": await _image(ctx, db, p.signature_file_id if p else None),
              "stamp": await _image(ctx, db, p.stamp_file_id if p else None)}
    context = render.build_context(
        data=v.data, totals=v.totals, profile=prof, images=images,
        created_at=v.created_at.isoformat(), word_langs=ctx.settings.kp_words_langs,
        ai_metadata=ctx.settings.kp_ai_metadata,
        visible_label=ctx.settings.label_ai_generated if ctx.settings.kp_visible_ai_label
        else None, valid_until=service.valid_until(v.data))  # fmt: skip
    if fmt == "pdf":
        html = render.render_html(context)
        digest = hashlib.sha256(html.encode()).hexdigest()
    else:
        raw = json.dumps(context, ensure_ascii=False, sort_keys=True, default=str)
        digest = hashlib.sha256(f"{docx_render.template_hash()}:{raw}".encode()).hexdigest()
    attr, mime = FORMATS[fmt]
    key = f"u/{user.public_id}/kp/{doc.public_id}/v{v.n}-{digest[:24]}.{fmt}"
    same = await db.scalar(select(File).where(File.user_id == user.id, File.storage_key == key))
    if same is None:
        doc_pk, v_pk, item_pk = doc.id, v.id, doc.item_id
        await db.commit()  # no transaction open while rendering and storing
        try:
            if fmt == "pdf":
                blob = await ctx.kp_renderer.render(html)
            else:
                blob = await docx_render.DocxRenderer().render(context)
        except RendererUnavailable as exc:
            raise ApiError(503, "kp_render_unavailable") from exc
        await ctx.storage.put(key, blob)
        same = await db.scalar(select(File).where(File.user_id == user.id,
                                                  File.storage_key == key))
        if same is None:
            same = File(user_id=user.id, item_id=item_pk, role=FileRole.KP_RENDER,
                        storage_key=key, mime=mime, bytes=len(blob),
                        sha256=hashlib.sha256(blob).hexdigest())  # fmt: skip
            db.add(same)
            await db.flush()
        doc = await db.get(Document, doc_pk, with_for_update=True)  # type: ignore[assignment]
        v = await db.get(DocumentVersion, v_pk, with_for_update=True)  # type: ignore[assignment]
        assert doc is not None and v is not None
    setattr(v, attr, same.id)
    if fmt == "pdf" and v.n == doc.current_version_n and doc.status == DocStatus.DRAFT:
        doc.status = DocStatus.READY
        doc.version += 1
    if v.sent_at is not None and ctx.settings.kp_keep_sent_render:
        await send.keep_files(db, v)
    await db.flush()
    return doc, v, same


@router.post("/{doc_id}/render")
async def render_document(doc_id: uuid.UUID, user: GatedUser, db: Db, ctx: Ctx,
                          format: Literal["pdf", "docx"] = "pdf",
                          n: int | None = None) -> dict[str, Any]:  # fmt: skip
    """PDF (default) or DOCX («Ещё → Сделать в Word») of the current version (or `n`). The same
    version and data → the same file; a sent version → its stored file."""
    doc = await _doc(db, user.id, doc_id)
    if not doc.current_version_n:
        raise ApiError(409, "kp_not_ready")
    try:
        v = await service.version(db, doc, n)
    except service.KpError as exc:
        raise _err(exc) from exc
    doc, v, f = await ensure_file(db, ctx, user, doc, v, format)
    return {"file": service.file_dict(doc, f, v.n), "version_n": v.n,
            "total": v.totals["total"], "document": await _row(db, doc)}  # fmt: skip


# --- sending through the phone (S18) and «Отправили?» ---


class SendIn(BaseModel):
    client_id: uuid.UUID
    n: int | None = Field(default=None, ge=1)
    channel: Literal["whatsapp", "email", "share"]
    format: Literal["pdf", "docx"] = "pdf"
    recipient_name: str | None = Field(default=None, max_length=120)  # never the phone number
    message: str | None = Field(default=None, max_length=2000)


def _send_out(p: PendingAction, doc_row: dict[str, Any], repeated: bool) -> dict[str, Any]:
    from assistant.api.routes.duplicates import pending_out

    prev = p.preview or {}
    return {"pending_action": pending_out(p), "file": prev.get("file"),
            "version_n": prev.get("version_n"), "resend": prev.get("resend"),
            "message": prev.get("message"), "hint": prev.get("hint"), "document": doc_row,
            "repeated": repeated}  # fmt: skip


@router.post("/{doc_id}/send")
async def send_document(doc_id: uuid.UUID, body: SendIn, user: GatedUser, db: Db,
                        ctx: Ctx) -> dict[str, Any]:  # fmt: skip
    """S18: the file of a version and a pending «Да» with a preview made by code. Nothing is
    sent: after «Да» the phone opens its share sheet / mail / `wa.me`."""
    now = _now()
    await lock_user(db, user.id)
    first = await db.scalar(select(PendingAction).where(PendingAction.user_id == user.id,
                                                        PendingAction.client_id == body.client_id))
    doc = await _doc(db, user.id, doc_id)
    if first is not None:
        return _send_out(first, await _row(db, doc), True)
    if doc.deleted_at is not None:
        raise ApiError(409, "item_deleted")
    if not doc.current_version_n:
        raise ApiError(409, "kp_not_ready")
    try:
        v = await service.version(db, doc, body.n)
    except service.KpError as exc:
        raise _err(exc) from exc
    doc, v, f = await ensure_file(db, ctx, user, doc, v, body.format)
    await lock_user(db, user.id)
    sent_at = None
    if doc.sent_version_n and doc.sent_version_n != v.n:
        sent_at = await db.scalar(select(DocumentVersion.sent_at).where(
            DocumentVersion.document_id == doc.id, DocumentVersion.n == doc.sent_version_n))
    name = (body.recipient_name or "").strip() or (doc.client or {}).get("contact") or None
    message = (body.message or "").strip() or send.cover_message(v.data, v.totals, name)
    resend = send.resend_info(doc, v.n, sent_at)
    preview = {"title_ru": "Отправить КП?", "document_id": str(doc.public_id), "version_n": v.n,
               "client": (doc.client or {}).get("name"), "recipient_name": name,
               "total": v.totals.get("total"),
               "total_text": format_money(v.totals["total"], v.data.get("currency") or "KZT"),
               "file": jsonable_encoder(service.file_dict(doc, f, v.n)), "channel": body.channel,
               "format": body.format, "message": message,
               "subject": send.kp_subject(v.data), "hint": send.hint(body.channel, name),
               "resend": jsonable_encoder(resend)}  # fmt: skip
    p = send.new_pending(user.id, send.FILE_KINDS[body.channel], preview,
                         {"document_id": str(doc.public_id), "version_n": v.n,
                          "channel": body.channel, "file_id": str(f.public_id)},
                         now=now, client_id=body.client_id)  # fmt: skip
    db.add(p)
    await db.flush()
    return _send_out(p, await _row(db, doc), False)


class SentIn(BaseModel):
    client_id: uuid.UUID
    channel: Literal["whatsapp_share", "whatsapp_text", "email", "share_other"]
    pending_action_id: uuid.UUID | None = None


async def mark_version_sent(db: Db, ctx: Ctx, user: Any, doc: Document, n: int, *, channel: str,
                            pending: PendingAction | None, client_id: uuid.UUID | None,
                            now: datetime) -> tuple[Document, Action | None]:  # fmt: skip
    """«Отправили? — Да»: the version frozen with its files, the document sent, one
    `send_external` action without «Отменить». Also called by /v1/pending-actions/{id}/result."""
    if doc.deleted_at is not None:
        raise ApiError(409, "item_deleted")
    if not doc.current_version_n:
        raise ApiError(409, "kp_not_ready")
    try:
        v = await service.version(db, doc, n)
    except service.KpError as exc:
        raise _err(exc) from exc
    if v.sent_at is None and v.render_file_id is None and v.docx_file_id is None:
        doc, v, _ = await ensure_file(db, ctx, user, doc, v, "pdf")  # the PDF is what is kept
        await lock_user(db, user.id)
    pending_pk = pending.id if pending is not None else None
    changed = await send.mark_sent(db, doc, v, channel=channel, now=now,
                                   keep=ctx.settings.kp_keep_sent_render)  # fmt: skip
    action = None
    if changed:
        item = await db.get(Item, doc.item_id)
        assert item is not None
        text = send.sent_text(doc, v.n, channel)
        action = await record(
            db, user_id=user.id, kind=ActionKind.SEND_EXTERNAL, initiated_by=Initiator.USER,
            summary={"ru": text, "kk": None},
            changes=[{"item_id": str(item.public_id), "document_id": str(doc.public_id),
                      "title": doc.title, "kind": "sent", "page_id": None, "text": text,
                      "version_n": v.n, "channel": channel}],
            inverse=[], now=now, source_item_ids=[item.id], client_id=client_id,
        )  # fmt: skip
        action.scope = "external"
    if pending_pk is not None:
        p = await db.get(PendingAction, pending_pk, with_for_update=True)
        if p is not None and p.status != PendingStatus.EXECUTED:
            p.status, p.executed_at = PendingStatus.EXECUTED, now
            p.decided_at = p.decided_at or now
            p.result = {"sent": True, "channel": channel, "version_n": v.n}
            p.action_id = action.id if action is not None else p.action_id
    await db.flush()
    return doc, action


@router.post("/{doc_id}/versions/{n}/sent")
async def version_sent(doc_id: uuid.UUID, n: int, body: SentIn, user: GatedUser, db: Db,
                       ctx: Ctx) -> dict[str, Any]:  # fmt: skip
    now = _now()
    await lock_user(db, user.id)
    if (first := await _first(db, user.id, body.client_id)) is not None:
        doc = await _doc(db, user.id, doc_id)
        return {**await _full(db, ctx, doc, n), "action": await _action_out(db, first),
                "repeated": True}  # fmt: skip
    doc = await _doc(db, user.id, doc_id, lock=True)
    pending = None
    if body.pending_action_id is not None:
        pending = await db.scalar(select(PendingAction).where(
            PendingAction.user_id == user.id, PendingAction.public_id == body.pending_action_id))
        if pending is None:
            raise ApiError(404, "not_found")
    doc, action = await mark_version_sent(db, ctx, user, doc, n, channel=body.channel,
                                          pending=pending, client_id=body.client_id,
                                          now=now)  # fmt: skip
    return {**await _full(db, ctx, doc, n), "action": await _action_out(db, action),
            "repeated": False}  # fmt: skip


@router.get("/{doc_id}/files/{file_id}", response_model=None)
async def download(doc_id: uuid.UUID, file_id: uuid.UUID, user: GatedUser, db: Db,
                   ctx: Ctx) -> Response:  # fmt: skip
    doc = await _doc(db, user.id, doc_id)
    f = await db.scalar(select(File).where(File.user_id == user.id, File.public_id == file_id,
                                           File.item_id == doc.item_id,
                                           File.role == FileRole.KP_RENDER))  # fmt: skip
    if f is None or f.purged_at is not None:
        raise ApiError(404, "not_found")
    data = await ctx.storage.get(f.storage_key)
    if data is None:
        raise ApiError(404, "not_found")
    n = await db.scalar(select(DocumentVersion.n).where(
        (DocumentVersion.render_file_id == f.id) | (DocumentVersion.docx_file_id == f.id))
        .order_by(DocumentVersion.n.desc()).limit(1)) or doc.current_version_n  # fmt: skip
    from urllib.parse import quote

    ext = "docx" if f.mime == service.DOCX_MIME else "pdf"
    name = quote(service.filename(doc, n or 1, ext))
    return Response(content=data, media_type=f.mime, headers={
        "Content-Disposition": f"attachment; filename*=UTF-8''{name}",
        "Cache-Control": "private, max-age=3600"})


__all__ = ["router"]
