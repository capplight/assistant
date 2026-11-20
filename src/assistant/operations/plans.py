"""Operations of a plan on the calendar (plans.md «A plan on the calendar», Ф-96):
`plans.to_calendar`, `calendar.remove_plan`, `calendar.shift_plan` over assistant.plans.calendar.
They write in their own way (one action, or the «Сделать делами» group for an action plan); the
`OpResult.data["outcome"]` is the `plans.calendar.Outcome` (a question to ask when nothing was
written: `need_mode`, `need_date`, `need_times`, `past`; or `already`, `none`, `same`)."""

import uuid
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.operations.registry import Operation, OpError, OpResult, register


class ToCalendar(BaseModel):
    model_config = ConfigDict(extra="forbid")
    plan_id: uuid.UUID
    start: date | None = None
    mode: Literal["days", "points"] | None = "days"  # None: ask first (the line, Ф-96)
    times: dict[str, str] | None = None  # point id → «HH:MM» (mode points)
    tz: str = "Asia/Almaty"


class PlanRef(BaseModel):
    model_config = ConfigDict(extra="forbid")
    plan_id: uuid.UUID


class ShiftPlan(BaseModel):
    model_config = ConfigDict(extra="forbid")
    plan_id: uuid.UUID
    days: int | None = None
    to_start: date | None = None
    tz: str = "Asia/Almaty"


async def _plan(session: AsyncSession, user_id: int, plan_id: uuid.UUID) -> Any:
    from assistant.plans.calendar import plan_by_id

    item = await plan_by_id(session, user_id, str(plan_id))
    if item is None or item.deleted_at is not None:
        raise OpError("not_found", 404)
    return item


def _result(outcome: Any, touched: tuple[str, ...]) -> OpResult:
    return OpResult(action=outcome.actions[0] if outcome.actions else None,
                    actions=list(outcome.actions), items=set(outcome.items),
                    pages=set(outcome.pages), sentence=outcome.sentence, touched=touched,
                    data={"outcome": outcome})  # fmt: skip


async def _to_calendar(session: AsyncSession, user_id: int, args: ToCalendar, *, by: str,
                       now: datetime, message_pk: int | None = None,
                       group_id: str | None = None, **_: Any) -> OpResult:  # fmt: skip
    from assistant.plans import calendar as plan_cal

    item = await _plan(session, user_id, args.plan_id)
    out = await plan_cal.add(session, user_id, item, start=args.start, by=by, now=now, tz=args.tz,
                             message_pk=message_pk, group_id=group_id, mode=args.mode,
                             times=args.times)  # fmt: skip
    return _result(out, ("tasks", "calendar", "plans", "reminders"))


async def _remove(session: AsyncSession, user_id: int, args: PlanRef, *, by: str, now: datetime,
                  message_pk: int | None = None, **_: Any) -> OpResult:  # fmt: skip
    from assistant.plans import calendar as plan_cal

    item = await _plan(session, user_id, args.plan_id)
    out = await plan_cal.remove(session, user_id, item, by=by, now=now, message_pk=message_pk)
    return _result(out, ("tasks", "calendar", "reminders"))


async def _shift(session: AsyncSession, user_id: int, args: ShiftPlan, *, by: str,
                 now: datetime, message_pk: int | None = None, **_: Any) -> OpResult:  # fmt: skip
    from assistant.plans import calendar as plan_cal

    item = await _plan(session, user_id, args.plan_id)
    out = await plan_cal.shift(session, user_id, item, days=args.days, to_start=args.to_start,
                               by=by, now=now, tz=args.tz, message_pk=message_pk)  # fmt: skip
    return _result(out, ("tasks", "calendar", "plans", "reminders"))


register(Operation("plans.to_calendar", "plans", "safe", ToCalendar, execute=_to_calendar,
                   description="a plan's days (or each point) onto the calendar"))
register(Operation("calendar.remove_plan", "calendar", "safe", PlanRef, execute=_remove,
                   description="exactly a plan's to-dos off the calendar (the plan stays)"))
register(Operation("calendar.shift_plan", "calendar", "safe", ShiftPlan, execute=_shift,
                   description="a plan's to-dos moved by N days or to a new first day"))
