"""Plans in the database (step 8, docs/api/plans.md).

A plan is a record: `items.kind = 'plan'` (0033), made by the assistant (`ai_generated`, source
`system`), its structure in `source_meta.plan`, its readable text in `text` (search, export). It
is placed by the page rules like any note («Заметки»). Short transactions; the caller commits.

- `new_item` / `edit_ops`: a plan made or changed in the chat (chat/plan_line.py writes the
  action with «Отменить»).
- `make_tasks`: «Сделать делами» — every step of an action plan becomes a task on «Дела» (its
  deadline computed by code when the plan was made) and, for a step with a time, a reminder.
  One action per step, all in one group (`payload.group_id`): one «Отменить» for the whole group
  (`POST /v1/actions/groups/{group_id}/undo`), each step also alone.
- `plan_dict`: the plan with its records and its tasks as they are now (`GET /v1/plans/{id}`).
"""

import uuid
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.actions import record
from assistant.actions.service import counts_text
from assistant.db.models import Item, Reminder
from assistant.db.models_actions import Action, ActionKind
from assistant.db.models_pages import Screen, ScreenItem, ScreenKind
from assistant.db.models_tasks import ListKey, Task
from assistant.db.models_v2 import RecordKind, RecordSource, RecordStatus
from assistant.memory import enqueue_embed
from assistant.pages import lock_user, place_item
from assistant.records import content_hash, detect_lang


