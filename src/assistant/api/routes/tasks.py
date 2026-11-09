"""/v1/tasks: «Дела» and «Покупки» by hand (week 9; F-12, US-10). Contract: docs/api/today.md.

Every change is an action with «Отменить» (initiated_by `user`, R-33); the undo recipe is run by
assistant.actions. The line (`/v1/chat/messages`) adds tasks through the same `tasks.service.add`.
"""

import uuid
from datetime import UTC, date, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Response
from sqlalchemy import select

from assistant.actions import actions_dicts, engine, record
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
from assistant.db.models import Item
from assistant.db.models_actions import Action, ActionKind, Initiator
from assistant.db.models_tasks import ListKey, Task
from assistant.pages import lock_user
from assistant.tasks import TaskSpec, service

router = APIRouter(prefix="/tasks", tags=["tasks"])
GatedUser = Annotated[CurrentUser, Depends(require_base_consent)]


def _now() -> datetime:
    return datetime.now(UTC)


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
    try:
        spec = TaskSpec(body.list_key, service.clean_title(body.title), body.qty, body.where,
                        date.fromisoformat(body.due_date) if body.due_date else None)
        added = await service.add(db, user.id, [spec], by=Initiator.USER, now=now,
                                  client_id=body.client_id)  # fmt: skip
    except (service.TaskError, ValueError) as exc:
        raise ApiError(422, "validation_error") from exc
    action = await record(
        db, user_id=user.id, kind=ActionKind.SAVE_ITEM, initiated_by=Initiator.USER,
        summary={"ru": added.sentence, "kk": None}, changes=added.changes,
        inverse=added.inverse, now=now, screen_id=added.page.id if added.page else None,
        source_item_ids=added.item_pks, client_id=body.client_id,
    )  # fmt: skip
    await db.flush()
    return TaskCreatedOut(task=await _task_out(db, added.tasks[0]),
                          action=await _action_out(db, action, now),
                          page_patches=await page_patches(db, user.id, added.pages, added.items))


def _change_row(task: Task, item_id: uuid.UUID, kind: str, text: str,
                page_id: uuid.UUID | None = None) -> dict[str, Any]:  # fmt: skip
    return {"item_id": str(item_id), "task_id": str(task.public_id), "title": task.title,
            "kind": kind, "page_id": str(page_id) if page_id else None, "text": text}


