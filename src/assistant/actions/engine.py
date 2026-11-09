"""The `inverse` engine (spec 3.7): white-listed ops that code runs, each returning its own reverse.

An op is a JSON object with ids as public uuids (strings), never database ids:

- `restore_positions` {page, rows: [{item, position, group_key, manual_order, updated_by?,
  expect?}]}: sets rows of a page.
- `restore_view_state` {page, view_state}: sets the page's view state.
- `add_screen_item` {page, item, position?, group_key?, manual_order?, added_by?}: shows the item on
  the page (inserts the row, or clears «убрано»).
- `remove_screen_item` {page, item, exclude}: `exclude=true` = «убрано с этой страницы» (rules do
  not bring it back); `false` = the row is deleted (it was added by the change being undone).
- `delete_entity_soft` / `restore_entity` {entity: items|screens, id}: trash / back.
- `restore_field` {entity: items, id, field: title, value, expect?}: sets one field.
- `restore_page_position` {page, position, expect?}: sets a page's place among the tabs.
- `restore_habit` {id, state: {evidence_count, status, value}, expect?}: sets a rule back (the
  undo of turning it off).
- `habit_evidence` {id, item, add}: counts one record for a learned rule, or takes it back (the
  undo of the learning a manual move did). A later move of another record does not block it, and a
  rule the person turned off stays off.
- Week 10 (`ops_dedup`): `hide_item`, `unhide_item`, `relink`, `set_status`,
  `add_collection_item`, `remove_collection_item`, `restore_collection` (repeats and stacks).
- Week 9: `delete_entity_soft` / `restore_entity` also take `entity: tasks` (the task and its own
  record go to the trash / come back together). `set_task` {id, values, expect?}: sets fields of a
  task (`title`, `qty`, `where_text`, `due_date`, `done_at`, `list_key`). `cancel_reminder` {id,
  expect?}: deletes a reminder (fires `cancelled`); `restore_reminder` {id, state, expect?}: sets a
  reminder's fields back (and brings a deleted one back), fires re-planned. `restore_screen_config`
  {page, title?, title_kk?, icon?, layout?, expect?}: a page's name, icon and layout. Restoring a
  removed page also places what was saved while it was gone (as `/restore`). `restore_fires`
  {reminder, fires: [{id, state, acked_at, expect}], status?}: fires of one occurrence and the
  reminder's status back (the undo of a late «Сделано»). `restore_habit` may carry `state.key`
  (a rule moved to another page).
- Week 11 (`ops_view`): `set_view_key`, `set_appearance`, `set_facet` (page views, own fields).
- Week 12 (`ops_expenses`): `delete_entity_soft` / `restore_entity` take `entity: expenses` (the
  expense and its own record together); `set_expense` {id, item, values, expect?};
  `set_expense_category` {id, values, expect?} (name, icon, hidden, pinned, order).

`apply` runs a list of ops in one transaction (the caller commits) and returns the ops that undo
what it did, newest first, so `apply(apply(x).inverse)` is a round trip. With `check=True` (an
undo) a row or field whose current value is not the `expect` the change left behind was changed by
the person since: it is skipped and counted, never overwritten («Часть уже изменена вами»).
Every changed page gets `view_version + 1`. Unknown ops or entities raise ValueError: nothing
outside the list ever runs.
"""

import uuid
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any

from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.db.models import Item, Reminder
from assistant.db.models_habits import UserHabit
from assistant.db.models_pages import MAX_PAGES, AddedBy, Screen, ScreenItem, ScreenKind
from assistant.db.models_reminders import APP_KINDS, AppReminderStatus, ReminderFire
from assistant.db.models_tasks import Task
from assistant.pages import add_link, fill_page, habits, lock_user, mark_rekeyed, rescue_moved
from assistant.records import restore_item, trash_item

