"""Operations of pages and the trash (Ф-97, chat-full-control.md phase 2):

- `pages.delete`: «Убрать страницу» — the page goes (soft, `/restore` and «Отменить» bring it
  back), its records stay (R-50). Reversible, so no «Да» (Ф-66). The «Сегодня» page is never.
- `pages.restore`: a removed page back, with what was saved while it was gone.
- `trash.restore`: records back from «Удалённые записи» (within their 30 days), each as what it
  is: a to-do's record with its to-do, an expense's with its expense, a КП with its document.

Permanent deletion is not an operation at all (Ф-95 (4)): only the trash screen does it.
"""

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.db.models import Item
from assistant.db.models_actions import ActionKind
from assistant.db.models_expenses import ExpenseEntry
from assistant.db.models_pages import MAX_PAGES, Screen, ScreenKind
from assistant.db.models_tasks import Task
from assistant.operations.registry import Built, Operation, OpError, register

MAX_RESTORE = 50


class PageRef(BaseModel):
    model_config = ConfigDict(extra="forbid")
    page_id: uuid.UUID


async def _page(session: AsyncSession, user_id: int, page_id: uuid.UUID) -> Screen:
    page = await session.scalar(select(Screen).where(Screen.user_id == user_id,
                                                     Screen.public_id == page_id))
    if page is None:
        raise OpError("not_found", 404)
    return page


def _page_row(page: Screen, kind: str, text: str) -> dict[str, Any]:
    return {"item_id": None, "title": page.title, "kind": kind,
            "page_id": str(page.public_id), "text": text}


async def _delete_page(session: AsyncSession, user_id: int, args: PageRef, *,
                       now: datetime) -> Built:  # fmt: skip
    page = await _page(session, user_id, args.page_id)
    if page.kind == ScreenKind.SYSTEM_TODAY:
        raise OpError("page_system", 403)
    sentence = f"Страница «{page.title}» убрана. Записи остались"
    ops = [] if page.deleted_at is not None else [
        {"op": "delete_entity_soft", "entity": "screens", "id": str(page.public_id)}]
    return Built(ops=ops, kind=ActionKind.DELETE_SCREEN, sentence=sentence,
                 changes=[_page_row(page, "delete_page", sentence)], touched=("pages",),
                 data={"page": page})  # fmt: skip


async def _restore_page(session: AsyncSession, user_id: int, args: PageRef, *,
                        now: datetime) -> Built:  # fmt: skip
    page = await _page(session, user_id, args.page_id)
    if page.deleted_at is None:
        return Built(ops=[], kind=ActionKind.DELETE_SCREEN, sentence="", touched=("pages",))
    live = (Screen.user_id == user_id, Screen.deleted_at.is_(None))
    if (await session.scalar(select(func.count()).select_from(Screen).where(*live)) or 0) \
            >= MAX_PAGES:  # fmt: skip
        raise OpError("pages_limit")
    if page.singleton and await session.scalar(select(Screen.id).where(
            *live, Screen.template_key == page.template_key, Screen.id != page.id)):
        raise OpError("singleton_exists", 409)  # fmt: skip
    sentence = f"Вернул страницу «{page.title}»"
    return Built(ops=[{"op": "restore_entity", "entity": "screens", "id": str(page.public_id)}],
                 kind=ActionKind.CREATE_SCREEN, sentence=sentence,
                 changes=[_page_row(page, "create_page", sentence)], touched=("pages",),
                 data={"page": page})  # fmt: skip


class TrashRef(BaseModel):
    model_config = ConfigDict(extra="forbid")
    item_ids: list[uuid.UUID] = Field(min_length=1, max_length=MAX_RESTORE)


async def _restore(session: AsyncSession, user_id: int, args: TrashRef, *,
                   now: datetime) -> Built:  # fmt: skip
    from assistant.db.models_kp import Document

    items = {i.public_id: i for i in await session.scalars(select(Item).where(
        Item.user_id == user_id, Item.public_id.in_(args.item_ids),
        Item.deleted_at.is_not(None)))}  # fmt: skip
    pks = [i.id for i in items.values()] or [0]
    tasks = {t.item_id: t for t in await session.scalars(select(Task).where(
        Task.user_id == user_id, Task.item_id.in_(pks)))}  # fmt: skip
    spends = {e.item_id: e for e in await session.scalars(select(ExpenseEntry).where(
        ExpenseEntry.user_id == user_id, ExpenseEntry.item_id.in_(pks)))}  # fmt: skip
    docs = {d.item_id: d for d in await session.scalars(select(Document).where(
        Document.user_id == user_id, Document.item_id.in_(pks)))}  # fmt: skip
    ops: list[dict[str, Any]] = []
    changes: list[dict[str, Any]] = []
    touched: set[str] = {"records"}
    for pid in dict.fromkeys(args.item_ids):
        item = items.get(pid)
        if item is None:
            continue  # not in the trash (back already, or gone for good)
        title = item.title or "Запись"
        row = {"item_id": str(pid), "title": title, "kind": "restore", "page_id": None,
               "text": f"«{title}» — снова на месте"}
        if (task := tasks.get(item.id)) is not None:
            ops.append({"op": "restore_entity", "entity": "tasks", "id": str(task.public_id),
                        "item": str(pid)})  # fmt: skip
            row["task_id"] = str(task.public_id)
            touched |= {"tasks", "calendar"}
        elif (entry := spends.get(item.id)) is not None:
            ops.append({"op": "restore_entity", "entity": "expenses", "id": str(entry.public_id),
                        "item": str(pid)})  # fmt: skip
            row["expense_id"] = str(entry.public_id)
            touched |= {"expenses", "budget"}
        elif (doc := docs.get(item.id)) is not None:
            ops.append({"op": "restore_entity", "entity": "documents", "id": str(doc.public_id),
                        "item": str(pid)})  # fmt: skip
        else:
            ops.append({"op": "restore_entity", "entity": "items", "id": str(pid)})
        changes.append(row)
    if not ops:
        raise OpError("not_found", 404)
    n = len(changes)
    sentence = (f"Вернул из корзины: {changes[0]['title']}" if n == 1
                else f"Вернул из корзины: {n} " + _records(n))  # fmt: skip
    return Built(ops=ops, kind="restore_item", sentence=sentence, changes=changes,
                 source_item_ids=[i.id for i in items.values()],
                 touched=tuple(sorted(touched)))  # fmt: skip


def _records(n: int) -> str:
    n100, n10 = n % 100, n % 10
    if n10 == 1 and n100 != 11:
        return "запись"
    if 2 <= n10 <= 4 and not 12 <= n100 <= 14:
        return "записи"
    return "записей"


register(Operation("pages.delete", "pages", "safe", PageRef, build=_delete_page,
                   description="remove a page (its records stay; it can be brought back)"))
register(Operation("pages.restore", "pages", "safe", PageRef, build=_restore_page,
                   description="bring a removed page back"))
register(Operation("trash.restore", "pages", "safe", TrashRef, build=_restore,
                   description="records back from the trash (a to-do / an expense with them)"))
