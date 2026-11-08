"""Placing items on pages and keeping their order.

"Human over AI" (R-54) at this layer: placement only ever inserts rows. An existing row keeps its
position and flags, and a row the person removed (`removed_by_user_at`) stays removed. Writers take
the per-user sync lock first, so neighbours read here can't change before the insert.
"""

import uuid
from datetime import datetime

from sqlalchemy import delete as sa_delete
from sqlalchemy import func, select, text, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from assistant.db.ids import uuid7
from assistant.db.models import Item
from assistant.db.models_pages import (
    AddedBy,
    Screen,
    ScreenCreatedBy,
    ScreenItem,
    ScreenKind,
    ScreenTemplate,
)
from assistant.db.models_v2 import HiddenReason
from assistant.pages import habits, lexorank
from assistant.pages.rules import ItemFacts, excluded, matches


async def lock_user(session: AsyncSession, user_id: int) -> None:
    await session.execute(text("SELECT sync_lock_user(:uid)"), {"uid": user_id})


async def latest_templates(session: AsyncSession) -> list[ScreenTemplate]:
    """What the gallery shows, in gallery order: the newest published version of each key."""
    rows = await session.scalars(
        select(ScreenTemplate)
        .where(ScreenTemplate.status == "published")
        .order_by(ScreenTemplate.version)
    )
    newest = {t.key: t for t in rows}
    return sorted((t for t in newest.values() if t.catalog_visible),
                  key=lambda t: t.catalog_order)  # fmt: skip


async def latest_template(session: AsyncSession, key: str) -> ScreenTemplate | None:
    """A template a person can add; `today` is not one."""
    return next((t for t in await latest_templates(session) if t.key == key), None)


async def _rules(session: AsyncSession, pages: list[Screen]) -> dict[int, dict]:
    """Rule per page: its own if set, else the one of the template version it was made from."""
    wanted = {p.template_key for p in pages if p.rule is None}
    by_key: dict[tuple[str, int], dict] = {}
    if wanted:
        rows = await session.execute(
            select(ScreenTemplate.key, ScreenTemplate.version, ScreenTemplate.auto_rule)
            .where(ScreenTemplate.key.in_(wanted))
        )  # fmt: skip
        by_key = {(r.key, r.version): r.auto_rule for r in rows}
    return {
        p.id: p.rule if p.rule is not None else by_key.get((p.template_key, p.template_version), {})
        for p in pages
    }


async def rebalance_page(session: AsyncSession, screen_id: int) -> int:
    """Re-key a page in one transaction: same visible order (page order, so rows that shared a key
    keep their tie-break), same flags, shorter keys. Who last moved a row is not touched. Rows
    without a position stay. Marks the page `rekeyed_seq`: keys a phone computed before this are
    not trusted (`order.trusted`). Returns the rows re-keyed."""
    rows = (
        await session.execute(
            select(ScreenItem.item_id)
            .join(Item, Item.id == ScreenItem.item_id)
            .where(ScreenItem.screen_id == screen_id, ScreenItem.position.is_not(None))
            .order_by(ScreenItem.position, func.coalesce(Item.occurred_at, Item.created_at).desc(),
                      Item.public_id)
            .with_for_update(of=ScreenItem)
        )
    ).all()  # fmt: skip
    for (item_id,), key in zip(rows, lexorank.sequence(len(rows)), strict=True):
        await session.execute(
            update(ScreenItem)
            .where(ScreenItem.screen_id == screen_id, ScreenItem.item_id == item_id)
            .values(position=key)
            .execution_options(synchronize_session=False)
        )
    await mark_rekeyed(session, screen_id)
    return len(rows)


async def mark_rekeyed(session: AsyncSession, screen_id: int) -> None:
    """Keys of this page's rows were laid out anew. Taken after the rows' own seq, so a phone whose
    `base_seq` covers this value has seen all of them, even when sync came in several pages."""
    await session.execute(
        update(Screen).where(Screen.id == screen_id)
        .values(rekeyed_seq=func.nextval("sync_seq"))
        .execution_options(synchronize_session=False)
    )  # fmt: skip


