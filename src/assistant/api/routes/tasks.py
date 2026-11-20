"""/v1/tasks: «Дела» and «Покупки» by hand (week 9; F-12, US-10). Contract: docs/api/today.md.

Every change is an action with «Отменить» (initiated_by `user`, R-33); the undo recipe is run by
assistant.actions. The line (`/v1/chat/messages`) adds tasks through the same `tasks.service.add`.
"""

import uuid
from datetime import UTC, date, datetime, timedelta
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Response
from sqlalchemy import select

from assistant import operations
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
from assistant.db.models import Item, User
from assistant.db.models_actions import Action, ActionKind, Initiator
from assistant.db.models_tasks import ListKey, Task, TaskOccurrence
from assistant.pages import lock_user
from assistant.tasks import TaskSpec, service
from assistant.tasks import calendar as cal

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
    if at is None:
        return None
    if not task.rrule:
        raise ApiError(422, "validation_error")
    at = at.astimezone(UTC).replace(microsecond=0)
    own = await db.scalar(select(TaskOccurrence.id).where(TaskOccurrence.task_id == task.id,
                                                          TaskOccurrence.occurrence_at == at))
    if own is None:
        try:
            cal.check_occurrence(task, at)
        except (service.TaskError, ValueError) as exc:
            raise ApiError(422, "validation_error") from exc
    return at


