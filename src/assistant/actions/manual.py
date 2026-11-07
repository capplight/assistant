"""The person's own moves (week 7; spec 6.12, F-41, R-54, US-27, US-28): a row within a page, a
record to other pages, «Убрать с этой страницы», the tab order. Contract: docs/api/pages.md
("Manual order").

Each call is one action with «Отменить» (`initiated_by=user`, inverse run by `engine`), made in the
caller's transaction under the per-user lock, and is safe to repeat: a `client_id` already used
returns that first action. Offline conflicts are settled here, not by the phone:
- one row (or tab) moved on two phones: last writer wins by `client_ts`, ties by `client_id`
  (`pages.order.wins`); the clock lives on the row and never goes back, so any arrival order gives
  the same winner;
- the phone's own LexoRank key is stored as is when it can be trusted (`pages.order.trusted` and no
  re-key of the page after the phone's `base_seq`), so moves of different rows commute;
- a move never leaves a record on no page (a removed target page, `rescue_moved`).
"""

import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.actions import engine
from assistant.actions.service import record
from assistant.db.models import Item
from assistant.db.models_actions import Action, ActionKind, Initiator
from assistant.db.models_habits import HabitKind, HabitStatus, UserHabit
from assistant.db.models_pages import Screen, ScreenItem, ScreenKind, UpdatedBy
from assistant.pages import habits, lexorank, lock_user, order, rebalance_page

KEEP = object()  # "leave group_key as it is"


class NotFound(LookupError):
    pass


class SystemPage(Exception):
    """«Сегодня» has no rows to move and cannot be moved."""


class Invalid(ValueError):
    pass


class ItemDeleted(Exception):
    pass


@dataclass
class Manual:
    done: bool
    reason: str | None = None
    repeated: bool = False
    action: Action | None = None
    pages: set[int] = field(default_factory=set)  # screen pks for `page_patches`
    items: set[str] = field(default_factory=set)  # item public ids for `page_patches`
    page: Screen | None = None
    rebased: bool = False
    learned: bool = False
    item_pk: int | None = None
    touched: list[int] = field(default_factory=list)  # screen pks whose row of the item to return


def _q(text: str) -> str:
    return f"«{text}»"


def title_of(item: Item) -> str:
    if item.title and item.title.strip():
        return " ".join(item.title.split())[:120]
    first = " ".join((item.text if item.text is not None else item.raw_text or "").split())
    return (first[:60] + "…") if len(first) > 60 else (first or "Запись")


async def _repeat(session: AsyncSession, user_id: int,
                  client_id: uuid.UUID | None) -> Action | None:  # fmt: skip
    if client_id is None:
        return None
    return await session.scalar(select(Action).where(Action.user_id == user_id,
                                                     Action.client_id == client_id))


async def _page(session: AsyncSession, user_id: int, page_id: uuid.UUID) -> Screen:
    page = await session.scalar(
        select(Screen).where(Screen.user_id == user_id, Screen.public_id == page_id)
        .with_for_update()
    )  # fmt: skip
    if page is None:
        raise NotFound("page")
    return page


async def _item_pks(session: AsyncSession, user_id: int,
                    ids: list[uuid.UUID]) -> dict[uuid.UUID, int]:  # fmt: skip
    if not ids:
        return {}
    rows = await session.execute(
        select(Item.public_id, Item.id).where(Item.user_id == user_id, Item.public_id.in_(ids))
    )
    return {pid: pk for pid, pk in rows}


async def _link(session: AsyncSession, screen_pk: int, item_pk: int) -> ScreenItem | None:
    return await session.scalar(
        select(ScreenItem).where(ScreenItem.screen_id == screen_pk, ScreenItem.item_id == item_pk)
        .with_for_update().execution_options(populate_existing=True)
    )  # fmt: skip


def _iso(ts: datetime | None) -> str | None:
    return ts.isoformat() if ts else None


# --- a row within a page ---


