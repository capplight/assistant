"""The «Сегодня» briefing (week 20, mocks v2 «Сегодня · утро / день / вечер», Ф-55): the facts
of the day counted by code here, worded by `assistant.suggestions.brief`. No model call.
Contract: docs/api/today.md «brief».
"""

from datetime import UTC, datetime, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.api.schemas import (
    BriefLinesOut,
    BriefMetricsOut,
    BriefNewOut,
    BriefOut,
    BriefPlanOut,
    BriefRemindersOut,
    BriefSpentOut,
    BriefTasksOut,
    BriefTextOut,
    BriefTomorrowOut,
    BriefWaitingOut,
    BudgetOut,
)
from assistant.db.models import Item, Reminder, User
from assistant.db.models_chat import ConversationMessage, MessageRole
from assistant.db.models_reminders import FireState, ReminderFire
from assistant.db.models_tasks import ListKey, Task
from assistant.expenses import service as expenses
from assistant.suggestions import brief
from assistant.tasks import service as tasks

WAITING_SHOWN = 5
PLAN_TASKS = 20
REMINDER = "Напоминание"


def _todo():  # type: ignore[no-untyped-def]
    return (select(Task).join(Item, Item.id == Task.item_id)
            .where(Task.list_key == ListKey.TODO, Task.deleted_at.is_(None),
                   Item.deleted_at.is_(None)))  # fmt: skip


