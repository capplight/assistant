"""/v1/today («Сегодня», S06, F-16, 6.9) and /v1/suggestions (F-18, R-35). Contract:
docs/api/today.md.

«Сегодня» is built on request from what the server holds; it keeps no state of its own except the
suggestions the engine decided to show. A suggestion only asks: nothing changes until [Да].
"""

import dataclasses
import uuid
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends
from sqlalchemy import select, text

from assistant.actions import actions_dicts, record
from assistant.api.consent_gate import AI_CONSENTS, missing_consents, require_base_consent
from assistant.api.deps import Ctx, CurrentUser, Db, get_active_consent_kinds
from assistant.api.errors import ApiError
from assistant.api.routes import today_brief
from assistant.api.schemas import (
    ActionOut,
    ChatMessageOut,
    DoneForYouOut,
    FireOut,
    PageTileOut,
    ReminderOut,
    SuggestionAcceptIn,
    SuggestionAcceptOut,
    SuggestionDismissOut,
    SuggestionOut,
    SuggestionsOut,
    TaskOut,
    TodayDueOut,
    TodayOut,
    TodayReminderOut,
    TodayShoppingOut,
)
from assistant.chat import store as chat_store
from assistant.db.models import Item, Reminder, User
from assistant.db.models_actions import Action, ActionKind, Initiator
from assistant.db.models_chat import ConversationMessage, Delivery, MessageRole, MessageState
from assistant.db.models_pages import Screen, ScreenKind
from assistant.db.models_reminders import AppReminderKind, FireState, ReminderFire
from assistant.db.models_tasks import ListKey, SuggestionKind, Task
from assistant.pages import ensure_default_pages, lock_user
from assistant.reminders import parse_phrase
from assistant.reminders import service as reminder_service
from assistant.reminders.parse import drafts_dicts
from assistant.suggestions import engine
from assistant.tasks import TaskSpec
from assistant.tasks import service as tasks

router = APIRouter(prefix="/today", tags=["today"])
suggestions_router = APIRouter(prefix="/suggestions", tags=["today"])
GatedUser = Annotated[CurrentUser, Depends(require_base_consent)]
Kinds = Annotated[frozenset[str], Depends(get_active_consent_kinds)]
EXAMPLE = "Например: напомни в пятницу оплатить свет"
MISSED_WINDOW = timedelta(hours=24)
TODAY_TASKS = 20
DONE_SHOWN = 3


def _now() -> datetime:
    return datetime.now(UTC).replace(microsecond=0)


# «Сегодня» page tiles (Ф-32, template-screens 2.7): by code, ≤2; the rule picks none in the
# first 7 days, a tile pinned by hand shows from day one.
TILE_QUIET_DAYS = 7
MAX_TILES = 2
CURRENCY_SIGN = {"KZT": "₸", "USD": "$", "EUR": "€", "RUB": "₽", "KGS": "сом", "UZS": "сум"}


def money(amount: Any, currency: str) -> str:
    """«7 500 ₸», «12,50 $»: groups of three, kopecks only when there are any."""
    from decimal import Decimal

    value = Decimal(str(amount)).quantize(Decimal("0.01"))
    whole, frac = divmod(abs(value), 1)
    digits = f"{int(whole):,}".replace(",", " ")
    tail = f",{int(frac * 100):02d}" if frac else ""
    sign = "-" if value < 0 else ""
    return f"{sign}{digits}{tail} {CURRENCY_SIGN.get(currency, currency)}"


async def _tile_text(db: Db, page: Screen, user_id: int, day: Any) -> tuple[str | None, str]:
    """(what the page has for today, or None; the line a pinned tile shows when it has none)."""
    key = page.template_key
    if key == "shopping":
        n = await db.scalar(text("""
            SELECT count(*) FROM tasks t JOIN items i ON i.id = t.item_id
            WHERE t.user_id = :u AND t.list_key = 'shopping' AND t.deleted_at IS NULL
              AND t.done_at IS NULL AND i.deleted_at IS NULL"""), {"u": user_id}) or 0
        return (f"Осталось {n}" if n else None), "Всё куплено"
    if key == "expenses":
        recent = await db.scalar(text("""
            SELECT 1 FROM expense_entries WHERE user_id = :u AND deleted_at IS NULL
              AND direction = 'expense' AND spent_on > CAST(:d AS date) - 7 LIMIT 1"""),
            {"u": user_id, "d": day})  # fmt: skip
        if not recent:
            return None, "Сегодня трат нет"
        sums = (await db.execute(text("""
            SELECT currency, sum(amount) FROM expense_entries WHERE user_id = :u
              AND deleted_at IS NULL AND direction = 'expense' AND spent_on = CAST(:d AS date)
            GROUP BY currency ORDER BY (currency = 'KZT') DESC, currency"""),
            {"u": user_id, "d": day})).all()  # fmt: skip
        if not sums:
            return "Сегодня трат нет", "Сегодня трат нет"
        return "Сегодня " + " · ".join(money(a, c) for c, a in sums), "Сегодня трат нет"
    if key == "documents":
        n = await db.scalar(text("""
            SELECT count(*) FROM documents WHERE user_id = :u AND deleted_at IS NULL
              AND deal_status IN ('sent', 'seen')"""), {"u": user_id}) or 0
        return (f"КП ждут ответа: {n}" if n else None), "КП: ничего не ждёт"
    n = await db.scalar(text("""
        SELECT count(*) FROM screen_items si JOIN items i ON i.id = si.item_id
        WHERE si.screen_id = :s AND si.removed_by_user_at IS NULL AND i.deleted_at IS NULL
          AND i.hidden_reason IS NULL"""), {"s": page.id}) or 0
    return None, f"Записей: {n}"


