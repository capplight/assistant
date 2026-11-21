"""Operations of the person's own settings (Ф-97, chat-full-control.md phases 2–3): the month's
budget (set / clear), quiet hours, the name to address the person by, and turning a learned
placement rule off. Each is one action with «Отменить» (`set_user_setting` / `restore_habit`).

Only safe settings: account deletion, consents, logout, the phone number, permanent deletes and
imports stay on their screens (Ф-95 (4)) — there is no operation for them here at all.
"""

import re
import uuid
from datetime import datetime, time
from decimal import Decimal
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.db.models import User
from assistant.db.models_actions import ActionKind
from assistant.operations.registry import Built, Operation, OpError, register

_HM = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")


def _money(value: Decimal, currency: str) -> str:
    from assistant.expenses import calc

    return calc.format_money(value, currency)


async def _user(session: AsyncSession, user_id: int) -> User:
    u = await session.get(User, user_id)
    if u is None:
        raise OpError("not_found", 404)
    return u


def _row(kind: str, title: str, text: str) -> dict[str, Any]:
    return {"item_id": None, "title": title, "kind": kind, "page_id": None, "text": text}


class BudgetSet(BaseModel):
    model_config = ConfigDict(extra="forbid")
    amount: str
    currency: str = "KZT"


async def _set_budget(session: AsyncSession, user_id: int, args: BudgetSet, *,
                      now: datetime) -> Built:  # fmt: skip
    from assistant.expenses import calc
    from assistant.expenses import service as expenses

    try:
        amount = calc.money("".join(args.amount.replace(",", ".").split()))
    except (ValueError, ArithmeticError) as exc:
        raise OpError("validation_error") from exc
    if not 0 < amount <= expenses.BUDGET_MAX:
        raise OpError("validation_error")
    sentence = f"Бюджет на месяц: {_money(amount, args.currency)}"
    return Built(ops=[{"op": "set_user_setting",
                       "values": {"expense_budget": f"{amount:.2f}",
                                  "expense_budget_currency": args.currency}}],
                 kind=ActionKind.EDIT_EXPENSE, sentence=sentence,
                 changes=[_row("budget", "Бюджет", sentence)], touched=("budget", "expenses"),
                 data={"amount": amount})  # fmt: skip


class Empty(BaseModel):
    model_config = ConfigDict(extra="forbid")


async def _clear_budget(session: AsyncSession, user_id: int, args: Empty, *,
                        now: datetime) -> Built:  # fmt: skip
    u = await _user(session, user_id)
    sentence = "Убрал бюджет на месяц"
    ops = [] if u.expense_budget is None else [
        {"op": "set_user_setting", "values": {"expense_budget": None}}]
    return Built(ops=ops, kind=ActionKind.EDIT_EXPENSE, sentence=sentence,
                 changes=[_row("budget", "Бюджет", sentence)], touched=("budget", "expenses"))


class QuietHours(BaseModel):
    model_config = ConfigDict(extra="forbid")
    quiet_from: str = Field(description="HH:MM")
    quiet_to: str = Field(description="HH:MM")

    @field_validator("quiet_from", "quiet_to")
    @classmethod
    def _hm(cls, v: str) -> str:
        m = _HM.match(v.strip())
        if m is None:
            raise ValueError("HH:MM")
        return f"{int(m.group(1)):02d}:{m.group(2)}"


def _hm(v: str) -> str:
    t = time.fromisoformat(v)
    return f"{t.hour}:{t.minute:02d}"


async def _quiet(session: AsyncSession, user_id: int, args: QuietHours, *,
                 now: datetime) -> Built:  # fmt: skip
    if args.quiet_from == args.quiet_to:
        raise OpError("validation_error")
    sentence = f"Тихие часы: с {_hm(args.quiet_from)} до {_hm(args.quiet_to)}"
    return Built(ops=[{"op": "set_user_setting",
                       "values": {"quiet_from": args.quiet_from, "quiet_to": args.quiet_to}}],
                 kind=ActionKind.USER_EDIT, sentence=sentence,
                 changes=[_row("settings", "Тихие часы", sentence)],
                 touched=("settings", "reminders"))  # fmt: skip


class DisplayName(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str | None = Field(default=None, max_length=60)


async def _name(session: AsyncSession, user_id: int, args: DisplayName, *,
                now: datetime) -> Built:  # fmt: skip
    from assistant.records import normalize_text

    name = " ".join(normalize_text(args.name or "").split()) or None
    sentence = f"Буду обращаться: {name}" if name else "Больше не обращаюсь по имени"
    return Built(ops=[{"op": "set_user_setting", "values": {"display_name": name}}],
                 kind=ActionKind.USER_EDIT, sentence=sentence,
                 changes=[_row("settings", "Имя", sentence)], touched=("settings",))


class HabitRef(BaseModel):
    model_config = ConfigDict(extra="forbid")
    habit_id: uuid.UUID


async def _habit_off(session: AsyncSession, user_id: int, args: HabitRef, *,
                     now: datetime) -> Built:  # fmt: skip
    """«Больше не клади чеки на страницу Ремонт»: the learned rule off (as «Убрать» on S30)."""
    from assistant.db.models_habits import HabitKind, HabitStatus, UserHabit
    from assistant.pages import habits

    habit = await session.scalar(select(UserHabit).where(
        UserHabit.user_id == user_id, UserHabit.public_id == args.habit_id,
        UserHabit.kind == HabitKind.PLACEMENT_RULE))  # fmt: skip
    if habit is None:
        raise OpError("not_found", 404)
    ops = [] if habit.status == HabitStatus.DISABLED else [
        {"op": "restore_habit", "id": str(habit.public_id),
         "state": {**habits.state_of(habit), "status": str(HabitStatus.DISABLED)}}]
    sentence = "Убрал правило: больше не кладу такие записи сама"
    return Built(ops=ops, kind=ActionKind.HABIT_CHANGE, sentence=sentence,
                 changes=[_row("habit", "Правило", sentence)], touched=("settings", "pages"))


register(Operation("expenses.set_budget", "settings", "safe", BudgetSet, build=_set_budget,
                   description="set the month's budget (an amount the person said)"))
register(Operation("expenses.clear_budget", "settings", "safe", Empty, build=_clear_budget,
                   description="remove the month's budget"))
register(Operation("settings.quiet_hours", "settings", "safe", QuietHours, build=_quiet,
                   description="quiet hours: no sound for reminders between two times"))
register(Operation("settings.name", "settings", "safe", DisplayName, build=_name,
                   description="the name to address the person by (or none)"))
register(Operation("habits.turn_off", "settings", "safe", HabitRef, build=_habit_off,
                   description="turn a learned placement rule off («больше не клади …»)"))
