"""/v1/duplicates (repeats: «Объединить?», «Это разные», the cleanup plan «37 → 1») and
/v1/pending-actions (what waits for «Да»). Contract: docs/api/duplicates.md.

Code only: nothing here calls a model. Groups of similar records are found by the background scan
(`python -m assistant.dedup`); merging is always the person's «Да» (one group, or the one «Да» of a
cleanup plan for every exact repeat), with one «Отменить»."""

import uuid
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import select

from assistant.actions import actions_dicts
from assistant.analytics import server_event
from assistant.api.consent_gate import require_base_consent
from assistant.api.deps import CurrentUser, Db
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


@pending_router.post("/{pending_id}/confirm")
async def confirm(pending_id: uuid.UUID, user: BaseUser, db: Db,
                  body: ConfirmIn | None = None) -> dict[str, Any]:  # fmt: skip
    p = await _pending(db, user, pending_id)
    now = _now()
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