async def page_tiles(db: Db, user: User, now: datetime, day: Any) -> list[PageTileOut]:
    """Pinned first, then the pages that have something for today, in tab order; ≤2. «Дела» are
    in the day list already, so they get a tile only when pinned. In the account's first 7 days
    only pinned tiles show."""
    # the first 7 days the rule shows nothing; a tile the person pinned by hand is theirs
    young = now - user.created_at < timedelta(days=TILE_QUIET_DAYS)
    pages = list(await db.scalars(
        select(Screen).where(Screen.user_id == user.id, Screen.deleted_at.is_(None),
                             Screen.kind == ScreenKind.PAGE)
        .order_by(Screen.position, Screen.public_id)))  # fmt: skip
    pinned: list[PageTileOut] = []
    auto: list[PageTileOut] = []
    for p in pages:
        mode = (p.view_state or {}).get("today_tile") or "auto"
        if mode == "hidden" or (mode == "auto" and (young or p.template_key == "tasks")):
            continue
        if mode == "auto" and len(auto) >= MAX_TILES:
            continue
        has, empty = await _tile_text(db, p, user.id, day)
        if mode != "pinned" and has is None:
            continue
        tile = PageTileOut(page_id=p.public_id, template_key=p.template_key, title=p.title,
                           icon=p.icon, text_ru=has or empty, pinned=mode == "pinned")  # fmt: skip
        (pinned if mode == "pinned" else auto).append(tile)
    return (pinned + auto)[:MAX_TILES]


async def _occurrences(db: Db, user_id: int, start: datetime,
                       end: datetime) -> list[tuple[Reminder, ReminderFire]]:  # fmt: skip
    """Each occurrence of a live normal reminder in [start, end) with its own fire (offset 0, the
    newest snooze)."""
    rows = (await db.execute(
        select(ReminderFire, Reminder).join(Reminder, Reminder.id == ReminderFire.reminder_id)
        .where(ReminderFire.user_id == user_id, ReminderFire.offset_min == 0,
               ReminderFire.occurrence_at >= start, ReminderFire.occurrence_at < end,
               ReminderFire.state != FireState.CANCELLED, Reminder.deleted_at.is_(None),
               Reminder.kind == AppReminderKind.NORMAL)
        .order_by(ReminderFire.occurrence_at, ReminderFire.reminder_id, ReminderFire.snooze_n)
    )).all()  # fmt: skip
    newest: dict[tuple[int, datetime], tuple[Reminder, ReminderFire]] = {}
    for fire, rem in rows:
        newest[(rem.id, fire.occurrence_at)] = (rem, fire)
    return list(newest.values())


async def _reminder_rows(db: Db, pairs: list[tuple[Reminder, ReminderFire]],
                         tz: str) -> list[TodayReminderOut]:  # fmt: skip
    if not pairs:
        return []
    rems = {r.id: d for r, d in zip(
        [p[0] for p in pairs], await reminder_service.reminders_dicts(db, [p[0] for p in pairs]),
        strict=True)}  # fmt: skip
    fires = await reminder_service.fires_dicts(db, [p[1] for p in pairs])
    zone = ZoneInfo(tz)
    return [TodayReminderOut(reminder=ReminderOut.model_validate(rems[r.id]),
                             fire=FireOut.model_validate(f), occurrence_at=fire.occurrence_at,
                             local_time=fire.occurrence_at.astimezone(zone).strftime("%H:%M"),
                             state=str(fire.state))
            for (r, fire), f in zip(pairs, fires, strict=True)]  # fmt: skip


