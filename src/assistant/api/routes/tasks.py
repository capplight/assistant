"""/v1/tasks: «Дела» and «Покупки» by hand (week 9; F-12, US-10). Contract: docs/api/today.md.

Every change is an action with «Отменить» (initiated_by `user`, R-33); the undo recipe is run by
assistant.actions. The line (`/v1/chat/messages`) adds tasks through the same `tasks.service.add`.
"""

import uuid
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Response
from sqlalchemy import select

from assistant import operations
from assistant.actions import actions_dicts
from assistant.actions.patch import page_patches
from assistant.api.consent_gate import require_base_consent
from assistant.api.deps import CurrentUser, Db
from assistant.api.errors import ApiError
from assistant.api.schemas import (
    ActionOut,
    TaskChangedOut,
    TaskCreatedOut,
    TaskDoneIn,
    TaskIn,
    TaskOut,
    TaskPatchIn,
    TasksClearDoneIn,
    TasksClearedOut,
    TasksOut,
)
from assistant.db.models import Item, User
from assistant.db.models_actions import Action, Initiator
from assistant.db.models_tasks import ListKey, Task, TaskOccurrence
from assistant.operations import tasks as task_ops
from assistant.pages import lock_user
from assistant.tasks import service

router = APIRouter(prefix="/tasks", tags=["tasks"])
GatedUser = Annotated[CurrentUser, Depends(require_base_consent)]


def _now() -> datetime:
    return datetime.now(UTC)


async def _op(name: str, db: Db, user_id: int, args: dict[str, Any], *, now: datetime,
              client_id: uuid.UUID | None = None) -> operations.OpResult:  # fmt: skip
    """The same operation the assistant line runs (assistant.operations, Ф-95)."""
    try:
        return await operations.run(name, db, user_id, args, by=Initiator.USER, now=now,
                                    client_id=client_id)  # fmt: skip
    except operations.OpError as exc:
        raise ApiError(exc.status, exc.code) from exc


async def _task_out(db: Db, task: Task) -> TaskOut:
    return TaskOut.model_validate((await service.tasks_dicts(db, [task]))[0])


async def _action_out(db: Db, action: Action | None, now: datetime) -> ActionOut | None:
    if action is None:
        return None
    return ActionOut.model_validate((await actions_dicts(db, [action], now))[0])


async def _by_client(db: Db, user_id: int, client_id: uuid.UUID | None) -> Action | None:
    if client_id is None:
        return None
    return await db.scalar(select(Action).where(Action.user_id == user_id,
                                                Action.client_id == client_id))  # fmt: skip


async def _user_tz(db: Db, user_id: int) -> str:
    return await db.scalar(select(User.tz).where(User.id == user_id)) or service.DEFAULT_TZ


def _utc(value: datetime | None) -> str | None:
    return value.astimezone(UTC).replace(microsecond=0).isoformat() if value else None


def _occ_out(row: TaskOccurrence | None, task: Task) -> dict[str, Any] | None:
    if row is None:
        return None
    return {"id": row.public_id, "task_id": task.public_id, "occurrence_at": row.occurrence_at,
            "start_at": row.start_at, "duration_min": row.duration_min, "done_at": row.done_at,
            "skipped": row.skipped, "version": row.version, "seq": row.seq,
            "updated_at": row.updated_at}  # fmt: skip


async def _occurrence(db: Db, task: Task, at: datetime | None) -> datetime | None:
    """The occurrence the phone named, checked: a start of the series or a row it already has."""
    try:
        return await task_ops.occurrence(db, task, at)
    except operations.OpError as exc:
        raise ApiError(exc.status, exc.code) from exc


async def _occ_row(db: Db, task: Task, at: datetime | None) -> TaskOccurrence | None:
    return await task_ops.occurrence_row(db, task, at)


async def _own(db: Db, user_id: int, task_id: uuid.UUID) -> Task:
    task = await service.get(db, user_id, task_id)
    if task is None:
        raise ApiError(404, "not_found")
    return task


@router.get("", response_model=TasksOut)
async def list_tasks(user: GatedUser, db: Db, list_key: ListKey | None = None,
                     include_done: bool = False) -> TasksOut:  # fmt: skip
    q = (select(Task).join(Item, Item.id == Task.item_id)
         .where(Task.user_id == user.id, Task.deleted_at.is_(None), Item.deleted_at.is_(None)))
    if list_key is not None:
        q = q.where(Task.list_key == list_key)
    if not include_done:
        q = q.where(Task.done_at.is_(None))
    rows = list(await db.scalars(q.order_by(Task.id.desc()).limit(500)))
    return TasksOut(tasks=[TaskOut.model_validate(d) for d in await service.tasks_dicts(db, rows)])