OPS = frozenset({"restore_positions", "restore_view_state", "add_screen_item",
                 "remove_screen_item", "delete_entity_soft", "restore_entity",
                 "restore_field", "restore_page_position", "restore_habit",
                 "habit_evidence", "set_task", "cancel_reminder", "restore_reminder",
                 "restore_screen_config", "restore_fires",
                 # week 10 (actions/ops_dedup.py): repeats and stacks
                 "hide_item", "unhide_item", "relink", "set_status", "add_collection_item",
                 "remove_collection_item", "restore_collection",
                 # week 11 (actions/ops_view.py): page views
                 "set_view_key", "set_appearance", "set_facet",
                 # week 12 (actions/ops_expenses.py): «Расходы»
                 "set_expense", "set_expense_category",
                 # week 13: an expense leaves while its record (a receipt photo) stays
                 "set_expense_live"})  # fmt: skip
HABIT_STATUSES = frozenset({"candidate", "active", "disabled"})
ENTITIES = frozenset({"items", "screens", "tasks", "expenses"})
OWNED = frozenset({"tasks", "expenses"})  # a row with its own record: trash / back together
TASK_FIELDS = frozenset({"title", "qty", "where_text", "due_date", "done_at", "list_key"})
REMINDER_FIELDS = ("title", "body", "due_at", "tz", "rrule", "offsets", "level", "sensitivity")
SCREEN_FIELDS = ("title", "title_kk", "icon", "layout")
ITEM_FIELDS = frozenset({"title"})
ROW_FIELDS = ("position", "group_key", "manual_order")


@dataclass
class Outcome:
    inverse: list[dict[str, Any]] = field(default_factory=list)
    skipped: int = 0
    items: set[str] = field(default_factory=set)  # item public ids whose state changed
    pages: set[int] = field(default_factory=set)  # screen pks whose rows or view changed


def _uuid(value: Any) -> uuid.UUID:
    return value if isinstance(value, uuid.UUID) else uuid.UUID(str(value))


async def _screen(session: AsyncSession, user_id: int, sid: Any) -> Screen | None:
    return await session.scalar(
        select(Screen).where(Screen.user_id == user_id, Screen.public_id == _uuid(sid))
        .with_for_update()
    )  # fmt: skip


async def _items(session: AsyncSession, user_id: int, ids: list[Any]) -> dict[str, Item]:
    if not ids:
        return {}
    rows = await session.scalars(
        select(Item).where(Item.user_id == user_id, Item.public_id.in_([_uuid(i) for i in ids]))
        .with_for_update()
    )  # fmt: skip
    return {str(i.public_id): i for i in rows}


async def _links(session: AsyncSession, screen_id: int,
                 item_pks: list[int]) -> dict[int, ScreenItem]:  # fmt: skip
    if not item_pks:
        return {}
    rows = await session.scalars(
        select(ScreenItem).where(ScreenItem.screen_id == screen_id,
                                 ScreenItem.item_id.in_(item_pks)).with_for_update()
    )  # fmt: skip
    return {r.item_id: r for r in rows}


def _state(link: ScreenItem) -> dict[str, Any]:
    return {"position": link.position, "group_key": link.group_key,
            "manual_order": link.manual_order, "updated_by": link.updated_by,
            "manual_at": link.manual_at.isoformat() if link.manual_at else None}  # fmt: skip


