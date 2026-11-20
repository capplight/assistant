"""Operations of «Дела» / «Покупки» and their calendar (Ф-95): create, change fields, move in
time (`tasks.reschedule`: one occurrence, «это и следующие», the whole series), skip / end a
repeat, shift many at once, delete, done / not done, clear the done ones. `api/routes/tasks.py`
and the assistant line call these (registry.py); a route keeps only the HTTP part (idempotency
by `client_id`, the `version` check, the response)."""

import uuid
from datetime import UTC, date, datetime, timedelta
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.actions import engine, record
from assistant.db.models import Item
from assistant.db.models_actions import ActionKind
from assistant.db.models_tasks import ListKey, Task, TaskOccurrence
from assistant.operations.registry import Built, Operation, OpError, OpResult, register
from assistant.tasks import TaskSpec, service
from assistant.tasks import calendar as cal

CLEARED_RU = {"shopping": "Убрал купленное", "todo": "Убрал сделанное"}
MAX_SHIFT = 50


def change_row(task: Task, item_id: uuid.UUID, kind: str, text: str,
               page_id: uuid.UUID | None = None) -> dict[str, Any]:  # fmt: skip
    return {"item_id": str(item_id), "task_id": str(task.public_id), "title": task.title,
            "kind": kind, "page_id": str(page_id) if page_id else None, "text": text}


async def _task(session: AsyncSession, user_id: int, task_id: uuid.UUID) -> Task:
    task = await service.get(session, user_id, task_id)
    if task is None:
        raise OpError("not_found", 404)
    return task


class TaskRef(BaseModel):
    model_config = ConfigDict(extra="forbid")
    task_id: uuid.UUID


async def trash_ops(session: AsyncSession, user_id: int, task: Task,
                    item_pid: uuid.UUID) -> list[dict[str, Any]]:  # fmt: skip
    """The to-do and its record to the trash, its linked reminders cancelled (as the screen)."""
    return [*await cal.linked_reminder_cancels(session, user_id, task),
            {"op": "delete_entity_soft", "entity": "tasks", "id": str(task.public_id),
             "item": str(item_pid)}]  # fmt: skip


async def _delete(session: AsyncSession, user_id: int, args: TaskRef, *, now: datetime) -> Built:
    task = await _task(session, user_id, args.task_id)
    item_pid = await service.item_public_id(session, task)
    return Built(
        ops=await trash_ops(session, user_id, task, item_pid), kind=ActionKind.DELETE_ITEM,
        sentence=f"Убрал в корзину: {service.lower_first(task.title)}",
        changes=[change_row(task, item_pid, "trash", f"«{task.title}» — в корзине")],
        source_item_ids=[task.item_id], touched=("tasks", "calendar", "reminders"),
        data={"task": task})  # fmt: skip


class SetDone(BaseModel):
    model_config = ConfigDict(extra="forbid")
    task_id: uuid.UUID
    done: bool = True
    occurrence_at: datetime | None = None  # checked by the caller (a start of the series)


async def _set_done(session: AsyncSession, user_id: int, args: SetDone, *,
                    now: datetime) -> Built:  # fmt: skip
    task = await _task(session, user_id, args.task_id)
    if not await service.is_live(session, task):
        raise OpError("not_found", 404)
    if task.rrule and args.occurrence_at is None:
        raise OpError("validation_error")  # a repeat is done one occurrence at a time
    item_pid = await service.item_public_id(session, task)
    done_at = now.isoformat() if args.done else None
    if args.occurrence_at is not None:
        op: dict[str, Any] = {"op": "set_occurrence", "task": str(task.public_id),
                              "item": str(item_pid),
                              "occurrence_at": args.occurrence_at.isoformat(),
                              "values": {"done_at": done_at}}  # fmt: skip
    else:
        op = {"op": "set_task", "id": str(task.public_id), "item": str(item_pid),
              "values": {"done_at": done_at}}
    sentence = service.done_sentence(task, args.done)
    return Built(ops=[op], kind=ActionKind.FACET_EDIT, sentence=sentence,
                 changes=[change_row(task, item_pid, "done", sentence)],
                 source_item_ids=[task.item_id], touched=("tasks", "calendar"),
                 data={"task": task})  # fmt: skip


class ClearDone(BaseModel):
    model_config = ConfigDict(extra="forbid")
    list_key: str
    task_ids: list[uuid.UUID] | None = None


