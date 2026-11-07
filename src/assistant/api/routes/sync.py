"""/v1/sync?since=<seq>&limit=: everything that changed for this user after `since`, in seq order.

Rows carry `seq` from the shared `sync_seq` sequence (trigger on every insert/update). Writers
of one user's rows take a per-user advisory lock before taking a seq, so seq order equals commit
order per user and a client that stores `next_since` never misses a change.

Soft-deleted records come back as items with `deleted_at` (trash); records purged after 30 days
come back as tombstones. Week 2: items only; other synced entities join the same response.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select, update

from assistant.api.consent_gate import require_base_consent
from assistant.api.deps import CurrentUser, Db
from assistant.api.routes.items import items_out
from assistant.api.schemas import SyncOut, TombstoneOut
from assistant.db.models import Item
from assistant.db.models_v2 import Device, SyncTombstone

router = APIRouter(prefix="/sync", tags=["sync"])
GatedUser = Annotated[CurrentUser, Depends(require_base_consent)]


@router.get("", response_model=SyncOut)
async def sync(
    user: GatedUser, db: Db,
    since: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=500)] = 200,
) -> SyncOut:  # fmt: skip
    items = list(
        await db.scalars(
            select(Item)
            .where(Item.user_id == user.id, Item.seq > since)
            .order_by(Item.seq)
            .limit(limit + 1)
        )
    )
    tombs = list(
        await db.scalars(
            select(SyncTombstone)
            .where(SyncTombstone.user_id == user.id, SyncTombstone.seq > since)
            .order_by(SyncTombstone.seq)
            .limit(limit + 1)
        )
    )
    merged = sorted([(i.seq, i) for i in items] + [(t.seq, t) for t in tombs],
                    key=lambda pair: pair[0])  # fmt: skip
    page = merged[:limit]
    has_more = len(merged) > limit
    page_items = [row for _, row in page if isinstance(row, Item)]
    page_tombs = [row for _, row in page if isinstance(row, SyncTombstone)]
    next_since = page[-1][0] if page else since

    if user.device_id is not None and since > 0:  # what this phone confirms it already has
        await db.execute(
            update(Device)
            .where(Device.id == user.device_id, Device.last_sync_seq < since)
            .values(last_sync_seq=since)
        )
    return SyncOut(
        items=await items_out(db, page_items),
        tombstones=[
            TombstoneOut(entity="item", id=t.public_id, seq=t.seq, deleted_at=t.deleted_at)
            for t in page_tombs
        ],  # fmt: skip
        next_since=next_since,
        has_more=has_more,
    )
