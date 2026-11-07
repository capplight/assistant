"""PagePatch: the rows of a page as they are now, for the phone to apply at once (chat event
`page_patch`, undo response). Shape: docs/api/chat.md (PagePatch); `rows[]` = the `link` object of
docs/api/pages.md."""

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.db.models import Item
from assistant.db.models_pages import Screen, ScreenItem


def link_dict(link: ScreenItem, page_id: uuid.UUID, item_id: uuid.UUID) -> dict[str, Any]:
    return {
        "id": str(link.public_id), "page_id": str(page_id), "item_id": str(item_id),
        "position": link.position, "group_key": link.group_key,
        "manual_order": link.manual_order,
        "manual_at": link.manual_at.isoformat() if link.manual_at else None,
        "pinned": link.pinned, "added_by": link.added_by,
        "removed_at": link.removed_by_user_at.isoformat() if link.removed_by_user_at else None,
        "seq": link.seq, "updated_at": link.updated_at.isoformat(), "updated_by": link.updated_by,
    }  # fmt: skip


async def page_patches(session: AsyncSession, user_id: int, screen_pks: set[int],
                       item_ids: set[str]) -> list[dict[str, Any]]:  # fmt: skip
    """One patch per page: its view and the rows of `item_ids` on it (call after flush)."""
    if not screen_pks:
        return []
    pages = list(await session.scalars(
        select(Screen).where(Screen.user_id == user_id, Screen.id.in_(screen_pks))
        .order_by(Screen.id).execution_options(populate_existing=True)))  # fmt: skip
    ids = [uuid.UUID(i) for i in item_ids]
    pk_of: dict[uuid.UUID, int] = {}
    if ids:
        pk_of = {pid: pk for pk, pid in await session.execute(
            select(Item.id, Item.public_id).where(Item.user_id == user_id,
                                                  Item.public_id.in_(ids)))}  # fmt: skip
    out = []
    for page in pages:
        rows = []
        found: set[int] = set()
        if pk_of:
            for link, item_pid in await session.execute(
                    select(ScreenItem, Item.public_id).join(Item, Item.id == ScreenItem.item_id)
                    .where(ScreenItem.screen_id == page.id,
                           ScreenItem.item_id.in_(pk_of.values()))
                    .order_by(ScreenItem.position, Item.public_id)):  # fmt: skip
                rows.append(link_dict(link, page.public_id, item_pid))
                found.add(link.item_id)
        out.append({
            "page_id": str(page.public_id), "view_version": page.view_version,
            "view_state": page.view_state or {}, "rows": rows,
            "removed_item_ids": sorted(str(pid) for pid, pk in pk_of.items() if pk not in found),
        })  # fmt: skip
    return out
