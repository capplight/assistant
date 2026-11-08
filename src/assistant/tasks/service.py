"""Tasks: one line of «Дела» or «Покупки», each with its own record (F-12, US-10).

A task's record is a plain note (text = the title): pages show records, so the task is on its list
page through that record's row, is found by search and goes to the trash with «Отменить». The
changes here run inside the caller's transaction and return the undo ops (assistant.actions
engine); the caller writes the action and commits. Writers take the per-user sync lock first.
"""

import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.actions import engine
from assistant.db.models import Item
from assistant.db.models_actions import Initiator
from assistant.db.models_pages import Screen
from assistant.db.models_tasks import ListKey, Task
from assistant.db.models_v2 import RecordKind, RecordSource, RecordStatus
from assistant.pages import lock_user, place_item
from assistant.records import content_hash, detect_lang, enqueue_ingest, normalize_text
from assistant.tasks.parse import QTY_MAX, TITLE_MAX, TaskSpec

# The page a list shows on: «Покупки», else «Дела и напоминания» (US-10).
LIST_PAGES: dict[str, tuple[str, ...]] = {ListKey.SHOPPING: ("shopping", "tasks"),
                                          ListKey.TODO: ("tasks",)}  # fmt: skip
LIST_OF_TEMPLATE = {"shopping": ListKey.SHOPPING, "tasks": ListKey.TODO}


class TaskError(ValueError):
    pass


def clean_title(value: str | None) -> str:
    title = " ".join((value or "").split())
    if not 1 <= len(title) <= TITLE_MAX:
        raise TaskError("validation_error")
    return title


def clean_short(value: str | None) -> str | None:
    text = " ".join((value or "").split()) or None
    if text is not None and len(text) > QTY_MAX:
        raise TaskError("validation_error")
    return text


def lower_first(title: str) -> str:
    """«Хлеб» → «хлеб» inside a sentence; «ТОО Арман», «Ерлану» stay (two capitals, a name)."""
    if len(title) > 1 and title[1].isupper():
        return title
    return title[:1].lower() + title[1:]


async def list_page(session: AsyncSession, user_id: int, list_key: str) -> Screen | None:
    """The live page this list shows on, or None (no page is made for it, R-55)."""
    for key in LIST_PAGES[list_key]:
        page = await session.scalar(
            select(Screen).where(Screen.user_id == user_id, Screen.template_key == key,
                                 Screen.deleted_at.is_(None)).order_by(Screen.id).limit(1)
        )  # fmt: skip
        if page is not None:
            return page
    return None


def sentence_for(page: Screen | None, list_key: str, titles: Sequence[str]) -> str:
    what = ", ".join(lower_first(t) for t in titles)
    if page is None:
        return f"Записал: {what}."
    if page.template_key == "tasks" and list_key == ListKey.TODO:
        return f"Добавил в дела: {what}."
    return f"Добавил в {page.title}: {what}."


@dataclass
class Added:
    tasks: list[Task] = field(default_factory=list)
    inverse: list[dict[str, Any]] = field(default_factory=list)
    changes: list[dict[str, Any]] = field(default_factory=list)
    pages: set[int] = field(default_factory=set)
    items: set[str] = field(default_factory=set)
    page: Screen | None = None
    sentence: str = ""
    item_pks: list[int] = field(default_factory=list)