async def _clear_done(session: AsyncSession, user_id: int, args: ClearDone, *,
                      now: datetime) -> Built:  # fmt: skip
    q = (select(Task).join(Item, Item.id == Task.item_id)
         .where(Task.user_id == user_id, Task.list_key == args.list_key,
                Task.done_at.is_not(None), Task.deleted_at.is_(None),
                Item.deleted_at.is_(None)))  # fmt: skip
    if args.task_ids is not None:
        q = q.where(Task.public_id.in_(args.task_ids))
    done = list(await session.scalars(q.order_by(Task.id).limit(500)))
    pids = {t.id: await service.item_public_id(session, t) for t in done}
    titles = ", ".join(service.lower_first(t.title) for t in done[:5])
    more = f" и ещё {len(done) - 5}" if len(done) > 5 else ""
    return Built(
        ops=[{"op": "delete_entity_soft", "entity": "tasks", "id": str(t.public_id),
              "item": str(pids[t.id])} for t in done],
        kind=ActionKind.DELETE_ITEM,
        sentence=f"{CLEARED_RU.get(args.list_key, 'Убрал')}: {titles}{more}.",
        changes=[change_row(t, pids[t.id], "trash", f"«{t.title}» — в корзине") for t in done],
        source_item_ids=[t.item_id for t in done], touched=("tasks",), data={"tasks": done})


# --- create ---


class TaskCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    list_key: str
    title: str
    qty: str | None = None
    where: str | None = None
    due_date: str | None = None  # YYYY-MM-DD
    start_at: datetime | None = None
    duration_min: int | None = None
    tz: str = service.DEFAULT_TZ
    rrule: str | None = None
    reminder_offset_min: int | None = None


async def _create(session: AsyncSession, user_id: int, args: TaskCreate, *, by: str,
                  now: datetime, client_id: uuid.UUID | None = None,
                  message_pk: int | None = None, **_: Any) -> OpResult:  # fmt: skip
    try:
        if args.rrule and args.start_at is None:
            raise service.TaskError("validation_error")
        spec = TaskSpec(args.list_key, service.clean_title(args.title), args.qty, args.where,
                        date.fromisoformat(args.due_date) if args.due_date else None,
                        start_at=args.start_at, duration_min=args.duration_min, tz=args.tz,
                        rrule=args.rrule)  # fmt: skip
        added = await service.add(session, user_id, [spec], by=by, now=now, client_id=client_id,
                                  dedupe=args.start_at is None)  # fmt: skip
    except (service.TaskError, ValueError) as exc:
        raise OpError("validation_error") from exc
    inverse = list(added.inverse)
    made = added.tasks[0]
    touched = ["tasks"]
    if made.start_at is not None or made.due_date is not None:
        touched.append("calendar")
    if args.reminder_offset_min is not None and made.start_at is not None:
        _, undo_alert = await cal.alert_ops(session, user_id, made, start=made.start_at,
                                            rrule=made.rrule, offset=args.reminder_offset_min,
                                            now=now)  # fmt: skip
        inverse = [*undo_alert, *inverse]
        touched.append("reminders")
    action = await record(
        session, user_id=user_id, kind=ActionKind.SAVE_ITEM, initiated_by=by,
        summary={"ru": added.sentence, "kk": None}, changes=added.changes, inverse=inverse,
        now=now, screen_id=added.page.id if added.page else None,
        source_item_ids=added.item_pks, client_id=client_id, message_id=message_pk,
        extra={"op": "tasks.create", "touched": touched})  # fmt: skip
    await session.flush()
    return OpResult(action=action, actions=[action], inverse=inverse, items=set(added.items),
                    pages=set(added.pages), sentence=added.sentence, touched=tuple(touched),
                    data={"task": made, "added": added})  # fmt: skip


# --- change fields (title, qty, where, day, list) ---


class TaskUpdate(BaseModel):
    """Only the fields given change (`model_fields_set`); `due_date: null` clears the day."""

    model_config = ConfigDict(extra="forbid")
    task_id: uuid.UUID
    title: str | None = None
    qty: str | None = None
    where: str | None = None
    due_date: str | None = None
    list_key: str | None = None