@router.post("", response_model=TaskCreatedOut, status_code=201)
async def create_task(body: TaskIn, user: GatedUser, db: Db,
                      response: Response) -> TaskCreatedOut:  # fmt: skip
    now = _now()
    await lock_user(db, user.id)
    found = await db.scalar(select(Task).where(Task.user_id == user.id,
                                               Task.client_id == body.client_id))  # fmt: skip
    if found is not None:
        response.status_code = 200
        action = await _by_client(db, user.id, body.client_id)
        return TaskCreatedOut(task=await _task_out(db, found),
                              action=await _action_out(db, action, now), repeated=True)
    args = {"list_key": body.list_key, "title": body.title, "qty": body.qty,
            "where": body.where, "due_date": body.due_date, "start_at": body.start_at,
            "duration_min": body.duration_min, "tz": body.tz or await _user_tz(db, user.id),
            "rrule": body.rrule, "reminder_offset_min": body.reminder_offset_min}
    res = await _op("tasks.create", db, user.id, args, now=now, client_id=body.client_id)
    added = res.data["added"]
    return TaskCreatedOut(task=await _task_out(db, res.data["task"]),
                          action=await _action_out(db, res.action, now),
                          page_patches=await page_patches(db, user.id, added.pages, added.items))


@router.patch("/{task_id}", response_model=TaskChangedOut)
async def patch_task(task_id: uuid.UUID, body: TaskPatchIn, user: GatedUser,
                     db: Db) -> TaskChangedOut:  # fmt: skip
    now = _now()
    await lock_user(db, user.id)
    task = await _own(db, user.id, task_id)
    # Week 12: outbox-safe like «done» — a repeat of the same `client_id` returns the first action
    # (and does not hit the version check: the first call already bumped the version).
    first = await _by_client(db, user.id, body.client_id)
    if first is not None:
        return TaskChangedOut(task=await _task_out(db, task),
                              action=await _action_out(db, first, now), repeated=True)
    if not await service.is_live(db, task):
        raise ApiError(404, "not_found")
    if task.version != body.version:
        raise ApiError(409, "conflict", details={"version": task.version})
    sent = body.model_fields_set - {"version", "client_id"}
    if sent & task_ops.TIME_FIELDS:
        return await _patch_time(db, user.id, task, body, sent, now)
    args = {k: getattr(body, k) for k in sent if k in ("title", "qty", "where", "due_date",
                                                     "list_key")}
    res = await _op("tasks.update", db, user.id, {"task_id": task.public_id, **args}, now=now,
                    client_id=body.client_id)  # fmt: skip
    return TaskChangedOut(task=await _task_out(db, task),
                          action=await _action_out(db, res.action, now))


@router.post("/{task_id}/done", response_model=TaskChangedOut)
async def tick_task(task_id: uuid.UUID, body: TaskDoneIn, user: GatedUser,
                    db: Db) -> TaskChangedOut:  # fmt: skip
    now = _now()
    await lock_user(db, user.id)
    task = await _own(db, user.id, task_id)
    first = await _by_client(db, user.id, body.client_id)
    if first is not None:
        return TaskChangedOut(task=await _task_out(db, task),
                              action=await _action_out(db, first, now), repeated=True)
    if not await service.is_live(db, task):
        raise ApiError(404, "not_found")
    at = await _occurrence(db, task, body.occurrence_at)
    res = await _op("tasks.set_done", db, user.id, {"task_id": task.public_id, "done": body.done,
                                                    "occurrence_at": at},
                    now=now, client_id=body.client_id)  # fmt: skip
    action = res.action
    occ = _occ_out(await _occ_row(db, task, at), task)
    return TaskChangedOut(task=await _task_out(db, task), action=await _action_out(db, action, now),
                          occurrence=occ)  # type: ignore[arg-type]


CLEARED_RU = {"shopping": "Убрал купленное", "todo": "Убрал сделанное"}


