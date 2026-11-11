"""«Моя компания» and «Мой прайс» (week 14; F-14, F-34, S19, S28). Contract: docs/api/kp.md.

Every change is an action with one «Отменить» (`company_profile_edit`, `price_list_edit`). Every
write takes a `client_id` (outbox-safe): a repeat returns the first result. No transaction stays
open across a model call. The model is asked only with `ai_cross_border` (consent gate); a card,
an old КП or a price list is data, never instructions.
"""

import uuid
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Response
from fastapi.encoders import jsonable_encoder
from pydantic import BaseModel, Field
from sqlalchemy import select

from assistant.actions import actions_dicts, record
from assistant.api.consent_gate import AI_CONSENTS, missing_consents, require_base_consent
from assistant.api.deps import Ctx, CurrentUser, Db, get_active_consent_kinds
from assistant.api.errors import ApiError
from assistant.db.models import Item
from assistant.db.models_actions import Action, ActionKind, Initiator
from assistant.db.models_kp import PriceList, PriceListItem, PriceListSource
from assistant.db.models_v2 import RecordKind, RecordStatus
from assistant.kp import pricelist, profile
from assistant.kp.calc import money
from assistant.kp.norm import MONEY_MAX, clean_text, parse_decimal, unit_norm
from assistant.pages import lock_user
from assistant.records import original_file

profile_router = APIRouter(prefix="/company-profile", tags=["kp"])
prices_router = APIRouter(prefix="/price-lists", tags=["kp"])
GatedUser = Annotated[CurrentUser, Depends(require_base_consent)]
Kinds = Annotated[frozenset[str], Depends(get_active_consent_kinds)]
WAITING = frozenset({RecordStatus.PENDING, RecordStatus.PROCESSING})
READABLE = frozenset({RecordKind.IMAGE, RecordKind.SCREENSHOT, RecordKind.PDF, RecordKind.DOCX,
                      RecordKind.XLSX, RecordKind.NOTE})  # fmt: skip


def _now() -> datetime:
    return datetime.now(UTC)


async def _action_out(db: Db, action: Action | None) -> dict[str, Any] | None:
    if action is None:
        return None
    return (await actions_dicts(db, [action], _now()))[0]


async def _first(db: Db, user_id: int, client_id: uuid.UUID | None) -> Action | None:
    if client_id is None:
        return None
    return await db.scalar(select(Action).where(Action.user_id == user_id,
                                                Action.client_id == client_id))


async def _own_item(db: Db, user_id: int, item_id: uuid.UUID) -> Item:
    item = await db.scalar(select(Item).where(Item.user_id == user_id, Item.public_id == item_id,
                                              Item.deleted_at.is_(None)))  # fmt: skip
    if item is None:
        raise ApiError(404, "not_found")
    return item


# --- «Моя компания» ---


class ProfileIn(BaseModel):
    client_id: uuid.UUID | None = None
    base_version: int | None = None  # the version the phone edited; another one → 409 conflict
    name: str | None = Field(default=None, max_length=200)
    legal_form: str | None = None
    bin_iin: str | None = Field(default=None, max_length=20)
    address: str | None = Field(default=None, max_length=300)
    bank: dict[str, Any] | None = None
    contacts: dict[str, Any] | None = None
    signer: dict[str, Any] | None = None
    vat_payer: bool | None = None
    logo_file_id: uuid.UUID | None = None
    signature_file_id: uuid.UUID | None = None
    stamp_file_id: uuid.UUID | None = None
    default_terms: dict[str, Any] | None = None
    license: dict[str, Any] | None = None  # week 15: {number, date, category}
    outgoing: dict[str, Any] | None = None  # week 15: {next, year?} «Исх. №» goes on from here
    review_fields: list[str] | None = None
    source: str | None = None


class ExtractIn(BaseModel):
    item_id: uuid.UUID


@profile_router.get("")
async def get_profile(user: GatedUser, db: Db, ctx: Ctx) -> dict[str, Any]:
    p = await profile.get(db, user.id)
    return {"profile": await profile.profile_dict(db, p, ctx.kp_cipher)}


