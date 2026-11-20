"""A plan on the calendar (2026-11-20, docs/api/plans.md «A plan on the calendar»).

«ИИ понимает — скрипт делает»: the line reads what the person asked (chat/plan_line.py
`calendar_phrase`), code does every write here, in the caller's transaction (the caller commits):

- `add`: a trip plan's days become to-dos of those days (`tasks`, one all-day to-do per day
  «Стамбул: Балат и Фенер»; a point that says its own time — «в 19:00», «утром» — is also a to-do
  with that time, `timewords`), all in **one action** with one «Отменить». The tasks keep
  `source_item_id` = the plan (the calendar entry shows `plan`), the plan keeps their ids on its
  days (`days[].task_ids`) and gets the dates, so its screen and text show them. An action plan
  goes the way of «Сделать делами» (`service.make_tasks`: a group, one «Отменить всё»).
- `remove`: exactly the plan's live to-dos go to the trash (their reminders cancelled), one action;
  the plan record stays.
- `shift`: the plan's live to-dos move by N days (and the plan's dates with them), one action.
Nothing is guessed: a plan without dates and no date said → `need_date` (the line asks once).
"""

import re
import uuid
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from assistant import timewords
from assistant.actions import engine, record
from assistant.db.models import Item
from assistant.db.models_actions import Action, ActionKind
from assistant.db.models_tasks import ListKey, Task
from assistant.pages import lock_user
from assistant.plans.build import text_of
from assistant.plans.service import Converted, PlanError, make_tasks, pages_of, plan_of

TITLE_CHARS = 200  # tasks.parse.TITLE_MAX
_MONTHS_GEN = ("января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа",
               "сентября", "октября", "ноября", "декабря")  # fmt: skip
# «до 10 утра», «не позже 18:00», «после 15»: a limit, not the point's start
_LIMIT = re.compile(r"(?<!\w)(до|к|не\s+позже|не\s+позднее|после|с)\s+\d{1,2}([:.]\d{2})?"
                    r"(\s+(часов|часа|утра|дня|вечера|ночи))?(?!\w)", re.IGNORECASE)  # fmt: skip


@dataclass
class Outcome:
    """What one calendar phrase did. `status`: done | already | need_mode (Ф-96: «по дню или
    каждый пункт?») | need_date | need_times (each point: the proposed times in `times`) | past |
    empty | none (nothing of the plan on the calendar) | same (a shift of 0 days)."""

    status: str
    sentence: str = ""
    actions: list[Action] = field(default_factory=list)
    tasks: list[Task] = field(default_factory=list)
    pages: set[int] = field(default_factory=set)
    items: set[str] = field(default_factory=set)
    group: bool = False  # an action plan: the actions are a group («Отменить всё»)
    first: date | None = None
    last: date | None = None
    dates: list[date] = field(default_factory=list)  # the plan's days (need_times)
    times: dict[str, str] = field(default_factory=dict)  # point id → «HH:MM» (need_times)


def range_text(a: date, b: date) -> str:
    """«10–14 декабря», «30 ноября – 2 декабря», «10 декабря»."""
    if a == b:
        return f"{a.day} {_MONTHS_GEN[a.month - 1]}"
    if (a.year, a.month) == (b.year, b.month):
        return f"{a.day}–{b.day} {_MONTHS_GEN[b.month - 1]}"
    return f"{a.day} {_MONTHS_GEN[a.month - 1]} – {b.day} {_MONTHS_GEN[b.month - 1]}"


def _plural(n: int, forms: tuple[str, str, str]) -> str:
    n100, n10 = n % 100, n % 10
    if n10 == 1 and n100 != 11:
        return forms[0]
    if 2 <= n10 <= 4 and not 12 <= n100 <= 14:
        return forms[1]
    return forms[2]


_DAYS = ("день", "дня", "дней")
_DEEDS = ("дело", "дела", "дел")


def point_time(point: dict[str, Any], day: date) -> time | None:
    """The time a trip point says itself («Ужин в 19:00», note «утром» → 9:00, Ф-91), else
    None. A limit («до 10 утра») or an unclear hour («в 7») is no time: never guessed."""
    said = " ".join(x for x in (point.get("title"), point.get("note")) if x)
    said = _LIMIT.sub(" ", said)
    r = timewords.read(said, datetime.combine(day, time(0, 0)))
    if r is None or r.rel is not None or r.day_said:
        return None
    clocks = r.times()
    return clocks[0] if len(clocks) == 1 else None