def _live_tasks():  # type: ignore[no-untyped-def]
    return (select(Task).join(Item, Item.id == Task.item_id)
            .where(Task.deleted_at.is_(None), Item.deleted_at.is_(None),
                   Task.done_at.is_(None)))  # fmt: skip


async def _suggestions_out(db: Db, rows: list[Any]) -> list[SuggestionOut]:
    return [SuggestionOut.model_validate(d) for d in await engine.views(db, rows)]


@router.get("", response_model=TodayOut)
async def today(user: GatedUser, db: Db, ctx: Ctx) -> TodayOut:
    now = _now()
    await lock_user(db, user.id)
    await ensure_default_pages(db, user.id)  # Ф-48: «Расходы» for older accounts, once
    u = await db.get(User, user.id)
    assert u is not None
    tz = u.tz or "Asia/Almaty"
    zone = ZoneInfo(tz)
    local = now.astimezone(zone)
    day = local.date()
    start = local.replace(hour=0, minute=0, second=0, microsecond=0).astimezone(UTC)
    end = (local.replace(hour=0, minute=0, second=0, microsecond=0)
           + timedelta(days=1)).astimezone(UTC)  # fmt: skip

    occ = await _occurrences(db, user.id, min(start, now - MISSED_WINDOW), end)
    missed = [(r, f) for r, f in occ if f.state == FireState.MISSED
              and f.occurrence_at >= now - MISSED_WINDOW]  # fmt: skip
    due = [(r, f) for r, f in occ if f.occurrence_at >= start and f.state != FireState.MISSED]

    todo = list(await db.scalars(
        _live_tasks().where(Task.user_id == user.id, Task.list_key == ListKey.TODO,
                            Task.due_date.is_not(None), Task.due_date <= day)
        .order_by(Task.due_date, Task.id).limit(TODAY_TASKS)))  # fmt: skip
    # Ф-49: with the shopping list hidden, no «Купить: …» on «Сегодня» (the things stay)
    shop = list(await db.scalars(
        _live_tasks().where(Task.user_id == user.id, Task.list_key == ListKey.SHOPPING)
        .order_by(Task.id))) if tasks.shopping_on() else []  # fmt: skip
    shopping = None
    if shop:
        page = await tasks.list_page(db, user.id, ListKey.SHOPPING)
        shopping = TodayShoppingOut(page_id=page.public_id if page else None, count=len(shop),
                                    titles=[t.title for t in shop[:5]])  # fmt: skip

    agent = (Action.user_id == user.id, Action.initiated_by == Initiator.AGENT,
             Action.undone_at.is_(None), Action.undo_of_action_id.is_(None))
    recent = list(await db.scalars(select(Action).where(*agent,
                                                        Action.created_at >= now - MISSED_WINDOW)
                                   .order_by(Action.id.desc()).limit(DONE_SHOWN)))  # fmt: skip
    count_today = len(list(await db.scalars(select(Action.id).where(
        *agent, Action.created_at >= start))))  # fmt: skip

    msg = await db.scalar(
        select(ConversationMessage)
        .where(ConversationMessage.user_id == user.id,
               ConversationMessage.delivery == Delivery.BANNER_PENDING,
               ConversationMessage.role == MessageRole.ASSISTANT,
               ConversationMessage.state.in_([MessageState.DONE, MessageState.DEFERRED,
                                              MessageState.FAILED]),
               ConversationMessage.deleted_at.is_(None))
        .order_by(ConversationMessage.id.desc()).limit(1)
    )  # fmt: skip
    banner = None
    if msg is not None:
        banner = ChatMessageOut.model_validate(
            (await chat_store.messages_dicts(db, [msg], ctx.settings.label_ai_generated))[0])

    proposals, tip = await engine.current(db, user.id, now, ctx.settings)
    items = await db.scalar(select(Item.id).where(Item.user_id == user.id,
                                                  Item.deleted_at.is_(None)).limit(1))  # fmt: skip
    empty = items is None and not occ and not await db.scalar(
        select(Reminder.id).where(Reminder.user_id == user.id, Reminder.deleted_at.is_(None),
                                  Reminder.kind == AppReminderKind.NORMAL).limit(1))  # fmt: skip

    # Ф-42: no page tiles for the beta (pinned ones too)
    tiles = await page_tiles(db, u, now, day) if ctx.settings.feature_today_tiles else []
    sections = [name for name, has in (
        ("banner", banner is not None), ("missed", bool(missed)),
        ("today", bool(due or todo or shopping)), ("page_tiles", bool(tiles)),
        ("done_for_you", bool(recent)),
        ("proposals", bool(proposals)), ("tip", tip is not None)) if has]  # fmt: skip
    name = (u.display_name or "").strip()
    # week 20 (mocks v2): the briefing, by code
    today_occ = [(r, f) for r, f in occ if f.occurrence_at >= start]
    brief = await today_brief.build(
        db, u, now=now, zone=zone, start=start, end=end, today_occ=today_occ,
        tomorrow_occ=await _occurrences(db, user.id, end, end + timedelta(days=1)),
        missed=missed)  # fmt: skip
    await db.flush()
    return TodayOut(
        date=day.isoformat(), tz=tz, greeting=f"Добрый день, {name}" if name else "Добрый день",
        sections=sections,
        today=TodayDueOut(reminders=await _reminder_rows(db, due, tz),
                          tasks=[TaskOut.model_validate(d)
                                 for d in await tasks.tasks_dicts(db, todo)],
                          shopping=shopping),
        missed=await _reminder_rows(db, missed, tz),
        done_for_you=DoneForYouOut(actions=[ActionOut.model_validate(d)
                                            for d in await actions_dicts(db, recent, now)],
                                   count_today=count_today),
        banner=banner, proposals=await _suggestions_out(db, proposals),
        tip=(await _suggestions_out(db, [tip]))[0] if tip else None,
        empty=empty, example=EXAMPLE if empty else None, page_tiles=tiles, brief=brief,
    )  # fmt: skip