async def _slot(session: AsyncSession, page: Screen, self_pk: int, after_pk: int | None,
                before_pk: int | None) -> tuple[str | None, bool]:  # fmt: skip
    """Key right after the row above (else right before the row below) among the rows as they are
    now; re-keys the page once if the gap can't take one. (None, _) when both anchors are gone."""
    for attempt in (0, 1):
        rows = (await session.execute(
            select(ScreenItem.item_id, ScreenItem.position)
            .where(ScreenItem.screen_id == page.id, ScreenItem.position.is_not(None))
        )).all()  # fmt: skip
        pos = {pk: key for pk, key in rows}
        others = sorted(key for pk, key in rows if pk != self_pk)
        after = pos.get(after_pk) if after_pk is not None and after_pk != self_pk else None
        before = pos.get(before_pk) if before_pk is not None and before_pk != self_pk else None
        if after is None and before is None:
            return None, False
        try:
            return order.slot(others, after=after, before=before if after is None else None), \
                attempt == 1  # fmt: skip
        except order.NeedRekey:
            if attempt:
                raise
            await rebalance_page(session, page.id)
    raise AssertionError("unreachable")


async def move_row(session: AsyncSession, user_id: int, *, page_id: uuid.UUID,
                   item_id: uuid.UUID, after_id: uuid.UUID | None, before_id: uuid.UUID | None,
                   position: str | None, base_seq: int | None, group_key: Any = KEEP,
                   base_view_version: int | None, client_id: uuid.UUID,
                   client_ts: datetime | None, now: datetime) -> Manual:  # fmt: skip
    """«Выше / Ниже / перетащил»: the row gets its new key, `manual_order`, `updated_by=user`."""
    if item_id in (after_id, before_id) or (after_id is None and before_id is None):
        raise Invalid("anchors")
    await lock_user(session, user_id)
    page = await _page(session, user_id, page_id)
    if page.kind == ScreenKind.SYSTEM_TODAY:
        raise SystemPage
    pks = await _item_pks(session, user_id, [i for i in (item_id, after_id, before_id) if i])
    item_pk = pks.get(item_id)
    link = await _link(session, page.id, item_pk) if item_pk is not None else None
    if link is None:
        raise NotFound("item")
    base = Manual(done=False, pages={page.id}, items={str(item_id)}, page=page, item_pk=item_pk,
                  touched=[page.id])  # fmt: skip
    if (prior := await _repeat(session, user_id, client_id)) is not None:
        base.done, base.repeated, base.action = True, True, prior
        return base
    stamp = order.Stamp.of(client_ts or now, client_id, now)
    current = order.stamp_of(link.moved_ts, link.moved_client_id)
    if current is not None and stamp == current:  # a repeat of a move that changed nothing
        base.done, base.repeated = True, True
        return base
    if not order.wins(stamp, current):
        base.reason = "newer_move"  # a later move of this row (other phone) stands
        return base
    base.rebased = base_view_version is not None and base_view_version != page.view_version
    rekeyed = False
    key: str | None = None
    fresh = base_seq is not None and (page.rekeyed_seq is None or page.rekeyed_seq <= base_seq)
    if order.trusted(position) and fresh:
        key = position
    else:
        key, rekeyed = await _slot(session, page, item_pk, pks.get(after_id) if after_id else None,
                                   pks.get(before_id) if before_id else None)  # type: ignore[arg-type]  # fmt: skip
        if key is None:
            base.reason = "anchor_gone"
            return base
        if rekeyed:  # every row of the page changed: the patch carries them all
            link = await _link(session, page.id, item_pk)  # type: ignore[arg-type]
            assert link is not None
            base.items = {str(pid) for pid in await session.scalars(
                select(Item.public_id).join(ScreenItem, ScreenItem.item_id == Item.id)
                .where(ScreenItem.screen_id == page.id))}  # fmt: skip
    new_group = link.group_key if group_key is KEEP else group_key
    changed = (link.position, link.group_key, link.manual_order) != (key, new_group, True)
    old = {"item": str(item_id), "position": link.position, "group_key": link.group_key,
           "manual_order": link.manual_order, "manual_at": _iso(link.manual_at),
           "updated_by": link.updated_by,
           "expect": {"position": key, "group_key": new_group, "manual_order": True}}  # fmt: skip
    link.moved_ts, link.moved_client_id = stamp.ts, client_id  # the clock moves even on a no-op
    base.done = True
    if not changed:
        await session.flush()
        return base
    link.position, link.group_key, link.manual_order = key, new_group, True
    link.manual_at = stamp.ts
    link.updated_by, link.updated_at = UpdatedBy.USER, now
    page.view_version += 1
    page.updated_at = now
    item = await session.get(Item, item_pk)
    assert item is not None
    title = title_of(item)
    base.action = await record(
        session, user_id=user_id, kind=ActionKind.SCREEN_REORDER_ITEMS, initiated_by=Initiator.USER,
        summary={"ru": f"Переставил {_q(title)}", "kk": None},
        changes=[{"item_id": str(item_id), "title": title, "kind": "order",
                  "page_id": str(page.public_id), "text": f"{_q(title)} — переставил"}],
        inverse=[{"op": "restore_positions", "page": str(page.public_id), "rows": [old]}],
        now=now, screen_id=page.id, source_item_ids=[item_pk], client_id=client_id,  # type: ignore[list-item]
    )  # fmt: skip
    return base