@profile_router.put("")
async def put_profile(body: ProfileIn, user: GatedUser, db: Db, ctx: Ctx) -> dict[str, Any]:
    now = _now()
    await lock_user(db, user.id)
    if (first := await _first(db, user.id, body.client_id)) is not None:
        p = await profile.get(db, user.id)
        return {"profile": await profile.profile_dict(db, p, ctx.kp_cipher),
                "action": await _action_out(db, first), "repeated": True}  # fmt: skip
    values = body.model_dump(exclude_unset=True)
    values.pop("client_id", None)
    base = values.pop("base_version", None)
    if not values:
        raise ApiError(422, "validation_error")
    cur = await profile.get(db, user.id, lock=True)
    if base is not None and (cur.version if cur else 0) != base:
        raise ApiError(409, "conflict", details=jsonable_encoder({
            "profile": await profile.profile_dict(db, cur, ctx.kp_cipher)}))
    try:
        change = profile.clean_change(values)
        p, before = await profile.apply(db, user.id, change, ctx.kp_cipher, now=now)
    except profile.ProfileError as exc:
        raise ApiError(422, exc.code, details={"field": exc.field} if exc.field else None) \
            from exc
    text = "Сохранил реквизиты компании" if before is None else "Обновил реквизиты компании"
    action = await record(
        db, user_id=user.id, kind=ActionKind.COMPANY_PROFILE_EDIT, initiated_by=Initiator.USER,
        summary={"ru": text, "kk": None},
        changes=[{"item_id": None, "key": "company_profile", "title": p.name or "Моя компания",
                  "kind": "edit", "page_id": None, "text": text,
                  "fields": sorted(values)}],
        inverse=[{"op": "set_company_profile", "values": before,
                  "expect": {"fingerprint": profile.fingerprint(await profile.snapshot(db, p))}}],
        now=now, client_id=body.client_id,
    )  # fmt: skip
    return {"profile": await profile.profile_dict(db, p, ctx.kp_cipher),
            "action": await _action_out(db, action), "repeated": False}  # fmt: skip


@profile_router.post("/extract")
async def extract_profile(body: ExtractIn, user: GatedUser, db: Db, ctx: Ctx,
                          kinds: Kinds) -> dict[str, Any]:  # fmt: skip
    """A draft from a card / an old КП, every number «Проверьте». Nothing is saved here."""
    item = await _own_item(db, user.id, body.item_id)
    if item.kind not in READABLE:
        raise ApiError(422, "item_kind")
    if item.status in WAITING:
        return {"status": "waiting", "draft": None, "retry_after": 2}
    text = item.text or ""
    if not text.strip():
        return {"status": "form", "draft": None, "retry_after": None,
                "message": "Не получилось прочитать. Введите реквизиты вручную."}
    if missing_consents(kinds, AI_CONSENTS) or ctx.ai_router is None:
        raise ApiError(403, "consent_required", details={"missing": missing_consents(
            kinds, AI_CONSENTS) or ["ai_cross_border"]})
    await db.commit()  # no transaction open across the model call
    draft, _cost = await profile.extract(text, router=ctx.ai_router, user_id=user.id)
    if draft is None:
        return {"status": "form", "draft": None, "retry_after": None,
                "message": "Не получилось прочитать. Введите реквизиты вручную."}
    return {"status": "ok", "draft": {**draft, "source": "extracted"}, "retry_after": None,
            "message": None}  # fmt: skip


# --- «Мой прайс» ---


class PriceListIn(BaseModel):
    client_id: uuid.UUID
    item_id: uuid.UUID  # the uploaded price list as a record (Excel / PDF / photo)
    title: str | None = Field(default=None, max_length=200)


class TypedRow(BaseModel):
    name: str = Field(min_length=1, max_length=300)
    unit: str | None = Field(default=None, max_length=20)
    price: str = Field(min_length=1, max_length=20)


class TypedIn(BaseModel):
    client_id: uuid.UUID
    items: list[TypedRow] = Field(min_length=1, max_length=200)
    source: str = "typed_sequence"  # typed_sequence | voice


class PriceItemPatch(BaseModel):
    client_id: uuid.UUID | None = None
    name: str | None = Field(default=None, max_length=300)
    unit: str | None = Field(default=None, max_length=20)
    price: str | None = Field(default=None, max_length=20)
    checked: bool | None = None  # «Верно»: clears «Проверьте»


