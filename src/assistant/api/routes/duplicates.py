"""/v1/duplicates (repeats: «Объединить?», «Это разные», the cleanup plan «37 → 1») and
/v1/pending-actions (what waits for «Да»). Contract: docs/api/duplicates.md.

Code only: nothing here calls a model. Groups of similar records are found by the background scan
(`python -m assistant.dedup`); merging is always the person's «Да» (one group, or the one «Да» of a
cleanup plan for every exact repeat), with one «Отменить».

Week 15: sending a КП or a draft (`send_whatsapp_file`, `send_email`, `share_file`,
`send_whatsapp_text`): «Да» (`confirm`) returns `execute`, what the phone opens (share sheet,
mail, `wa.me`); the server sends nothing. `result` takes «Отправили?» (docs/api/kp.md)."""

import uuid
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import select

from assistant.actions import actions_dicts
from assistant.analytics import server_event
from assistant.api.consent_gate import require_base_consent
from assistant.api.deps import Ctx, CurrentUser, Db
from assistant.api.errors import ApiError
from assistant.db.models_actions import Action
from assistant.db.models_dedup import DupKind, DuplicateGroup, DupOrigin, DupStatus
from assistant.db.models_tasks import PendingAction, PendingStatus
from assistant.dedup import (
    DedupError,
    dismiss_group,
    get_group,
    groups_dicts,
    merge_group,
    merge_groups,
    plan_cleanup,
    run_cleanup,
    schedule_scan,
)

router = APIRouter(prefix="/duplicates", tags=["duplicates"])
pending_router = APIRouter(prefix="/pending-actions", tags=["duplicates"])
BaseUser = Annotated[CurrentUser, Depends(require_base_consent)]
STATUSES = {str(s) for s in DupStatus}


class MergeIn(BaseModel):
    keep_item_id: uuid.UUID | None = None
    client_id: uuid.UUID | None = None


class Pick(BaseModel):
    id: uuid.UUID
    keep_item_id: uuid.UUID | None = None


class MergeManyIn(BaseModel):
    groups: list[Pick] = Field(min_length=1, max_length=100)
    client_id: uuid.UUID | None = None


class DismissIn(BaseModel):
    client_id: uuid.UUID | None = None


class PlanIn(BaseModel):
    client_id: uuid.UUID | None = None


class ConfirmIn(BaseModel):
    client_id: uuid.UUID | None = None


def _now() -> datetime:
    return datetime.now(UTC)


def _err(e: DedupError) -> ApiError:
    return ApiError(e.status, e.code)


async def _action_out(db: Db, action: Action | None) -> dict[str, Any] | None:
    if action is None:
        return None
    return (await actions_dicts(db, [action], _now()))[0]