async def _update(session: AsyncSession, user_id: int, args: TaskUpdate, *,
                  now: datetime) -> Built:  # fmt: skip
    task = await _task(session, user_id, args.task_id)
    sent = args.model_fields_set - {"task_id"}
    values: dict[str, Any] = {}
    try:
        if "title" in sent:
            values["title"] = service.clean_title(args.title)
        if "qty" in sent:
            values["qty"] = service.clean_short(args.qty)
        if "where" in sent:
            values["where_text"] = service.clean_short(args.where)
        if "due_date" in sent:
            values["due_date"] = date.fromisoformat(args.due_date).isoformat() \
                if args.due_date else None  # fmt: skip
        if "list_key" in sent and args.list_key is not None:
            values["list_key"] = args.list_key
    except (service.TaskError, ValueError) as exc:
        raise OpError("validation_error") from exc
    item_pid = await service.item_public_id(session, task)
    ops: list[dict[str, Any]] = []
    if values:
        ops.append({"op": "set_task", "id": str(task.public_id), "item": str(item_pid),
                    "values": values})  # fmt: skip
    old_list = task.list_key
    new_list = values.get("list_key", old_list)
    new_page = None
    if new_list != old_list:  # the row moves between «Покупки» and «Дела»
        old_page = await service.list_page(session, user_id, old_list)
        new_page = await service.list_page(session, user_id, new_list)
        # «Дела» holds both lists when there is no «Покупки»: then nothing moves
        if not (old_page is not None and new_page is not None and new_page.id == old_page.id):
            if new_page is not None:
                ops.append({"op": "add_screen_item", "page": str(new_page.public_id),
                            "item": str(item_pid)})  # fmt: skip
            if old_page is not None:
                ops.append({"op": "remove_screen_item", "page": str(old_page.public_id),
                            "item": str(item_pid), "exclude": True})  # fmt: skip
    touched = ("tasks", "calendar") if "due_date" in values else ("tasks",)
    return Built(ops=ops, kind=ActionKind.FACET_EDIT,
                 sentence=f"Изменил: {service.lower_first(task.title)}",
                 changes=[change_row(task, item_pid, "edit", f"«{task.title}» — изменено",
                                     new_page.public_id if new_page else None)],
                 source_item_ids=[task.item_id], touched=touched, data={"task": task})


# --- time: move, resize, repeat; one occurrence or the series (0035, calendar.md) ---

TIME_FIELDS = frozenset({"start_at", "duration_min", "tz", "rrule", "occurrence_at", "scope",
                         "reminder_offset_min"})  # fmt: skip


def utc(value: datetime | None) -> str | None:
    return value.astimezone(UTC).replace(microsecond=0).isoformat() if value else None


async def occurrence(session: AsyncSession, task: Task, at: datetime | None) -> datetime | None:
    """The occurrence named, checked: a start of the series or a row it already has."""
    if at is None:
        return None
    if not task.rrule or at.tzinfo is None:
        raise OpError("validation_error")
    at = at.astimezone(UTC).replace(microsecond=0)
    own = await session.scalar(select(TaskOccurrence.id).where(
        TaskOccurrence.task_id == task.id, TaskOccurrence.occurrence_at == at))  # fmt: skip
    if own is None:
        try:
            cal.check_occurrence(task, at)
        except (service.TaskError, ValueError) as exc:
            raise OpError("validation_error") from exc
    return at


async def occurrence_row(session: AsyncSession, task: Task,
                         at: datetime | None) -> TaskOccurrence | None:  # fmt: skip
    if at is None:
        return None
    return await session.scalar(select(TaskOccurrence).where(
        TaskOccurrence.task_id == task.id, TaskOccurrence.occurrence_at == at))  # fmt: skip


async def alert_ends(session: AsyncSession, user_id: int, task: Task,
                     at: datetime) -> list[dict[str, Any]]:  # fmt: skip
    """The repeating alert of a series ended before `at` ends with it."""
    alert = await cal.linked_reminder(session, user_id, task)
    if alert is None or not alert.rrule:
        return []
    offset = cal.offset_of(task.start_at, alert) or 0
    return [{"op": "set_reminder_time", "id": str(alert.public_id),
             "due_at": alert.due_at.isoformat(),
             "rrule": cal.with_until(alert.rrule, at - timedelta(minutes=offset))}]


def without_until(rule: str | None) -> str | None:
    if not rule:
        return None
    return ";".join(p for p in rule.split(";") if not p.startswith("UNTIL=")) or None


