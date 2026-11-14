"""Placing items on pages and keeping their order.

"Human over AI" (R-54) at this layer: placement only ever inserts rows. An existing row keeps its
position and flags, and a row the person removed (`removed_by_user_at`) stays removed. Writers take
the per-user sync lock first, so neighbours read here can't change before the insert.
"""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import delete as sa_delete
from sqlalchemy import func, or_, select, text, update
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
from assistant.pages import board, habits, lexorank, order
from assistant.pages.rules import ItemFacts, excluded, matches


async def timed_items(session: AsyncSession, page: Screen,
                      item_pks: list[int] | None = None) -> set[int]:  # fmt: skip
    """Item pks of the page's rows that have a time («Дела»: a live reminder of the record;
    `order.TIMED_TEMPLATES`). Such rows are ordered by their time, never by `position`."""
    if page.template_key not in order.TIMED_TEMPLATES:
        return set()
    rows = await session.execute(text("""
        SELECT DISTINCT r.item_id FROM reminders r
        JOIN screen_items si ON si.item_id = r.item_id AND si.screen_id = :s
        WHERE r.user_id = :u AND r.kind = 'normal' AND r.deleted_at IS NULL
          AND r.status <> 'cancelled' AND (CAST(:pks AS BIGINT[]) IS NULL
                                           OR r.item_id = ANY(CAST(:pks AS BIGINT[])))
    """), {"s": page.id, "u": page.user_id, "pks": item_pks})  # fmt: skip
    return {int(r[0]) for r in rows}


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
    place: dict[str, float] = {}
    if board_on(page):  # a new sticker lies in the first free place from the top (Ф-28)
        (bx, by), = board.free_slots(await _placed(session, page.id), 1)
        place = {"board_x": bx, "board_y": by}
    result = await session.execute(
        insert(ScreenItem)
        .values(screen_id=page.id, item_id=item_id, user_id=page.user_id, public_id=uuid7(),
                position=key, added_by=str(added_by), updated_by=updated_by, **place)
        .on_conflict_do_nothing(index_elements=["screen_id", "item_id"])
    )  # fmt: skip
    return bool(result.rowcount)


# --- the free board of «Заметки» (weeks 16а–16б; pure rules in `pages.board`) ---


def board_on(page: Screen) -> bool:
    """«Заметки» shown as «Доска» (`view_state.board`)."""
    return page.template_key == "notes" and bool((page.view_state or {}).get("board"))


def _shown():  # type: ignore[no-untyped-def]
    return (ScreenItem.removed_by_user_at.is_(None), Item.deleted_at.is_(None),
            Item.hidden_reason.is_(None))  # fmt: skip


async def _placed(session: AsyncSession, screen_id: int) -> list[board.Placed]:
    rows = await session.execute(
        select(ScreenItem.board_x, ScreenItem.board_y).join(Item, Item.id == ScreenItem.item_id)
        .where(ScreenItem.screen_id == screen_id, ScreenItem.board_x.is_not(None),
               ScreenItem.board_y.is_not(None), *_shown())
    )  # fmt: skip
    return [board.Placed(board.x_pt(x), int(y)) for x, y in rows]