async def linked_tasks(session: AsyncSession, user_id: int, plan_pk: int) -> list[Task]:
    """The plan's live to-dos (`tasks.source_item_id` = the plan), oldest first."""
    return list(await session.scalars(
        select(Task).join(Item, Item.id == Task.item_id)
        .where(Task.user_id == user_id, Task.source_item_id == plan_pk,
               Task.deleted_at.is_(None), Item.deleted_at.is_(None))
        .order_by(Task.id)))  # fmt: skip


async def _item_pids(session: AsyncSession, tasks: list[Task]) -> dict[int, uuid.UUID]:
    rows = await session.execute(select(Item.id, Item.public_id).where(
        Item.id.in_([t.item_id for t in tasks])))  # fmt: skip
    return {pk: pid for pk, pid in rows}


def _span(tasks: list[Task]) -> tuple[date | None, date | None]:
    days = [t.due_date for t in tasks if t.due_date is not None]
    return (min(days), max(days)) if days else (None, None)


def _plan_start(plan: dict[str, Any]) -> date | None:
    return date.fromisoformat(plan["start_date"]) if plan.get("start_date") else None


async def _record(session: AsyncSession, user_id: int, item: Item, *, kind: str, by: str,
                  sentence: str, changes: list[dict], inverse: list[dict], now: datetime,
                  pages: set[int], task_pks: list[int], message_pk: int | None,
                  op: str, notice: str) -> Action:  # fmt: skip
    return await record(
        session, user_id=user_id, kind=kind, initiated_by=by, summary={"ru": sentence, "kk": None},
        changes=changes, inverse=inverse, now=now, screen_id=next(iter(pages), None),
        message_id=message_pk, source_item_ids=[item.id, *task_pks][:50],
        extra={"plan_calendar": op, "plan_id": str(item.public_id),
               "notice_ru": notice})  # fmt: skip


def _plan_row(item: Item, plan: dict[str, Any], text: str) -> dict[str, Any]:
    return {"item_id": str(item.public_id), "title": plan.get("title") or "", "kind": "edit",
            "page_id": None, "text": text}  # fmt: skip


# Ф-96: proposed times for «каждый пункт отдельно» — a point's own time is kept; a meal word
# takes its part of the day; the rest go in order into free slots (timewords defaults).
_MEALS = (("завтрак", "morning"), ("обед", "lunch"), ("ужин", "evening"))
_SLOTS = (timewords.TIME_DEFAULTS["morning"], timewords.TIME_DEFAULTS["before_lunch"],
          timewords.TIME_DEFAULTS["lunch"], time(15, 0), time(17, 0),
          timewords.TIME_DEFAULTS["evening"], time(21, 0),
          timewords.TIME_DEFAULTS["late_evening"])  # fmt: skip


def _hm(t: time) -> str:
    return f"{t.hour:02d}:{t.minute:02d}"


def propose_times(days: list[dict[str, Any]], dates: list[date]) -> dict[str, str]:
    """point id → «HH:MM» for every point of every day (Ф-96: the person may correct it)."""
    out: dict[str, str] = {}
    for d, on in zip(days, dates, strict=False):
        points = d.get("points") or []
        fixed: dict[str, time] = {}
        for p in points:
            at = point_time(p, on)
            if at is None:
                low = str(p.get("title") or "").lower()
                part = next((k for w, k in _MEALS if w in low), None)
                at = timewords.TIME_DEFAULTS[part] if part else None
            if at is not None:
                fixed[p["id"]] = at
        taken = set(fixed.values())
        prev = time(8, 0)
        for p in points:
            at = fixed.get(p["id"])
            if at is None:
                at = next((t for t in _SLOTS if t > prev and t not in taken), None)
                if at is None:
                    at = time(min(prev.hour + 1, 23), prev.minute)
                taken.add(at)
            out[p["id"]] = _hm(at)
            prev = max(prev, at)
    return out