async def add(session: AsyncSession, user_id: int, specs: Sequence[TaskSpec], *, by: str,
              now: datetime, client_id: uuid.UUID | None = None,
              source_item_id: int | None = None, voice: bool = False) -> Added:  # fmt: skip
    """New tasks of one list (one phrase or one tap). An open task with the same title is not
    added twice; a ticked one comes back on the list."""
    await lock_user(session, user_id)
    out = Added()
    if not specs:
        return out
    list_key = specs[0].list_key
    page = await list_page(session, user_id, list_key)
    out.page = page
    titles: list[str] = []
    for spec in specs:
        title = clean_title(spec.title)
        same = await session.scalar(
            select(Task).join(Item, Item.id == Task.item_id)
            .where(Task.user_id == user_id, Task.list_key == spec.list_key,
                   Task.deleted_at.is_(None), Item.deleted_at.is_(None),
                   func.lower(Task.title) == title.lower())
            .order_by(Task.id.desc()).limit(1)
        )  # fmt: skip
        if same is not None:
            item_pid = await session.scalar(select(Item.public_id).where(Item.id == same.item_id))
            if same.done_at is not None:  # bought before: back on the list
                res = await engine.apply(session, user_id, [
                    {"op": "set_task", "id": str(same.public_id), "item": str(item_pid),
                     "values": {"done_at": None}}], by=by, check=False, now=now)  # fmt: skip
                out.inverse = [*res.inverse, *out.inverse]
            out.tasks.append(same)
            out.items.add(str(item_pid))
            out.item_pks.append(same.item_id)
            out.changes.append({"item_id": str(item_pid), "task_id": str(same.public_id),
                                "title": same.title, "kind": "create",
                                "page_id": str(page.public_id) if page else None,
                                "text": f"«{same.title}» — уже в списке"})  # fmt: skip
            titles.append(same.title)
            continue
        body = normalize_text(title)
        item = Item(user_id=user_id, client_id=uuid.uuid4(), kind=RecordKind.NOTE,
                    source=RecordSource.MIC if voice else RecordSource.TYPED,
                    status=RecordStatus.PENDING, title=None, text=body,
                    text_lang=detect_lang(body), content_hash=content_hash(body),
                    source_meta={"task_list": str(spec.list_key)},
                    ai_generated=by == Initiator.AGENT)  # fmt: skip
        session.add(item)
        await session.flush()
        item.occurred_at = item.created_at
        task = Task(user_id=user_id, item_id=item.id, list_key=str(spec.list_key), title=title,
                    qty=clean_short(spec.qty) if spec.list_key == ListKey.SHOPPING else None,
                    where_text=clean_short(spec.where) if spec.list_key == ListKey.SHOPPING
                    else None,
                    due_date=spec.due_date if spec.list_key == ListKey.TODO else None,
                    source_item_id=source_item_id,
                    client_id=client_id if len(specs) == 1 else None)  # fmt: skip
        session.add(task)
        await session.flush()
        await enqueue_ingest(session, item)
        await place_item(session, item)  # the page rules, as for any record («Заметки»)
        inverse: list[dict[str, Any]] = [{"op": "delete_entity_soft", "entity": "tasks",
                                          "id": str(task.public_id),
                                          "item": str(item.public_id)}]  # fmt: skip
        if page is not None:
            res = await engine.apply(session, user_id, [
                {"op": "add_screen_item", "page": str(page.public_id),
                 "item": str(item.public_id)}], by=by, check=False, now=now)  # fmt: skip
            # The row goes with the task's trash; dropping it first would leave «убрано» marks.
            out.pages |= res.pages
        out.inverse = [*inverse, *out.inverse]
        out.tasks.append(task)
        out.items.add(str(item.public_id))
        out.item_pks.append(item.id)
        out.changes.append({"item_id": str(item.public_id), "task_id": str(task.public_id),
                            "title": title, "kind": "create",
                            "page_id": str(page.public_id) if page else None,
                            "text": f"«{title}»" + (f" → {page.title}" if page else "")})
        titles.append(title)
    if page is not None:
        out.pages.add(page.id)
    out.sentence = sentence_for(page, list_key, titles)
    return out


async def get(session: AsyncSession, user_id: int, public_id: uuid.UUID) -> Task | None:
    return await session.scalar(select(Task).where(Task.user_id == user_id,
                                                   Task.public_id == public_id))  # fmt: skip


async def item_public_id(session: AsyncSession, task: Task) -> uuid.UUID:
    pid = await session.scalar(select(Item.public_id).where(Item.id == task.item_id))
    assert pid is not None
    return pid


async def is_live(session: AsyncSession, task: Task) -> bool:
    deleted = await session.scalar(select(Item.deleted_at).where(Item.id == task.item_id))
    return task.deleted_at is None and deleted is None


def done_sentence(task: Task, done: bool) -> str:
    what = lower_first(task.title)
    if not done:
        return f"Вернул: {what}"
    return f"Купил: {what}" if task.list_key == ListKey.SHOPPING else f"Сделал: {what}"


async def tasks_dicts(session: AsyncSession, rows: Sequence[Task]) -> list[dict[str, Any]]:
    pids: dict[int, uuid.UUID] = {}
    ids = {t.item_id for t in rows}
    if ids:
        pids = dict((await session.execute(
            select(Item.id, Item.public_id).where(Item.id.in_(ids)))).tuples().all())  # fmt: skip
    return [task_dict(t, pids.get(t.item_id)) for t in rows]


def task_dict(t: Task, item_id: uuid.UUID | None) -> dict[str, Any]:
    return {
        "id": t.public_id, "client_id": t.client_id, "item_id": item_id, "list_key": t.list_key,
        "title": t.title, "qty": t.qty, "where": t.where_text,
        "due_date": t.due_date.isoformat() if t.due_date else None,
        "done": t.done_at is not None, "done_at": t.done_at, "version": t.version, "seq": t.seq,
        "created_at": t.created_at, "updated_at": t.updated_at, "deleted_at": t.deleted_at,
    }  # fmt: skip


def field_values(template_key: str, task: Task) -> dict[str, Any]:
    """Page fields from the task (the templates' `task.*` / `facet.*` sources)."""
    if template_key == "shopping":
        values = {"what": task.title, "qty": task.qty, "bought": task.done_at is not None,
                  "where": task.where_text}  # fmt: skip
    elif template_key == "tasks":
        values = {"what": task.title,
                  "when": task.due_date.isoformat() if task.due_date else None,
                  "done": task.done_at is not None}  # fmt: skip
    else:
        return {}
    return {k: v for k, v in values.items() if v is not None}
