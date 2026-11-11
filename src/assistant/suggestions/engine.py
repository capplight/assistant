"""Tips and data proposals for «Сегодня» (spec 3.4, 6.5; R-35, R-08; product 6.8). Contract:
docs/api/today.md.

The assistant never acts here: a suggestion only asks, and nothing changes until the person taps
[Да] (`accept`). It must not nag, so the limits are code:
- tip: ≤2 a day in the first 14 days of the account, then ≤1 a day; one on screen; 2× «Не сейчас»
  → 30 days' pause for that tip; a tip already accepted is not offered again; the same tip at most
  every 3 days (ours, so an ignored card does not come back every morning).
- data proposal: from a new record's `envelope.proposed` (ENRICH only proposes, spec 5.6 rule 6);
  ≤2 shown at once, silently `expired` after 24 h; one per record and key, ever.
- `link_phone` (anonymous accounts, R-08): from day 3 and the 20th record, ≤1 a week, ≤3 in all.
- Nothing here sends a push, so quiet hours need no rule.

`current()` runs when «Сегодня» opens (short transaction, no model call). Settings:
`suggestions_*` in config.
"""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.config import Settings
from assistant.db.models import Item, Reminder, User
from assistant.db.models_tasks import (
    Suggestion,
    SuggestionCounter,
    SuggestionKind,
    SuggestionStatus,
)
from assistant.db.models_v2 import AuthIdentity, AuthProvider

TIP_GAP = timedelta(days=3)
PROPOSAL_FROM = timedelta(days=3)  # records this new may propose something
LINK_PHONE_EVERY = timedelta(days=7)
LINK_PHONE_TIMES = 3
LINK_PHONE_DAY = 3
LINK_PHONE_RECORDS = 20
LIVE = (SuggestionStatus.PENDING, SuggestionStatus.SHOWN)


@dataclass(frozen=True)
class Tip:
    text_ru: str
    yes_label: str
    do: dict[str, Any]


TIPS: dict[str, Tip] = {
    "first_reminder": Tip("Скажите: „Напомни в пятницу оплатить свет“", "Сказать",
                          {"type": "open_mic"}),
    "ask_anything": Tip("Спросите: „Что я записывал про врача?“", "Спросить",
                        {"type": "open_mic"}),
    "arrange_here": Tip("Скажите здесь: «разложи по темам»", "Попробовать",
                        {"type": "put_phrase", "phrase": "разложи по темам"}),
    "photo_paper": Tip("Сфотографируйте квитанцию — найду её словами", "Сфотографировать",
                       {"type": "open_camera"}),
    "share_from_apps": Tip("Делитесь из WhatsApp и браузера — кнопкой „Поделиться“", "Как это",
                           {"type": "show_share_help"}),
    "link_phone": Tip("Сохраните записи — укажите номер", "Указать номер",
                      {"type": "link_phone"}),
    # week 16 (US-33): the account started from a blank page; from its 2nd day, once
    "add_ready_pages": Tip("Добавить готовые страницы?", "Посмотреть", {"type": "open_gallery"}),
}  # fmt: skip
# Page proposals (R-55, week 16): ≤1 a week, never in the first 10 minutes, each topic once.
PAGE_PROPOSALS = ("page_from_stack", "add_documents_page")
PAGE_PROPOSAL_EVERY = timedelta(days=7)
PAGE_PROPOSAL_AFTER = timedelta(minutes=10)
PAGE_FROM_STACK_RECORDS = 10
NO_LABEL = "Не сейчас"


def _today_start(now: datetime, tz: str) -> datetime:
    local = now.astimezone(ZoneInfo(tz))
    return local.replace(hour=0, minute=0, second=0, microsecond=0).astimezone(UTC)


