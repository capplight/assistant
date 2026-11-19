"""The calendar over «Дела» (Ф-89 direction A, migration 0035; contract docs/api/calendar.md).

Pure parts: `check_rrule`, `expand` (occurrences of a start + rrule on a zone's clock). DB parts:
`entries` (the range query: tasks with a time or a day, repeats expanded with their own
occurrences, timed reminders not linked to a timed task, plan steps with a time and no live
task) and `change_ops` (the engine ops of a move / resize / done / delete, for one occurrence,
this-and-following or the whole task; the caller records them as one action with «Отменить»).
"""

import re
import uuid
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from dateutil.rrule import rrulestr
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.db.models import Item, Reminder
from assistant.db.models_reminders import APP_KINDS, FireState, ReminderFire
from assistant.db.models_tasks import ListKey, Task, TaskOccurrence

MAX_DAYS = 62  # `to - from` ≤ 61: a 6-week month grid and some
MAX_PER_SERIES = 400
DEFAULT_TZ = "Asia/Almaty"
_KEYS = ("FREQ", "INTERVAL", "BYDAY", "BYMONTHDAY", "UNTIL")
_DAYS = {"MO", "TU", "WE", "TH", "FR", "SA", "SU"}
_UNTIL = re.compile(r"^\d{8}T\d{6}Z$")


class CalendarError(ValueError):
    pass


def check_rrule(rule: str | None) -> str | None:
    """The closed set of `reminders.check_rrule` + `UNTIL=YYYYMMDDTHHMMSSZ` (a series ended by
    «это и следующие»)."""
    if rule is None or not str(rule).strip():
        return None
    rule = str(rule).strip().upper().removeprefix("RRULE:")
    try:
        parts = dict(p.split("=", 1) for p in rule.split(";"))
    except ValueError as exc:
        raise _err() from exc
    freq = parts.get("FREQ")
    if not set(parts) <= set(_KEYS) or freq not in {"DAILY", "WEEKLY", "MONTHLY"}:
        raise _err()
    if "INTERVAL" in parts and not (parts["INTERVAL"].isdigit()
                                    and 1 <= int(parts["INTERVAL"]) <= 12):  # fmt: skip
        raise _err()
    if "BYDAY" in parts and (freq != "WEEKLY" or not set(parts["BYDAY"].split(",")) <= _DAYS):
        raise _err()
    if "BYMONTHDAY" in parts and (freq != "MONTHLY" or not parts["BYMONTHDAY"].isdigit()
                                  or not 1 <= int(parts["BYMONTHDAY"]) <= 31):  # fmt: skip
        raise _err()
    if "UNTIL" in parts and not _UNTIL.match(parts["UNTIL"]):
        raise _err()
    return ";".join(f"{k}={parts[k]}" for k in _KEYS if k in parts)


def _err() -> Exception:
    from assistant.tasks.service import TaskError

    return TaskError("validation_error")


def with_until(rule: str, before: datetime) -> str:
    """The series ends just before `before` (UTC)."""
    parts = [p for p in rule.split(";") if not p.startswith("UNTIL=")]
    until = (before - timedelta(seconds=1)).astimezone(UTC).strftime("%Y%m%dT%H%M%SZ")
    return ";".join([*parts, f"UNTIL={until}"])