def schedule_lines(days: list[dict[str, Any]], dates: list[date],
                   times: dict[str, str]) -> list[str]:  # fmt: skip
    """«10 декабря, чт: 9:00 Голубая мечеть · 13:00 Обед у Сулеймание»."""
    from assistant.plans.build import day_text

    lines = []
    for d, on in zip(days, dates, strict=False):
        pts = sorted(d.get("points") or [], key=lambda p: times.get(p["id"], "99"))
        bits = [f"{timewords.clock(time.fromisoformat(times[p['id']]))} {p['title']}"
                for p in pts if p["id"] in times]  # fmt: skip
        lines.append(f"{day_text(on)}: " + " · ".join(bits))
    return lines


async def add(session: AsyncSession, user_id: int, item: Item, *, start: date | None, by: str,
              now: datetime, tz: str, message_pk: int | None = None,
              group_id: str | None = None, mode: str | None = "days",
              times: dict[str, str] | None = None) -> Outcome:  # fmt: skip
    """The plan onto the calendar. `start`: a first day the person said (wins over the plan's).
    `mode` (Ф-96): `days` — one all-day to-do per day (a point with its own time also a timed
    one); `points` — every point its own timed to-do at `times` (point id → «HH:MM»; without it
    → `need_times` with the proposal); None → `need_mode` (the line asks first)."""
    await lock_user(session, user_id)
    plan = plan_of(item)
    if plan is None or item.deleted_at is not None:
        raise PlanError("not_a_plan")
    if plan.get("kind") == "actions":
        return await _add_steps(session, user_id, item, plan, by=by, now=now, tz=tz,
                                message_pk=message_pk, group_id=group_id)  # fmt: skip
    days = [dict(d) for d in plan.get("days") or []]
    if not days:
        return Outcome("empty")
    zone = ZoneInfo(tz)
    today = now.astimezone(zone).date()
    title = plan.get("title") or "План"
    had = _plan_start(plan)
    live = await linked_tasks(session, user_id, item.id)
    live_ids = {str(t.public_id) for t in live}
    if live and start is not None and had is not None and start != had:
        a, b = _span(live)
        move = range_text(start, start)
        return Outcome("already", f"План «{title}» уже в календаре: {range_text(a, b)}. Чтобы "
                       f"перенести, скажите: «перенеси поездку на {move}»." if a and b else "",
                       first=a, last=b)  # fmt: skip
    missing = [i for i, d in enumerate(days) if not set(d.get("task_ids") or []) & live_ids]
    if not missing:
        a, b = _span(live)
        return Outcome("already", f"План «{title}» уже в календаре: {range_text(a, b)}."
                       if a and b else f"План «{title}» уже в календаре.", first=a, last=b)
    if mode not in ("days", "points"):
        return Outcome("need_mode")
    first = start or had
    if first is None:
        return Outcome("need_date")
    dates = [first + timedelta(days=i) for i in range(len(days))]
    if dates[-1] < today:
        return Outcome("past", first=dates[0], last=dates[-1])
    if mode == "points" and times is None:
        want = [days[i] for i in missing]
        return Outcome("need_times", first=dates[missing[0]], last=dates[missing[-1]],
                       dates=[dates[i] for i in missing],
                       times=propose_times(want, [dates[i] for i in missing]))  # fmt: skip
    from assistant.tasks import TaskSpec
    from assistant.tasks import service as tasks_service

    inverse: list[dict[str, Any]] = []
    changes: list[dict[str, Any]] = []
    out = Outcome("done", first=dates[missing[0]], last=dates[missing[-1]])
    timed = 0
    for i in missing:
        d, on = days[i], dates[i]
        specs = [] if mode == "points" else [
            TaskSpec(ListKey.TODO, f"{title}: {d['title']}"[:TITLE_CHARS], due_date=on)]
        for p in d.get("points") or []:
            at = point_time(p, on)
            if mode == "points":
                said = (times or {}).get(p["id"])
                at = time.fromisoformat(said) if said else None
                if at is None:  # a point with no time given: a to-do of that day
                    specs.append(TaskSpec(ListKey.TODO, str(p["title"])[:TITLE_CHARS],
                                          due_date=on))  # fmt: skip
                    continue
            if at is not None:
                specs.append(TaskSpec(ListKey.TODO, str(p["title"])[:TITLE_CHARS], due_date=on,
                                      start_at=datetime.combine(on, at, tzinfo=zone),
                                      duration_min=timewords.default_duration(p["title"]),
                                      tz=tz))  # fmt: skip
        added = await tasks_service.add(session, user_id, specs, by=by, now=now,
                                        source_item_id=item.id, dedupe=False)  # fmt: skip
        timed += sum(1 for t in added.tasks if t.start_at is not None)
        inverse = [*added.inverse, *inverse]
        changes += added.changes
        out.tasks += added.tasks
        out.pages |= added.pages
        out.items |= added.items
        days[i] = {**d, "task_ids": [str(t.public_id) for t in added.tasks]}
    dated = [{**d, "date": dates[i].isoformat()} for i, d in enumerate(days)]
    new_plan = {**plan, "days": dated, "start_date": dates[0].isoformat(),
                "end_date": dates[-1].isoformat(), "tz": tz}  # fmt: skip
    values: dict[str, Any] = {"plan": new_plan}
    if had != dates[0]:
        values["text"] = text_of(new_plan)
        when = range_text(dates[0], dates[-1])
        changes.append(_plan_row(item, new_plan, f"План «{title}»: {when}"))
    res = await engine.apply(session, user_id, [{"op": "set_item_content", "entity": "items",
                                                 "id": str(item.public_id), "values": values}],
                             by=by, check=False, now=now)  # fmt: skip
    inverse = [*res.inverse, *inverse]
    out.items |= res.items
    n_days = len(missing)
    more = "ещё " if len(missing) < len(days) else ""
    when = range_text(out.first, out.last)  # type: ignore[arg-type]
    if mode == "points":
        n = len(out.tasks)
        sentence = (f"Добавил в календарь «{title}»: {more}{n} {_plural(n, _DEEDS)} — каждый "
                    f"пункт отдельно, {when}.")
        if timed < n:
            sentence += f" Без времени — {n - timed}."
    else:
        sentence = (f"Добавил в календарь «{title}»: {more}{n_days} {_plural(n_days, _DAYS)}, "
                    f"{when}.")
        if timed:
            sentence += f" Со временем — {timed} {_plural(timed, _DEEDS)}."
    if len(missing) < len(days):
        sentence += " Остальные дни уже были в календаре."
    out.sentence = sentence
    task_pks = [t.item_id for t in out.tasks]
    out.actions.append(await _record(session, user_id, item, kind=ActionKind.SAVE_ITEM, by=by,
                                     sentence=sentence, changes=changes, inverse=inverse, now=now,
                                     pages=out.pages, task_pks=task_pks, message_pk=message_pk,
                                     op="add", notice=f"Добавил в календарь: {len(out.tasks)} "
                                     f"{_plural(len(out.tasks), _DEEDS)}"))  # fmt: skip
    await session.flush()
    return out