def view(s: Suggestion, item_public_id: uuid.UUID | None = None) -> dict[str, Any]:
    """The JSON of docs/api/today.md (Suggestion)."""
    payload = s.payload or {}
    if s.kind == SuggestionKind.TIP:
        tip = TIPS.get(s.key)
        text_ru, yes = (tip.text_ru, tip.yes_label) if tip else ("", "Да")
        do = dict(tip.do) if tip else {"type": "none"}
        if s.key == "arrange_here" and payload.get("page_id"):
            do["page_id"] = payload["page_id"]
    elif s.key == "task_from_item":
        text_ru, yes = f"Добавить в дела: «{payload.get('title', '')}»?", "Да, добавить"
        do = {"type": "accept"}
    elif s.key == "reminder_from_item":
        when = payload.get("when_text") or ""
        text_ru = f"Напомнить: «{payload.get('text', '')}»" + (f" — {when}?" if when else "?")
        yes, do = "Да, напомнить", {"type": "accept"}
    elif s.key == "page_from_stack":
        title = payload.get("title", "")
        text_ru = (f"Про «{title}» уже {payload.get('count', 0)} записей. "
                   f"Сделать страницу «{title}»?")  # fmt: skip
        yes, do = "Да, сделать", {"type": "accept"}
    elif s.key == "add_documents_page":
        text_ru, yes = "Добавить страницу «Документы и КП»?", "Да, добавить"
        do = {"type": "accept"}
    else:
        text_ru, yes, do = "", "Да", {"type": "none"}
    return {"id": s.public_id, "kind": s.kind, "key": s.key, "text_ru": text_ru,
            "yes_label": yes, "no_label": NO_LABEL, "do": do, "source_item_id": item_public_id,
            "status": s.status, "expires_at": s.expires_at, "seq": s.seq,
            "created_at": s.created_at}  # fmt: skip


async def views(session: AsyncSession, rows: list[Suggestion]) -> list[dict[str, Any]]:
    ids = {s.source_item_id for s in rows if s.source_item_id}
    pids: dict[int, uuid.UUID] = {}
    if ids:
        pids = dict((await session.execute(
            select(Item.id, Item.public_id).where(Item.id.in_(ids)))).tuples().all())  # fmt: skip
    return [view(s, pids.get(s.source_item_id) if s.source_item_id else None) for s in rows]


async def _counter(session: AsyncSession, user_id: int, key: str) -> SuggestionCounter:
    c = await session.get(SuggestionCounter, (user_id, key), with_for_update=True)
    if c is None:
        c = SuggestionCounter(user_id=user_id, key=key, dismiss_count=0, shown_total=0)
        session.add(c)
        await session.flush()
    return c


async def _expire(session: AsyncSession, user_id: int, now: datetime, day_start: datetime) -> None:
    """Old proposals go quietly; a tip nobody answered is not carried into a new day."""
    await session.execute(
        update(Suggestion)
        .where(Suggestion.user_id == user_id, Suggestion.status.in_(LIVE),
               ((Suggestion.expires_at.is_not(None)) & (Suggestion.expires_at <= now))
               | ((Suggestion.kind == SuggestionKind.TIP) & (Suggestion.shown_at < day_start)))
        .values(status=SuggestionStatus.EXPIRED, updated_at=now)
        .execution_options(synchronize_session=False)
    )  # fmt: skip