class Reschedule(BaseModel):
    """Only the fields given change (`model_fields_set`, like `PATCH /v1/tasks/{id}`)."""

    model_config = ConfigDict(extra="forbid")
    task_id: uuid.UUID
    start_at: datetime | None = None
    duration_min: int | None = Field(default=None, ge=5, le=1440)
    tz: str | None = None
    rrule: str | None = None
    occurrence_at: datetime | None = None
    scope: Literal["this", "following", "all"] | None = None
    reminder_offset_min: int | None = None


async def _write(session: AsyncSession, user_id: int, *, name: str, by: str, now: datetime,
                 sentence: str, changes: list[dict[str, Any]], inverse: list[dict[str, Any]],
                 source: list[int], touched: tuple[str, ...], client_id: uuid.UUID | None,
                 message_pk: int | None) -> Any:  # fmt: skip
    if not inverse:
        return None
    return await record(
        session, user_id=user_id, kind=ActionKind.FACET_EDIT, initiated_by=by,
        summary={"ru": sentence, "kk": None}, changes=changes, inverse=inverse, now=now,
        source_item_ids=source, client_id=client_id, message_id=message_pk,
        extra={"op": name, "touched": list(touched)})  # fmt: skip


async def _reschedule(session: AsyncSession, user_id: int, args: Reschedule, *, by: str,
                      now: datetime, client_id: uuid.UUID | None = None,
                      message_pk: int | None = None, **_: Any) -> OpResult:  # fmt: skip
    """One action with «Отменить». `data`: task (the new series for «это и следующие»),
    previous (the old series then), occurrence_at (scope this)."""
    task = await _task(session, user_id, args.task_id)
    if not await service.is_live(session, task):
        raise OpError("not_found", 404)
    sent = args.model_fields_set - {"task_id"}
    scope = args.scope or ("this" if args.occurrence_at is not None else "all")
    at = await occurrence(session, task, args.occurrence_at)
    if scope != "all" and at is None:
        raise OpError("validation_error")
    item_pid = await service.item_public_id(session, task)
    tz = (args.tz if "tz" in sent and args.tz else None) or task.tz or service.DEFAULT_TZ
    try:
        rule = cal.check_rrule(args.rrule) if "rrule" in sent else task.rrule
    except (service.TaskError, ValueError) as exc:
        raise OpError("validation_error") from exc
    alert = await cal.linked_reminder(session, user_id, task)
    offset = (args.reminder_offset_min if "reminder_offset_min" in sent
              else cal.offset_of(task.start_at, alert))  # fmt: skip
    ops: list[dict[str, Any]] = []
    extra_inverse: list[dict[str, Any]] = []
    new_task: Task | None = None
    previous: Task | None = None
    old_start = task.start_at
    new_start = args.start_at.astimezone(UTC).replace(microsecond=0) if args.start_at else None
    if at is not None and scope == "following" and task.start_at is not None \
            and at <= task.start_at:  # fmt: skip
        scope, at = "all", None  # from the first one on = the whole series
    if scope == "this":
        assert at is not None
        if "rrule" in sent or "tz" in sent or "reminder_offset_min" in sent or (
                "start_at" in sent and new_start is None):  # fmt: skip
            raise OpError("validation_error")  # one occurrence: only its time
        values: dict[str, Any] = {}
        if "start_at" in sent:
            values["start_at"] = utc(new_start)
        if "duration_min" in sent:
            values["duration_min"] = args.duration_min
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
                            duration_min=(args.duration_min if "duration_min" in sent
                                          else task.duration_min), tz=tz,
                            rrule=rule if "rrule" in sent else without_until(task.rrule))
            added = await service.add(session, user_id, [spec], by=by, now=now,
                                      source_item_id=task.source_item_id, dedupe=False)
        except (service.TaskError, ValueError) as exc:
            raise OpError("validation_error") from exc
        new_task, previous = added.tasks[0], task
        extra_inverse = list(added.inverse)
        if alert is not None:  # the old series' alert ends with it
            ops += await alert_ends(session, user_id, task, at)
        if offset is not None:
            _, undo_alert = await cal.alert_ops(session, user_id, new_task,
                                                start=new_task.start_at, rrule=new_task.rrule,
                                                offset=offset, now=now)  # fmt: skip
            extra_inverse = [*undo_alert, *extra_inverse]
        sentence = cal.moved_sentence(task, at, new_task.start_at)
    else:
        start = new_start if "start_at" in sent else task.start_at
        duration = args.duration_min if "duration_min" in sent else task.duration_min
        if start is None:
            rule, duration = None, None  # all day on `due_date`
        probe = Task(due_date=task.due_date)
        try:
            service.set_time(probe, start, duration, tz, rule)
        except (service.TaskError, ValueError) as exc:
            raise OpError("validation_error") from exc
        values = {"start_at": utc(probe.start_at), "duration_min": probe.duration_min,
                  "tz": probe.tz, "rrule": probe.rrule}
        if probe.start_at is not None and probe.due_date is not None:
            values["due_date"] = probe.due_date.isoformat()
        ops.append({"op": "set_task", "id": str(task.public_id), "item": str(item_pid),
                    "values": values})  # fmt: skip
        if "reminder_offset_min" in sent or (alert is not None and (task.rrule or rule)
                                             and offset is not None):  # fmt: skip
            # the alert: set / changed / removed, or it follows a repeating task
            alert_ops, undo_alert = await cal.alert_ops(
                session, user_id, task, start=probe.start_at, rrule=probe.rrule, offset=offset,
                now=now)  # fmt: skip
            ops += alert_ops
            extra_inverse = [*undo_alert, *extra_inverse]
        elif old_start is not None and probe.start_at is not None:
            ops += await cal.reminder_shift_ops(session, user_id, task,
                                                probe.start_at - old_start, now)  # fmt: skip
        sentence = (cal.moved_sentence(task, old_start, probe.start_at)
                    if old_start != probe.start_at
                    else f"Изменил: {service.lower_first(task.title)}")  # fmt: skip
    out = await engine.apply(session, user_id, ops, by=by, check=False, now=now)
    inverse = [*extra_inverse, *out.inverse]
    touched = ("tasks", "calendar", "reminders") if alert is not None or offset is not None \
        else ("tasks", "calendar")  # fmt: skip
    action = await _write(session, user_id, name="tasks.reschedule", by=by, now=now,
                          sentence=sentence,
                          changes=[change_row(new_task or task, item_pid, "edit", sentence)],
                          inverse=inverse, source=[task.item_id], touched=touched,
                          client_id=client_id, message_pk=message_pk)  # fmt: skip
    await session.flush()
    return OpResult(action=action, actions=[action] if action else [], inverse=inverse,
                    items=out.items, pages=out.pages, sentence=sentence, touched=touched,
                    data={"task": new_task or task, "previous": previous,
                          "occurrence_at": at if scope == "this" else None})  # fmt: skip