@suggestions_router.get("", response_model=SuggestionsOut)
async def list_suggestions(user: GatedUser, db: Db, ctx: Ctx) -> SuggestionsOut:
    await lock_user(db, user.id)
    proposals, tip = await engine.current(db, user.id, _now(), ctx.settings)
    return SuggestionsOut(proposals=await _suggestions_out(db, proposals),
                          tip=(await _suggestions_out(db, [tip]))[0] if tip else None)


async def _decide(db: Db, ctx: Ctx, user_id: int, sid: uuid.UUID, *, accept: bool,
                  client_id: uuid.UUID | None = None) -> tuple[Any, bool]:  # fmt: skip
    await lock_user(db, user_id)
    try:
        return await engine.decide(db, user_id, sid, accept=accept, now=_now(),
                                   settings=ctx.settings, client_id=client_id)  # fmt: skip
    except LookupError as exc:
        raise ApiError(404, "not_found") from exc
    except engine.SuggestionGone as exc:
        await db.commit()  # keep the `expired` mark
        raise ApiError(410, "suggestion_expired") from exc


@suggestions_router.post("/{suggestion_id}/accept", response_model=SuggestionAcceptOut)
async def accept(suggestion_id: uuid.UUID, user: GatedUser, db: Db, ctx: Ctx, kinds: Kinds,
                 body: SuggestionAcceptIn | None = None) -> SuggestionAcceptOut:  # fmt: skip
    body = body or SuggestionAcceptIn()
    now = _now()
    s, repeated = await _decide(db, ctx, user.id, suggestion_id, accept=True,
                                client_id=body.client_id)  # fmt: skip
    action_out = task_out = draft = None
    if s.key == "task_from_item":
        task = await db.scalar(select(Task).where(Task.source_item_id == s.source_item_id,
                                                  Task.user_id == user.id))  # fmt: skip
        action = await db.get(Action, s.action_id) if s.action_id else None
        if task is None and not repeated:
            added = await tasks.add(db, user.id, [TaskSpec(ListKey.TODO, str(s.payload["title"]))],
                                    by=Initiator.AGENT, now=now,
                                    source_item_id=s.source_item_id)  # fmt: skip
            action = await record(
                db, user_id=user.id, kind=ActionKind.SAVE_ITEM, initiated_by=Initiator.AGENT,
                summary={"ru": added.sentence, "kk": None}, changes=added.changes,
                inverse=added.inverse, now=now, screen_id=added.page.id if added.page else None,
                source_item_ids=added.item_pks,
            )  # fmt: skip
            s.action_id = action.id
            task = added.tasks[0]
        await db.flush()
        if task is not None:
            task_out = TaskOut.model_validate((await tasks.tasks_dicts(db, [task]))[0])
        if action is not None:
            action_out = ActionOut.model_validate((await actions_dicts(db, [action], now))[0])
    page_out_ = None
    if s.key in engine.PAGE_PROPOSALS:
        page_out_, action_out = await _accept_page(db, user.id, s, repeated, now)
    out = (await _suggestions_out(db, [s]))[0]
    if s.key == "reminder_from_item":
        u = await db.get(User, user.id)
        tz = (u.tz if u else None) or "Asia/Almaty"
        phrase = " ".join(str(s.payload.get(k) or "") for k in ("text", "when_text")).strip()
        await db.commit()  # no transaction stays open across the model call
        outcome = await parse_phrase(
            phrase, now=now, tz=tz, created_via="agent_suggestion",
            rules_first=ctx.settings.reminders_rules_first,
            ai_allowed=not missing_consents(kinds, AI_CONSENTS), router=ctx.ai_router,
            user_id=user.id,
        )  # fmt: skip
        # The assistant's proposal is never loud (R-11), whatever words the record has.
        quiet = [dataclasses.replace(d, level="notification") for d in outcome.drafts]
        drafts = drafts_dicts(quiet, now, tz)
        draft = {"status": outcome.status, "source": outcome.source, "reason": outcome.reason,
                 "message": outcome.message,
                 "draft": drafts[0] if drafts and outcome.status != "ambiguous" else None,
                 "options": drafts if outcome.status == "ambiguous" else [],
                 "parser": "rules_first" if ctx.settings.reminders_rules_first else "llm",
                 "created_via": "agent_suggestion"}  # fmt: skip
    return SuggestionAcceptOut(suggestion=out, action=action_out, task=task_out,
                               reminder_draft=draft, page=page_out_)  # fmt: skip