async def fill_board(session: AsyncSession, page: Screen) -> list[str]:
    """Give every shown sticker without a place the first free grid slot, in rows order (pinned
    first, then position). Never moves a placed sticker; not the person's place
    (`board_manual` stays false). Returns the item public ids that got a place."""
    rows = (await session.execute(
        select(ScreenItem, Item.public_id).join(Item, Item.id == ScreenItem.item_id)
        .where(ScreenItem.screen_id == page.id, *_shown(),
               or_(ScreenItem.board_x.is_(None), ScreenItem.board_y.is_(None)))
        .order_by(ScreenItem.pinned.desc(), ScreenItem.position, Item.public_id)
        .with_for_update(of=ScreenItem)
    )).all()  # fmt: skip
    if not rows:
        return []
    slots = board.free_slots(await _placed(session, page.id), len(rows))
    for (link, _), (bx, by) in zip(rows, slots, strict=True):
        link.board_x, link.board_y, link.board_z = bx, by, None
    await session.flush()
    return [str(pid) for _, pid in rows]


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
    owners = await _owners(session, item.user_id, [item.id])
    owned_by = owners.get(item.id, frozenset())
    facts = ItemFacts(kind=str(item.kind), envelope=item.envelope, title=item.title,
                      summary=item.summary,
                      text=item.text if item.text is not None else item.raw_text,
                      is_task=bool(owned_by))  # fmt: skip
    # Learned from the person's moves: such records also go where they put the others.
    learned = await habits.placements(session, item.user_id, item.envelope)
    targets = {str(h.value.get("page_id")) for h in learned}
    when = item.occurred_at or item.created_at
    live = [p for p in pages if p.kind != ScreenKind.SYSTEM_TODAY]
    # Which pages take it regardless of `none` (week 10): a page that takes it elsewhere lets
    # «Заметки» leave a receipt or a task out; with no such page the record stays on «Заметки».
    takes = {p.id: str(p.public_id) in targets or matches(rules[p.id], facts, elsewhere=False)
             or p.template_key in owned_by for p in live}  # fmt: skip
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
# Week 12: «Расходы» is a view over `expense_entries` the same way.
EXPENSES_TEMPLATE = "expenses"


async def _owners(session: AsyncSession, user_id: int,
                  item_ids: list[int] | None) -> dict[int, frozenset[str]]:  # fmt: skip
    """Records that are a tool row's own record (a task; an expense, week 12; a КП, week 14) → the
    templates whose page takes them. `item_ids=None`: all of the person's."""
    where = "user_id = :u" + (" AND item_id = ANY(:i)" if item_ids is not None else "")
    params = {"u": user_id, "i": item_ids or []}
    out: dict[int, set[str]] = {}
    for (item_id,) in await session.execute(text(f"SELECT item_id FROM tasks WHERE {where}"),
                                            params):  # fmt: skip
        out.setdefault(item_id, set()).update(TASK_LISTS)
    for (item_id,) in await session.execute(
            text(f"SELECT item_id FROM expense_entries WHERE {where}"), params):  # fmt: skip
        out.setdefault(item_id, set()).add(EXPENSES_TEMPLATE)
    for (item_id,) in await session.execute(  # week 14: a КП's own record
            text(f"SELECT item_id FROM documents WHERE {where}"), params):  # fmt: skip
        out.setdefault(item_id, set()).add("documents")
    return {k: frozenset(v) for k, v in out.items()}