class OccurrenceRemove(BaseModel):
    model_config = ConfigDict(extra="forbid")
    task_id: uuid.UUID
    occurrence_at: datetime
    scope: Literal["this", "following"] | None = None


async def _remove_occurrence(session: AsyncSession, user_id: int, args: OccurrenceRemove, *,
                             by: str, now: datetime, client_id: uuid.UUID | None = None,
                             message_pk: int | None = None, **_: Any) -> OpResult:  # fmt: skip
    """One occurrence skipped («только это»), or the series ended before it («это и
    следующие»; from the first one on it is the whole series: the caller runs `tasks.delete`)."""
    task = await _task(session, user_id, args.task_id)
    item_pid = await service.item_public_id(session, task)
    at = await occurrence(session, task, args.occurrence_at)
    assert at is not None
    if args.scope == "following":
        ops: list[dict[str, Any]] = [{"op": "set_task", "id": str(task.public_id),
                                      "item": str(item_pid),
                                      "values": {"rrule": cal.with_until(task.rrule or "", at)}}]
        ops += await alert_ends(session, user_id, task, at)
        sentence = f"Больше не повторяю: {service.lower_first(task.title)}"
    else:
        ops = [{"op": "set_occurrence", "task": str(task.public_id), "item": str(item_pid),
                "occurrence_at": at.isoformat(), "values": {"skipped": True}}]
        sentence = f"Убрал один раз: {service.lower_first(task.title)}"
    out = await engine.apply(session, user_id, ops, by=by, check=False, now=now)
    action = await _write(session, user_id, name="tasks.remove_occurrence", by=by, now=now,
                          sentence=sentence,
                          changes=[change_row(task, item_pid, "edit", sentence)],
                          inverse=out.inverse, source=[task.item_id],
                          touched=("tasks", "calendar"), client_id=client_id,
                          message_pk=message_pk)  # fmt: skip
    await session.flush()
    return OpResult(action=action, actions=[action] if action else [], inverse=out.inverse,
                    items=out.items, pages=out.pages, sentence=sentence,
                    touched=("tasks", "calendar"), data={"task": task, "occurrence_at": at})


