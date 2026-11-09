"""/v1/sync?since=<seq>&limit=: everything that changed for this user after `since`, in seq order.

Rows carry `seq` from the shared `sync_seq` sequence (trigger on every insert/update). Writers
of one user's rows take a per-user advisory lock before taking a seq, so seq order equals commit
order per user and a client that stores `next_since` never misses a change.

Soft-deleted records come back as items with `deleted_at` (trash); records purged after 30 days
come back as tombstones. Pages (`screens`, `screen_items`) and app reminders (`reminders`,
`reminder_fires`, week 8) are in the same stream; week 9 adds `tasks`, `suggestions`,
`pending_actions` and learned `habits`; week 12 adds `expenses` and `expense_categories`. Other
synced entities join the same response.
"""

import uuid
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
    ExpenseCategoryOut,
    ExpenseOut,
    FireOut,
    HabitSyncOut,
    ItemFacetOut,
    PageItemOut,
    PageRefOut,
    PageSummaryOut,
    PendingActionOut,
    ReminderOut,
    SuggestionOut,
    SyncOut,
    TaskOut,
    TombstoneOut,
)
from assistant.chat import store as chat_store
from assistant.db.models import Item, Reminder, User
from assistant.db.models_actions import Action
from assistant.db.models_chat import ConversationMessage, MessageRole
from assistant.db.models_expenses import ExpenseCategory, ExpenseEntry
from assistant.db.models_habits import HabitKind, UserHabit
from assistant.db.models_pages import ItemFacet, Screen, ScreenItem
from assistant.db.models_reminders import APP_KINDS, ReminderFire
from assistant.db.models_search import ScreenSummary
from assistant.db.models_tasks import PendingAction, Suggestion, Task
from assistant.db.models_v2 import Device, HiddenReason, SyncTombstone
from assistant.expenses import service as expenses
from assistant.pages import habits as page_habits
from assistant.reminders import service as reminder_service
from assistant.suggestions import engine as suggestions
from assistant.tasks import service as tasks

router = APIRouter(prefix="/sync", tags=["sync"])
CHAT_KEEP = 50  # the phone keeps the newest 50 messages for offline «Переписка» (spec 6.11)
GatedUser = Annotated[CurrentUser, Depends(require_base_consent)]