@router.patch("/{task_id}", response_model=TaskChangedOut)
async def patch_task(task_id: uuid.UUID, body: TaskPatchIn, user: GatedUser,
                     db: Db) -> TaskChangedOut:  # fmt: skip
    now = _now()
    await lock_user(db, user.id)
    task = await _own(db, user.id, task_id)
    if not await service.is_live(db, task):
        raise ApiError(404, "not_found")
    if task.version != body.version:
        raise ApiError(409, "conflict", details={"version": task.version})
    sent = body.model_fields_set - {"version"}
    values: dict[str, Any] = {}
    try:
        if "title" in sent:
            values["title"] = service.clean_title(body.title)
        if "qty" in sent:
            values["qty"] = service.clean_short(body.qty)
        if "where" in sent:
            values["where_text"] = service.clean_short(body.where)
        if "due_date" in sent:
            values["due_date"] = date.fromisoformat(body.due_date).isoformat() \
                if body.due_date else None  # fmt: skip
        if "list_key" in sent and body.list_key is not None:
            values["list_key"] = body.list_key
    except (service.TaskError, ValueError) as exc:
        raise ApiError(422, "validation_error") from exc
    item_pid = await service.item_public_id(db, task)
    ops: list[dict[str, Any]] = []
    if values:
        ops.append({"op": "set_task", "id": str(task.public_id), "item": str(item_pid),
                    "values": values})  # fmt: skip
    old_list = task.list_key
    new_list = values.get("list_key", old_list)
    new_page = None
    if new_list != old_list:  # the row moves between «Покупки» and «Дела»
        old_page = await service.list_page(db, user.id, old_list)
        new_page = await service.list_page(db, user.id, new_list)
        if old_page is not None and new_page is not None and new_page.id == old_page.id:
            pass  # «Дела» holds both lists when there is no «Покупки»
        else:
            if new_page is not None:
                ops.append({"op": "add_screen_item", "page": str(new_page.public_id),
                            "item": str(item_pid)})  # fmt: skip
            if old_page is not None:
                ops.append({"op": "remove_screen_item", "page": str(old_page.public_id),
                            "item": str(item_pid), "exclude": True})  # fmt: skip
    out = await engine.apply(db, user.id, ops, by=Initiator.USER, check=False, now=now)
    action = None
    if out.inverse:
        sentence = f"Изменил: {service.lower_first(task.title)}"
        action = await record(
            db, user_id=user.id, kind=ActionKind.FACET_EDIT, initiated_by=Initiator.USER,
            summary={"ru": sentence, "kk": None},
            changes=[_change_row(task, item_pid, "edit", f"«{task.title}» — изменено",
                                 new_page.public_id if new_page else None)],
            inverse=out.inverse, now=now, source_item_ids=[task.item_id],
        )  # fmt: skip
    await db.flush()
    return TaskChangedOut(task=await _task_out(db, task), action=await _action_out(db, action, now))


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
    item_pid = await service.item_public_id(db, task)
    out = await engine.apply(db, user.id, [
        {"op": "set_task", "id": str(task.public_id), "item": str(item_pid),
         "values": {"done_at": now.isoformat() if body.done else None}}],
        by=Initiator.USER, check=False, now=now)  # fmt: skip
    action = None
    if out.inverse:
        sentence = service.done_sentence(task, body.done)
        action = await record(
            db, user_id=user.id, kind=ActionKind.FACET_EDIT, initiated_by=Initiator.USER,
            summary={"ru": sentence, "kk": None},
            changes=[_change_row(task, item_pid, "done", sentence)],
            inverse=out.inverse, now=now, source_item_ids=[task.item_id],
            client_id=body.client_id,
        )  # fmt: skip
    await db.flush()
    return TaskChangedOut(task=await _task_out(db, task), action=await _action_out(db, action, now))


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
    q = (select(Task).join(Item, Item.id == Task.item_id)
         .where(Task.user_id == user.id, Task.list_key == body.list_key,
                Task.done_at.is_not(None), Task.deleted_at.is_(None),
                Item.deleted_at.is_(None)))  # fmt: skip
    if body.task_ids is not None:
        q = q.where(Task.public_id.in_(body.task_ids))
    done = list(await db.scalars(q.order_by(Task.id).limit(500)))
    if not done:
        return TasksClearedOut(tasks=[], action=None)
    pids = {t.id: await service.item_public_id(db, t) for t in done}
    ops = [{"op": "delete_entity_soft", "entity": "tasks", "id": str(t.public_id),
            "item": str(pids[t.id])} for t in done]  # fmt: skip
    out = await engine.apply(db, user.id, ops, by=Initiator.USER, check=False, now=now)
    action = None
    if out.inverse:
        titles = ", ".join(service.lower_first(t.title) for t in done[:5])
        more = f" и ещё {len(done) - 5}" if len(done) > 5 else ""
        sentence = f"{CLEARED_RU.get(body.list_key, 'Убрал')}: {titles}{more}."
        action = await record(
            db, user_id=user.id, kind=ActionKind.DELETE_ITEM, initiated_by=Initiator.USER,
            summary={"ru": sentence, "kk": None},
            changes=[_change_row(t, pids[t.id], "trash", f"«{t.title}» — в корзине")
                     for t in done],
            inverse=out.inverse, now=now, source_item_ids=[t.item_id for t in done],
            client_id=body.client_id,
        )  # fmt: skip
    await db.flush()
    page = await service.list_page(db, user.id, body.list_key)
    pages = out.pages | ({page.id} if page is not None else set())
    return TasksClearedOut(
        tasks=[TaskOut.model_validate(d) for d in await service.tasks_dicts(db, done)],
        action=await _action_out(db, action, now),
        page_patches=await page_patches(db, user.id, pages, out.items))  # fmt: skip


@router.delete("/{task_id}", response_model=TaskChangedOut)
async def delete_task(task_id: uuid.UUID, user: GatedUser, db: Db,
                      client_id: uuid.UUID | None = None) -> TaskChangedOut:  # fmt: skip
    now = _now()
    await lock_user(db, user.id)
    task = await _own(db, user.id, task_id)
    first = await _by_client(db, user.id, client_id)
    if first is not None:
        return TaskChangedOut(task=await _task_out(db, task),
                              action=await _action_out(db, first, now), repeated=True)
    item_pid = await service.item_public_id(db, task)
    out = await engine.apply(db, user.id, [
        {"op": "delete_entity_soft", "entity": "tasks", "id": str(task.public_id),
         "item": str(item_pid)}], by=Initiator.USER, check=False, now=now)  # fmt: skip
    action = None
    if out.inverse:
        sentence = f"Убрал в корзину: {service.lower_first(task.title)}"
        action = await record(
            db, user_id=user.id, kind=ActionKind.DELETE_ITEM, initiated_by=Initiator.USER,
            summary={"ru": sentence, "kk": None},
            changes=[_change_row(task, item_pid, "trash", f"«{task.title}» — в корзине")],
            inverse=out.inverse, now=now, source_item_ids=[task.item_id], client_id=client_id,
        )  # fmt: skip
    await db.flush()
    return TaskChangedOut(task=await _task_out(db, task), action=await _action_out(db, action, now))


__all__ = ["router"]