def _price(value: str) -> str:
    v = parse_decimal(value)
    if v is None or v < 0 or v > MONEY_MAX:
        raise ApiError(422, "validation_error", details={"field": "price"})
    return f"{money(v):.2f}"


@prices_router.get("")
async def list_price_lists(user: GatedUser, db: Db) -> dict[str, Any]:
    rows = list(await db.scalars(select(PriceList).where(
        PriceList.user_id == user.id, PriceList.deleted_at.is_(None)).order_by(PriceList.id)))
    return {"price_lists": [await pricelist.list_dict(db, pl) for pl in rows]}


@prices_router.post("", status_code=201)
async def upload_price_list(body: PriceListIn, user: GatedUser, db: Db, ctx: Ctx, kinds: Kinds,
                            response: Response) -> dict[str, Any]:  # fmt: skip
    now = _now()
    first = await db.scalar(select(PriceList).where(PriceList.user_id == user.id,
                                                    PriceList.client_id == body.client_id))
    if first is not None:
        response.status_code = 200
        action = await _first(db, user.id, body.client_id)
        return {"status": "ok", "price_list": await pricelist.list_dict(db, first),
                "action": await _action_out(db, action), "repeated": True}  # fmt: skip
    item = await _own_item(db, user.id, body.item_id)
    if item.kind not in READABLE:
        raise ApiError(422, "item_kind")
    if item.status in WAITING:
        response.status_code = 200
        return {"status": "waiting", "price_list": None, "action": None, "retry_after": 2}
    rows = pricelist.read_table(item.source_meta, item.text)
    reader = "table" if rows else None
    if not rows:
        if missing_consents(kinds, AI_CONSENTS) or ctx.ai_router is None:
            raise ApiError(422, "price_list_unreadable")
        text = item.text or ""
        if not text.strip():
            raise ApiError(422, "price_list_unreadable")
        item_pk = item.id
        await db.commit()  # no transaction open across the model
        try:
            got, _cost = await pricelist.read_with_model(text, router=ctx.ai_router,
                                                         user_id=user.id)  # fmt: skip
        except pricelist.PriceListError as exc:
            raise ApiError(422, exc.code) from exc
        if not got:
            raise ApiError(422, "price_list_unreadable")
        rows, reader = got, "model"
        item = await db.get(Item, item_pk)  # type: ignore[assignment]
        assert item is not None
    await lock_user(db, user.id)
    file = await original_file(db, item.id)
    title = clean_text(body.title, 200) or item.title or "Прайс"
    pl, inverse = await pricelist.create_list(
        db, user.id, rows, source=PriceListSource.UPLOAD, title=title, reader=reader,
        item_id=item.id, file_id=file.id if file else None, client_id=body.client_id, now=now)
    review = sum(1 for r in rows if r.review)
    text_ = f"Загрузил прайс: {len(rows)} поз." + (f", проверьте {review}" if review else "")
    action = await record(
        db, user_id=user.id, kind=ActionKind.PRICE_LIST_EDIT, initiated_by=Initiator.USER,
        summary={"ru": text_, "kk": None},
        changes=[{"item_id": str(item.public_id), "key": f"price_list:{pl.public_id}",
                  "title": pl.title, "kind": "create", "page_id": None, "text": text_}],
        inverse=inverse, now=now, source_item_ids=[item.id], client_id=body.client_id,
    )  # fmt: skip
    return {"status": "ok", "price_list": await pricelist.list_dict(db, pl),
            "action": await _action_out(db, action), "repeated": False}  # fmt: skip


