"""/v1/drafts: messages and letters the assistant writes and the person sends (F-15, US-13, S25;
spec 4.7, 6.8). Contract: docs/api/kp.md «Drafts».

DRAFT (light model, answers budget, consent gate, masking) writes the text; the server never
sends it. Each open draft has a pending «Да» whose preview is what the person sees; «Изменить»
replaces it (the confirmation is bound to the preview). «Открыть WhatsApp / почту» =
`/v1/pending-actions/{id}/confirm` → the phone opens `wa.me` / its mail composer; «Отправили? —
Да» = `/v1/pending-actions/{id}/result {outcome: "sent"}` → `send_external` without «Отменить».
"""

import uuid
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy import select

from assistant.actions import actions_dicts, record
from assistant.ai import AIConsentRequired, AIError
from assistant.api.consent_gate import AI_CONSENTS, missing_consents, require_base_consent
from assistant.api.deps import Ctx, CurrentUser, Db, get_active_consent_kinds
from assistant.api.errors import ApiError
from assistant.db.models_actions import Action, ActionKind, Initiator
from assistant.db.models_kp import Document, Draft, DraftStatus
from assistant.db.models_tasks import PendingAction, PendingStatus
from assistant.kp import send, service
from assistant.pages import lock_user

router = APIRouter(prefix="/drafts", tags=["kp"])
GatedUser = Annotated[CurrentUser, Depends(require_base_consent)]
Kinds = Annotated[frozenset[str], Depends(get_active_consent_kinds)]


def _now() -> datetime:
    return datetime.now(UTC)


class DraftIn(BaseModel):
    client_id: uuid.UUID
    request: str = Field(min_length=1, max_length=1000)  # «напиши Арману, что КП будет в пятницу»
    channel: Literal["whatsapp", "email"] = "whatsapp"
    recipient_name: str | None = Field(default=None, max_length=120)
    document_id: uuid.UUID | None = None


class DraftPatchIn(BaseModel):
    text: str | None = Field(default=None, min_length=1, max_length=4000)
    subject: str | None = Field(default=None, max_length=200)
    recipient_name: str | None = Field(default=None, max_length=120)
    channel: Literal["whatsapp", "email"] | None = None


async def _out(db: Db, d: Draft) -> dict[str, Any]:
    from assistant.api.routes.duplicates import pending_out

    p = await db.get(PendingAction, d.pending_action_id) if d.pending_action_id else None
    return {"draft": (await send.draft_dicts(db, [d]))[0], "pending_action": pending_out(p)}


async def _get(db: Db, user_id: int, draft_id: uuid.UUID) -> Draft:
    d = await db.scalar(select(Draft).where(Draft.user_id == user_id,
                                            Draft.public_id == draft_id).with_for_update())
    if d is None or d.deleted_at is not None:
        raise ApiError(404, "not_found")
    return d


async def _new_pending(db: Db, d: Draft, now: datetime) -> None:
    await send.close_pending(db, d.pending_action_id, PendingStatus.REJECTED, now)
    p = send.new_pending(d.user_id, send.DRAFT_KINDS[d.channel], send.draft_preview(d),
                         {"draft_id": str(d.public_id)}, now=now)  # fmt: skip
    db.add(p)
    await db.flush()
    d.pending_action_id = p.id


@router.post("", status_code=201)
async def create_draft(body: DraftIn, user: GatedUser, db: Db, ctx: Ctx, kinds: Kinds,
                       response: Response) -> dict[str, Any]:  # fmt: skip
    now = _now()
    await lock_user(db, user.id)
    first = await db.scalar(select(Draft).where(Draft.user_id == user.id,
                                                Draft.client_id == body.client_id))
    labels = {"ai_generated": ctx.settings.label_ai_generated}
    if first is not None:
        response.status_code = 200
        return {**await _out(db, first), "labels": labels, "repeated": True}
    missing = missing_consents(kinds, AI_CONSENTS)
    if missing or ctx.ai_router is None:
        raise ApiError(403, "consent_required", details={"missing": missing or
                                                         ["ai_cross_border"]})
    doc = None
    facts = ""
    if body.document_id is not None:
        doc = await db.scalar(select(Document).where(Document.user_id == user.id,
                                                     Document.public_id == body.document_id))
        if doc is None or doc.deleted_at is not None:
            raise ApiError(404, "not_found")
        v = await service.version(db, doc) if doc.current_version_n else None
        facts = send.draft_facts(doc, v.data if v else None, v.totals if v else None)
    doc_pk = doc.id if doc is not None else None
    request = " ".join(body.request.split())
    await db.commit()  # no transaction stays open across the model call
    try:
        reply, _cost = await send.write_draft(ctx.ai_router, user.id, request, body.channel,
                                              facts)  # fmt: skip
    except AIConsentRequired as exc:
        raise ApiError(403, "consent_required", details={"missing": ["ai_cross_border"]}) from exc
    except AIError as exc:
        raise ApiError(503, "draft_unavailable") from exc
    checked = send.check_draft(reply, request, facts)
    if checked is None:
        raise ApiError(422, "draft_empty")
    await lock_user(db, user.id)
    first = await db.scalar(select(Draft).where(Draft.user_id == user.id,
                                                Draft.client_id == body.client_id))
    if first is not None:  # the same request finished in parallel
        response.status_code = 200
        return {**await _out(db, first), "labels": labels, "repeated": True}
    d = Draft(user_id=user.id, client_id=body.client_id, document_id=doc_pk,
              channel=body.channel,
              recipient_name=(body.recipient_name or "").strip() or checked["recipient_name"],
              subject=checked["subject"] if body.channel == "email" else None,
              text=checked["text"], request_text=request,
              review_fields=checked["review_fields"], ai_generated=True)  # fmt: skip
    db.add(d)
    await db.flush()
    await _new_pending(db, d, now)
    await db.flush()
    return {**await _out(db, d), "labels": labels, "repeated": False}


