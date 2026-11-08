"""/v1/sync?since=<seq>&limit=: everything that changed for this user after `since`, in seq order.

Rows carry `seq` from the shared `sync_seq` sequence (trigger on every insert/update). Writers
of one user's rows take a per-user advisory lock before taking a seq, so seq order equals commit
order per user and a client that stores `next_since` never misses a change.

Soft-deleted records come back as items with `deleted_at` (trash); records purged after 30 days
come back as tombstones. Pages (`screens`, `screen_items`) and app reminders (`reminders`,
`reminder_fires`, week 8) are in the same stream; other synced entities join the same response.
"""

from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select, update

from assistant.actions import actions_dicts
from assistant.api.consent_gate import require_base_consent
from assistant.api.deps import Ctx, CurrentUser, Db
from assistant.api.routes.items import items_out
from assistant.api.routes.memory import summary_out
from assistant.api.routes.pages import page_item_out, page_out
from assistant.api.schemas import (
    ActionOut,
    ChatMessageOut,
    FireOut,
    PageItemOut,
    PageSummaryOut,
    ReminderOut,
    SyncOut,
    TombstoneOut,
)
from assistant.chat import store as chat_store
from assistant.db.models import Item, Reminder
from assistant.db.models_actions import Action
from assistant.db.models_chat import ConversationMessage, MessageRole
from assistant.db.models_pages import Screen, ScreenItem
from assistant.db.models_reminders import APP_KINDS, ReminderFire
from assistant.db.models_search import ScreenSummary
from assistant.db.models_v2 import Device, HiddenReason, SyncTombstone
from assistant.reminders import service as reminder_service

router = APIRouter(prefix="/sync", tags=["sync"])
CHAT_KEEP = 50  # the phone keeps the newest 50 messages for offline «Переписка» (spec 6.11)
GatedUser = Annotated[CurrentUser, Depends(require_base_consent)]


@router.get("", response_model=SyncOut)
async def sync(
    user: GatedUser, db: Db, ctx: Ctx,
    since: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=500)] = 200,
) -> SyncOut:  # fmt: skip
    items = list(
        await db.scalars(
            select(Item)
            .where(Item.user_id == user.id, Item.seq > since,
                   # part of a recording, reaches the phone through it
                   Item.hidden_reason.is_distinct_from(HiddenReason.VOICE_FRAGMENT))
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
    screens = list(
        await db.scalars(
            select(Screen)
            .where(Screen.user_id == user.id, Screen.seq > since)
            .order_by(Screen.seq)
            .limit(limit + 1)
        )
    )
    links = [
        page_item_out(link, page_id, item_id)
        for link, page_id, item_id in await db.execute(
            select(ScreenItem, Screen.public_id, Item.public_id)
            .join(Screen, Screen.id == ScreenItem.screen_id)
            .join(Item, Item.id == ScreenItem.item_id)
            .where(ScreenItem.user_id == user.id, ScreenItem.seq > since,
                   Item.hidden_reason.is_distinct_from(HiddenReason.VOICE_FRAGMENT))
            .order_by(ScreenItem.seq)
            .limit(limit + 1)
        )
    ]
    summaries = [
        summary_out(row, page_id)
        for row, page_id in await db.execute(
            select(ScreenSummary, Screen.public_id)
            .join(Screen, Screen.id == ScreenSummary.screen_id)
            .where(ScreenSummary.user_id == user.id, ScreenSummary.seq > since)
            .order_by(ScreenSummary.seq)
            .limit(limit + 1)
        )
    ]
    actions = list(
        await db.scalars(
            select(Action)
            .where(Action.user_id == user.id, Action.seq > since)
            .order_by(Action.seq)
            .limit(limit + 1)
        )
    )
    newest = (
        select(ConversationMessage.id)
        .where(ConversationMessage.user_id == user.id,
               ConversationMessage.role.in_([MessageRole.USER, MessageRole.ASSISTANT]))
        .order_by(ConversationMessage.id.desc()).limit(CHAT_KEEP)
    )  # fmt: skip
    messages = list(
        await db.scalars(
            select(ConversationMessage)
            .where(ConversationMessage.id.in_(newest), ConversationMessage.seq > since)
            .order_by(ConversationMessage.seq)
            .limit(limit + 1)
        )
    )
    reminders = list(
        await db.scalars(
            select(Reminder)
            .where(Reminder.user_id == user.id, Reminder.seq > since,
                   Reminder.kind.in_(APP_KINDS))  # bot rows are not the phone's
            .order_by(Reminder.seq)
            .limit(limit + 1)
        )
    )  # fmt: skip
    fires = list(
        await db.scalars(
            select(ReminderFire)
            .where(ReminderFire.user_id == user.id, ReminderFire.seq > since)
            .order_by(ReminderFire.seq)
            .limit(limit + 1)
        )
    )
    merged = sorted([(row.seq, row) for row in (*items, *tombs, *screens, *links, *summaries,
                                                *actions, *messages, *reminders, *fires)],
                    key=lambda pair: pair[0])  # fmt: skip
    page = merged[:limit]
    has_more = len(merged) > limit
    page_items = [row for _, row in page if isinstance(row, Item)]
    page_tombs = [row for _, row in page if isinstance(row, SyncTombstone)]
    page_screens = [row for _, row in page if isinstance(row, Screen)]
    page_links = [row for _, row in page if isinstance(row, PageItemOut)]
    page_summaries = [row for _, row in page if isinstance(row, PageSummaryOut)]
    page_actions = [row for _, row in page if isinstance(row, Action)]
    page_messages = [row for _, row in page if isinstance(row, ConversationMessage)]
    page_reminders = [row for _, row in page if isinstance(row, Reminder)]
    page_fires = [row for _, row in page if isinstance(row, ReminderFire)]
    next_since = page[-1][0] if page else since

    if user.device_id is not None and since > 0:  # what this phone confirms it already has
        await db.execute(
            update(Device)
            .where(Device.id == user.device_id, Device.last_sync_seq < since)
            .values(last_sync_seq=since)
        )
    label = ctx.settings.label_ai_generated
    return SyncOut(
        items=await items_out(db, page_items),
        actions=[ActionOut.model_validate(d)
                 for d in await actions_dicts(db, page_actions, datetime.now(UTC))],
        conversation_messages=[ChatMessageOut.model_validate(d) for d in
                               await chat_store.messages_dicts(db, page_messages, label)],
        screens=[page_out(row) for row in page_screens],
        screen_items=page_links,
        screen_summaries=page_summaries,
        reminders=[ReminderOut.model_validate(d)
                   for d in await reminder_service.reminders_dicts(db, page_reminders)],
        reminder_fires=[FireOut.model_validate(d)
                        for d in await reminder_service.fires_dicts(db, page_fires)],
        tombstones=[
            TombstoneOut(entity=t.entity, id=t.public_id, seq=t.seq, deleted_at=t.deleted_at)
            for t in page_tombs
        ],  # fmt: skip
        next_since=next_since,
        has_more=has_more,
    )