async def _add_steps(session: AsyncSession, user_id: int, item: Item, plan: dict[str, Any], *,
                     by: str, now: datetime, tz: str, message_pk: int | None,
                     group_id: str | None) -> Outcome:  # fmt: skip
    """An action plan: its steps become to-dos as with «Сделать делами»; those with a deadline
    are on the calendar, the others only in «Дела» (the answer says which)."""
    title = plan.get("title") or "План"
    if not plan.get("steps"):
        return Outcome("empty")
    conv: Converted = await make_tasks(session, user_id, item, by=by, now=now, tz=tz,
                                       message_pk=message_pk, group_id=group_id)  # fmt: skip
    if not conv.actions:
        live = await linked_tasks(session, user_id, item.id)
        dated = [t for t in live if t.due_date is not None]
        a, b = _span(dated)
        tail = f": {len(dated)} с датой — в календаре, {range_text(a, b)}." if a and b else "."
        return Outcome("already", f"Шаги плана «{title}» уже в «Делах»{tail}", first=a, last=b)
    dated = [t for t in conv.tasks if t.due_date is not None]
    undated = len(conv.tasks) - len(dated)
    a, b = _span(dated)
    n = len(conv.tasks)
    sentence = f"Сделал {n} {_plural(n, _DEEDS)} из плана «{title}»"
    if dated and a and b:
        sentence += f": {len(dated)} с датой — в календаре, {range_text(a, b)}"
        if undated:
            sentence += f"; {undated} без даты — только в «Делах»"
        sentence += "."
    else:
        sentence += ". В шагах нет дат — они в «Делах», не в календаре."
    if conv.reminders:
        k = len(conv.reminders)
        sentence += f" Напомню о {k} " + ("шаге." if k == 1 else "шагах.")
    return Outcome("done", sentence, actions=conv.actions, tasks=conv.tasks, pages=conv.pages,
                   items=conv.items, group=True, first=a, last=b)