async def _restore_positions(session: AsyncSession, user_id: int, op: dict, out: Outcome, *,
                             by: str, check: bool, now: datetime) -> None:  # fmt: skip
    rows = list(op.get("rows") or [])
    page = await _screen(session, user_id, op["page"])
    if page is None:
        out.skipped += len(rows)
        return
    items = await _items(session, user_id, [r["item"] for r in rows])
    links = await _links(session, page.id, [i.id for i in items.values()])
    back = []
    for r in rows:
        item = items.get(str(r["item"]))
        link = links.get(item.id) if item is not None else None
        if link is None or link.removed_by_user_at is not None:
            out.skipped += 1
            continue
        cur = _state(link)
        expect = r.get("expect")
        if check and expect and any(cur.get(k) != v for k, v in expect.items()):
            out.skipped += 1
            continue
        new = {k: r[k] for k in ROW_FIELDS if k in r}
        if all(cur[k] == v for k, v in new.items()):
            continue
        back.append({"item": str(r["item"]), **{k: cur[k] for k in new},
                     "updated_by": cur["updated_by"], "manual_at": cur["manual_at"],
                     "expect": new})  # fmt: skip
        for k, v in new.items():
            setattr(link, k, v)
        if "manual_at" in r:  # kept with manual_order (a manual row has a manual_at)
            link.manual_at = datetime.fromisoformat(r["manual_at"]) if r["manual_at"] else None
        link.updated_by = r.get("updated_by") or by
        link.updated_at = now
        out.items.add(str(r["item"]))
        out.pages.add(page.id)
    if back:
        out.inverse.append({"op": "restore_positions", "page": str(page.public_id), "rows": back})
    if len(back) > 1:  # the page was rearranged: a key a phone computed before says nothing now
        await session.flush()
        await mark_rekeyed(session, page.id)


async def _restore_view_state(session: AsyncSession, user_id: int, op: dict, out: Outcome, *,
                              by: str, check: bool, now: datetime) -> None:  # fmt: skip
    page = await _screen(session, user_id, op["page"])
    if page is None or page.kind == ScreenKind.SYSTEM_TODAY:
        out.skipped += 1
        return
    new = dict(op.get("view_state") or {})
    if new == (page.view_state or {}):
        return
    out.inverse.append({"op": "restore_view_state", "page": str(page.public_id),
                        "view_state": dict(page.view_state or {})})  # fmt: skip
    page.view_state = new
    out.pages.add(page.id)


async def _add_screen_item(session: AsyncSession, user_id: int, op: dict, out: Outcome, *,
                           by: str, check: bool, now: datetime) -> None:  # fmt: skip
    page = await _screen(session, user_id, op["page"])
    items = await _items(session, user_id, [op["item"]])
    item = items.get(str(op["item"]))
    if page is None or item is None or page.deleted_at is not None \
            or page.kind == ScreenKind.SYSTEM_TODAY:  # fmt: skip
        out.skipped += 1
        return
    link = (await _links(session, page.id, [item.id])).get(item.id)
    if link is not None and link.removed_by_user_at is None:
        return
    if link is not None:  # it was taken off this page: show it again
        out.inverse.append({"op": "remove_screen_item", "page": str(page.public_id),
                            "item": str(item.public_id), "exclude": True})  # fmt: skip
        link.removed_by_user_at = None
    else:
        added = AddedBy.USER if by == "user" else AddedBy.AGENT
        if op.get("added_by") in (AddedBy.RULE, AddedBy.AGENT, AddedBy.USER):
            added = AddedBy(op["added_by"])
        await add_link(session, page, item.id, item.occurred_at or item.created_at, added)
        await session.flush()
        link = (await _links(session, page.id, [item.id]))[item.id]
        out.inverse.append({"op": "remove_screen_item", "page": str(page.public_id),
                            "item": str(item.public_id), "exclude": False})  # fmt: skip
    for k in ROW_FIELDS:
        if k in op and op[k] is not None:
            setattr(link, k, op[k])
    link.updated_by = by
    link.updated_at = now
    out.items.add(str(item.public_id))
    out.pages.add(page.id)