async def _gap(session: AsyncSession, screen_id: int,
               when: datetime) -> tuple[str | None, str | None]:  # fmt: skip
    """Neighbours for a row dated `when`: right above the first auto-placed row that isn't newer.
    Rows the person placed or pinned are no reference, so they keep their places, and a head of them
    stays on top of anything new."""
    below = await session.scalar(
        select(ScreenItem.position)
        .join(Item, Item.id == ScreenItem.item_id)
        .where(
            ScreenItem.screen_id == screen_id,
            ScreenItem.position.is_not(None),
            ScreenItem.manual_order.is_(False),
            ScreenItem.pinned.is_(False),
            ScreenItem.removed_by_user_at.is_(None),
            func.coalesce(Item.occurred_at, Item.created_at) <= when,
        )
        .order_by(ScreenItem.position, Item.public_id)
        .limit(1)
    )
    stmt = select(func.max(ScreenItem.position)).where(ScreenItem.screen_id == screen_id)
    if below is not None:
        stmt = stmt.where(ScreenItem.position < below)
    return await session.scalar(stmt), below


async def _position_for(session: AsyncSession, screen_id: int, when: datetime) -> str:
    above, below = await _gap(session, screen_id, when)
    key = lexorank.between(above, below)
    if len(key) > lexorank.MAX_LENGTH:
        await rebalance_page(session, screen_id)
        above, below = await _gap(session, screen_id, when)
        key = lexorank.between(above, below)
    return key


async def add_link(session: AsyncSession, page: Screen, item_id: int, when: datetime,
                   added_by: AddedBy = AddedBy.RULE) -> bool:  # fmt: skip
    """Insert a row unless one exists, whatever its state. True if it was inserted."""
    exists = await session.scalar(
        select(ScreenItem.item_id)
        .where(ScreenItem.screen_id == page.id, ScreenItem.item_id == item_id)
    )  # fmt: skip
    if exists is not None:
        return False
    key = await _position_for(session, page.id, when)
    updated_by = "user" if added_by == AddedBy.USER else "agent"
    result = await session.execute(
        insert(ScreenItem)
        .values(screen_id=page.id, item_id=item_id, user_id=page.user_id, public_id=uuid7(),
                position=key, added_by=str(added_by), updated_by=updated_by)
        .on_conflict_do_nothing(index_elements=["screen_id", "item_id"])
    )  # fmt: skip
    return bool(result.rowcount)


async def place_item(session: AsyncSession, item: Item) -> int:
    """Put an item on every live page of its owner whose rule matches. Safe to repeat. Returns how
    many rows were added."""
    await lock_user(session, item.user_id)
    pages = list(
        await session.scalars(
            select(Screen).where(Screen.user_id == item.user_id, Screen.deleted_at.is_(None))
        )
    )
    rules = await _rules(session, pages)
    is_task = await session.scalar(text("SELECT 1 FROM tasks WHERE item_id = :i"),
                                   {"i": item.id}) is not None  # fmt: skip
    facts = ItemFacts(kind=str(item.kind), envelope=item.envelope, title=item.title,
                      summary=item.summary,
                      text=item.text if item.text is not None else item.raw_text,
                      is_task=is_task)  # fmt: skip
    # Learned from the person's moves: such records also go where they put the others.
    learned = await habits.placements(session, item.user_id, item.envelope)
    targets = {str(h.value.get("page_id")) for h in learned}
    when = item.occurred_at or item.created_at
    live = [p for p in pages if p.kind != ScreenKind.SYSTEM_TODAY]
    # Which pages take it regardless of `none` (week 10): a page that takes it elsewhere lets
    # «Заметки» leave a receipt or a task out; with no such page the record stays on «Заметки».
    takes = {p.id: str(p.public_id) in targets or matches(rules[p.id], facts, elsewhere=False)
             or (is_task and p.template_key in TASK_LISTS) for p in live}  # fmt: skip
    added = 0
    for page in live:
        others = any(takes[q.id] and not excluded(rules[q.id], facts) for q in live
                     if q.id != page.id)  # fmt: skip
        wanted = str(page.public_id) in targets or matches(rules[page.id], facts, elsewhere=others)
        if wanted and await add_link(session, page, item.id, when):
            added += 1
        elif not wanted and others and excluded(rules[page.id], facts):
            await _drop_rule_row(session, page, item.id)
    for h in learned:
        h.last_used_at = func.now()
    return added