async def _occ_row(db: Db, task: Task, at: datetime | None) -> TaskOccurrence | None:
    if at is None:
        return None
    return await db.scalar(select(TaskOccurrence).where(TaskOccurrence.task_id == task.id,
                                                        TaskOccurrence.occurrence_at == at))


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
        if body.rrule and body.start_at is None:
            raise service.TaskError("validation_error")
        spec = TaskSpec(body.list_key, service.clean_title(body.title), body.qty, body.where,
                        date.fromisoformat(body.due_date) if body.due_date else None,
                        start_at=body.start_at, duration_min=body.duration_min,
                        tz=body.tz or await _user_tz(db, user.id), rrule=body.rrule)
        added = await service.add(db, user.id, [spec], by=Initiator.USER, now=now,
                                  client_id=body.client_id, dedupe=body.start_at is None)
    except (service.TaskError, ValueError) as exc:
        raise ApiError(422, "validation_error") from exc
    inverse = list(added.inverse)
    made = added.tasks[0]
    if body.reminder_offset_min is not None and made.start_at is not None:
        _, undo_alert = await cal.alert_ops(db, user.id, made, start=made.start_at,
                                            rrule=made.rrule, offset=body.reminder_offset_min,
                                            now=now)  # fmt: skip
        inverse = [*undo_alert, *inverse]
    action = await record(
        db, user_id=user.id, kind=ActionKind.SAVE_ITEM, initiated_by=Initiator.USER,
        summary={"ru": added.sentence, "kk": None}, changes=added.changes,
        inverse=inverse, now=now, screen_id=added.page.id if added.page else None,
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
    if sent & {"start_at", "duration_min", "tz", "rrule", "occurrence_at", "scope",
               "reminder_offset_min"}:
        return await _patch_time(db, user.id, task, body, sent, now)
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
            client_id=body.client_id,
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
    if scope == "following":
        ops: list[dict[str, Any]] = [{"op": "set_task", "id": str(task.public_id),
                                      "item": str(item_pid),
                                      "values": {"rrule": cal.with_until(task.rrule or "", at)}}]
        ops += await _alert_ends(db, user_id, task, at, now)
        sentence = f"Больше не повторяю: {service.lower_first(task.title)}"
    else:
        ops = [{"op": "set_occurrence", "task": str(task.public_id), "item": str(item_pid),
                "occurrence_at": at.isoformat(), "values": {"skipped": True}}]
        sentence = f"Убрал один раз: {service.lower_first(task.title)}"
    out = await engine.apply(db, user_id, ops, by=Initiator.USER, check=False, now=now)
    action = None
    if out.inverse:
        action = await record(
            db, user_id=user_id, kind=ActionKind.FACET_EDIT, initiated_by=Initiator.USER,
            summary={"ru": sentence, "kk": None},
            changes=[_change_row(task, item_pid, "edit", sentence)], inverse=out.inverse,
            now=now, source_item_ids=[task.item_id], client_id=client_id)  # fmt: skip
    await db.flush()
    occ = _occ_out(await _occ_row(db, task, at), task)
    return TaskChangedOut(task=await _task_out(db, task),
                          action=await _action_out(db, action, now),
                          occurrence=occ)  # type: ignore[arg-type]


async def _patch_time(db: Db, user_id: int, task: Task, body: TaskPatchIn, sent: set[str],
                      now: datetime) -> TaskChangedOut:  # fmt: skip
    """0035: move / resize / repeat of a to-do (calendar.md). One action with «Отменить»."""
    scope = body.scope or ("this" if body.occurrence_at is not None else "all")
    at = await _occurrence(db, task, body.occurrence_at)
    if scope != "all" and at is None:
        raise ApiError(422, "validation_error")
    item_pid = await service.item_public_id(db, task)
    tz = (body.tz if "tz" in sent and body.tz else None) or task.tz or await _user_tz(db, user_id)
    try:
        rule = cal.check_rrule(body.rrule) if "rrule" in sent else task.rrule
    except (service.TaskError, ValueError) as exc:
        raise ApiError(422, "validation_error") from exc
    other = sent - {"start_at", "duration_min", "tz", "rrule", "occurrence_at", "scope",
                    "reminder_offset_min"}
    alert = await cal.linked_reminder(db, user_id, task)
    offset = (body.reminder_offset_min if "reminder_offset_min" in sent
              else cal.offset_of(task.start_at, alert))  # fmt: skip
    if other:
        raise ApiError(422, "validation_error")  # a time change goes alone
    ops: list[dict[str, Any]] = []
    extra_inverse: list[dict[str, Any]] = []
    new_task: Task | None = None
    previous: Task | None = None
    old_start = task.start_at
    new_start = body.start_at.astimezone(UTC).replace(microsecond=0) if body.start_at else None
    if at is not None and scope == "following" and task.start_at is not None \
            and at <= task.start_at:  # fmt: skip
        scope, at = "all", None  # from the first one on = the whole series
    if scope == "this":
        assert at is not None
        if "rrule" in sent or "tz" in sent or "reminder_offset_min" in sent or (
                "start_at" in sent and new_start is None):  # fmt: skip
            raise ApiError(422, "validation_error")  # one occurrence: only its time
        values: dict[str, Any] = {}
        if "start_at" in sent:
            values["start_at"] = _utc(new_start)
        if "duration_min" in sent:
            values["duration_min"] = body.duration_min
        if values:
            ops.append({"op": "set_occurrence", "task": str(task.public_id),
                        "item": str(item_pid), "occurrence_at": at.isoformat(),
                        "values": values})  # fmt: skip
        sentence = (cal.moved_sentence(task, at, new_start) if new_start
                    else f"Изменил: {service.lower_first(task.title)}")  # fmt: skip
    elif scope == "following":
        assert at is not None and task.rrule is not None
        ops.append({"op": "set_task", "id": str(task.public_id), "item": str(item_pid),
                    "values": {"rrule": cal.with_until(task.rrule, at)}})
        try:
            spec = TaskSpec(ListKey.TODO, task.title, start_at=new_start or at,
                            duration_min=(body.duration_min if "duration_min" in sent
                                          else task.duration_min), tz=tz,
                            rrule=rule if "rrule" in sent else _without_until(task.rrule))
            added = await service.add(db, user_id, [spec], by=Initiator.USER, now=now,
                                      source_item_id=task.source_item_id, dedupe=False)
        except (service.TaskError, ValueError) as exc:
            raise ApiError(422, "validation_error") from exc
        new_task, previous = added.tasks[0], task
        extra_inverse = list(added.inverse)
        if alert is not None:  # the old series' alert ends with it
            ops += await _alert_ends(db, user_id, task, at, now)
        if offset is not None:
            _, undo_alert = await cal.alert_ops(db, user_id, new_task, start=new_task.start_at,
                                                rrule=new_task.rrule, offset=offset, now=now)
            extra_inverse = [*undo_alert, *extra_inverse]
        sentence = cal.moved_sentence(task, at, new_task.start_at)
    else:
        start = new_start if "start_at" in sent else task.start_at
        duration = body.duration_min if "duration_min" in sent else task.duration_min
        if start is None:
            rule, duration = None, None  # all day on `due_date`
        probe = Task(due_date=task.due_date)
        try:
            service.set_time(probe, start, duration, tz, rule)
        except (service.TaskError, ValueError) as exc:
            raise ApiError(422, "validation_error") from exc
        values = {"start_at": _utc(probe.start_at), "duration_min": probe.duration_min,
                  "tz": probe.tz, "rrule": probe.rrule}
        if probe.start_at is not None and probe.due_date is not None:
            values["due_date"] = probe.due_date.isoformat()
        ops.append({"op": "set_task", "id": str(task.public_id), "item": str(item_pid),
                    "values": values})  # fmt: skip
        if "reminder_offset_min" in sent or (alert is not None and (task.rrule or rule)
                                             and offset is not None):  # fmt: skip
            # the alert: set / changed / removed, or it follows a repeating task
            alert_ops, undo_alert = await cal.alert_ops(
                db, user_id, task, start=probe.start_at, rrule=probe.rrule, offset=offset,
                now=now)  # fmt: skip
            ops += alert_ops
            extra_inverse = [*undo_alert, *extra_inverse]
        elif old_start is not None and probe.start_at is not None:
            ops += await cal.reminder_shift_ops(db, user_id, task, probe.start_at - old_start,
                                                now)  # fmt: skip
        sentence = (cal.moved_sentence(task, old_start, probe.start_at)
                    if old_start != probe.start_at
                    else f"Изменил: {service.lower_first(task.title)}")  # fmt: skip
    out = await engine.apply(db, user_id, ops, by=Initiator.USER, check=False, now=now)
    inverse = [*extra_inverse, *out.inverse]
    action = None
    if inverse:
        action = await record(
            db, user_id=user_id, kind=ActionKind.FACET_EDIT, initiated_by=Initiator.USER,
            summary={"ru": sentence, "kk": None},
            changes=[_change_row(new_task or task, item_pid, "edit", sentence)],
            inverse=inverse, now=now, source_item_ids=[task.item_id],
            client_id=body.client_id)  # fmt: skip
    await db.flush()
    occ = _occ_out(await _occ_row(db, task, at), task) if scope == "this" else None
    return TaskChangedOut(task=await _task_out(db, new_task or task),
                          action=await _action_out(db, action, now),
                          occurrence=occ,  # type: ignore[arg-type]
                          previous_task=await _task_out(db, previous) if previous else None)


async def _alert_ends(db: Db, user_id: int, task: Task, at: datetime,
                      now: datetime) -> list[dict[str, Any]]:  # fmt: skip
    """The repeating alert of a series ended before `at` ends with it."""
    alert = await cal.linked_reminder(db, user_id, task)
    if alert is None or not alert.rrule:
        return []
    offset = cal.offset_of(task.start_at, alert) or 0
    return [{"op": "set_reminder_time", "id": str(alert.public_id),
             "due_at": alert.due_at.isoformat(),
             "rrule": cal.with_until(alert.rrule, at - timedelta(minutes=offset))}]


def _without_until(rule: str | None) -> str | None:
    if not rule:
        return None
    return ";".join(p for p in rule.split(";") if not p.startswith("UNTIL=")) or None


__all__ = ["router"]