async def fill_page(session: AsyncSession, page: Screen) -> int:
    """Bring in what the memory already holds, so a new page isn't empty if something matches.
    Trashed and merged items are included (reads hide them): restoring one needs no extra work.
    Voice fragments are not: a fragment reaches pages through its recording."""
    await lock_user(session, page.user_id)
    rule = (await _rules(session, [page]))[page.id]
    lists = TASK_LISTS.get(page.template_key, ())
    expenses = page.template_key == EXPENSES_TEMPLATE
    if not rule.get("any") and not lists and not expenses:
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
    if expenses:
        task_items |= set(await session.scalars(
            text("SELECT item_id FROM expense_entries WHERE user_id = :u "
                 "AND deleted_at IS NULL"), {"u": page.user_id}))  # fmt: skip
    owners = await _owners(session, page.user_id, None)
    # Week 10 (rules.py `none`): what another page takes stays off a page whose rule says so.
    others = list(await session.scalars(select(Screen).where(
        Screen.user_id == page.user_id, Screen.deleted_at.is_(None), Screen.id != page.id,
        Screen.kind != ScreenKind.SYSTEM_TODAY)))  # fmt: skip
    other_rules = await _rules(session, others)
    facts_of: dict[int, ItemFacts] = {}

    def wanted(r) -> bool:  # type: ignore[no-untyped-def]
        facts = ItemFacts(kind=str(r.kind), envelope=r.envelope, title=r.title,
                          summary=r.summary, text=r.body, is_task=r.id in owners)  # fmt: skip
        facts_of[r.id] = facts
        if not rule.get("none"):
            return r.id in task_items or matches(rule, facts)
        elsewhere = any(matches(other_rules[q.id], facts)
                        or q.template_key in owners.get(r.id, frozenset())
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


# Default pages added after accounts already existed (Ф-48): made lazily for those accounts.
LAZY_DEFAULT_KEYS = frozenset({"expenses"})


def default_keys(s: Any = None) -> list[str]:
    """Template keys every account has after «Сегодня» (Ф-35, Ф-48), in tab order."""
    from assistant.config import get_settings

    s = s or get_settings()
    return [k for k in s.pages_default_keys if k != "today"]


def first_use_keys(s: Any = None) -> list[str]:
    """Template keys made on their first record (Ф-35, Ф-36): not the default ones, and not
    «Покупки» while the shopping list is hidden (Ф-49). Empty when `pages_on_first_use` is off."""
    from assistant.config import get_settings

    s = s or get_settings()
    if not s.pages_on_first_use:
        return []
    default = set(default_keys(s))
    return [k for k in s.pages_first_use_keys
            if k not in default and (k != "shopping" or s.feature_shopping)]


async def _make_once(session: AsyncSession, user_id: int, key: str) -> Screen | None:
    """Make the page of `key` unless the person has, had (and removed) or was given one before,
    or is at the page limit. The caller checked there is no live one."""
    from assistant.db.models import User
    from assistant.db.models_pages import MAX_PAGES

    await lock_user(session, user_id)
    user = await session.get(User, user_id)
    if user is None or key in (user.pages_first_use or []):
        return None
    had = await session.scalar(select(Screen.id).where(Screen.user_id == user_id,
                                                       Screen.template_key == key).limit(1))
    if had is not None:
        return None
    count = await session.scalar(select(func.count()).select_from(Screen).where(
        Screen.user_id == user_id, Screen.deleted_at.is_(None))) or 0  # fmt: skip
    template = await latest_template(session, key)
    if template is None or count >= MAX_PAGES:
        return None
    page = await create_page(session, user_id, template, client_id=uuid.uuid4(),
                             created_by=ScreenCreatedBy.SYSTEM)  # fmt: skip
    user.pages_first_use = [*(user.pages_first_use or []), key]
    await fill_page(session, page)
    return page


async def ensure_default_pages(session: AsyncSession, user_id: int) -> list[Screen]:
    """Ф-48: an account made before «Расходы» was a default page gets it once, lazily (on
    `GET /v1/pages`, `/v1/sync`, `/v1/today`), at the end of the tabs. Only after the first launch
    (`users.onboarding_done_at`); never when the person has or had one (removed stays removed)."""
    from assistant.db.models import User

    keys = [k for k in default_keys() if k in LAZY_DEFAULT_KEYS]
    if not keys:
        return []
    done = await session.scalar(select(User.onboarding_done_at).where(User.id == user_id))
    if done is None:
        return []
    known = set(await session.scalars(select(Screen.template_key).where(
        Screen.user_id == user_id, Screen.template_key.in_(keys))))  # fmt: skip
    made: list[Screen] = []
    for key in keys:
        if key in known:
            continue
        page = await _make_once(session, user_id, key)
        if page is not None:
            made.append(page)
    return made


async def first_use_page(session: AsyncSession, user_id: int,
                         key: str) -> tuple[Screen | None, bool]:  # fmt: skip
    """(the live page of `key` — «shopping», «expenses», «documents» —, made_now). The page is
    made when this is its first record (Ф-35, Ф-36; `first_use_keys`), and a default page
    (`default_keys`, Ф-48) the account never had is made the same way.

    A page is made once per kind: never when the person has (or had, and removed) one, nor when
    the server made it before, nor over the page limit. Then (None, False), and the caller files
    the record as before. The new page is not part of the record's «Отменить»: it stays.
    """
    live = await session.scalar(
        select(Screen).where(Screen.user_id == user_id, Screen.template_key == key,
                             Screen.deleted_at.is_(None)).order_by(Screen.id).limit(1))
    if live is not None:
        return live, False
    if key not in default_keys() and key not in first_use_keys():
        return None, False
    page = await _make_once(session, user_id, key)
    return page, page is not None