@router.get("/groups")
async def list_groups(
    user: BaseUser, db: Db, status: str = "suggested", kind: str | None = None,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> dict[str, Any]:  # fmt: skip
    if status not in STATUSES or kind not in (None, "near", "exact"):
        raise ApiError(422, "validation_error")
    q = select(DuplicateGroup).where(DuplicateGroup.user_id == user.id,
                                     DuplicateGroup.status == status)
    if kind:
        q = q.where(DuplicateGroup.kind == kind)
    rows = list(await db.scalars(q.order_by(DuplicateGroup.member_count.desc(),
                                            DuplicateGroup.id.desc()).limit(limit)))
    return {"groups": await groups_dicts(db, rows)}


@router.get("/groups/{group_id}")
async def one_group(group_id: uuid.UUID, user: BaseUser, db: Db) -> dict[str, Any]:
    try:
        g = await get_group(db, user.id, group_id)
    except DedupError as e:
        raise _err(e) from e
    return {"group": (await groups_dicts(db, [g]))[0]}


@router.post("/groups/{group_id}/merge")
async def merge(group_id: uuid.UUID, user: BaseUser, db: Db,
                body: MergeIn | None = None) -> dict[str, Any]:  # fmt: skip
    body = body or MergeIn()
    try:
        g, action, repeated = await merge_group(db, user.id, group_id, now=_now(),
                                                keep_id=body.keep_item_id,
                                                client_id=body.client_id)  # fmt: skip
    except DedupError as e:
        if e.code == "group_stale":
            await db.commit()  # the group is closed: nothing left to merge
        raise _err(e) from e
    await db.flush()
    if not repeated:
        await server_event(db, user.id, "duplicate_decided", {"decision": "merge"})
    return {"group": (await groups_dicts(db, [g]))[0], "action": await _action_out(db, action),
            "repeated": repeated}  # fmt: skip


@router.post("/groups/{group_id}/dismiss")
async def dismiss(group_id: uuid.UUID, user: BaseUser, db: Db,
                  body: DismissIn | None = None) -> dict[str, Any]:  # fmt: skip
    body = body or DismissIn()
    try:
        g, action, repeated = await dismiss_group(db, user.id, group_id, now=_now(),
                                                  client_id=body.client_id)  # fmt: skip
    except DedupError as e:
        raise _err(e) from e
    await db.flush()
    if not repeated:
        await server_event(db, user.id, "duplicate_decided", {"decision": "keep"})
    return {"group": (await groups_dicts(db, [g]))[0], "action": await _action_out(db, action),
            "repeated": repeated}  # fmt: skip


@router.post("/merge")
async def merge_many(body: MergeManyIn, user: BaseUser, db: Db) -> dict[str, Any]:
    """«Объединить все отмеченные (N)»: one action, one «Отменить» for all of them."""
    ids = [p.id for p in body.groups]
    if len(set(ids)) != len(ids):
        raise ApiError(422, "validation_error")
    try:
        groups, action, repeated, skipped = await merge_groups(
            db, user.id, [(p.id, p.keep_item_id) for p in body.groups], now=_now(),
            client_id=body.client_id)  # fmt: skip
    except DedupError as e:
        raise _err(e) from e
    await db.flush()
    if not repeated and action is not None:
        await server_event(db, user.id, "duplicate_decided", {"decision": "merge"})
    return {"groups": await groups_dicts(db, groups), "action": await _action_out(db, action),
            "skipped_group_ids": skipped, "repeated": repeated}  # fmt: skip


def pending_out(p: PendingAction | None) -> dict[str, Any] | None:
    if p is None:
        return None
    return {"id": str(p.public_id), "kind": p.kind, "status": p.status, "preview": p.preview,
            "expires_at": p.expires_at.isoformat(), "message_id": None, "action_id": None,
            "seq": p.seq, "created_at": p.created_at.isoformat(),
            "decided_at": p.decided_at.isoformat() if p.decided_at else None}  # fmt: skip


@router.post("/cleanup/plan")
async def cleanup_plan(user: BaseUser, db: Db, body: PlanIn | None = None) -> dict[str, Any]:
    body = body or PlanIn()
    pending, near = await plan_cleanup(db, user.id, now=_now(), client_id=body.client_id)
    await schedule_scan(db, user.id, origin=DupOrigin.CLEANUP, delay_s=0)
    await db.flush()
    exact = None
    if pending is not None:
        exact = {k: pending.preview.get(k) for k in ("copies", "records_before", "records_after",
                                                     "groups")}
        await server_event(db, user.id, "cleanup_offered",
                           {"groups": exact["groups"], "items_before": exact["records_before"],
                            "items_after": exact["records_after"]})  # fmt: skip
    groups = list(await db.scalars(select(DuplicateGroup).where(
        DuplicateGroup.user_id == user.id, DuplicateGroup.kind == DupKind.EXACT,
        DuplicateGroup.status == DupStatus.SUGGESTED).order_by(DuplicateGroup.member_count.desc())
        .limit(20)))  # fmt: skip
    return {"pending_action": pending_out(pending), "exact": exact,
            "exact_groups": await groups_dicts(db, groups),
            "near_groups": await groups_dicts(db, near[:50]), "near_total": len(near)}  # fmt: skip


# --- pending «Да» ---


async def _pending(db: Db, user: CurrentUser, pid: uuid.UUID) -> PendingAction:
    p = await db.scalar(select(PendingAction).where(PendingAction.user_id == user.id,
                                                    PendingAction.public_id == pid)
                        .with_for_update())  # fmt: skip
    if p is None:
        raise ApiError(404, "not_found")
    return p


@pending_router.get("")
async def list_pending(user: BaseUser, db: Db) -> dict[str, Any]:
    rows = list(await db.scalars(select(PendingAction).where(
        PendingAction.user_id == user.id, PendingAction.status == PendingStatus.PROPOSED,
        PendingAction.expires_at > _now()).order_by(PendingAction.id.desc())))  # fmt: skip
    return {"pending_actions": [pending_out(p) for p in rows]}


SEND_KINDS = frozenset({"send_whatsapp_file", "send_email", "share_file", "send_whatsapp_text"})


def _send_confirm(p: PendingAction, now: datetime) -> dict[str, Any]:
    """«Открыть WhatsApp / почту»: confirmed; the phone gets what to open (nothing is sent)."""
    from assistant.kp import send

    if p.status == PendingStatus.CONFIRMED:
        return {"pending_action": pending_out(p), "action": None,
                "execute": send.execute_params(p), "repeated": True}  # fmt: skip
    if p.status != PendingStatus.PROPOSED:
        raise ApiError(409, "pending_closed")
    if p.expires_at <= now:
        raise ApiError(410, "pending_expired")
    p.status, p.decided_at = PendingStatus.CONFIRMED, now
    return {"pending_action": pending_out(p), "action": None, "execute": send.execute_params(p),
            "repeated": False}  # fmt: skip


@pending_router.post("/{pending_id}/confirm")
async def confirm(pending_id: uuid.UUID, user: BaseUser, db: Db,
                  body: ConfirmIn | None = None) -> dict[str, Any]:  # fmt: skip
    p = await _pending(db, user, pending_id)
    now = _now()
    if p.kind in SEND_KINDS and p.status != PendingStatus.EXECUTED:
        if p.status == PendingStatus.PROPOSED and p.expires_at <= now:
            p.status, p.decided_at = PendingStatus.EXPIRED, now
            await db.commit()
            raise ApiError(410, "pending_expired")
        out = _send_confirm(p, now)
        await db.flush()
        return out
    if p.status == PendingStatus.EXECUTED:  # a repeat of the same «Да»
        a = await db.get(Action, p.action_id) if p.action_id else None
        return {"pending_action": pending_out(p), "action": await _action_out(db, a),
                "repeated": True}  # fmt: skip
    if p.status != PendingStatus.PROPOSED:
        raise ApiError(409, "pending_closed")
    if p.expires_at <= now:
        p.status, p.decided_at = PendingStatus.EXPIRED, now
        await db.commit()
        raise ApiError(410, "pending_expired")
    if p.kind == "import_statement":  # week 13: a bank statement plan (expenses.md)
        from assistant.api.routes.expense_docs import confirm_statement
        from assistant.db.models_expenses import StatementImport

        st = await db.scalar(select(StatementImport).where(
            StatementImport.user_id == user.id,
            StatementImport.pending_action_id == p.id).with_for_update())  # fmt: skip
        if st is None:
            raise ApiError(404, "not_found")
        out = await confirm_statement(db, user.id, st, now)
        return {"pending_action": out["pending_action"], "action": out["action"],
                "repeated": out["repeated"]}  # fmt: skip
    if p.kind != "cleanup_batch":
        raise ApiError(422, "pending_kind_unknown")
    action = await run_cleanup(db, user.id, p, now)
    p.status, p.decided_at, p.executed_at = PendingStatus.EXECUTED, now, now
    p.action_id = action.id if action else None
    p.result = {"merged": bool(action)}
    await db.flush()
    if action is not None:
        prev = p.preview or {}
        await server_event(db, user.id, "cleanup_done",
                           {"groups": prev.get("groups"),
                            "items_before": prev.get("records_before"),
                            "items_after": prev.get("records_after")})  # fmt: skip
    return {"pending_action": pending_out(p), "action": await _action_out(db, action),
            "repeated": False}  # fmt: skip


@pending_router.post("/{pending_id}/reject")
async def reject(pending_id: uuid.UUID, user: BaseUser, db: Db) -> dict[str, Any]:
    p = await _pending(db, user, pending_id)
    if p.status == PendingStatus.PROPOSED and p.kind == "import_statement":
        from assistant.db.models_expenses import StatementImport
        from assistant.expenses import imports as statement_imports

        st = await db.scalar(select(StatementImport).where(
            StatementImport.user_id == user.id, StatementImport.pending_action_id == p.id))
        if st is not None:
            await statement_imports.reject(db, st, _now())  # rows cleared, nothing saved
    if p.status == PendingStatus.PROPOSED:
        p.status, p.decided_at = PendingStatus.REJECTED, _now()
        await db.flush()
    elif p.status != PendingStatus.REJECTED:
        raise ApiError(409, "pending_closed")
    return {"pending_action": pending_out(p)}


class ResultIn(BaseModel):
    outcome: Literal["sent", "not_sent", "cancelled"]
    channel: Literal["whatsapp_share", "whatsapp_text", "email", "share_other"] | None = None
    client_id: uuid.UUID | None = None


DEFAULT_CHANNEL = {"send_whatsapp_file": "whatsapp_share", "send_email": "email",
                   "share_file": "share_other", "send_whatsapp_text": "whatsapp_text"}


@pending_router.post("/{pending_id}/result")
async def result(pending_id: uuid.UUID, body: ResultIn, user: BaseUser, db: Db,
                 ctx: Ctx) -> dict[str, Any]:  # fmt: skip
    """After the phone comes back: «Отправили?» [Да] (`sent`) / [Нет] (`not_sent`), or the share
    sheet was closed (`cancelled`). Only for sending (a КП or a draft)."""
    from assistant.pages import lock_user

    now = _now()
    await lock_user(db, user.id)
    p = await _pending(db, user, pending_id)
    if p.kind not in SEND_KINDS:
        raise ApiError(422, "pending_kind_unknown")
    if body.outcome != "sent":
        if p.status in (PendingStatus.PROPOSED, PendingStatus.CONFIRMED):
            p.status, p.decided_at = PendingStatus.CANCELLED_BY_USER, p.decided_at or now
            p.result = {"sent": False, "outcome": body.outcome}
            await db.flush()
        return {"pending_action": pending_out(p), "action": None}
    if p.status == PendingStatus.EXECUTED:
        a = await db.get(Action, p.action_id) if p.action_id else None
        return {"pending_action": pending_out(p), "action": await _action_out(db, a),
                "repeated": True}  # fmt: skip
    if p.status in (PendingStatus.REJECTED, PendingStatus.FAILED):
        raise ApiError(409, "pending_closed")
    payload = p.payload or {}
    if payload.get("draft_id"):
        from assistant.api.routes.drafts import mark_draft_sent
        from assistant.db.models_kp import Draft
        from assistant.kp import send

        d = await db.scalar(select(Draft).where(
            Draft.user_id == user.id, Draft.public_id == uuid.UUID(payload["draft_id"]))
            .with_for_update())  # fmt: skip
        if d is None:
            raise ApiError(404, "not_found")
        action = await mark_draft_sent(db, user.id, d, p, now)
        return {"pending_action": pending_out(p), "action": await _action_out(db, action),
                "draft": (await send.draft_dicts(db, [d]))[0], "repeated": False}  # fmt: skip
    from assistant.api.routes.documents import mark_version_sent
    from assistant.db.models_kp import Document
    from assistant.kp import service

    doc = await db.scalar(select(Document).where(
        Document.user_id == user.id, Document.public_id == uuid.UUID(payload["document_id"]))
        .with_for_update())  # fmt: skip
    if doc is None:
        raise ApiError(404, "not_found")
    pk = p.id
    doc, action = await mark_version_sent(
        db, ctx, user, doc, int(payload["version_n"]),
        channel=body.channel or DEFAULT_CHANNEL[p.kind], pending=p, client_id=body.client_id,
        now=now)  # fmt: skip
    p = await db.get(PendingAction, pk)  # type: ignore[assignment]
    return {"pending_action": pending_out(p), "action": await _action_out(db, action),
            "document": (await service.rows_dicts(db, [doc]))[0], "repeated": False}