async def _remove_screen_item(session: AsyncSession, user_id: int, op: dict, out: Outcome, *,
                              by: str, check: bool, now: datetime) -> None:  # fmt: skip
    page = await _screen(session, user_id, op["page"])
    items = await _items(session, user_id, [op["item"]])
    item = items.get(str(op["item"]))
    if page is None or item is None:
        out.skipped += 1
        return
    link = (await _links(session, page.id, [item.id])).get(item.id)
    if link is None or link.removed_by_user_at is not None:
        return
    if op.get("exclude"):
        out.inverse.append({"op": "add_screen_item", "page": str(page.public_id),
                            "item": str(item.public_id)})  # fmt: skip
        link.removed_by_user_at = now
        link.updated_by = by
        link.updated_at = now
    else:
        if check and link.updated_by == "user" and link.manual_order:
            out.skipped += 1  # the person placed it by hand since: it stays
            return
        out.inverse.append({"op": "add_screen_item", "page": str(page.public_id),
                            "item": str(item.public_id), "added_by": link.added_by,
                            **{k: getattr(link, k) for k in ROW_FIELDS}})  # fmt: skip
        await session.execute(delete(ScreenItem).where(ScreenItem.screen_id == page.id,
                                                       ScreenItem.item_id == item.id))
    out.items.add(str(item.public_id))
    out.pages.add(page.id)


def _item_of(op: dict) -> dict[str, str]:
    """A task op names its record too, so «Вернуть» on one row of «Что изменилось» finds it."""
    return {"item": str(op["item"])} if op.get("item") else {}


async def _soft(session: AsyncSession, user_id: int, op: dict, out: Outcome, *,
                by: str, check: bool, now: datetime) -> None:  # fmt: skip
    entity, rid = op["entity"], str(op["id"])
    if entity in OWNED:
        task, item = await _owned(session, user_id, entity, rid)
        if task is None or item is None:
            out.skipped += 1
            return
        if task.deleted_at is not None and item.deleted_at is not None:
            return
        task.deleted_at = task.deleted_at or now
        if item.deleted_at is None:
            trash_item(item, now)
        out.items.add(str(item.public_id))
    elif entity == "items":
        item = (await _items(session, user_id, [rid])).get(rid)
        if item is None:
            out.skipped += 1
            return
        if item.deleted_at is not None:
            return
        trash_item(item, now)
        out.items.add(rid)
    else:
        page = await _screen(session, user_id, rid)
        if page is None or page.kind == ScreenKind.SYSTEM_TODAY:
            out.skipped += 1
            return
        if page.deleted_at is not None:
            return
        page.deleted_at = now
        await session.flush()
        await rescue_moved(session, page)
    out.inverse.append({"op": "restore_entity", "entity": entity, "id": rid, **_item_of(op)})


async def _restore(session: AsyncSession, user_id: int, op: dict, out: Outcome, *,
                   by: str, check: bool, now: datetime) -> None:  # fmt: skip
    entity, rid = op["entity"], str(op["id"])
    if entity in OWNED:
        task, item = await _owned(session, user_id, entity, rid)
        if task is None or item is None:  # purged after 30 days in the trash
            out.skipped += 1
            return
        if task.deleted_at is None and item.deleted_at is None:
            return
        task.deleted_at = None
        if item.deleted_at is not None:
            restore_item(item)
        out.items.add(str(item.public_id))
    elif entity == "items":
        item = (await _items(session, user_id, [rid])).get(rid)
        if item is None:  # purged after 30 days in the trash
            out.skipped += 1
            return
        if item.deleted_at is None:
            return
        restore_item(item)
        out.items.add(rid)
    else:
        page = await _screen(session, user_id, rid)
        if page is None:
            out.skipped += 1
            return
        if page.deleted_at is None:
            return
        live = Screen.user_id == user_id, Screen.deleted_at.is_(None)
        if page.singleton and await session.scalar(select(Screen.id).where(
                *live, Screen.template_key == page.template_key, Screen.id != page.id)):
            out.skipped += 1  # the topic was added again meanwhile
            return  # fmt: skip
        if (await session.scalar(select(func.count()).select_from(Screen).where(*live))
                or 0) >= MAX_PAGES:
            out.skipped += 1
            return  # fmt: skip
        page.deleted_at = None
        await session.flush()
        await fill_page(session, page)  # what was saved while it was gone (as /restore)
    out.inverse.append({"op": "delete_entity_soft", "entity": entity, "id": rid, **_item_of(op)})