# --- «Убрать с этой страницы» ---


async def remove_row(session: AsyncSession, user_id: int, *, page_id: uuid.UUID,
                     item_id: uuid.UUID, client_id: uuid.UUID | None,
                     now: datetime) -> Manual:  # fmt: skip
    await lock_user(session, user_id)
    page = await _page(session, user_id, page_id)
    if page.kind == ScreenKind.SYSTEM_TODAY:
        raise SystemPage
    item = await session.scalar(select(Item).where(Item.user_id == user_id,
                                                   Item.public_id == item_id))  # fmt: skip
    if item is None or await _link(session, page.id, item.id) is None:
        raise NotFound("item")
    base = Manual(done=False, pages={page.id}, items={str(item_id)}, page=page, item_pk=item.id,
                  touched=[page.id])  # fmt: skip
    if (prior := await _repeat(session, user_id, client_id)) is not None:
        base.done, base.repeated, base.action = True, True, prior
        return base
    out = await engine.apply(session, user_id, [{"op": "remove_screen_item",
                                                 "page": str(page.public_id),
                                                 "item": str(item_id), "exclude": True}],
                             by=Initiator.USER, check=False, now=now)  # fmt: skip
    if not out.inverse:
        base.reason = "nothing_to_do"  # already off this page
        return base
    title = title_of(item)
    base.done = True
    base.action = await record(
        session, user_id=user_id, kind=ActionKind.SCREEN_REMOVE_ITEM, initiated_by=Initiator.USER,
        summary={"ru": f"Убрал {_q(title)} со страницы {_q(page.title)}", "kk": None},
        changes=[{"item_id": str(item_id), "title": title, "kind": "remove",
                  "page_id": str(page.public_id),
                  "text": f"{_q(title)} — убрал с {_q(page.title)}"}],
        inverse=out.inverse, now=now, screen_id=page.id, source_item_ids=[item.id],
        client_id=client_id,
    )  # fmt: skip
    return base


# --- a record to other pages ---