async def remove(session: AsyncSession, user_id: int, item: Item, *, by: str, now: datetime,
                 message_pk: int | None = None) -> Outcome:  # fmt: skip
    """Exactly the plan's live to-dos go to the trash (one action). The plan stays."""
    await lock_user(session, user_id)
    plan = plan_of(item)
    if plan is None:
        raise PlanError("not_a_plan")
    title = plan.get("title") or "План"
    live = await linked_tasks(session, user_id, item.id)
    if not live:
        return Outcome("none", f"Плана «{title}» в календаре нет.")
    from assistant.tasks import calendar as cal

    pids = await _item_pids(session, live)
    ops: list[dict[str, Any]] = []
    changes = []
    for t in live:
        ops += await cal.linked_reminder_cancels(session, user_id, t)
        ops.append({"op": "delete_entity_soft", "entity": "tasks", "id": str(t.public_id),
                    "item": str(pids[t.item_id])})  # fmt: skip
        changes.append({"item_id": str(pids[t.item_id]), "task_id": str(t.public_id),
                        "title": t.title, "kind": "trash", "page_id": None,
                        "text": f"«{t.title}» — в корзине"})  # fmt: skip
    res = await engine.apply(session, user_id, ops, by=by, check=False, now=now)
    a, b = _span(live)
    n = len(live)
    pages = await pages_of(session, item.id)
    where = f"в «{pages[0]['title']}»" if pages else "в записях"
    when = f", {range_text(a, b)}" if a and b else ""
    sentence = (f"Убрал из календаря «{title}»: {n} {_plural(n, _DEEDS)}{when}. "
                f"Сам план остался {where}.")
    out = Outcome("done", sentence, tasks=live, items=res.items, pages=res.pages, first=a, last=b)
    out.actions.append(await _record(session, user_id, item, kind=ActionKind.DELETE_ITEM, by=by,
                                     sentence=sentence, changes=changes, inverse=res.inverse,
                                     now=now, pages=res.pages,
                                     task_pks=[t.item_id for t in live], message_pk=message_pk,
                                     op="remove", notice=f"Убрал из календаря: {n} "
                                     f"{_plural(n, _DEEDS)}"))  # fmt: skip
    await session.flush()
    return out


def _shift_word(n: int) -> str:
    k = abs(n)
    what = ("на неделю" if k == 7 else f"на {k // 7} недели" if k in (14, 21)
            else f"на {k} {_plural(k, _DAYS)}")  # fmt: skip
    return f"{what} {'позже' if n > 0 else 'раньше'}"