@router.post("/clear-done", response_model=TasksClearedOut)
async def clear_done(body: TasksClearDoneIn, user: GatedUser, db: Db) -> TasksClearedOut:
    """«Убрать все купленные» (proposal 2.4): the done tasks of a list and their records go to
    the trash in one action with one «Отменить». `task_ids`: only these (what the phone showed,
    so a line ticked on another phone meanwhile stays)."""
    now = _now()
    await lock_user(db, user.id)
    first = await _by_client(db, user.id, body.client_id)
    if first is not None:
        ids = [int(i) for i in first.source_item_ids or []]
        done = list(await db.scalars(select(Task).where(Task.user_id == user.id,
                                                        Task.item_id.in_(ids))))  # fmt: skip
        return TasksClearedOut(
            tasks=[TaskOut.model_validate(d) for d in await service.tasks_dicts(db, done)],
            action=await _action_out(db, first, now), repeated=True)  # fmt: skip
    built = await operations.build("tasks.clear_done", db, user.id,
                                   {"list_key": body.list_key, "task_ids": body.task_ids},
                                   now=now)  # fmt: skip
    done = built.data["tasks"]
    if not done:
        return TasksClearedOut(tasks=[], action=None)
    out = await _op("tasks.clear_done", db, user.id,
                    {"list_key": body.list_key, "task_ids": [t.public_id for t in done]},
                    now=now, client_id=body.client_id)  # fmt: skip
    action = out.action
    page = await service.list_page(db, user.id, body.list_key)
    pages = out.pages | ({page.id} if page is not None else set())
    return TasksClearedOut(
        tasks=[TaskOut.model_validate(d) for d in await service.tasks_dicts(db, done)],
        action=await _action_out(db, action, now),
        page_patches=await page_patches(db, user.id, pages, out.items))  # fmt: skip


@router.delete("/{task_id}", response_model=TaskChangedOut)
async def delete_task(task_id: uuid.UUID, user: GatedUser, db: Db,
                      client_id: uuid.UUID | None = None, occurrence_at: datetime | None = None,
                      scope: str | None = None) -> TaskChangedOut:  # fmt: skip
    now = _now()
    await lock_user(db, user.id)
    task = await _own(db, user.id, task_id)
    first = await _by_client(db, user.id, client_id)
    if first is not None:
        return TaskChangedOut(task=await _task_out(db, task),
                              action=await _action_out(db, first, now), repeated=True)
    if scope not in (None, "this", "following") or (
            occurrence_at is not None and occurrence_at.tzinfo is None):  # fmt: skip
        raise ApiError(422, "validation_error")
    item_pid = await service.item_public_id(db, task)
    at = await _occurrence(db, task, occurrence_at)
    whole = at is None or (scope == "following" and task.start_at is not None
                           and at <= task.start_at)  # fmt: skip
    if not whole:
        return await _delete_some(db, user.id, task, item_pid, at, scope, client_id, now)
    res = await _op("tasks.delete", db, user.id, {"task_id": task.public_id}, now=now,
                    client_id=client_id)  # fmt: skip
    return TaskChangedOut(task=await _task_out(db, task),
                          action=await _action_out(db, res.action, now))


async def _delete_some(db: Db, user_id: int, task: Task, item_pid: uuid.UUID, at: datetime,
                       scope: str | None, client_id: uuid.UUID | None,
                       now: datetime) -> TaskChangedOut:  # fmt: skip
    """One occurrence skipped («только это»), or the series ended before it («это и следующие»)."""
    res = await _op("tasks.remove_occurrence", db, user_id,
                    {"task_id": task.public_id, "occurrence_at": at, "scope": scope}, now=now,
                    client_id=client_id)  # fmt: skip
    occ = _occ_out(await _occ_row(db, task, at), task)
    return TaskChangedOut(task=await _task_out(db, task),
                          action=await _action_out(db, res.action, now),
                          occurrence=occ)  # type: ignore[arg-type]


async def _patch_time(db: Db, user_id: int, task: Task, body: TaskPatchIn, sent: set[str],
                      now: datetime) -> TaskChangedOut:  # fmt: skip
    """0035: move / resize / repeat of a to-do (calendar.md): `tasks.reschedule`."""
    if sent - task_ops.TIME_FIELDS:
        raise ApiError(422, "validation_error")  # a time change goes alone
    args: dict[str, Any] = {k: getattr(body, k) for k in sent}
    if "tz" in args and not args["tz"]:
        args.pop("tz")
    res = await _op("tasks.reschedule", db, user_id, {"task_id": task.public_id, **args},
                    now=now, client_id=body.client_id)  # fmt: skip
    at = res.data["occurrence_at"]
    occ = _occ_out(await _occ_row(db, task, at), task) if at is not None else None
    previous = res.data["previous"]
    return TaskChangedOut(task=await _task_out(db, res.data["task"]),
                          action=await _action_out(db, res.action, now),
                          occurrence=occ,  # type: ignore[arg-type]
                          previous_task=await _task_out(db, previous) if previous else None)


__all__ = ["router"]