async def move_to_page(session: AsyncSession, user_id: int, *, item_id: uuid.UUID,
                       mode: Literal["move", "also_show"], from_page_id: uuid.UUID | None,
                       to_page_ids: list[uuid.UUID], client_id: uuid.UUID,
                       now: datetime) -> Manual:  # fmt: skip
    """«Переместить на страницу…» (`move`) / «Показать ещё на…» (`also_show`). Teaches
    `placement_rule`."""
    targets_ids = list(dict.fromkeys(to_page_ids))
    if not targets_ids or (mode == "move" and (from_page_id is None or len(targets_ids) != 1)):
        raise Invalid("pages")
    if from_page_id is not None and mode == "move" and from_page_id in targets_ids:
        raise Invalid("same page")
    await lock_user(session, user_id)
    item = await session.scalar(select(Item).where(Item.user_id == user_id,
                                                   Item.public_id == item_id))  # fmt: skip
    if item is None:
        raise NotFound("item")
    targets = [await _page(session, user_id, pid) for pid in targets_ids]
    src = await _page(session, user_id, from_page_id) if mode == "move" else None  # type: ignore[arg-type]
    if any(p.kind == ScreenKind.SYSTEM_TODAY for p in [*targets, *([src] if src else [])]):
        raise SystemPage
    live = [p for p in targets if p.deleted_at is None]
    base = Manual(done=False, pages={p.id for p in live} | ({src.id} if src else set()),
                  items={str(item_id)}, item_pk=item.id,
                  touched=[p.id for p in live] + ([src.id] if src else []))  # fmt: skip
    if (prior := await _repeat(session, user_id, client_id)) is not None:
        base.done, base.repeated, base.action = True, True, prior
        return base
    if item.deleted_at is not None:
        raise ItemDeleted
    if not live:
        base.reason = "page_removed"  # the other phone removed it: the record stays where it is
        return base
    ops: list[dict[str, Any]] = [{"op": "add_screen_item", "page": str(p.public_id),
                                  "item": str(item_id)} for p in live]  # fmt: skip
    if src is not None:
        ops.append({"op": "remove_screen_item", "page": str(src.public_id),
                    "item": str(item_id), "exclude": True})  # fmt: skip
    out = await engine.apply(session, user_id, ops, by=Initiator.USER, check=False, now=now)
    if src is not None:
        for p in live:
            link = await _link(session, p.id, item.id)
            if link is not None:
                link.moved_from_screen_id = src.id
    if not out.inverse:
        base.reason = "nothing_to_do"
        return base
    learned_ops: list[dict[str, Any]] = []
    for p in live:
        op, switched_on = await habits.learn(session, user_id, item_public_id=str(item_id),
                                             envelope=item.envelope, to_page=p, from_page=src,
                                             now=now)  # fmt: skip
        if op is not None:
            learned_ops.append(op)
        base.learned |= switched_on
    title = title_of(item)
    if mode == "move":
        dst = live[0]
        summary = f"Перенёс {_q(title)} в {_q(dst.title)}"
        changes = [{"item_id": str(item_id), "title": title, "kind": "move",
                    "page_id": str(dst.public_id), "text": f"{_q(title)} → {dst.title}"}]
    else:
        summary = (f"Показал {_q(title)} ещё и на {_q(live[0].title)}" if len(live) == 1
                   else f"Показал {_q(title)} ещё на {len(live)} страницах")  # fmt: skip
        changes = [{"item_id": str(item_id), "title": title, "kind": "show",
                    "page_id": str(p.public_id), "text": f"{_q(title)} — ещё и на {_q(p.title)}"}
                   for p in live]  # fmt: skip
    base.done = True
    base.page = src or live[0]
    base.action = await record(
        session, user_id=user_id, kind=ActionKind.SCREEN_MOVE_ITEMS, initiated_by=Initiator.USER,
        summary={"ru": summary, "kk": None}, changes=changes,
        inverse=[*reversed(learned_ops), *out.inverse], now=now, screen_id=(src or live[0]).id,
        source_item_ids=[item.id], client_id=client_id,
    )  # fmt: skip
    return base


# --- tab order ---


async def _rekey_tabs(session: AsyncSession, user_id: int) -> None:
    tabs = list(await session.scalars(
        select(Screen).where(Screen.user_id == user_id, Screen.kind != ScreenKind.SYSTEM_TODAY)
        .order_by(Screen.position, Screen.public_id).with_for_update()))  # fmt: skip
    for tab, key in zip(tabs, lexorank.sequence(len(tabs)), strict=True):
        tab.position = key
    await session.flush()


