"""/v1/plans: «Составь план» (step 8, contract: docs/api/plans.md).

Plans are made and changed in the chat (`make_plan`, assistant.chat.plan_line); here the phone
reads them and makes an action plan's steps into tasks («Сделать делами»): one action per step,
one group, «Отменить» = `POST /v1/actions/groups/{group.id}/undo`.
"""

import uuid
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select

from assistant.actions import actions_dicts
from assistant.actions.patch import page_patches
from assistant.api.consent_gate import require_base_consent
from assistant.api.deps import CurrentUser, Db
from assistant.api.errors import ApiError
from assistant.api.schemas import (
    ActionGroupOut,
    ActionOut,
    PlanListOut,
    PlanOut,
    PlanTasksIn,
    PlanTasksOut,
    ReminderOut,
    TaskOut,
)
from assistant.db.models import Item, User
from assistant.db.models_actions import Initiator
from assistant.db.models_tasks import Task
from assistant.db.models_v2 import RecordKind
from assistant.plans import PlanError, make_tasks, plan_dict
from assistant.plans.service import repeat_of

router = APIRouter(prefix="/plans", tags=["plans"])
GatedUser = Annotated[CurrentUser, Depends(require_base_consent)]


async def _plan(db: Db, user: CurrentUser, plan_id: uuid.UUID, *, lock: bool = False) -> Item:
    q = select(Item).where(Item.user_id == user.id, Item.public_id == plan_id,
                           Item.kind == RecordKind.PLAN)  # fmt: skip
    if lock:
        q = q.with_for_update()
    item = await db.scalar(q)
    if item is None:
        raise ApiError(404, "not_found")
    return item


@router.get("", response_model=PlanListOut)
async def list_plans(user: GatedUser, db: Db,
                     limit: Annotated[int, Query(ge=1, le=100)] = 30) -> PlanListOut:  # fmt: skip
    """The person's plans, newest first (trashed ones are left out)."""
    rows = list(await db.scalars(
        select(Item).where(Item.user_id == user.id, Item.kind == RecordKind.PLAN,
                           Item.deleted_at.is_(None))
        .order_by(Item.id.desc()).limit(limit)))  # fmt: skip
    return PlanListOut(plans=[PlanOut.model_validate(await plan_dict(db, i)) for i in rows])


@router.get("/{plan_id}", response_model=PlanOut)
async def get_plan(plan_id: uuid.UUID, user: GatedUser, db: Db) -> PlanOut:
    return PlanOut.model_validate(await plan_dict(db, await _plan(db, user, plan_id)))


@router.post("/{plan_id}/tasks", response_model=PlanTasksOut)
async def plan_to_tasks(plan_id: uuid.UUID, user: GatedUser, db: Db,
                        body: PlanTasksIn | None = None) -> PlanTasksOut:  # fmt: skip
    """«Сделать делами»: no «Да» (an internal change with «Отменить», Ф-65)."""
    from assistant.reminders import service as reminders
    from assistant.tasks import service as tasks_service

    body = body or PlanTasksIn()
    now = datetime.now(UTC)
    item = await _plan(db, user, plan_id, lock=True)
    repeated = await repeat_of(db, user.id, body.client_id)
    if repeated is not None:
        acts, conv_tasks, conv_rems, patches, skipped = repeated, [], [], [], 0
        task_ids = {c.get("task_id") for a in acts for c in (a.payload or {}).get("changes", [])}
        rem_ids = {c.get("reminder_id") for a in acts
                   for c in (a.payload or {}).get("changes", [])}  # fmt: skip
        ids = [uuid.UUID(t) for t in task_ids if t]
        conv_tasks = list(await db.scalars(select(Task).where(Task.public_id.in_(ids)))) \
            if ids else []  # fmt: skip
        from assistant.db.models import Reminder

        rids = [uuid.UUID(r) for r in rem_ids if r]
        conv_rems = list(await db.scalars(select(Reminder).where(Reminder.public_id.in_(rids)))) \
            if rids else []  # fmt: skip
        sentence = "Уже сделано."
    else:
        tz = await db.scalar(select(User.tz).where(User.id == user.id)) or "Asia/Almaty"
        try:
            conv = await make_tasks(db, user.id, item, by=Initiator.AGENT, now=now, tz=tz,
                                    step_ids=body.step_ids, client_id=body.client_id)
        except PlanError as exc:
            raise ApiError(409, exc.code) from exc
        if not conv.actions:
            raise ApiError(409, "plan_already_tasks")
        await db.flush()
        acts, conv_tasks, conv_rems = conv.actions, conv.tasks, conv.reminders
        patches = await page_patches(db, user.id, conv.pages, conv.items)
        skipped, sentence = conv.skipped, conv.sentence
    outs = await actions_dicts(db, acts, now)
    group = outs[0]["group"] if outs else None
    return PlanTasksOut(
        plan=PlanOut.model_validate(await plan_dict(db, item)),
        group=ActionGroupOut.model_validate(group) if group else None,
        actions=[ActionOut.model_validate(d) for d in outs],
        tasks=[TaskOut.model_validate(d) for d in await tasks_service.tasks_dicts(db, conv_tasks)],
        reminders=[ReminderOut.model_validate(d)
                   for d in await reminders.reminders_dicts(db, conv_rems)],
        page_patches=patches, skipped=skipped, repeated=repeated is not None,
        message_ru=sentence,
    )  # fmt: skip