async def _accept_page(db: Db, user_id: int, s: Any, repeated: bool,
                       now: datetime) -> tuple[Any, ActionOut | None]:  # fmt: skip
    """R-55 [Да]: the page is made now, by the assistant, with «Отменить» (week 16)."""
    from assistant.api.routes.collections import stack_page
    from assistant.api.routes.pages import _bring_back, _live_singleton, _removed_singleton
    from assistant.api.routes.pages import page_out as page_view
    from assistant.db.models_dedup import Collection
    from assistant.pages import create_page, fill_page, latest_template

    action = await db.get(Action, s.action_id) if s.action_id else None
    page = None
    if action is None and not repeated:
        if s.key == "page_from_stack":
            c = await db.scalar(select(Collection).where(
                Collection.user_id == user_id, Collection.deleted_at.is_(None),
                Collection.public_id == uuid.UUID(str(s.payload.get("collection_id")))))
            if c is None:
                raise ApiError(410, "suggestion_expired")
            page, action, _ = await stack_page(db, user_id, c, client_id=None, title=None,
                                               by=Initiator.AGENT, now=now)  # fmt: skip
        else:
            page = await _live_singleton(db, user_id, "documents")
            if page is None:
                page = await _removed_singleton(db, user_id, "documents")
                if page is not None:
                    await _bring_back(db, page)
                else:
                    template = await latest_template(db, "documents")
                    assert template is not None
                    from assistant.api.routes.pages import _check_room
                    from assistant.db.models_pages import ScreenCreatedBy

                    await _check_room(db, user_id)
                    page = await create_page(db, user_id, template, client_id=uuid.uuid4(),
                                             created_by=ScreenCreatedBy.AGENT)  # fmt: skip
                    await fill_page(db, page)
                sentence = f"Страница «{page.title}» добавлена"
                action = await record(
                    db, user_id=user_id, kind=ActionKind.CREATE_SCREEN,
                    initiated_by=Initiator.AGENT, summary={"ru": sentence, "kk": None},
                    changes=[{"item_id": None, "title": page.title, "kind": "create_page",
                              "page_id": str(page.public_id), "text": sentence}],
                    inverse=[{"op": "delete_entity_soft", "entity": "screens",
                              "id": str(page.public_id)}],
                    now=now, screen_id=page.id,
                    extra={"created_page_id": str(page.public_id)})  # fmt: skip
        if action is not None:
            s.action_id = action.id
        await db.flush()
    if page is None and action is not None and action.screen_id:
        page = await db.get(Screen, action.screen_id)
    if page is not None:
        await db.refresh(page)
    action_out = (ActionOut.model_validate((await actions_dicts(db, [action], now))[0])
                  if action is not None else None)  # fmt: skip
    return (page_view(page) if page is not None else None), action_out


@suggestions_router.post("/{suggestion_id}/dismiss", response_model=SuggestionDismissOut)
async def dismiss(suggestion_id: uuid.UUID, user: GatedUser, db: Db,
                  ctx: Ctx) -> SuggestionDismissOut:  # fmt: skip
    s, _ = await _decide(db, ctx, user.id, suggestion_id, accept=False)
    return SuggestionDismissOut(suggestion=(await _suggestions_out(db, [s]))[0])


__all__ = ["router", "suggestions_router", "SuggestionKind"]