@prices_router.post("/items", status_code=201)
async def add_items(body: TypedIn, user: GatedUser, db: Db, response: Response) -> dict[str, Any]:
    """«Ввести цены подряд», voice, «Обновить в прайсе? — Да»: the person's own numbers."""
    now = _now()
    if body.source not in ("typed_sequence", "voice"):
        raise ApiError(422, "validation_error")
    await lock_user(db, user.id)
    if (first := await _first(db, user.id, body.client_id)) is not None:
        response.status_code = 200
        ids = [c.get("price_item_id") for c in first.payload.get("changes", [])]
        rows = list(await db.scalars(select(PriceListItem).where(
            PriceListItem.public_id.in_([uuid.UUID(i) for i in ids if i]))))
        return {"items": [pricelist.item_dict(r) for r in rows],
                "action": await _action_out(db, first), "repeated": True}  # fmt: skip
    rows = [pricelist.Row(name=clean_text(r.name, 300) or "", unit=unit_norm(r.unit),
                          price=money(parse_decimal(_price(r.price)) or 0))
            for r in body.items]  # fmt: skip
    if any(not r.name for r in rows):
        raise ApiError(422, "validation_error", details={"field": "name"})
    items, inverse = await pricelist.add_typed(db, user.id, rows, now=now)
    text_ = f"Записал цены: {len(items)} поз."
    action = await record(
        db, user_id=user.id, kind=ActionKind.PRICE_LIST_EDIT, initiated_by=Initiator.USER,
        summary={"ru": text_, "kk": None},
        changes=[{"item_id": None, "key": f"price_item:{it.public_id}",
                  "price_item_id": str(it.public_id), "title": it.name, "kind": "price",
                  "page_id": None, "text": f"{it.name} — {money(it.price):.2f}"} for it in items],
        inverse=inverse, now=now, client_id=body.client_id,
    )  # fmt: skip
    lists = dict((await db.execute(select(PriceList.id, PriceList.public_id).where(
        PriceList.id.in_({i.price_list_id for i in items})))).tuples().all())
    return {"items": [pricelist.item_dict(i, lists.get(i.price_list_id)) for i in items],
            "action": await _action_out(db, action), "repeated": False}  # fmt: skip


@prices_router.get("/items")
async def search_items(
    user: GatedUser, db: Db, q: Annotated[str | None, Query(max_length=200)] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0, le=10_000)] = 0,
) -> dict[str, Any]:
    rows = await pricelist.search(db, user.id, q, limit + 1, offset)
    return {"items": [pricelist.item_dict(it, lid) for it, lid in rows[:limit]],
            "next_offset": offset + limit if len(rows) > limit else None}


@prices_router.get("/history")
async def history(user: GatedUser, db: Db,
                  limit: Annotated[int, Query(ge=1, le=200)] = 50) -> dict[str, Any]:  # fmt: skip
    """«ИЗ ПРОШЛЫХ КП»: the last price of each position of past КП that is not in a price list."""
    from sqlalchemy import text

    rows = (await db.execute(text("""
        SELECT DISTINCT ON (h.name_norm, coalesce(h.unit, '')) h.name, h.unit, h.unit_price,
               h.currency, d.public_id AS document_id, h.version_n, h.client_name, h.created_at
        FROM kp_price_history h JOIN documents d ON d.id = h.document_id
        WHERE h.user_id = :u AND d.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM price_list_items p JOIN price_lists l
                                 ON l.id = p.price_list_id
                          WHERE p.user_id = :u AND p.name_norm = h.name_norm
                            AND p.deleted_at IS NULL AND l.deleted_at IS NULL)
        ORDER BY h.name_norm, coalesce(h.unit, ''), h.id DESC
        LIMIT :n
    """), {"u": user.id, "n": limit})).mappings().all()  # fmt: skip
    return {"items": [{"name": r["name"], "unit": r["unit"],
                       "price": f"{money(r['unit_price']):.2f}", "currency": r["currency"],
                       "price_source": f"past_kp:{r['document_id']}#v{r['version_n']}",
                       "client": r["client_name"], "created_at": r["created_at"]}
                      for r in rows]}  # fmt: skip


