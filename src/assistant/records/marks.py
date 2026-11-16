"""«Изменил помощник» (Ф-73): a record the assistant created or changed carries a mark for 24 h.

Stored on the record (`items.assistant_changed_at`, `items.assistant_action_id`, 0029); a task
or an expense shows the mark of its own record. Set by `actions.record` / `extend` for every
record of an agent action; cleared when the person edits the record (any action of theirs that
names it, `PATCH /v1/items`) or undoes the action that set it. Older than `MARK_HOURS`: the API
shows nothing (`mark_fields`), the column is left as is.
"""

import uuid
from collections.abc import Iterable
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.db.models import Item

MARK_HOURS = 24


def _uuids(ids: Iterable[Any]) -> list[uuid.UUID]:
    out = []
    for i in ids:
        try:
            out.append(i if isinstance(i, uuid.UUID) else uuid.UUID(str(i)))
        except ValueError:
            continue
    return list(dict.fromkeys(out))


async def set_marks(session: AsyncSession, user_id: int, item_ids: Iterable[Any],
                    action_id: uuid.UUID, now: datetime) -> None:  # fmt: skip
    ids = _uuids(item_ids)
    if not ids:
        return
    # ORM rows, not a bulk UPDATE: objects already in the session keep a fresh `seq`
    for item in await session.scalars(select(Item).where(Item.user_id == user_id,
                                                         Item.public_id.in_(ids))):
        item.assistant_changed_at, item.assistant_action_id = now, action_id
    await session.flush()


async def clear_marks(session: AsyncSession, user_id: int, item_ids: Iterable[Any], *,
                      action_id: uuid.UUID | None = None) -> None:  # fmt: skip
    """The person edited these records (or undid `action_id`: only its marks go)."""
    ids = _uuids(item_ids)
    if not ids:
        return
    where = [Item.user_id == user_id, Item.public_id.in_(ids),
             Item.assistant_changed_at.is_not(None)]  # fmt: skip
    if action_id is not None:
        where.append(Item.assistant_action_id == action_id)
    marked = list(await session.scalars(select(Item).where(*where)))
    for item in marked:
        item.assistant_changed_at = item.assistant_action_id = None
    if marked:
        await session.flush()


def mark_fields(changed_at: datetime | None, action_id: uuid.UUID | None,
                now: datetime | None = None) -> dict[str, Any]:  # fmt: skip
    """The payload fields: `assistant_changed_at` / `assistant_action_id`, null after 24 h."""
    now = now or datetime.now(UTC)
    if changed_at is None or now - changed_at >= timedelta(hours=MARK_HOURS):
        return {"assistant_changed_at": None, "assistant_action_id": None}
    return {"assistant_changed_at": changed_at, "assistant_action_id": action_id}