class PlanError(ValueError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def plan_of(item: Item) -> dict[str, Any] | None:
    if str(item.kind) != RecordKind.PLAN:
        return None
    plan = (item.source_meta or {}).get("plan")
    return plan if isinstance(plan, dict) else None


async def new_item(session: AsyncSession, user_id: int, plan: dict[str, Any], text: str, *,
                   phrase: str | None = None) -> Item:  # fmt: skip
    """The plan's record, placed by the page rules (it lands on «Заметки»)."""
    await lock_user(session, user_id)
    meta: dict[str, Any] = {"plan": plan}
    if phrase:
        meta["asked"] = phrase[:500]  # what the person asked for (the plan screen shows it)
    item = Item(user_id=user_id, client_id=uuid.uuid4(), kind=RecordKind.PLAN,
                source=RecordSource.SYSTEM, status=RecordStatus.READY, title=plan["title"],
                text=text, text_lang=detect_lang(text), content_hash=content_hash(text),
                source_meta=meta, ai_generated=True)  # fmt: skip
    session.add(item)
    await session.flush()
    item.occurred_at = item.created_at
    await place_item(session, item)
    await enqueue_embed(session, item)
    await session.flush()
    return item


async def pages_of(session: AsyncSession, item_pk: int) -> list[dict[str, Any]]:
    rows = await session.execute(
        select(Screen.public_id, Screen.title, Screen.id)
        .join(ScreenItem, ScreenItem.screen_id == Screen.id)
        .where(ScreenItem.item_id == item_pk, ScreenItem.removed_by_user_at.is_(None),
               Screen.deleted_at.is_(None), Screen.kind == ScreenKind.PAGE)
        .order_by(Screen.position))  # fmt: skip
    return [{"page_id": str(pid), "title": title, "pk": pk} for pid, title, pk in rows]


# --- «Сделать делами» ---


@dataclass
class Converted:
    group_id: str
    actions: list[Action] = field(default_factory=list)
    tasks: list[Task] = field(default_factory=list)
    reminders: list[Reminder] = field(default_factory=list)
    pages: set[int] = field(default_factory=set)
    items: set[str] = field(default_factory=set)
    skipped: int = 0  # steps that are tasks already
    repeated: bool = False

    @property
    def counts(self) -> dict[str, int]:
        return {"tasks": len(self.tasks), "reminders": len(self.reminders)}

    @property
    def sentence(self) -> str:
        what = counts_text(self.counts)
        return f"Сделал {what}." if what else "Шаги уже в «Делах»."


async def _live_task(session: AsyncSession, user_id: int, task_id: str | None) -> Task | None:
    if not task_id:
        return None
    try:
        tid = uuid.UUID(str(task_id))
    except ValueError:
        return None
    task = await session.scalar(select(Task).where(Task.user_id == user_id,
                                                   Task.public_id == tid))  # fmt: skip
    if task is None or task.deleted_at is not None:
        return None
    gone = await session.scalar(select(Item.deleted_at).where(Item.id == task.item_id))
    return None if gone is not None else task


async def repeat_of(session: AsyncSession, user_id: int,
                    client_id: uuid.UUID | None) -> list[Action] | None:  # fmt: skip
    """The same «Сделать делами» again (same `client_id`): the actions it made."""
    if client_id is None:
        return None
    first = await session.scalar(select(Action).where(Action.user_id == user_id,
                                                      Action.client_id == client_id))  # fmt: skip
    if first is None:
        return None
    gid = (first.payload or {}).get("group_id")
    if not gid:
        return [first]
    return list(await session.scalars(select(Action).where(
        Action.user_id == user_id, Action.payload["group_id"].astext == str(gid),
        Action.undo_of_action_id.is_(None)).order_by(Action.id)))  # fmt: skip


async def make_tasks(session: AsyncSession, user_id: int, item: Item, *, by: str, now: datetime,
                     tz: str, step_ids: list[str] | None = None,
                     client_id: uuid.UUID | None = None, message_pk: int | None = None,
                     group_id: str | None = None) -> Converted:  # fmt: skip
    """Every step (or the named ones) not yet a live task becomes a task on «Дела» with its
    deadline, and a reminder when the step has a time in the future. One action per step."""
    from assistant.reminders import service as reminders
    from assistant.tasks import TaskSpec
    from assistant.tasks import service as tasks_service

    await lock_user(session, user_id)
    plan = plan_of(item)
    if plan is None or item.deleted_at is not None:
        raise PlanError("not_a_plan")
    if plan.get("kind") != "actions" or not plan.get("steps"):
        raise PlanError("plan_has_no_steps")
    out = Converted(group_id or str(uuid.uuid4()))
    steps = [dict(s) for s in plan["steps"]]
    want = set(step_ids) if step_ids else None
    zone = ZoneInfo(tz)
    pending: list[tuple[dict[str, Any], list[dict], list[dict], str]] = []
    for step in steps:
        if want is not None and step["id"] not in want:
            continue
        if await _live_task(session, user_id, step.get("task_id")) is not None:
            out.skipped += 1
            continue
        due = date.fromisoformat(step["due_date"]) if step.get("due_date") else None
        # 0035: a step with a time is a block on the calendar (its reminder is its alert)
        start = (datetime.fromisoformat(step["remind_at"]).replace(tzinfo=zone)
                 if step.get("remind_at") else None)  # fmt: skip
        length = step.get("duration_min") if isinstance(step.get("duration_min"), int) else None
        spec = TaskSpec(ListKey.TODO, step["title"], due_date=due, start_at=start,
                        duration_min=length, tz=tz if start is not None else None)
        added = await tasks_service.add(session, user_id, [spec],
                                        by=by, now=now, source_item_id=item.id)  # fmt: skip
        if not added.tasks:
            continue
        task = added.tasks[0]
        inverse, changes = list(added.inverse), list(added.changes)
        out.tasks.append(task)
        out.pages |= added.pages
        out.items |= added.items
        step["task_id"] = str(task.public_id)
        if step.get("remind_at"):
            local = datetime.fromisoformat(step["remind_at"]).replace(tzinfo=zone)
            if local.astimezone(UTC) > now:
                try:
                    r, _, _ = await reminders.create(session, user_id, reminders.ReminderInput(
                        title=step["title"][:200], due_at=local, tz=tz, item_id=task.item_id,
                        created_via="agent_suggestion", parse_source="llm"), now)  # fmt: skip
                except reminders.ReminderError:
                    r = None
                if r is not None:
                    out.reminders.append(r)
                    step["reminder_id"] = str(r.public_id)
                    inverse.insert(0, {"op": "cancel_reminder", "id": str(r.public_id),
                                       "expect": r.version})  # fmt: skip
                    changes.append({"item_id": None, "reminder_id": str(r.public_id),
                                    "title": r.title or "", "kind": "reminder", "page_id": None,
                                    "text": f"Напомню: {local:%d.%m, %H:%M}"})  # fmt: skip
        pending.append((step, inverse, changes, added.sentence))
    if not pending:
        return out
    for i, (step, inverse, changes, sentence) in enumerate(pending):
        task_pk = next(t.item_id for t in out.tasks if str(t.public_id) == step["task_id"])
        out.actions.append(await record(
            session, user_id=user_id, kind=ActionKind.SAVE_ITEM, initiated_by=by,
            summary={"ru": sentence, "kk": None}, changes=changes, inverse=inverse, now=now,
            screen_id=next(iter(out.pages), None), message_id=message_pk,
            source_item_ids=[task_pk, item.id], client_id=client_id if i == 0 else None,
            extra={"group_id": out.group_id, "group_counts": {}, "plan_id": str(item.public_id),
                   "plan_step": step["id"]}))  # fmt: skip
    for a in out.actions:  # the counts are known only now; every member carries them
        a.payload = {**a.payload, "group_counts": out.counts}
    by_id = {s["id"]: s for s, *_ in pending}
    plan = {**plan, "steps": [by_id.get(s["id"], s) for s in plan["steps"]]}
    item.source_meta = {**(item.source_meta or {}), "plan": plan}
    await session.flush()
    return out


# --- read ---


def _iso(v: datetime | None) -> str | None:
    return v.isoformat() if v else None


async def plan_dict(session: AsyncSession, item: Item) -> dict[str, Any]:
    """The plan as it is now: its records (gone ones say so) and the state of its tasks."""
    plan = plan_of(item) or {}
    ids = {s["item_id"] for s in plan.get("sources") or []}
    for d in plan.get("days") or []:
        ids |= {p["source_id"] for p in d["points"] if p.get("source_id")}
    ids |= {s["source_id"] for s in plan.get("steps") or [] if s.get("source_id")}
    found: dict[str, Item] = {}
    if ids:
        uids = [uuid.UUID(i) for i in ids]
        for it in await session.scalars(select(Item).where(Item.user_id == item.user_id,
                                                           Item.public_id.in_(uids))):
            found[str(it.public_id)] = it
    sources = []
    for s in plan.get("sources") or []:
        it = found.get(s["item_id"])
        sources.append({**s, "title": (it.title or s["title"]) if it else s["title"],
                        "available": it is not None and it.deleted_at is None
                        and it.hidden_reason is None,
                        "occurred_at": _iso(it.occurred_at) if it else None})  # fmt: skip
    task_ids = [uuid.UUID(s["task_id"]) for s in plan.get("steps") or [] if s.get("task_id")]
    tasks: dict[str, Task] = {}
    live_items: set[int] = set()
    if task_ids:
        for t in await session.scalars(select(Task).where(Task.public_id.in_(task_ids))):
            tasks[str(t.public_id)] = t
        live_items = set(await session.scalars(select(Item.id).where(
            Item.id.in_([t.item_id for t in tasks.values()]), Item.deleted_at.is_(None))))
    steps = []
    for s in plan.get("steps") or []:
        t = tasks.get(s.get("task_id") or "")
        live = t is not None and t.deleted_at is None and t.item_id in live_items
        steps.append({**s, "task": {"id": str(t.public_id), "done": t.done_at is not None,
                                    "due_date": t.due_date.isoformat() if t.due_date else None}
                      if live and t is not None else None})  # fmt: skip
    pages = await pages_of(session, item.id)
    return {
        "id": str(item.public_id), "kind": plan.get("kind"), "title": item.title,
        "start_date": plan.get("start_date"), "end_date": plan.get("end_date"),
        "days": plan.get("days") or [], "steps": steps, "sources": sources,
        "counts": plan.get("counts") or {}, "asked": (item.source_meta or {}).get("asked"),
        "text": item.text, "pages": [{"page_id": p["page_id"], "title": p["title"]}
                                     for p in pages],
        "can_make_tasks": plan.get("kind") == "actions"
        and any(x["task"] is None for x in steps),
        "check_note": "составил по вашим записям — проверьте"
        if (plan.get("counts") or {}).get("sources") else None,
        "ai_generated": True, "seq": item.seq, "created_at": _iso(item.created_at),
        "updated_at": _iso(item.updated_at), "deleted_at": _iso(item.deleted_at),
    }  # fmt: skip