# --- many calendar entries at once («сдвинь всё завтра на час»): bulk, «Да» first ---


class ShiftEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")
    task_id: uuid.UUID
    occurrence_at: datetime | None = None  # one occurrence of a repeat


class ShiftMany(BaseModel):
    model_config = ConfigDict(extra="forbid")
    entries: list[ShiftEntry] = Field(min_length=1, max_length=MAX_SHIFT)
    minutes: int = Field(ge=-7 * 1440, le=7 * 1440)


async def _shift_many(session: AsyncSession, user_id: int, args: ShiftMany, *,
                      now: datetime) -> Built:  # fmt: skip
    delta = timedelta(minutes=args.minutes)
    ops: list[dict[str, Any]] = []
    changes: list[dict[str, Any]] = []
    source: list[int] = []
    for e in args.entries:
        task = await _task(session, user_id, e.task_id)
        if task.start_at is None or not await service.is_live(session, task):
            continue
        item_pid = await service.item_public_id(session, task)
        if task.rrule:
            at = await occurrence(session, task, e.occurrence_at)
            if at is None:
                continue
            row = await occurrence_row(session, task, at)
            start = row.start_at if row is not None and row.start_at is not None else at
            ops.append({"op": "set_occurrence", "task": str(task.public_id),
                        "item": str(item_pid), "occurrence_at": at.isoformat(),
                        "values": {"start_at": utc(start + delta)}})  # fmt: skip
            text = cal.moved_sentence(task, start, start + delta)
        else:
            ops.append({"op": "set_task", "id": str(task.public_id), "item": str(item_pid),
                        "values": {"start_at": utc(task.start_at + delta)}})
            ops += await cal.reminder_shift_ops(session, user_id, task, delta, now)
            text = cal.moved_sentence(task, task.start_at, task.start_at + delta)
        changes.append(change_row(task, item_pid, "edit", text))
        source.append(task.item_id)
    if not ops:
        raise OpError("not_found", 404)
    n = len(changes)
    sentence = changes[0]["text"] if n == 1 else f"Сдвинул {n} {_events(n)}"
    return Built(ops=ops, kind=ActionKind.FACET_EDIT, sentence=sentence, changes=changes,
                 source_item_ids=source, touched=("tasks", "calendar", "reminders"))


def _events(n: int) -> str:
    n100, n10 = n % 100, n % 10
    if n10 == 1 and n100 != 11:
        return "дело"
    if 2 <= n10 <= 4 and not 12 <= n100 <= 14:
        return "дела"
    return "дел"


register(Operation("tasks.create", "tasks", "safe", TaskCreate, execute=_create,
                   description="a to-do or a purchase (with a day, a time, a repeat, an alert)"))
register(Operation("tasks.update", "tasks", "safe", TaskUpdate, build=_update,
                   description="a to-do's title, quantity, shop, day or list"))
register(Operation("tasks.reschedule", "calendar", "safe", Reschedule, execute=_reschedule,
                   description="a to-do / calendar event moved in time or resized (one "
                               "occurrence, this and the following, or the whole series)"))
register(Operation("tasks.remove_occurrence", "calendar", "safe", OccurrenceRemove,
                   execute=_remove_occurrence,
                   description="one occurrence of a repeat skipped, or the repeat ended there"))
register(Operation("calendar.shift_many", "calendar", "bulk", ShiftMany, build=_shift_many,
                   description="several calendar entries moved by the same minutes"))
register(Operation("tasks.delete", "tasks", "safe", TaskRef, build=_delete,
                   description="a to-do and its record to the trash, its reminder cancelled"))
register(Operation("tasks.set_done", "tasks", "safe", SetDone, build=_set_done,
                   description="tick a to-do (or one occurrence of a repeat), or untick it"))
register(Operation("tasks.clear_done", "tasks", "bulk", ClearDone, build=_clear_done,
                   description="the done to-dos of a list to the trash"))