async def _drop_rule_row(session: AsyncSession, page: Screen, item_id: int) -> None:
    """A row the rules alone put here before the record was understood (a receipt on «Заметки»):
    it goes once the record is known to belong elsewhere. A row the person placed, moved, pinned
    or removed is never touched (R-54)."""
    await session.execute(
        sa_delete(ScreenItem)
        .where(ScreenItem.screen_id == page.id, ScreenItem.item_id == item_id,
               ScreenItem.added_by == AddedBy.RULE, ScreenItem.updated_by == "agent",
               ScreenItem.manual_order.is_(False), ScreenItem.pinned.is_(False),
               ScreenItem.removed_by_user_at.is_(None), ScreenItem.moved_ts.is_(None))
        .execution_options(synchronize_session=False))  # fmt: skip


async def rescue_moved(session: AsyncSession, page: Screen) -> int:
    """A page is being removed: a record the person moved onto it by hand, that is on no other live
    page, goes back on the page it was moved from (a move never leaves a record on no page, also
    when the move and the removal came from two phones). Returns how many came back."""
    other = aliased(ScreenItem)
    live = aliased(Screen)
    rows = list(await session.execute(
        select(ScreenItem.item_id, ScreenItem.moved_from_screen_id)
        .join(Screen, Screen.id == ScreenItem.moved_from_screen_id)
        .where(ScreenItem.screen_id == page.id, ScreenItem.removed_by_user_at.is_(None),
               ScreenItem.moved_from_screen_id.is_not(None), Screen.deleted_at.is_(None),
               ~select(other.item_id).join(live, live.id == other.screen_id)
               .where(other.item_id == ScreenItem.item_id, other.screen_id != page.id,
                      other.removed_by_user_at.is_(None), live.deleted_at.is_(None),
                      live.kind != ScreenKind.SYSTEM_TODAY).exists())
    ))  # fmt: skip
    back = 0
    for item_id, src in rows:
        result = await session.execute(
            update(ScreenItem)
            .where(ScreenItem.screen_id == src, ScreenItem.item_id == item_id,
                   ScreenItem.removed_by_user_at.is_not(None))
            .values(removed_by_user_at=None, updated_at=func.now())
            .execution_options(synchronize_session=False)
        )  # fmt: skip
        back += result.rowcount or 0
    return back


# «Дела» / «Покупки» are views over the tasks table (spec 3.10): their pages hold the records of
# these lists' tasks besides what their rule matches.
TASK_LISTS = {"tasks": ("todo",), "shopping": ("shopping",)}