@prices_router.patch("/items/{item_id}")
async def patch_item(item_id: uuid.UUID, body: PriceItemPatch, user: GatedUser,
                     db: Db) -> dict[str, Any]:  # fmt: skip
    from assistant.actions import engine

    now = _now()
    await lock_user(db, user.id)
    if (first := await _first(db, user.id, body.client_id)) is not None:
        it = await db.scalar(select(PriceListItem).where(PriceListItem.public_id == item_id,
                                                         PriceListItem.user_id == user.id))
        return {"item": pricelist.item_dict(it) if it else None,
                "action": await _action_out(db, first), "repeated": True}  # fmt: skip
    it = await db.scalar(select(PriceListItem).where(PriceListItem.public_id == item_id,
                                                     PriceListItem.user_id == user.id,
                                                     PriceListItem.deleted_at.is_(None)))
    if it is None:
        raise ApiError(404, "not_found")
    values: dict[str, Any] = {}
    if body.name is not None:
        values["name"] = clean_text(body.name, 300) or it.name
    if body.unit is not None:
        values["unit"] = unit_norm(body.unit)
    if body.price is not None:
        values["price"] = _price(body.price)
    if body.checked or values:
        values["review_fields"] = []
    if not values:
        raise ApiError(422, "validation_error")
    out = await engine.apply(db, user.id, [{"op": "set_price_item", "id": str(it.public_id),
                                            "values": values}],
                             by=Initiator.USER, check=False, now=now)  # fmt: skip
    text_ = f"Поправил цену: {values.get('name') or it.name}"
    action = await record(
        db, user_id=user.id, kind=ActionKind.PRICE_LIST_EDIT, initiated_by=Initiator.USER,
        summary={"ru": text_, "kk": None},
        changes=[{"item_id": None, "key": f"price_item:{it.public_id}",
                  "price_item_id": str(it.public_id), "title": it.name, "kind": "edit",
                  "page_id": None, "text": text_}],
        inverse=out.inverse, now=now, client_id=body.client_id,
    )  # fmt: skip
    await db.refresh(it)
    return {"item": pricelist.item_dict(it), "action": await _action_out(db, action),
            "repeated": False}  # fmt: skip


@prices_router.delete("/items/{item_id}")
async def delete_item(item_id: uuid.UUID, user: GatedUser, db: Db,
                      client_id: uuid.UUID | None = None) -> dict[str, Any]:  # fmt: skip
    from assistant.actions import engine

    now = _now()
    await lock_user(db, user.id)
    if (first := await _first(db, user.id, client_id)) is not None:
        return {"action": await _action_out(db, first), "repeated": True}
    it = await db.scalar(select(PriceListItem).where(PriceListItem.public_id == item_id,
                                                     PriceListItem.user_id == user.id,
                                                     PriceListItem.deleted_at.is_(None)))
    if it is None:
        raise ApiError(404, "not_found")
    out = await engine.apply(db, user.id, [{"op": "set_price_item", "id": str(it.public_id),
                                            "values": {"deleted_at": now.isoformat()}}],
                             by=Initiator.USER, check=False, now=now)  # fmt: skip
    text_ = f"Убрал из прайса: {it.name}"
    action = await record(
        db, user_id=user.id, kind=ActionKind.PRICE_LIST_EDIT, initiated_by=Initiator.USER,
        summary={"ru": text_, "kk": None},
        changes=[{"item_id": None, "key": f"price_item:{it.public_id}", "title": it.name,
                  "kind": "delete", "page_id": None, "text": text_}],
        inverse=out.inverse, now=now, client_id=client_id,
    )  # fmt: skip
    return {"action": await _action_out(db, action), "repeated": False}


@prices_router.delete("/{list_id}")
async def delete_list(list_id: uuid.UUID, user: GatedUser, db: Db,
                      client_id: uuid.UUID | None = None) -> dict[str, Any]:  # fmt: skip
    from assistant.actions import engine

    now = _now()
    await lock_user(db, user.id)
    if (first := await _first(db, user.id, client_id)) is not None:
        return {"action": await _action_out(db, first), "repeated": True}
    pl = await db.scalar(select(PriceList).where(PriceList.public_id == list_id,
                                                 PriceList.user_id == user.id,
                                                 PriceList.deleted_at.is_(None)))
    if pl is None:
        raise ApiError(404, "not_found")
    out = await engine.apply(db, user.id, [{"op": "set_price_list", "id": str(pl.public_id),
                                            "values": {"deleted_at": now.isoformat()}}],
                             by=Initiator.USER, check=False, now=now)  # fmt: skip
    text_ = f"Убрал прайс «{pl.title}»"
    action = await record(
        db, user_id=user.id, kind=ActionKind.PRICE_LIST_EDIT, initiated_by=Initiator.USER,
        summary={"ru": text_, "kk": None},
        changes=[{"item_id": None, "key": f"price_list:{pl.public_id}", "title": pl.title,
                  "kind": "delete", "page_id": None, "text": text_}],
        inverse=out.inverse, now=now, client_id=client_id,
    )  # fmt: skip
    return {"action": await _action_out(db, action), "repeated": False}


__all__ = ["prices_router", "profile_router"]