async def _restore_field(session: AsyncSession, user_id: int, op: dict, out: Outcome, *,
                         by: str, check: bool, now: datetime) -> None:  # fmt: skip
    if op.get("entity") != "items" or op.get("field") not in ITEM_FIELDS:
        raise ValueError("restore_field: entity/field not allowed")
    rid, name = str(op["id"]), op["field"]
    item = (await _items(session, user_id, [rid])).get(rid)
    if item is None:
        out.skipped += 1
        return
    cur = getattr(item, name)
    if check and "expect" in op and cur != op["expect"]:
        out.skipped += 1
        return
    if cur == op["value"]:
        return
    out.inverse.append({"op": "restore_field", "entity": "items", "id": rid, "field": name,
                        "value": cur, "expect": op["value"]})  # fmt: skip
    setattr(item, name, op["value"])
    out.items.add(rid)


async def _restore_page_position(session: AsyncSession, user_id: int, op: dict, out: Outcome, *,
                                 by: str, check: bool, now: datetime) -> None:  # fmt: skip
    page = await _screen(session, user_id, op["page"])
    if page is None or page.kind == ScreenKind.SYSTEM_TODAY:
        out.skipped += 1
        return
    if check and "expect" in op and page.position != op["expect"]:
        out.skipped += 1  # the person moved the tab again since
        return
    if page.position == op["position"]:
        return
    out.inverse.append({"op": "restore_page_position", "page": str(page.public_id),
                        "position": page.position, "expect": op["position"]})  # fmt: skip
    page.position = op["position"]
    page.updated_at = now


async def _restore_habit(session: AsyncSession, user_id: int, op: dict, out: Outcome, *,
                         by: str, check: bool, now: datetime) -> None:  # fmt: skip
    state = op.get("state") or {}
    if state.get("status") not in HABIT_STATUSES or not isinstance(state.get("value"), dict):
        raise ValueError("restore_habit: bad state")
    habit = await session.scalar(
        select(UserHabit).where(UserHabit.user_id == user_id,
                                UserHabit.public_id == _uuid(op["id"])).with_for_update()
    )  # fmt: skip
    if habit is None:
        out.skipped += 1
        return
    cur = {"evidence_count": habit.evidence_count, "status": habit.status}
    expect = op.get("expect")
    if check and expect and any(cur.get(k) != v for k, v in expect.items()):
        out.skipped += 1  # the person changed the rule since (turned it off, ...)
        return
    back = {"evidence_count": habit.evidence_count, "status": habit.status,
            "value": dict(habit.value or {})}  # fmt: skip
    if "key" in state:
        back["key"] = habit.key
    if back == state:
        return
    out.inverse.append({"op": "restore_habit", "id": str(habit.public_id), "state": back,
                        "expect": {"evidence_count": int(state.get("evidence_count") or 0),
                                   "status": state["status"]}})  # fmt: skip
    habit.evidence_count = int(state.get("evidence_count") or 0)
    if state.get("key"):
        habit.key = str(state["key"])
    habit.status = state["status"]
    habit.value = dict(state["value"])
    habit.updated_at = now


async def _habit_evidence(session: AsyncSession, user_id: int, op: dict, out: Outcome, *,
                          by: str, check: bool, now: datetime) -> None:  # fmt: skip
    habit = await session.scalar(
        select(UserHabit).where(UserHabit.user_id == user_id,
                                UserHabit.public_id == _uuid(op["id"])).with_for_update()
    )  # fmt: skip
    if habit is None:
        out.skipped += 1
        return
    item, add = str(op["item"]), bool(op.get("add"))
    if habits.count_evidence(habit, item, add=add, now=now):
        out.inverse.append({"op": "habit_evidence", "id": str(habit.public_id), "item": item,
                            "add": not add})  # fmt: skip


