"""«Сейчас» (Ф-89 part 3): the assistant knows what time it is for the person, what of today is
already past, the next thing with a time and how long until it, and the free window until then.

Everything here is computed by code from the person's reminders (the only rows with a time;
`docs/spec/proposals/calendar-data.md` for the calendar's start + duration) and «Дела» due today.
The model gets one code line (times and counts only, no titles: titles are the person's data and
go into the data block «Расписание на сегодня»), and every time / number of these lines is a
fact the answer check (`verify`, AnswerGate) accepts. Pure `build` + `lines`; `load` reads the DB.
"""

import re
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.chat.verify import Facts

SCHEDULE_LABEL = "Расписание на сегодня"
MAX_SLOTS = 30
LOOK_AHEAD = timedelta(days=7)  # the next thing with a time, if nothing is left today
TITLE_CHARS = 80


@dataclass(frozen=True)
class Slot:
    at: datetime  # naive, on the person's clock
    title: str


@dataclass
class NowView:
    now: datetime  # naive local, minute precision
    past: list[Slot] = field(default_factory=list)  # today, already past
    later: list[Slot] = field(default_factory=list)  # today, still ahead
    next: Slot | None = None  # the next one (today or a later day, within LOOK_AHEAD)
    tasks_today: list[str] = field(default_factory=list)  # «Дела» due today, no time
    overdue: int = 0  # «Дела» with a day before today, not done

    @property
    def minutes_to_next(self) -> int | None:
        if self.next is None:
            return None
        return max(0, int((self.next.at - self.now).total_seconds() // 60))

    @property
    def free_until(self) -> datetime:
        """The free window runs until the next thing with a time today, else to the end of the
        day (nothing has a duration yet)."""
        if self.later:
            return self.later[0].at
        return datetime.combine(self.now.date(), time(23, 59))


def build(now_local: datetime, slots: list[Slot], tasks_today: list[str] | None = None,
          overdue: int = 0) -> NowView:  # fmt: skip
    now_local = now_local.replace(second=0, microsecond=0, tzinfo=None)
    today = now_local.date()
    ordered = sorted(slots, key=lambda s: s.at)
    view = NowView(now_local, tasks_today=list(tasks_today or []), overdue=overdue)
    for s in ordered:
        if s.at.date() == today and s.at <= now_local:
            view.past.append(s)
        elif s.at.date() == today:
            view.later.append(s)
    view.next = next((s for s in ordered if s.at > now_local), None)
    return view


def _hm(t: datetime | time) -> str:
    return f"{t.hour}:{t.minute:02d}"


def _span(minutes: int) -> str:
    """«40 мин», «2 ч», «1 ч 20 мин»."""
    h, m = divmod(minutes, 60)
    if not h:
        return f"{m} мин"
    return f"{h} ч" + (f" {m} мин" if m else "")


def _add_minutes(f: Facts, minutes: int) -> None:
    """A duration in every spelling an answer may use: 100 мин, 1 ч 40 мин, ≈2 ч."""
    h, m = divmod(minutes, 60)
    f.numbers |= {Decimal(minutes), Decimal(h), Decimal(m), Decimal(round(minutes / 60))}
    if m == 30:
        f.numbers.add(Decimal("1.5") if h == 1 else Decimal(f"{h}.5"))


def lines(view: NowView) -> tuple[str, str | None, Facts]:
    """(the code line for the context, the data block text or None, the facts it states)."""
    f = Facts()
    now = view.now
    f.times.add((now.hour, now.minute))
    parts = [f"Сейчас у человека {_hm(now)}."]
    today = now.date()
    if view.past:
        last = view.past[-1]
        parts.append(f"Сегодня уже прошло по времени: {len(view.past)} "
                     f"(последнее в {_hm(last.at)}).")  # fmt: skip
        f.numbers.add(Decimal(len(view.past)))
    if view.later:
        parts.append(f"Ещё впереди сегодня: {len(view.later)}.")
        f.numbers.add(Decimal(len(view.later)))
    if view.next is not None:
        mins = view.minutes_to_next or 0
        when = _hm(view.next.at) if view.next.at.date() == today else \
            f"{view.next.at.day:02d}.{view.next.at.month:02d} в {_hm(view.next.at)}"  # fmt: skip
        parts.append(f"Следующее по времени — {when}, через {_span(mins)}.")
        f.add_date(view.next.at)
        _add_minutes(f, mins)
    else:
        parts.append("Дальше на неделю ничего по времени нет.")
    free_end = view.free_until
    free = int((free_end - now).total_seconds() // 60)
    if view.later:
        parts.append(f"Свободно сейчас: до {_hm(free_end)} ({_span(free)}).")
    else:
        parts.append("Сегодня по времени больше ничего нет: свободно до конца дня.")
    _add_minutes(f, max(free, 0))
    f.times.add((free_end.hour, free_end.minute))
    if view.tasks_today:
        parts.append(f"Дела на сегодня без времени: {len(view.tasks_today)}.")
        f.numbers.add(Decimal(len(view.tasks_today)))
    if view.overdue:
        parts.append(f"Просроченных дел: {view.overdue}.")
        f.numbers.add(Decimal(view.overdue))
    parts.append(f"Время раньше {_hm(now)} сегодня уже прошло: не предлагай его. На «что у меня "
                 "сейчас», «когда я свободен», «успею до …» отвечай по этим строкам"
                 + (f" и блоку «{SCHEDULE_LABEL}»." if view.past or view.later or view.next
                    or view.tasks_today else "."))  # fmt: skip
    rows: list[str] = []
    for s in view.past:
        rows.append(f"{_hm(s.at)} — {s.title} (прошло)")
    for s in view.later:
        rows.append(f"{_hm(s.at)} — {s.title}")
    if view.next is not None and view.next.at.date() != today:
        rows.append(f"{view.next.at.day:02d}.{view.next.at.month:02d} {_hm(view.next.at)} — "
                    f"{view.next.title} (следующее)")  # fmt: skip
    for title in view.tasks_today:
        rows.append(f"без времени — {title}")
    for s in [*view.past, *view.later]:
        f.times.add((s.at.hour, s.at.minute))
    return " ".join(parts), ("\n".join(rows) if rows else None), f


_CLEAN = re.compile(r"\s+")


def _title(value: str | None) -> str:
    return _CLEAN.sub(" ", value or "").strip()[:TITLE_CHARS] or "Напоминание"


async def load(session: AsyncSession, user_id: int, now: datetime, tz: str) -> NowView:
    """Today's reminders (each occurrence once, cancelled ones left out) and «Дела» of today."""
    zone = ZoneInfo(tz)
    local = now.astimezone(zone)
    start = datetime.combine(local.date(), time(0, 0), zone)
    rows = await session.execute(text("""
        SELECT DISTINCT ON (f.reminder_id, f.occurrence_at) f.occurrence_at AS at, r.title
        FROM reminder_fires f JOIN reminders r ON r.id = f.reminder_id
        WHERE f.user_id = :u AND f.offset_min = 0 AND f.snooze_n = 0
          AND f.state <> 'cancelled' AND r.deleted_at IS NULL AND r.status <> 'cancelled'
          AND r.kind = 'normal' AND f.occurrence_at >= :a AND f.occurrence_at < :b
        ORDER BY f.reminder_id, f.occurrence_at
        LIMIT :n
    """), {"u": user_id, "a": start, "b": now + LOOK_AHEAD, "n": MAX_SLOTS * 4})  # fmt: skip
    slots = [Slot(r.at.astimezone(zone).replace(tzinfo=None), _title(r.title)) for r in rows]
    slots.sort(key=lambda s: s.at)
    today: date = local.date()
    tasks = [r[0] for r in await session.execute(text("""
        SELECT title FROM tasks WHERE user_id = :u AND list_key = 'todo' AND deleted_at IS NULL
          AND done_at IS NULL AND due_date = :d ORDER BY id LIMIT 20
    """), {"u": user_id, "d": today})]  # fmt: skip
    overdue = await session.scalar(text("""
        SELECT count(*) FROM tasks WHERE user_id = :u AND list_key = 'todo' AND deleted_at IS NULL
          AND done_at IS NULL AND due_date < :d
    """), {"u": user_id, "d": today})  # fmt: skip
    keep = [s for s in slots if s.at.date() == today][:MAX_SLOTS]
    later_days = [s for s in slots if s.at.date() != today][:1]
    return build(local.replace(tzinfo=None), keep + later_days,
                 [_title(t) for t in tasks], int(overdue or 0))  # fmt: skip