async def shift(session: AsyncSession, user_id: int, item: Item, *, days: int | None,
                to_start: date | None, by: str, now: datetime, tz: str,
                message_pk: int | None = None) -> Outcome:  # fmt: skip
    """The plan's live to-dos move by `days` (or so that the first day is `to_start`)."""
    await lock_user(session, user_id)
    plan = plan_of(item)
    if plan is None:
        raise PlanError("not_a_plan")
    title = plan.get("title") or "План"
    live = [t for t in await linked_tasks(session, user_id, item.id) if not t.rrule]
    a, b = _span(live)
    if not live or a is None or b is None:
        return Outcome("none", f"Плана «{title}» в календаре нет — сначала скажите «добавь "
                       f"план в календарь».")  # fmt: skip
    delta = days if days is not None else ((to_start - a).days if to_start else 0)
    if not delta:
        return Outcome("same", f"План «{title}» и так стоит на {range_text(a, b)}.", first=a,
                       last=b)  # fmt: skip
    zone = ZoneInfo(tz)
    if b + timedelta(days=delta) < now.astimezone(zone).date():
        return Outcome("past", first=a + timedelta(days=delta), last=b + timedelta(days=delta))
    from assistant.tasks import calendar as cal

    pids = await _item_pids(session, live)
    step = timedelta(days=delta)
    ops: list[dict[str, Any]] = []
    changes = []
    for t in live:
        values: dict[str, Any] = {}
        moved = step
        if t.due_date is not None:
            values["due_date"] = (t.due_date + step).isoformat()
        if t.start_at is not None:
            local = t.start_at.astimezone(ZoneInfo(t.tz or tz))
            new = local + step  # the same clock time N days on (wall time)
            # stored as UTC text: the undo's `expect` compares it with the row as read back
            values["start_at"] = new.astimezone(UTC).isoformat()
            moved = new.astimezone(UTC) - local.astimezone(UTC)
        if not values:
            continue
        ops.append({"op": "set_task", "id": str(t.public_id), "item": str(pids[t.item_id]),
                    "values": values})  # fmt: skip
        ops += await cal.reminder_shift_ops(session, user_id, t, moved, now)
        old = t.due_date
        new_day = old + step if old else None
        changes.append({"item_id": str(pids[t.item_id]), "task_id": str(t.public_id),
                        "title": t.title, "kind": "edit", "page_id": None,
                        "text": f"«{t.title}»: {old:%d.%m} → {new_day:%d.%m}"
                        if old and new_day else f"«{t.title}»"})  # fmt: skip
    moved_ids = {str(t.public_id) for t in live}
    new_plan = _shifted_plan(plan, step, moved_ids)
    ops.append({"op": "set_item_content", "entity": "items", "id": str(item.public_id),
                "values": {"plan": new_plan, "text": text_of(new_plan)}})
    res = await engine.apply(session, user_id, ops, by=by, check=False, now=now)
    na, nb = a + step, b + step
    changes.append(_plan_row(item, new_plan, f"План «{title}»: {range_text(na, nb)}"))
    n = len(live)
    sentence = (f"Перенёс «{title}» {_shift_word(delta)}: теперь {range_text(na, nb)} "
                f"({n} {_plural(n, _DEEDS)}).")
    out = Outcome("done", sentence, tasks=live, items=res.items, pages=res.pages, first=na,
                  last=nb)  # fmt: skip
    out.actions.append(await _record(session, user_id, item, kind=ActionKind.FACET_EDIT, by=by,
                                     sentence=sentence, changes=changes, inverse=res.inverse,
                                     now=now, pages=res.pages,
                                     task_pks=[t.item_id for t in live], message_pk=message_pk,
                                     op="shift",
                                     notice=f"Перенёс «{title}» на {range_text(na, nb)}"))
    await session.flush()
    return out


def _shifted_plan(plan: dict[str, Any], step: timedelta, moved: set[str]) -> dict[str, Any]:
    """The plan's own dates moved with its to-dos (days; steps whose to-do moved)."""

    def mv(value: str | None) -> str | None:
        return (date.fromisoformat(value) + step).isoformat() if value else value

    out = {**plan, "start_date": mv(plan.get("start_date")), "end_date": mv(plan.get("end_date"))}
    out["days"] = [{**d, "date": mv(d.get("date"))} for d in plan.get("days") or []]
    steps = []
    for s in plan.get("steps") or []:
        if s.get("task_id") in moved:
            remind = s.get("remind_at")
            if remind:
                remind = (datetime.fromisoformat(remind) + step).isoformat(timespec="minutes")
            s = {**s, "due_date": mv(s.get("due_date")), "remind_at": remind}
        steps.append(s)
    out["steps"] = steps
    return out


async def plan_by_id(session: AsyncSession, user_id: int, public_id: str) -> Item | None:
    try:
        pid = uuid.UUID(str(public_id))
    except ValueError:
        return None
    item = await session.scalar(select(Item).where(Item.user_id == user_id,
                                                   Item.public_id == pid))  # fmt: skip
    return item if item is not None and plan_of(item) is not None else None


__all__ = ["Outcome", "add", "linked_tasks", "plan_by_id", "point_time", "propose_times",
           "range_text", "remove", "schedule_lines", "shift"]  # fmt: skip


def days_word(n: int) -> str:
    return _plural(n, _DAYS)