async def _new_proposals(session: AsyncSession, user_id: int, now: datetime,
                         settings: Settings) -> None:  # fmt: skip
    """From new records' `envelope.proposed`: one row per record and key, ever. Records that are
    themselves tasks, or already have a task or a reminder, propose nothing."""
    rows = (await session.execute(text("""
        SELECT i.id, i.envelope -> 'proposed' AS p
        FROM items i
        WHERE i.user_id = :u AND i.deleted_at IS NULL AND i.hidden_reason IS NULL
          AND i.created_at >= :since AND i.envelope ? 'proposed'
          AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.item_id = i.id OR t.source_item_id = i.id)
          AND NOT EXISTS (SELECT 1 FROM reminders r WHERE r.item_id = i.id)
        ORDER BY i.id DESC LIMIT 20
    """), {"u": user_id, "since": now - PROPOSAL_FROM})).all()  # fmt: skip
    expires = now + timedelta(hours=settings.suggestions_proposal_hours)
    for item_id, proposed in rows:
        proposed = proposed if isinstance(proposed, dict) else {}
        wanted: list[tuple[str, dict[str, Any]]] = []
        tasks = [t for t in proposed.get("tasks") or [] if isinstance(t, dict) and t.get("title")]
        if tasks:
            wanted.append(("task_from_item", {"title": str(tasks[0]["title"])[:200]}))
        rems = [r for r in proposed.get("reminders") or [] if isinstance(r, dict) and r.get("text")]
        if rems:
            wanted.append(("reminder_from_item", {"text": str(rems[0]["text"])[:200],
                                                  "when_text": str(rems[0].get("when_text")
                                                                   or "")[:80]}))
        for key, payload in wanted:
            exists = await session.scalar(select(Suggestion.id).where(
                Suggestion.user_id == user_id, Suggestion.key == key,
                Suggestion.source_item_id == item_id))  # fmt: skip
            if exists is None:
                session.add(Suggestion(user_id=user_id, kind=SuggestionKind.DATA_PROPOSAL,
                                       key=key, payload=payload, source_item_id=item_id,
                                       status=SuggestionStatus.PENDING,
                                       expires_at=expires))  # fmt: skip
    await session.flush()


async def _page_proposals(session: AsyncSession, user: User, now: datetime,
                          settings: Settings) -> None:  # fmt: skip
    """R-55: the assistant offers a page; nothing is made before [Да]. At most one a week, not in
    the first 10 minutes, each topic once ever."""
    if now - user.created_at < PAGE_PROPOSAL_AFTER:
        return
    last = await session.scalar(select(func.max(Suggestion.created_at)).where(
        Suggestion.user_id == user.id, Suggestion.key.in_(PAGE_PROPOSALS)))  # fmt: skip
    if last is not None and now - last < PAGE_PROPOSAL_EVERY:
        return
    expires = now + timedelta(hours=settings.suggestions_proposal_hours)
    stack = (await session.execute(text("""
        SELECT c.public_id, c.title, c.item_count FROM collections c
        WHERE c.user_id = :u AND c.deleted_at IS NULL AND c.hidden_at IS NULL
          AND c.item_count >= :n
          AND NOT EXISTS (SELECT 1 FROM screens sc WHERE sc.user_id = :u
                          AND sc.deleted_at IS NULL AND lower(sc.title) = lower(c.title))
          AND NOT EXISTS (SELECT 1 FROM suggestions s WHERE s.user_id = :u
                          AND s.key = 'page_from_stack'
                          AND s.payload ->> 'collection_id' = c.public_id::text)
        ORDER BY c.item_count DESC, c.id LIMIT 1
    """), {"u": user.id, "n": PAGE_FROM_STACK_RECORDS})).first()  # fmt: skip
    if stack is not None:
        session.add(Suggestion(user_id=user.id, kind=SuggestionKind.DATA_PROPOSAL,
                               key="page_from_stack", status=SuggestionStatus.PENDING,
                               payload={"collection_id": str(stack.public_id),
                                        "title": stack.title, "count": int(stack.item_count)},
                               expires_at=expires))  # fmt: skip
        await session.flush()
        return
    wants_docs = await session.scalar(text("""
        SELECT 1 FROM company_profiles p WHERE p.user_id = :u AND p.name IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM screens sc WHERE sc.user_id = :u
                          AND sc.deleted_at IS NULL AND sc.template_key = 'documents')
          AND NOT EXISTS (SELECT 1 FROM suggestions s WHERE s.user_id = :u
                          AND s.key = 'add_documents_page')
    """), {"u": user.id})  # fmt: skip
    if wants_docs:
        session.add(Suggestion(user_id=user.id, kind=SuggestionKind.DATA_PROPOSAL,
                               key="add_documents_page", status=SuggestionStatus.PENDING,
                               payload={}, expires_at=expires))  # fmt: skip
        await session.flush()


async def _count(session: AsyncSession, sql: str, **params: Any) -> int:
    return int(await session.scalar(text(sql), params) or 0)


