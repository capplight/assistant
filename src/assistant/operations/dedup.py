"""Operation of repeats (Ф-97, chat-full-control.md phase 2): `duplicates.cleanup` — the «Да» on a
cleanup plan («37 → 1», `dedup.plan_cleanup`): every exact repeat merged into its oldest copy, one
`cleanup_batch` action with «Отменить». Bulk: the line always asks «Да» first with the count; the
screen runs the same plan through `POST /v1/pending-actions/{id}/confirm`."""

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.operations.registry import Operation, OpError, OpResult, register


class CleanupRef(BaseModel):
    model_config = ConfigDict(extra="forbid")
    pending_id: uuid.UUID


async def _cleanup(session: AsyncSession, user_id: int, args: CleanupRef, *, by: str,
                   now: datetime, message_pk: int | None = None, **_: Any) -> OpResult:  # fmt: skip
    from assistant.db.models_tasks import PendingAction, PendingStatus
    from assistant.dedup import run_cleanup

    p = await session.scalar(select(PendingAction).where(
        PendingAction.user_id == user_id, PendingAction.public_id == args.pending_id,
        PendingAction.kind == "cleanup_batch").with_for_update())  # fmt: skip
    if p is None:
        raise OpError("not_found", 404)
    if p.status != PendingStatus.PROPOSED or p.expires_at <= now:
        raise OpError("pending_closed", 409)
    action = await run_cleanup(session, user_id, p, now, by=by, message_pk=message_pk)
    p.status, p.decided_at, p.executed_at = PendingStatus.EXECUTED, now, now
    p.action_id = action.id if action else None
    p.result = {"merged": bool(action)}
    await session.flush()
    sentence = (action.summary or {}).get("ru", "") if action is not None else ""
    return OpResult(action=action, actions=[action] if action else [],
                    inverse=list(action.inverse or []) if action else [], sentence=sentence,
                    touched=("records", "pages"))  # fmt: skip


register(Operation("duplicates.cleanup", "records", "bulk", CleanupRef, execute=_cleanup,
                   description="merge every exact repeat into one copy (after «Да»)"))