async def _owned(session: AsyncSession, user_id: int, entity: str,
                 rid: Any) -> tuple[Any, Item | None]:  # fmt: skip
    """A task or an expense (week 12) and its own record, both locked."""
    if entity == "tasks":
        return await _task(session, user_id, rid)
    from assistant.db.models_expenses import ExpenseEntry

    row = await session.scalar(
        select(ExpenseEntry).where(ExpenseEntry.user_id == user_id,
                                   ExpenseEntry.public_id == _uuid(rid)).with_for_update()
    )  # fmt: skip
    if row is None:
        return None, None
    item = await session.scalar(select(Item).where(Item.id == row.item_id).with_for_update())
    return row, item


async def _task(session: AsyncSession, user_id: int, tid: Any) -> tuple[Task | None, Item | None]:
    task = await session.scalar(
        select(Task).where(Task.user_id == user_id, Task.public_id == _uuid(tid)).with_for_update()
    )  # fmt: skip
    if task is None:
        return None, None
    item = await session.scalar(select(Item).where(Item.id == task.item_id).with_for_update())
    return task, item


def task_value(task: Task, name: str) -> Any:
    """A task field as JSON (dates as ISO text)."""
    value = getattr(task, name)
    return value.isoformat() if isinstance(value, date | datetime) else value


def _task_set(task: Task, name: str, value: Any) -> None:
    if name == "due_date":
        value = date.fromisoformat(value) if value else None
    elif name == "done_at":
        value = datetime.fromisoformat(value) if value else None
    setattr(task, name, value)


async def _set_task(session: AsyncSession, user_id: int, op: dict, out: Outcome, *,
                    by: str, check: bool, now: datetime) -> None:  # fmt: skip
    values = dict(op.get("values") or {})
    if not values or set(values) - TASK_FIELDS:
        raise ValueError("set_task: fields not allowed")
    task, item = await _task(session, user_id, op["id"])
    if task is None or item is None:
        out.skipped += 1
        return
    expect = op.get("expect")
    if check and expect and any(task_value(task, k) != v for k, v in expect.items()):
        out.skipped += 1  # the person changed the task since: theirs stays
        return
    changed = {k: v for k, v in values.items() if task_value(task, k) != v}
    if not changed:
        return
    out.inverse.append({"op": "set_task", "id": str(task.public_id), "item": str(item.public_id),
                        "values": {k: task_value(task, k) for k in changed},
                        "expect": changed})  # fmt: skip
    for k, v in changed.items():
        _task_set(task, k, v)
    task.version += 1
    task.updated_at = now
    out.items.add(str(item.public_id))


async def _reminder(session: AsyncSession, user_id: int, rid: Any) -> Reminder | None:
    return await session.scalar(
        select(Reminder).where(Reminder.user_id == user_id, Reminder.public_id == _uuid(rid),
                               Reminder.kind.in_(APP_KINDS)).with_for_update()
    )  # fmt: skip


def reminder_state(r: Reminder) -> dict[str, Any]:
    """What `restore_reminder` sets back: the fields the person edits, and whether it is live."""
    return {"title": r.title, "body": r.body, "due_at": r.due_at.isoformat(), "tz": r.tz,
            "rrule": r.rrule, "offsets": list(r.offsets or []), "level": r.level,
            "sensitivity": r.sensitivity, "deleted": r.deleted_at is not None}  # fmt: skip


async def _cancel_reminder(session: AsyncSession, user_id: int, op: dict, out: Outcome, *,
                           by: str, check: bool, now: datetime) -> None:  # fmt: skip
    r = await _reminder(session, user_id, op["id"])
    if r is None:
        out.skipped += 1
        return
    if r.deleted_at is not None:
        return
    if check and "expect" in op and r.version != op["expect"]:
        out.skipped += 1  # changed since: the newer version stays
        return
    back = reminder_state(r)
    from assistant.reminders import service as reminders  # reminders -> chat -> actions

    await reminders.delete(session, user_id, r.public_id, now)
    out.inverse.append({"op": "restore_reminder", "id": str(r.public_id), "state": back,
                        "expect": r.version})  # fmt: skip