async def _eligible(session: AsyncSession, user: User, key: str,
                    now: datetime) -> dict[str, Any] | None:  # fmt: skip
    """The tip's condition (product 6.8). Returns its payload when it holds."""
    u = user.id
    age = now - user.created_at
    live_items = "SELECT count(*) FROM items WHERE user_id = :u AND deleted_at IS NULL " \
                 "AND hidden_reason IS NULL"  # fmt: skip
    if key == "first_reminder":
        items = await _count(session, live_items, u=u)
        rems = await session.scalar(select(func.count()).select_from(Reminder).where(
            Reminder.user_id == u, Reminder.deleted_at.is_(None), Reminder.kind == "normal"))
        return {} if items == 0 and not rems else None
    if key == "ask_anything":
        if await _count(session, live_items, u=u) < 15:
            return None
        asked = await _count(session, "SELECT count(*) FROM conversation_messages WHERE "
                             "user_id = :u AND role = 'assistant' AND answer_kind = 'text'", u=u)
        return {} if asked == 0 else None
    if key == "arrange_here":
        page = (await session.execute(text("""
            SELECT sc.public_id FROM screens sc
            WHERE sc.user_id = :u AND sc.deleted_at IS NULL AND sc.kind = 'page'
              AND sc.template_key NOT IN ('tasks', 'shopping')
              AND NOT EXISTS (SELECT 1 FROM actions a WHERE a.screen_id = sc.id
                              AND a.kind = 'screen_reorder_items')
              AND (SELECT count(*) FROM screen_items si JOIN items i ON i.id = si.item_id
                   WHERE si.screen_id = sc.id AND si.removed_by_user_at IS NULL
                     AND i.deleted_at IS NULL AND i.hidden_reason IS NULL) >= 10
            ORDER BY sc.position LIMIT 1
        """), {"u": u})).scalar()  # fmt: skip
        return {"page_id": str(page)} if page else None
    if key == "photo_paper":
        if age < timedelta(days=3):
            return None
        n = await _count(session, live_items + " AND kind IN ('image', 'screenshot') "
                         "AND created_at >= :since", u=u, since=now - timedelta(days=3))
        return {} if n == 0 else None
    if key == "share_from_apps":
        if age < timedelta(days=5):
            return None
        n = await _count(session, "SELECT count(*) FROM items WHERE user_id = :u AND "
                         "source = 'share' AND created_at >= :since", u=u,
                         since=now - timedelta(days=5))  # fmt: skip
        return {} if n == 0 else None
    if key == "add_ready_pages":
        if user.onboarding_path != "blank":
            return None
        if user.created_at >= _today_start(now, user.tz or "Asia/Almaty"):
            return None  # not before the 2nd day
        c = await session.get(SuggestionCounter, (u, key))
        return {} if c is None or not c.shown_total else None
    if key == "link_phone":
        phone = await session.scalar(select(AuthIdentity.id).where(
            AuthIdentity.user_id == u, AuthIdentity.provider == AuthProvider.PHONE).limit(1))
        if phone is not None or age < timedelta(days=LINK_PHONE_DAY):
            return None
        if await _count(session, live_items, u=u) < LINK_PHONE_RECORDS:
            return None
        c = await session.get(SuggestionCounter, (u, key))
        if c is not None and (c.shown_total >= LINK_PHONE_TIMES or (
                c.last_shown_at and now - c.last_shown_at < LINK_PHONE_EVERY)):
            return None  # fmt: skip
        return {}
    return None