async def move_tab(session: AsyncSession, user_id: int, *, page_id: uuid.UUID,
                   after_id: uuid.UUID | None, before_id: uuid.UUID | None,
                   position: str | None, client_id: uuid.UUID, client_ts: datetime | None,
                   now: datetime) -> Manual:  # fmt: skip
    """«Мои страницы»: one page to a new place among the tabs. «Сегодня» is always first."""
    if page_id in (after_id, before_id) or (after_id is None and before_id is None):
        raise Invalid("anchors")
    await lock_user(session, user_id)
    page = await _page(session, user_id, page_id)
    if page.kind == ScreenKind.SYSTEM_TODAY:
        raise SystemPage
    base = Manual(done=False, page=page)
    if (prior := await _repeat(session, user_id, client_id)) is not None:
        base.done, base.repeated, base.action = True, True, prior
        return base
    stamp = order.Stamp.of(client_ts or now, client_id, now)
    current = order.stamp_of(page.moved_ts, page.moved_client_id)
    if current is not None and stamp == current:  # a repeat of a move that changed nothing
        base.done, base.repeated = True, True
        return base
    if not order.wins(stamp, current):
        base.reason = "newer_move"
        return base
    key = position if order.trusted(position) else None
    for attempt in (0, 1):
        if key is not None:
            break
        rows = (await session.execute(
            select(Screen.public_id, Screen.position, Screen.kind)
            .where(Screen.user_id == user_id, Screen.id != page.id))).all()  # fmt: skip
        pos = {pid: k for pid, k, kind in rows if kind != ScreenKind.SYSTEM_TODAY}
        today = {pid for pid, _, kind in rows if kind == ScreenKind.SYSTEM_TODAY}
        others = sorted(pos.values())
        try:
            if after_id is not None and after_id in today:  # the first place after «Сегодня»
                key = order.slot(others, after=None, before=others[0]) if others \
                    else lexorank.between(None, None)  # fmt: skip
            else:
                after = pos.get(after_id) if after_id else None
                before = pos.get(before_id) if before_id else None
                if after is None and before is None:
                    base.reason = "anchor_gone"
                    return base
                key = order.slot(others, after=after, before=before if after is None else None)
        except order.NeedRekey:
            if attempt:
                raise
            await _rekey_tabs(session, user_id)
            await session.refresh(page)
    assert key is not None
    page.moved_ts, page.moved_client_id = stamp.ts, client_id
    base.done = True
    if key == page.position:
        await session.flush()
        return base
    old = page.position
    page.position, page.updated_at = key, now
    base.action = await record(
        session, user_id=user_id, kind=ActionKind.REORDER_SCREENS, initiated_by=Initiator.USER,
        summary={"ru": f"Переставил страницу {_q(page.title)}", "kk": None}, changes=[],
        inverse=[{"op": "restore_page_position", "page": str(page.public_id), "position": old,
                  "expect": key}],
        now=now, screen_id=page.id, client_id=client_id,
    )  # fmt: skip
    return base


# --- a learned rule, turned off by the person ---


async def turn_off_rule(session: AsyncSession, user_id: int, *, habit_id: uuid.UUID,
                        client_id: uuid.UUID | None, now: datetime) -> Manual:  # fmt: skip
    """«Убрать» in «Что я для вас настроил»: the rule stays as `disabled`, so learning does not
    switch it on again. One action with «Отменить»."""
    await lock_user(session, user_id)
    habit = await session.scalar(
        select(UserHabit).where(UserHabit.user_id == user_id, UserHabit.public_id == habit_id,
                                UserHabit.kind == HabitKind.PLACEMENT_RULE).with_for_update()
    )  # fmt: skip
    if habit is None:
        raise NotFound("habit")
    base = Manual(done=False)
    if (prior := await _repeat(session, user_id, client_id)) is not None:
        base.done, base.repeated, base.action = True, True, prior
        return base
    if habit.status == HabitStatus.DISABLED:
        base.reason = "nothing_to_do"
        return base
    before = habits.state_of(habit)
    habit.status, habit.updated_at = HabitStatus.DISABLED, now
    base.done = True
    base.action = await record(
        session, user_id=user_id, kind=ActionKind.HABIT_CHANGE, initiated_by=Initiator.USER,
        summary={"ru": "Убрал правило: больше не кладу такие записи сама", "kk": None}, changes=[],
        inverse=[{"op": "restore_habit", "id": str(habit.public_id), "state": before,
                  "expect": {"evidence_count": habit.evidence_count,
                             "status": str(HabitStatus.DISABLED)}}],
        now=now, client_id=client_id,
    )  # fmt: skip
    return base
