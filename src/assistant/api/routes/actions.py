"""/v1/actions: «Что я сделал», «Отменить», «Вернуть» (contract: docs/api/actions.md).

The undo runs the action's stored `inverse` in one transaction (assistant.actions); the phone
never computes an undo itself."""

import uuid
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select

from assistant.actions import (
    TEXT_PARTIAL,
    ActionNotFound,
    UndoExpired,
    actions_dicts,
    undo,
)
from assistant.actions.patch import page_patches
from assistant.api.consent_gate import require_base_consent
from assistant.api.deps import CurrentUser, Db
from assistant.api.errors import ApiError
from assistant.api.schemas import ActionOut, ActionsOut, UndoIn, UndoOut
from assistant.db.models_actions import Action

router = APIRouter(prefix="/actions", tags=["actions"])
BaseUser = Annotated[CurrentUser, Depends(require_base_consent)]


async def _own(db: Db, user: CurrentUser, action_id: uuid.UUID) -> Action:
    row = await db.scalar(select(Action).where(Action.user_id == user.id,
                                               Action.public_id == action_id))
    if row is None:
        raise ApiError(404, "not_found")
    return row


@router.get("", response_model=ActionsOut)
async def list_actions(user: BaseUser, db: Db, before: uuid.UUID | None = None,
                       limit: Annotated[int, Query(ge=1, le=100)] = 30) -> ActionsOut:  # fmt: skip
    q = select(Action).where(Action.user_id == user.id)
    if before is not None:
        q = q.where(Action.id < (await _own(db, user, before)).id)
    rows = list(await db.scalars(q.order_by(Action.id.desc()).limit(limit + 1)))
    out = await actions_dicts(db, rows[:limit], datetime.now(UTC))
    return ActionsOut(actions=[ActionOut.model_validate(d) for d in out],
                      has_more=len(rows) > limit)  # fmt: skip


@router.get("/{action_id}", response_model=ActionOut)
async def get_action(action_id: uuid.UUID, user: BaseUser, db: Db) -> ActionOut:
    row = await _own(db, user, action_id)
    return ActionOut.model_validate((await actions_dicts(db, [row], datetime.now(UTC)))[0])


@router.post("/{action_id}/undo", response_model=UndoOut)
async def undo_action(action_id: uuid.UUID, user: BaseUser, db: Db,
                      body: UndoIn | None = None) -> UndoOut:  # fmt: skip
    body = body or UndoIn()
    now = datetime.now(UTC)
    try:
        res = await undo(db, user.id, action_id, now=now, item_ids=body.item_ids,
                         keys=body.keys,
                         client_id=body.client_id)  # fmt: skip
    except ActionNotFound as exc:
        raise ApiError(404, "not_found") from exc
    except UndoExpired as exc:
        raise ApiError(410, "undo_expired") from exc
    await db.flush()
    patches = await page_patches(db, user.id, res.pages, res.items)
    action, made = await actions_dicts(db, [res.action, res.undo], now)
    return UndoOut(action=ActionOut.model_validate(action), undo=ActionOut.model_validate(made),
                   partial=res.partial, repeated=res.repeated,
                   message_ru=TEXT_PARTIAL if res.partial else None,
                   page_patches=patches)  # fmt: skip