async def _restore_reminder(session: AsyncSession, user_id: int, op: dict, out: Outcome, *,
                            by: str, check: bool, now: datetime) -> None:  # fmt: skip
    state = dict(op.get("state") or {})
    if set(state) - {*REMINDER_FIELDS, "deleted"}:
        raise ValueError("restore_reminder: fields not allowed")
    r = await _reminder(session, user_id, op["id"])
    if r is None:
        out.skipped += 1
        return
    if check and "expect" in op and r.version != op["expect"]:
        out.skipped += 1
        return
    due = datetime.fromisoformat(state["due_at"]) if state.get("due_at") else r.due_at
    rrule = state.get("rrule", r.rrule)
    if not state.get("deleted") and not rrule and due <= now:
        out.skipped += 1  # a one-off whose time has passed cannot ring again
        return
    back = reminder_state(r)
    if back == state:
        return
    for name in REMINDER_FIELDS:
        if name in state:
            setattr(r, name, due if name == "due_at" else state[name])
    if state.get("deleted"):
        r.deleted_at, r.status = r.deleted_at or now, AppReminderStatus.CANCELLED
    else:
        r.deleted_at, r.snooze_until = None, None
        r.status = AppReminderStatus.SCHEDULED
    r.version += 1
    await session.flush()
    from assistant.reminders import service as reminders  # reminders -> chat -> actions

    await reminders.plan_fires(session, r, now)
    out.inverse.append({"op": "restore_reminder", "id": str(r.public_id), "state": back,
                        "expect": r.version})  # fmt: skip


async def _restore_fires(session: AsyncSession, user_id: int, op: dict, out: Outcome, *,
                         by: str, check: bool, now: datetime) -> None:  # fmt: skip
    r = await _reminder(session, user_id, op["reminder"])
    if r is None:
        out.skipped += 1
        return
    wanted = {str(f["id"]): f for f in op.get("fires") or []}
    rows = list(await session.scalars(
        select(ReminderFire).where(ReminderFire.reminder_id == r.id,
                                   ReminderFire.public_id.in_([_uuid(i) for i in wanted]))
        .with_for_update()))  # fmt: skip
    back = []
    for f in rows:
        w = wanted[str(f.public_id)]
        if check and w.get("expect") and f.state != w["expect"]:
            out.skipped += 1  # the phone reported something newer for this fire
            continue
        if f.state == w["state"]:
            continue
        back.append({"id": str(f.public_id), "state": str(f.state),
                     "acked_at": f.acked_at.isoformat() if f.acked_at else None,
                     "expect": w["state"]})  # fmt: skip
        f.state = w["state"]
        f.acked_at = datetime.fromisoformat(w["acked_at"]) if w.get("acked_at") else None
    inv: dict[str, Any] = {"op": "restore_fires", "reminder": str(r.public_id), "fires": back}
    if op.get("status") and r.status != op["status"] and r.deleted_at is None:
        inv["status"] = str(r.status)
        r.status = op["status"]
    if back or "status" in inv:
        out.inverse.append(inv)
        await session.flush()


def screen_state(page: Screen) -> dict[str, Any]:
    return {k: getattr(page, k) for k in SCREEN_FIELDS}