async def _pick_tip(session: AsyncSession, user: User, now: datetime, day_start: datetime,
                    settings: Settings) -> Suggestion | None:  # fmt: skip
    on_screen = await session.scalar(
        select(Suggestion).where(Suggestion.user_id == user.id,
                                 Suggestion.kind == SuggestionKind.TIP,
                                 Suggestion.status == SuggestionStatus.SHOWN,
                                 Suggestion.shown_at >= day_start)
        .order_by(Suggestion.id.desc()).limit(1)
    )  # fmt: skip
    if on_screen is not None:
        return on_screen
    new_account = now - user.created_at < timedelta(days=settings.suggestions_new_days)
    per_day = (settings.suggestions_tips_per_day_new if new_account
               else settings.suggestions_tips_per_day)  # fmt: skip
    shown_today = await session.scalar(
        select(func.count()).select_from(Suggestion)
        .where(Suggestion.user_id == user.id, Suggestion.kind == SuggestionKind.TIP,
               Suggestion.shown_at >= day_start)
    ) or 0  # fmt: skip
    if shown_today >= per_day:
        return None
    accepted = set(await session.scalars(
        select(Suggestion.key).where(Suggestion.user_id == user.id,
                                     Suggestion.kind == SuggestionKind.TIP,
                                     Suggestion.status == SuggestionStatus.ACCEPTED)))  # fmt: skip
    for key in TIPS:
        if key in accepted:
            continue
        c = await session.get(SuggestionCounter, (user.id, key))
        if c is not None and ((c.cooldown_until and c.cooldown_until > now)
                              or (c.last_shown_at and now - c.last_shown_at < TIP_GAP)):
            continue
        payload = await _eligible(session, user, key, now)
        if payload is None:
            continue
        tip = Suggestion(user_id=user.id, kind=SuggestionKind.TIP, key=key, payload=payload,
                         status=SuggestionStatus.SHOWN, shown_at=now)  # fmt: skip
        session.add(tip)
        counter = await _counter(session, user.id, key)
        counter.last_shown_at, counter.shown_total = now, counter.shown_total + 1
        await session.flush()
        return tip
    return None


async def current(session: AsyncSession, user_id: int, now: datetime,
                  settings: Settings) -> tuple[list[Suggestion], Suggestion | None]:  # fmt: skip
    """What «Сегодня» shows now: ≤2 data proposals and ≤1 tip. Call under the user's lock."""
    user = await session.get(User, user_id)
    assert user is not None
    day_start = _today_start(now, user.tz or "Asia/Almaty")
    await _expire(session, user_id, now, day_start)
    await _new_proposals(session, user_id, now, settings)
    await _page_proposals(session, user, now, settings)
    proposals = list(await session.scalars(
        select(Suggestion).where(Suggestion.user_id == user_id,
                                 Suggestion.kind == SuggestionKind.DATA_PROPOSAL,
                                 Suggestion.status.in_(LIVE))
        .order_by(Suggestion.status.desc(), Suggestion.id)  # already shown first: no jumping
        .limit(settings.suggestions_proposals_max)
    ))  # fmt: skip
    for p in proposals:
        if p.status == SuggestionStatus.PENDING:
            p.status, p.shown_at = SuggestionStatus.SHOWN, now
    tip = await _pick_tip(session, user, now, day_start, settings)
    await session.flush()
    return proposals, tip


class SuggestionGone(Exception):
    """Expired, or already decided otherwise."""


async def decide(session: AsyncSession, user_id: int, public_id: uuid.UUID, *, accept: bool,
                 now: datetime, settings: Settings,
                 client_id: uuid.UUID | None = None) -> tuple[Suggestion, bool]:  # fmt: skip
    """Mark a suggestion accepted / dismissed. Returns (row, repeated). The caller does what an
    accepted proposal does, in the same transaction."""
    s = await session.scalar(select(Suggestion).where(
        Suggestion.user_id == user_id, Suggestion.public_id == public_id).with_for_update())
    if s is None:
        raise LookupError(str(public_id))
    wanted = SuggestionStatus.ACCEPTED if accept else SuggestionStatus.DISMISSED
    if s.status == wanted:
        return s, True
    if s.status not in LIVE or (s.expires_at is not None and s.expires_at <= now):
        if s.status in LIVE:
            s.status = SuggestionStatus.EXPIRED
        raise SuggestionGone(str(public_id))
    s.status, s.decided_at = wanted, now
    if client_id is not None:
        s.client_id = client_id
    if not accept and s.kind == SuggestionKind.TIP:
        c = await _counter(session, user_id, s.key)
        c.dismiss_count += 1
        if c.dismiss_count >= settings.suggestions_dismiss_limit:
            c.cooldown_until = now + timedelta(days=settings.suggestions_dismiss_pause_days)
            c.dismiss_count = 0
    await session.flush()
    return s, False