def expand(start_at: datetime, rule: str | None, tz: str, lo: datetime,
           hi: datetime) -> list[datetime]:  # fmt: skip
    """Occurrence starts (UTC) in [lo, hi) of a series that starts at `start_at`, on the clock
    of `tz` (so «каждый день в 9» stays 9:00 local)."""
    if not rule:
        return [start_at] if lo <= start_at < hi else []
    zone = ZoneInfo(tz)
    parts = [p for p in rule.split(";") if not p.startswith("UNTIL=")]
    until = next((p[6:] for p in rule.split(";") if p.startswith("UNTIL=")), None)
    dtstart = start_at.astimezone(zone).replace(tzinfo=None)
    series = rrulestr(";".join(parts), dtstart=dtstart)
    a = max(lo.astimezone(zone).replace(tzinfo=None), dtstart) - timedelta(seconds=1)
    b = hi.astimezone(zone).replace(tzinfo=None)
    end = datetime.strptime(until, "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC) if until else None
    out: list[datetime] = []
    for local in series.between(a, b, inc=True):
        moment = local.replace(tzinfo=zone).astimezone(UTC)
        if end is not None and moment > end:
            break
        if lo <= moment < hi:
            out.append(moment)
        if len(out) >= MAX_PER_SERIES:
            break
    return out


def _hm(d: datetime) -> str:
    return f"{d.hour}:{d.minute:02d}"


@dataclass
class Window:
    tz: str
    start: date
    end: date  # inclusive
    lo: datetime = field(init=False)
    hi: datetime = field(init=False)

    def __post_init__(self) -> None:
        if self.end < self.start or (self.end - self.start).days >= MAX_DAYS:
            raise CalendarError("range_invalid")
        zone = ZoneInfo(self.tz)
        self.lo = datetime.combine(self.start, time(0), zone).astimezone(UTC)
        self.hi = datetime.combine(self.end + timedelta(days=1), time(0), zone).astimezone(UTC)


def _entry(kind: str, key: str, *, title: str, start: datetime | None, duration: int | None,
           tz: str, day: date | None, **extra: Any) -> dict[str, Any]:  # fmt: skip
    zone = ZoneInfo(tz)
    local = start.astimezone(zone) if start is not None else None
    end = start + timedelta(minutes=duration) if start is not None and duration else None
    return {"key": key, "kind": kind, "title": title,
            "date": (local.date() if local else day).isoformat(),  # type: ignore[union-attr]
            "all_day": start is None, "start_at": start, "end_at": end,
            "start": _hm(local) if local else None,
            "end": _hm(end.astimezone(zone)) if end else None, "duration_min": duration,
            **extra}  # fmt: skip


async def _pages(session: AsyncSession, user_id: int) -> uuid.UUID | None:
    from assistant.tasks.service import list_page

    page = await list_page(session, user_id, ListKey.TODO)
    return page.public_id if page is not None else None


async def entries(session: AsyncSession, user_id: int, win: Window,
                  now: datetime) -> list[dict[str, Any]]:  # fmt: skip
    out: list[dict[str, Any]] = []
    page_id = await _pages(session, user_id)
    # --- tasks
    tasks = list(await session.scalars(
        select(Task).join(Item, Item.id == Task.item_id)
        .where(Task.user_id == user_id, Task.list_key == ListKey.TODO,
               Task.deleted_at.is_(None), Item.deleted_at.is_(None),
               ((Task.start_at.is_not(None) & ((Task.rrule.is_not(None)) | (
                   (Task.start_at < win.hi)
                   & (Task.start_at >= win.lo - timedelta(days=1)))))
                | (Task.start_at.is_(None) & Task.due_date.between(win.start, win.end))))
        .order_by(Task.id)))  # fmt: skip
    items = {pk: pid for pk, pid in await session.execute(
        select(Item.id, Item.public_id).where(Item.id.in_({t.item_id for t in tasks} or {0})))}
    timed_items = {t.item_id for t in tasks if t.start_at is not None}
    links: dict[int, Reminder] = {}
    if timed_items:
        for r in await session.scalars(select(Reminder).where(
                Reminder.user_id == user_id, Reminder.item_id.in_(timed_items),
                Reminder.kind.in_(APP_KINDS), Reminder.deleted_at.is_(None))):  # fmt: skip
            links.setdefault(r.item_id, r)  # type: ignore[index]
    occs: dict[int, dict[datetime, TaskOccurrence]] = {}
    series_ids = [t.id for t in tasks if t.rrule]
    if series_ids:
        for o in await session.scalars(select(TaskOccurrence).where(
                TaskOccurrence.task_id.in_(series_ids))):  # fmt: skip
            occs.setdefault(o.task_id, {})[o.occurrence_at] = o
    plan_ids = {t.source_item_id for t in tasks if t.source_item_id}
    plans = {pk: (pid, title) for pk, pid, title in await session.execute(
        select(Item.id, Item.public_id, Item.title).where(Item.id.in_(plan_ids or {0}),
                                                          Item.kind == "plan"))}  # fmt: skip
    for t in tasks:
        tz = t.tz or DEFAULT_TZ
        rem = links.get(t.item_id)
        base = {"id": t.public_id, "rrule": t.rrule, "source": t.created_by or "user",
                "item_id": items.get(t.item_id), "page_id": page_id,
                "reminder": ({"id": rem.public_id, "offsets": list(rem.offsets or [])}
                             if rem is not None else None),
                "plan": ({"id": plans[t.source_item_id][0], "title": plans[t.source_item_id][1]}
                         if t.source_item_id in plans else None),
                "version": t.version}  # fmt: skip
        if t.start_at is None:
            out.append(_entry("task", f"task:{t.public_id}:", title=t.title, start=None,
                              duration=None, tz=tz, day=t.due_date, occurrence_at=None,
                              moved=False, done=t.done_at is not None, **base))
            continue
        if not t.rrule:
            if win.lo <= t.start_at < win.hi:
                out.append(_entry("task", f"task:{t.public_id}:", title=t.title, start=t.start_at,
                                  duration=t.duration_min, tz=tz, day=None, occurrence_at=None,
                                  moved=False, done=t.done_at is not None, **base))
            continue
        own = occs.get(t.id, {})
        starts = set(expand(t.start_at, t.rrule, tz, win.lo - timedelta(days=7), win.hi))
        starts |= set(own)  # an occurrence moved into (or out of) the window
        for at in sorted(starts):
            o = own.get(at)
            if o is not None and o.skipped:
                continue
            start = o.start_at if o is not None and o.start_at is not None else at
            if not win.lo <= start < win.hi:
                continue
            duration = o.duration_min if o is not None and o.duration_min else t.duration_min
            out.append(_entry("task", f"task:{t.public_id}:{at.isoformat()}", title=t.title,
                              start=start, duration=duration, tz=tz, day=None,
                              occurrence_at=at, moved=start != at,
                              done=o is not None and o.done_at is not None, **base))
    # --- reminders that are not a timed task's alert
    rems = list(await session.scalars(select(Reminder).where(
        Reminder.user_id == user_id, Reminder.kind == "normal", Reminder.deleted_at.is_(None),
        (Reminder.rrule.is_not(None)) | ((Reminder.due_at >= win.lo) & (Reminder.due_at < win.hi))
    )))  # fmt: skip
    rems = [r for r in rems if r.item_id not in timed_items]
    acked: set[tuple[int, datetime]] = set()
    if rems:
        for rid, occ in await session.execute(select(ReminderFire.reminder_id,
                                                     ReminderFire.occurrence_at).where(
                ReminderFire.reminder_id.in_([r.id for r in rems]),
                ReminderFire.state == FireState.ACKED,
                ReminderFire.occurrence_at >= win.lo, ReminderFire.occurrence_at < win.hi)):
            acked.add((rid, occ))
    rem_items = {pk: pid for pk, pid in await session.execute(select(Item.id, Item.public_id).where(
        Item.id.in_({r.item_id for r in rems if r.item_id} or {0})))}  # fmt: skip
    for r in rems:
        tz = r.tz or DEFAULT_TZ
        for at in expand(r.due_at, r.rrule, tz, win.lo, win.hi):
            out.append(_entry(
                "reminder", f"reminder:{r.public_id}:{at.isoformat()}", title=r.title or "",
                start=at, duration=r.duration_min, tz=tz, day=None,
                occurrence_at=at if r.rrule else None, id=r.public_id, rrule=r.rrule,
                moved=False, done=(r.id, at) in acked, source="user",
                item_id=rem_items.get(r.item_id) if r.item_id else None, page_id=None,
                reminder=None, plan=None, version=r.version))  # fmt: skip
    out.extend(await _plan_steps(session, user_id, win))
    out.sort(key=lambda e: (e["date"], not e["all_day"], e["start_at"] or win.lo, e["title"]))
    return out


async def _plan_steps(session: AsyncSession, user_id: int, win: Window) -> list[dict[str, Any]]:
    """Steps of action plans with a time and no live task: read-only entries."""
    out: list[dict[str, Any]] = []
    rows = await session.execute(
        select(Item.public_id, Item.title, Item.source_meta)
        .where(Item.user_id == user_id, Item.kind == "plan", Item.deleted_at.is_(None),
               Item.hidden_reason.is_(None)))  # fmt: skip
    live_tasks: set[str] | None = None
    for pid, title, meta in rows:
        plan = (meta or {}).get("plan") or {}
        tz = plan.get("tz") or win.tz
        for st in plan.get("steps") or []:
            at_text = st.get("remind_at")
            if not at_text:
                continue
            start = datetime.fromisoformat(at_text).replace(tzinfo=ZoneInfo(tz)).astimezone(UTC)
            if not win.lo <= start < win.hi:
                continue
            if st.get("task_id"):
                if live_tasks is None:
                    live_tasks = {str(t) for t in await session.scalars(
                        select(Task.public_id).join(Item, Item.id == Task.item_id)
                        .where(Task.user_id == user_id, Task.deleted_at.is_(None),
                               Item.deleted_at.is_(None)))}  # fmt: skip
                if str(st["task_id"]) in live_tasks:
                    continue
            duration = st.get("duration_min") if isinstance(st.get("duration_min"), int) else None
            out.append(_entry(
                "plan_step", f"plan_step:{pid}:{st.get('id')}", title=st.get("title") or "",
                start=start, duration=duration, tz=tz, day=None, id=st.get("id"),
                occurrence_at=None, rrule=None, moved=False, done=False, source="assistant",
                item_id=pid, page_id=None, reminder=None,
                plan={"id": pid, "title": title}, version=None))  # fmt: skip
    return out


# --- changes ---


@dataclass
class Change:
    ops: list[dict[str, Any]] = field(default_factory=list)
    sentence: str = ""
    new_task: Task | None = None  # «это и следующие»: the series that starts here
    occurrence_at: datetime | None = None


def check_occurrence(task: Task, at: datetime) -> None:
    """`at` is a real occurrence of the series (or already has its own row: checked by caller)."""
    if not task.rrule or task.start_at is None:
        raise _err()
    hit = expand(task.start_at, task.rrule, task.tz or DEFAULT_TZ, at, at + timedelta(seconds=1))
    if not hit:
        raise _err()


def moved_sentence(task: Task, old: datetime | None, new: datetime | None) -> str:
    zone = ZoneInfo(task.tz or DEFAULT_TZ)
    what = task.title[:1].lower() + task.title[1:] if len(task.title) > 1 and not \
        task.title[1].isupper() else task.title  # fmt: skip
    if new is None:
        return f"Без времени: {what}"
    if old is None:
        return f"Поставил на {_hm(new.astimezone(zone))}: {what}"
    a, b = old.astimezone(zone), new.astimezone(zone)
    if a.date() != b.date():
        return (f"Перенёс: {what} — {a.day:02d}.{a.month:02d} {_hm(a)} → "
                f"{b.day:02d}.{b.month:02d} {_hm(b)}")
    return f"Перенёс: {what} — {_hm(a)} → {_hm(b)}"


async def reminder_shift_ops(session: AsyncSession, user_id: int, task: Task,
                             delta: timedelta, now: datetime) -> list[dict[str, Any]]:  # fmt: skip
    """The single reminders linked to the task's record move by the same shift."""
    if not delta:
        return []
    ops = []
    for r in await session.scalars(select(Reminder).where(
            Reminder.user_id == user_id, Reminder.item_id == task.item_id,
            Reminder.kind.in_(APP_KINDS), Reminder.deleted_at.is_(None),
            Reminder.rrule.is_(None))):  # fmt: skip
        due = r.due_at + delta
        if due > now:
            ops.append({"op": "set_reminder_time", "id": str(r.public_id),
                        "due_at": due.isoformat()})  # fmt: skip
    return ops


async def linked_reminder_cancels(session: AsyncSession, user_id: int,
                                  task: Task) -> list[dict[str, Any]]:  # fmt: skip
    return [{"op": "cancel_reminder", "id": str(r.public_id)} for r in await session.scalars(
        select(Reminder).where(Reminder.user_id == user_id, Reminder.item_id == task.item_id,
                               Reminder.kind.in_(APP_KINDS), Reminder.deleted_at.is_(None)))]


__all__ = ["CalendarError", "Change", "MAX_DAYS", "Window", "check_occurrence", "check_rrule",
           "entries", "expand", "linked_reminder_cancels", "moved_sentence",
           "reminder_shift_ops", "with_until"]  # fmt: skip