async def _restore_screen_config(session: AsyncSession, user_id: int, op: dict, out: Outcome, *,
                                 by: str, check: bool, now: datetime) -> None:  # fmt: skip
    page = await _screen(session, user_id, op["page"])
    if page is None or page.kind == ScreenKind.SYSTEM_TODAY:
        out.skipped += 1
        return
    expect = op.get("expect")
    cur = screen_state(page)
    if check and expect and any(cur.get(k) != v for k, v in expect.items()):
        out.skipped += 1  # renamed again since
        return
    new = {k: op[k] for k in SCREEN_FIELDS if k in op}
    changed = {k: v for k, v in new.items() if cur[k] != v}
    if not changed:
        return
    out.inverse.append({"op": "restore_screen_config", "page": str(page.public_id),
                        **{k: cur[k] for k in changed}, "expect": changed})  # fmt: skip
    for k, v in changed.items():
        setattr(page, k, v)
    if "layout" in changed:
        page.view_version += 1
    page.updated_at = now


_HANDLERS = {
    "restore_positions": _restore_positions,
    "restore_view_state": _restore_view_state,
    "add_screen_item": _add_screen_item,
    "remove_screen_item": _remove_screen_item,
    "delete_entity_soft": _soft,
    "restore_entity": _restore,
    "restore_field": _restore_field,
    "restore_page_position": _restore_page_position,
    "restore_habit": _restore_habit,
    "habit_evidence": _habit_evidence,
    "set_task": _set_task,
    "cancel_reminder": _cancel_reminder,
    "restore_reminder": _restore_reminder,
    "restore_screen_config": _restore_screen_config,
    "restore_fires": _restore_fires,
}


def _register_week10() -> None:
    from assistant.actions import (  # need Outcome and the helpers above
        ops_dedup,
        ops_expenses,
        ops_view,
    )

    _HANDLERS.update(ops_dedup.HANDLERS)
    _HANDLERS.update(ops_view.HANDLERS)
    _HANDLERS.update(ops_expenses.HANDLERS)


_register_week10()


def validate(ops: list[dict[str, Any]]) -> None:
    for op in ops:
        if not isinstance(op, dict) or op.get("op") not in OPS:
            raise ValueError(f"op not allowed: {op.get('op') if isinstance(op, dict) else op}")
        if op["op"] in ("delete_entity_soft", "restore_entity", "restore_field") \
                and op.get("entity") not in ENTITIES:  # fmt: skip
            raise ValueError("entity not allowed")


async def apply(session: AsyncSession, user_id: int, ops: list[dict[str, Any]], *, by: str,
                check: bool, now: datetime) -> Outcome:  # fmt: skip
    """Run `ops` in order inside the caller's transaction. Returns their undo, newest first."""
    validate(ops)
    await lock_user(session, user_id)
    out = Outcome()
    for op in ops:
        await _HANDLERS[op["op"]](session, user_id, op, out, by=by, check=check, now=now)
    await session.flush()
    if out.pages:
        await session.execute(update(Screen).where(Screen.id.in_(out.pages))
                              .values(view_version=Screen.view_version + 1, updated_at=now))
    out.inverse.reverse()
    return out


def op_items(op: dict[str, Any]) -> set[str]:
    """Item ids an op is about (empty: a page-level op). A view setting (week 11) is named by
    its «Что изменилось» key instead, so «Вернуть» on that row undoes it alone."""
    if op.get("change"):
        return {str(op["change"])}
    if op["op"] == "restore_positions":
        return {str(r["item"]) for r in op.get("rows") or []}
    if op.get("item"):  # add/remove_screen_item, habit_evidence, task ops
        return {str(op["item"])}
    if op.get("entity") == "items":
        return {str(op["id"])}
    return set()


def select_ops(ops: list[dict[str, Any]], *, only: set[str] | None,
               without: set[str]) -> list[dict[str, Any]]:  # fmt: skip
    """The ops (and rows) for some items. `only=None`: everything except `without`."""
    out = []
    for op in ops:
        ids = op_items(op)
        if not ids:
            if only is None:
                out.append(op)
            continue
        keep = (ids & only if only is not None else ids) - without
        if not keep:
            continue
        if op["op"] == "restore_positions":
            out.append({**op, "rows": [r for r in op["rows"] if str(r["item"]) in keep]})
        else:
            out.append(op)
    return out