async def build(db: AsyncSession, u: User, *, now: datetime, zone: ZoneInfo, start: datetime,
                end: datetime, today_occ: list[tuple[Reminder, ReminderFire]],
                tomorrow_occ: list[tuple[Reminder, ReminderFire]],
                missed: list[tuple[Reminder, ReminderFire]]) -> BriefOut:  # fmt: skip
    """`today_occ`: today's reminder occurrences (any state but cancelled); `tomorrow_occ`:
    tomorrow's; `missed`: missed ones of the last 24 h not acked since."""
    local = now.astimezone(zone)
    day = local.date()

    # the day plan: reminders by their time, then today's to-dos («без времени»)
    plan: list[BriefPlanOut] = []
    entries: list[brief.PlanEntry] = []
    for r, f in today_occ:
        at = f.occurrence_at.astimezone(zone)
        done, was_missed = f.state == FireState.ACKED, f.state == FireState.MISSED
        plan.append(BriefPlanOut(kind="reminder", title=r.title or REMINDER,
                                 time=at.strftime("%H:%M"), at=f.occurrence_at, done=done,
                                 missed=was_missed, reminder_id=r.public_id))  # fmt: skip
        entries.append(brief.PlanEntry("reminder", r.title or REMINDER, at.replace(tzinfo=None),
                                       done, was_missed))  # fmt: skip
    day_tasks = list(await db.scalars(
        _todo().where(Task.user_id == u.id, Task.due_date == day)
        .order_by(Task.done_at.is_not(None), Task.id).limit(PLAN_TASKS)))  # fmt: skip
    pids = {d["id"]: d["item_id"] for d in await tasks.tasks_dicts(db, day_tasks)}
    for t in day_tasks:
        done = t.done_at is not None
        plan.append(BriefPlanOut(kind="task", title=t.title, time=None, at=None, done=done,
                                 missed=False, task_id=t.public_id,
                                 item_id=pids.get(t.public_id)))  # fmt: skip
        entries.append(brief.PlanEntry("task", t.title, None, done))
    timed = sorted((p for p in plan if p.at is not None), key=lambda p: p.at or now)
    plan = [*timed, *(p for p in plan if p.at is None)]

    tomorrow_tasks = await db.scalar(
        select(func.count()).select_from(Task).join(Item, Item.id == Task.item_id)
        .where(Task.user_id == u.id, Task.list_key == ListKey.TODO, Task.deleted_at.is_(None),
               Item.deleted_at.is_(None), Task.done_at.is_(None),
               Task.due_date == day + timedelta(days=1))) or 0  # fmt: skip
    tomorrow = [brief.PlanEntry("reminder", r.title or REMINDER,
                                f.occurrence_at.astimezone(zone).replace(tzinfo=None))
                for r, f in tomorrow_occ]  # fmt: skip

    # «Ждёт вас»: missed reminders, overdue to-dos, questions waiting for a tap
    waiting: list[BriefWaitingOut] = []
    for r, f in missed:
        at = f.occurrence_at.astimezone(zone)
        when = "вчера" if at.date() < day else "сегодня"
        waiting.append(BriefWaitingOut(kind="missed", title=r.title or REMINDER,
                                       text_ru=f"пропущено {when} в {at.strftime('%H:%M')}",
                                       at=f.occurrence_at, reminder_id=r.public_id))  # fmt: skip
    overdue = list(await db.scalars(
        _todo().where(Task.user_id == u.id, Task.done_at.is_(None), Task.due_date.is_not(None),
                      Task.due_date < day)
        .order_by(Task.due_date, Task.id).limit(WAITING_SHOWN)))  # fmt: skip
    opids = {d["id"]: d["item_id"] for d in await tasks.tasks_dicts(db, overdue)}
    for t in overdue:
        due = t.due_date.strftime("%d.%m") if t.due_date else ""
        waiting.append(BriefWaitingOut(kind="overdue", title=t.title, text_ru=f"было на {due}",
                                       at=None, task_id=t.public_id,
                                       item_id=opids.get(t.public_id)))  # fmt: skip
    asks = list(await db.scalars(
        select(ConversationMessage)
        .where(ConversationMessage.user_id == u.id,
               ConversationMessage.role == MessageRole.ASSISTANT,
               ConversationMessage.deleted_at.is_(None),
               ConversationMessage.proposal["state"].astext == "open",
               ConversationMessage.created_at >= now - timedelta(hours=24))
        .order_by(ConversationMessage.id.desc()).limit(WAITING_SHOWN)))  # fmt: skip
    for m in asks:
        prop = m.proposal or {}
        expires = prop.get("expires_at")
        if not expires or datetime.fromisoformat(expires) <= now:
            continue
        waiting.append(BriefWaitingOut(kind="question", title=prop.get("question") or m.content,
                                       text_ru="нужен ваш ответ", at=m.created_at,
                                       message_id=m.public_id))  # fmt: skip
    waiting = waiting[:WAITING_SHOWN]

    # money: today and this month in the budget's currency (KZT without one); code's sums
    budget = await expenses.budget(db, u.id, day)
    cur = budget.currency if budget else "KZT"
    t_day = await expenses.totals(db, u.id, period="custom", day=day, start=day, end=day,
                                  currency=cur)  # fmt: skip
    row = next((x for x in t_day.result.totals if x.currency == cur), None)
    spent_today, count_today = (row.total, row.count) if row else (Decimal("0.00"), 0)
    if budget is not None:
        spent_month = budget.spent
    else:
        t_month = await expenses.totals(db, u.id, period="month", day=day, currency=cur)
        spent_month = next((x.total for x in t_month.result.totals if x.currency == cur),
                           Decimal("0.00"))  # fmt: skip

    # new records: since yesterday in the morning, since midnight later (not to-dos, expenses, КП)
    part = brief.part_of_day(local.replace(tzinfo=None))
    midnight = local.replace(hour=0, minute=0, second=0, microsecond=0)
    since = midnight - timedelta(days=1) if part == "morning" else midnight
    new_count = await db.scalar(text("""
        SELECT count(*) FROM items i
        WHERE i.user_id = :u AND i.deleted_at IS NULL AND i.hidden_reason IS NULL
          AND i.kind <> 'kp' AND i.created_at >= :since
          AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.item_id = i.id)
          AND NOT EXISTS (SELECT 1 FROM expense_entries e WHERE e.item_id = i.id)"""),
        {"u": u.id, "since": since.astimezone(UTC)}) or 0  # fmt: skip

    words = brief.build(brief.Facts(
        now=local.replace(tzinfo=None), plan=entries, tomorrow=tomorrow, waiting=len(waiting),
        spent_today=spent_today, spent_month=spent_month, count_today=count_today, currency=cur,
        budget_left=budget.left if budget else None))  # fmt: skip

    open_ = [p for p in plan if not p.done and not p.missed and (p.at is None or p.at >= now)]
    nxt = next((p for p in open_ if p.at is not None), open_[0] if open_ else None)
    rem_next = next((p for p in open_ if p.kind == "reminder" and p.at is not None), None)
    first = tomorrow_occ[0] if tomorrow_occ else None
    bdict = expenses.budget_dict(budget)
    return BriefOut(
        part=words["part"], headline=BriefTextOut(**words["headline"]),
        lines=BriefLinesOut(**words["lines"]),
        metrics=BriefMetricsOut(
            tasks=BriefTasksOut(done=sum(1 for p in plan if p.done), total=len(plan),
                                next_time=nxt.time if nxt else None,
                                next_title=nxt.title if nxt else None),
            spent=BriefSpentOut(currency=cur, today=f"{spent_today:.2f}",
                                count_today=count_today, month=f"{spent_month:.2f}",
                                budget=BudgetOut.model_validate(bdict) if bdict else None),
            reminders=BriefRemindersOut(today=len(today_occ),
                                        next_time=rem_next.time if rem_next else None),
            tomorrow=BriefTomorrowOut(
                count=len(tomorrow_occ) + tomorrow_tasks,
                first_time=first[1].occurrence_at.astimezone(zone).strftime("%H:%M")
                if first else None,
                first_title=(first[0].title or REMINDER) if first else None),
            new_records=BriefNewOut(count=new_count, since=since.astimezone(UTC),
                                    period="yesterday" if part == "morning" else "today"),
        ),
        plan=plan, waiting=waiting,
    )  # fmt: skip