@router.get("", response_model=SyncOut)
async def sync(
    user: GatedUser, db: Db, ctx: Ctx,
    since: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=500)] = 200,
    full: bool = False,
) -> SyncOut:  # fmt: skip
    floor = await db.scalar(select(User.sync_floor_seq).where(User.id == user.id)) or 0
    # Tombstones this phone never saw are gone (retention): unless it is paging through a sync
    # that started at 0 (`full=true`), it must start again from scratch.
    if 0 < since < floor and not full:
        return SyncOut(items=[], screens=[], screen_items=[], screen_summaries=[], tombstones=[],
                       next_since=0, has_more=True, full_resync=True)  # fmt: skip
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
    facets = [
        ItemFacetOut(id=f.public_id, page_id=page_id, item_id=item_id, data=dict(f.data or {}),
                     updated_by=f.updated_by, seq=f.seq, updated_at=f.updated_at)
        for f, page_id, item_id in await db.execute(
            select(ItemFacet, Screen.public_id, Item.public_id)
            .join(Screen, Screen.id == ItemFacet.screen_id)
            .join(Item, Item.id == ItemFacet.item_id)
            .where(ItemFacet.user_id == user.id, ItemFacet.seq > since)
            .order_by(ItemFacet.seq)
            .limit(limit + 1)
        )
    ]  # fmt: skip
    extra: list[object] = []
    for model in (Task, Suggestion, PendingAction, UserHabit, ExpenseEntry, ExpenseCategory):
        extra.extend(await db.scalars(
            select(model).where(model.user_id == user.id, model.seq > since)  # type: ignore[attr-defined]
            .order_by(model.seq).limit(limit + 1)))  # type: ignore[attr-defined]  # fmt: skip
    merged = sorted([(row.seq, row) for row in (*items, *tombs, *screens, *links, *summaries,  # type: ignore[attr-defined]
                                                *actions, *messages, *reminders, *fires, *facets,
                                                *extra)],
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
    page_tasks = [row for _, row in page if isinstance(row, Task)]
    page_suggestions = [row for _, row in page if isinstance(row, Suggestion)]
    page_pending = [row for _, row in page if isinstance(row, PendingAction)]
    page_habits = [row for _, row in page if isinstance(row, UserHabit)]
    page_facets = [row for _, row in page if isinstance(row, ItemFacetOut)]
    page_expenses = [row for _, row in page if isinstance(row, ExpenseEntry)]
    page_categories = [row for _, row in page if isinstance(row, ExpenseCategory)]
    next_since = page[-1][0] if page else since
    if not has_more:  # nothing older than the floor is left to see
        next_since = max(next_since, floor)

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
        tasks=[TaskOut.model_validate(d) for d in await tasks.tasks_dicts(db, page_tasks)],
        suggestions=[SuggestionOut.model_validate(d)
                     for d in await suggestions.views(db, page_suggestions)],
        pending_actions=await pending_out(db, page_pending),
        habits=await habits_out(db, user.id, page_habits),
        item_facets=page_facets,
        expenses=[ExpenseOut.model_validate(d)
                  for d in await expenses.expenses_dicts(db, page_expenses)],
        expense_categories=[ExpenseCategoryOut.model_validate(expenses.category_dict(c))
                            for c in page_categories],
        tombstones=[
            TombstoneOut(entity=t.entity, id=t.public_id, seq=t.seq, deleted_at=t.deleted_at)
            for t in page_tombs
        ],  # fmt: skip
        next_since=next_since,
        has_more=has_more,
    )


async def pending_out(db: Db, rows: list[PendingAction]) -> list[PendingActionOut]:
    """Pending «Да» in sync: never the token or the plan."""
    ids = {pk for r in rows for pk in (r.message_id, r.action_id) if pk}
    pubs: dict[int, uuid.UUID] = {}
    if ids:
        pubs = dict((await db.execute(select(ConversationMessage.id, ConversationMessage.public_id)
                                      .where(ConversationMessage.id.in_(ids)))).tuples().all())
        pubs.update(dict((await db.execute(select(Action.id, Action.public_id)
                                           .where(Action.id.in_(ids)))).tuples().all()))
    return [PendingActionOut(id=r.public_id, kind=r.kind, status=r.status, preview=r.preview,
                             expires_at=r.expires_at,
                             message_id=pubs.get(r.message_id) if r.message_id else None,
                             action_id=pubs.get(r.action_id) if r.action_id else None,
                             seq=r.seq, created_at=r.created_at, decided_at=r.decided_at)
            for r in rows]  # fmt: skip


async def habits_out(db: Db, user_id: int, rows: list[UserHabit]) -> list[HabitSyncOut]:
    wanted = {uuid.UUID(str(h.value["page_id"])) for h in rows
              if h.kind == HabitKind.PLACEMENT_RULE and (h.value or {}).get("page_id")}
    pages = {p.public_id: p for p in await db.scalars(
        select(Screen).where(Screen.user_id == user_id, Screen.public_id.in_(wanted)))
    } if wanted else {}  # fmt: skip
    out = []
    for h in rows:
        value = h.value or {}
        page = pages.get(uuid.UUID(str(value["page_id"]))) if value.get("page_id") else None
        kind = value.get("envelope_type")
        out.append(HabitSyncOut(
            id=h.public_id, kind=h.kind, status=h.status,
            text_ru=page_habits.describe(kind, page.title) if page else "",
            page=PageRefOut(id=page.public_id, title=page.title, icon=page.icon) if page else None,
            envelope_type=kind, evidence_count=h.evidence_count, updated_at=h.updated_at,
            seq=h.seq,
        ))  # fmt: skip
    return out