async def fill_page(session: AsyncSession, page: Screen) -> int:
    """Bring in what the memory already holds, so a new page isn't empty if something matches.
    Trashed and merged items are included (reads hide them): restoring one needs no extra work.
    Voice fragments are not: a fragment reaches pages through its recording."""
    await lock_user(session, page.user_id)
    rule = (await _rules(session, [page]))[page.id]
    lists = TASK_LISTS.get(page.template_key, ())
    if not rule.get("any") and not lists:
        return 0
    when = func.coalesce(Item.occurred_at, Item.created_at)
    rows = await session.execute(
        select(Item.id, Item.kind, Item.envelope, Item.title, Item.summary,
               func.coalesce(Item.text, Item.raw_text).label("body"), when.label("when"))
        .where(Item.user_id == page.user_id,
               Item.hidden_reason.is_distinct_from(HiddenReason.VOICE_FRAGMENT))
        .order_by(when.desc(), Item.id.desc())
    )  # fmt: skip
    task_items: set[int] = set()
    if lists:
        task_items = set(await session.scalars(
            text("SELECT item_id FROM tasks WHERE user_id = :u AND list_key = ANY(:l) "
                 "AND deleted_at IS NULL"), {"u": page.user_id, "l": list(lists)}))  # fmt: skip
    all_tasks: set[int] = set(await session.scalars(
        text("SELECT item_id FROM tasks WHERE user_id = :u"), {"u": page.user_id}))
    # Week 10 (rules.py `none`): what another page takes stays off a page whose rule says so.
    others = list(await session.scalars(select(Screen).where(
        Screen.user_id == page.user_id, Screen.deleted_at.is_(None), Screen.id != page.id,
        Screen.kind != ScreenKind.SYSTEM_TODAY)))  # fmt: skip
    other_rules = await _rules(session, others)
    facts_of: dict[int, ItemFacts] = {}

    def wanted(r) -> bool:  # type: ignore[no-untyped-def]
        facts = ItemFacts(kind=str(r.kind), envelope=r.envelope, title=r.title,
                          summary=r.summary, text=r.body, is_task=r.id in all_tasks)  # fmt: skip
        facts_of[r.id] = facts
        if not rule.get("none"):
            return r.id in task_items or matches(rule, facts)
        elsewhere = any(matches(other_rules[q.id], facts) or (facts.is_task and
                                                              q.template_key in TASK_LISTS)
                        for q in others)  # fmt: skip
        return r.id in task_items or matches(rule, facts, elsewhere=elsewhere)

    found = [r for r in rows if wanted(r)]
    # This page now takes them: a page that leaves such records out lets its rule-placed rows go
    # («Расходы» added: the receipts the rules had put on «Заметки» leave it).
    for q in others:
        if other_rules[q.id].get("none"):
            for r in found:
                if excluded(other_rules[q.id], facts_of[r.id]):
                    await _drop_rule_row(session, q, r.id)
    existing = set(await session.scalars(
        select(ScreenItem.item_id).where(ScreenItem.screen_id == page.id)
    ))  # fmt: skip
    if not existing:
        if found:
            await session.execute(
                insert(ScreenItem),
                [{"screen_id": page.id, "item_id": r.id, "user_id": page.user_id,
                  "public_id": uuid7(), "position": key}
                 for r, key in zip(found, lexorank.sequence(len(found)), strict=True)],
            )  # fmt: skip
        return len(found)
    # A restored page: every row stays as it was; only what is missing is added, oldest first.
    added = 0
    for row in reversed(found):
        if row.id not in existing and await add_link(session, page, row.id, row.when):
            added += 1
    return added


async def create_page(
    session: AsyncSession, user_id: int, template: ScreenTemplate, *,
    client_id: uuid.UUID, title: str | None = None, icon: str | None = None,
    layout: str | None = None, created_by: ScreenCreatedBy = ScreenCreatedBy.USER,
) -> Screen:  # fmt: skip
    """Insert a page at the end of the tabs. Limits and idempotency belong to the caller; a
    singleton or client_id conflict raises IntegrityError on flush."""
    await lock_user(session, user_id)
    # Removed pages count too: restoring one must not produce an equal key.
    last = await session.scalar(select(func.max(Screen.position)).where(Screen.user_id == user_id))
    page = Screen(
        user_id=user_id, client_id=client_id, template_key=template.key,
        template_version=template.version, singleton=template.singleton,
        title=title or template.default_title["ru"],
        title_kk=None if title else template.default_title.get("kk"),
        icon=icon or template.icon, position=lexorank.between(last, None),
        layout=layout or template.default_layout, view_state=dict(template.default_view or {}),
        created_by=str(created_by),
    )  # fmt: skip
    session.add(page)
    await session.flush()
    return page