@router.get("")
async def list_drafts(user: GatedUser, db: Db,
                      status: Literal["draft", "sent", "discarded"] | None = "draft",
                      limit: Annotated[int, Query(ge=1, le=200)] = 50,
                      ) -> dict[str, Any]:  # fmt: skip
    q = select(Draft).where(Draft.user_id == user.id, Draft.deleted_at.is_(None))
    if status is not None:
        q = q.where(Draft.status == status)
    rows = list(await db.scalars(q.order_by(Draft.id.desc()).limit(limit)))
    return {"drafts": await send.draft_dicts(db, rows)}


@router.patch("/{draft_id}")
async def edit_draft(draft_id: uuid.UUID, body: DraftPatchIn, user: GatedUser,
                     db: Db) -> dict[str, Any]:  # fmt: skip
    """«Изменить»: the person's own text; the open «Да» is replaced by one with the new preview."""
    now = _now()
    await lock_user(db, user.id)
    d = await _get(db, user.id, draft_id)
    if d.status != DraftStatus.DRAFT:
        raise ApiError(409, "draft_closed")
    changed = False
    for name in ("text", "subject", "recipient_name", "channel"):
        value = getattr(body, name)
        if value is not None:
            value = value.strip() or None if name != "channel" else value
            if name == "text" and not value:
                raise ApiError(422, "draft_empty")
            if getattr(d, name) != value:
                setattr(d, name, value)
                changed = True
                if name == "text":
                    d.review_fields = []
    if d.channel != "email":
        d.subject = None
    if changed:
        d.version += 1
        d.updated_at = now
        await _new_pending(db, d, now)
    await db.flush()
    return await _out(db, d)


@router.delete("/{draft_id}")
async def discard_draft(draft_id: uuid.UUID, user: GatedUser, db: Db) -> dict[str, Any]:
    """«Не надо»."""
    now = _now()
    await lock_user(db, user.id)
    d = await _get(db, user.id, draft_id)
    if d.status == DraftStatus.DRAFT:
        d.status = DraftStatus.DISCARDED
        d.version += 1
        d.updated_at = now
        await send.close_pending(db, d.pending_action_id, PendingStatus.REJECTED, now)
    await db.flush()
    return {"draft": (await send.draft_dicts(db, [d]))[0]}


async def mark_draft_sent(db: Db, user_id: int, d: Draft, p: PendingAction,
                          now: datetime) -> Action | None:  # fmt: skip
    """«Отправили? — Да» for a draft (called by /v1/pending-actions/{id}/result)."""
    action = None
    if d.status == DraftStatus.DRAFT:
        d.status, d.sent_at = DraftStatus.SENT, now
        d.version += 1
        d.updated_at = now
        how = "по почте" if d.channel == "email" else "в WhatsApp"
        who = f" — {d.recipient_name}" if d.recipient_name else ""
        text = f"Отправил сообщение {how}{who}"
        action = await record(
            db, user_id=user_id, kind=ActionKind.SEND_EXTERNAL, initiated_by=Initiator.USER,
            summary={"ru": text, "kk": None},
            changes=[{"item_id": None, "draft_id": str(d.public_id), "title": text,
                      "kind": "sent", "page_id": None, "text": text}],
            inverse=[], now=now,
        )  # fmt: skip
        action.scope = "external"
    p.status, p.executed_at = PendingStatus.EXECUTED, now
    p.decided_at = p.decided_at or now
    p.result = {"sent": True}
    p.action_id = action.id if action is not None else p.action_id
    await db.flush()
    return action


async def action_out(db: Db, action: Action | None) -> dict[str, Any] | None:
    return (await actions_dicts(db, [action], _now()))[0] if action is not None else None


__all__ = ["action_out", "mark_draft_sent", "router"]
