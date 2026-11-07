"""`placement_rule` (spec 3.4, 6.12; F-29): «похожие записи кладу на страницу Ремонт».

Learned from the person's own moves (`move-to-page`), never from the assistant's: after 2 different
records of one kind went to the same page by hand, new records of that kind are placed there too.
"Kind" is the envelope type, and only the specific ones: a plain note, an idea or "other" says
nothing about where the next one belongs. `from_page_ids` is kept for «Что я для вас настроил».

A rule only adds rows, like `auto_rule` (R-54): it does not take a new record off the page it was
moved from (its type is known only after the record was already placed by the page rules, and
taking rows off is the person's call). The person turns it off in «Что я для вас
настроил» (week 9, `status=disabled`); learning never switches a disabled rule on again.
"""

from collections.abc import Mapping
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.db.models_habits import HabitKind, HabitSource, HabitStatus, UserHabit
from assistant.db.models_pages import Screen

LEARN_AT = 2  # different records moved the same way before the rule is used
KEEP_ITEMS = 20  # evidence item ids kept on the rule (to count each record once)
LEARNABLE = frozenset({"task", "reminder_request", "shopping_list", "document", "receipt",
                       "contract", "id_document", "contact", "kp_request", "price_list",
                       "event"})  # fmt: skip
TEXT_LEARNED = "Похожие положу туда же"
KIND_WORDS = {"task": "Дела", "reminder_request": "Напоминания", "shopping_list": "Списки покупок",
              "document": "Документы", "receipt": "Чеки", "contract": "Договоры",
              "id_document": "Удостоверения", "contact": "Контакты", "kp_request": "Запросы КП",
              "price_list": "Прайсы", "event": "События"}  # fmt: skip


def kind_of(envelope: Mapping[str, Any] | None) -> str | None:
    """What makes two records "of one kind" for a placement rule, or None."""
    t = (envelope or {}).get("type")
    return t if isinstance(t, str) and t in LEARNABLE else None


def _key(page: Screen, kind: str) -> str:
    return f"{page.public_id}:envelope_type:{kind}"


def describe(kind: str | None, page_title: str) -> str:
    """The line in «Что я для вас настроил»."""
    return f"{KIND_WORDS.get(kind or '', 'Такие записи')} кладу на страницу «{page_title}»"


def state_of(h: UserHabit) -> dict[str, Any]:
    return {"evidence_count": h.evidence_count, "status": h.status, "value": dict(h.value or {})}


def count_evidence(habit: UserHabit, item_public_id: str, *, add: bool, now: datetime) -> bool:
    """Count a record for the rule, or take it back; the rule goes on at LEARN_AT and off below it.
    A rule the person turned off stays off. True if anything changed."""
    value = dict(habit.value or {})
    items = list(value.get("item_ids") or [])
    if (item_public_id in items) == add:
        return False
    if add:
        items = [*items, item_public_id][-KEEP_ITEMS:]
        evidence = habit.evidence_count + 1
    else:
        items.remove(item_public_id)
        evidence = max(habit.evidence_count - 1, 0)
    habit.value, habit.evidence_count = {**value, "item_ids": items}, evidence
    if habit.status != HabitStatus.DISABLED:
        habit.status = HabitStatus.ACTIVE if evidence >= LEARN_AT else HabitStatus.CANDIDATE
    habit.updated_at = now
    return True


async def learn(session: AsyncSession, user_id: int, *, item_public_id: str,
                envelope: Mapping[str, Any] | None, to_page: Screen, from_page: Screen | None,
                now: datetime) -> tuple[dict[str, Any] | None, bool]:  # fmt: skip
    """Count one manual move. Returns (the op that takes it back, or None; True if this move
    switched the rule on). Call under the user's lock."""
    kind = kind_of(envelope)
    if kind is None or to_page.kind == "system_today":
        return None, False
    key = _key(to_page, kind)
    habit = await session.scalar(
        select(UserHabit).where(UserHabit.user_id == user_id,
                                UserHabit.kind == HabitKind.PLACEMENT_RULE, UserHabit.key == key)
        .with_for_update()
    )  # fmt: skip
    if habit is None:
        habit = UserHabit(user_id=user_id, kind=HabitKind.PLACEMENT_RULE, key=key,
                          source=HabitSource.LEARNED_EDIT, evidence_count=0,
                          status=HabitStatus.CANDIDATE,
                          value={"page_id": str(to_page.public_id), "envelope_type": kind,
                                 "from_page_ids": [], "item_ids": []})  # fmt: skip
        session.add(habit)
        await session.flush()
    elif habit.status == HabitStatus.DISABLED:
        return None, False
    was_on = habit.status == HabitStatus.ACTIVE
    froms = list((habit.value or {}).get("from_page_ids") or [])
    if from_page is not None and str(from_page.public_id) not in froms:
        habit.value = {**habit.value, "from_page_ids": [*froms, str(from_page.public_id)]}
    if not count_evidence(habit, item_public_id, add=True, now=now):
        return None, False
    op = {"op": "habit_evidence", "id": str(habit.public_id), "item": item_public_id, "add": False}
    return op, habit.status == HabitStatus.ACTIVE and not was_on


async def placements(session: AsyncSession, user_id: int,
                     envelope: Mapping[str, Any] | None) -> list[UserHabit]:  # fmt: skip
    """The person's active rules that hold for a record with this envelope."""
    kind = kind_of(envelope)
    if kind is None:
        return []
    rows = await session.scalars(
        select(UserHabit).where(UserHabit.user_id == user_id,
                                UserHabit.kind == HabitKind.PLACEMENT_RULE,
                                UserHabit.status == HabitStatus.ACTIVE)
        .order_by(UserHabit.id)
    )  # fmt: skip
    return [h for h in rows if (h.value or {}).get("envelope_type") == kind]
