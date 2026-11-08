"""App reminders on the server: rows, fires, phone events, last active phone (spec 6.6, R-09…R-13).

The server is the source of truth; the phone plans the nearest fires as local alarms and reports
events. Writers take the per-user sync lock (`sync_lock_user`) so `seq` order is commit order.

Fires: one per occurrence × (event moment + each offset), keyed by
(reminder, occurrence, offset, snooze_n). `plan_fires` reconciles the wanted set with what is
stored: matching future fires keep their id, the rest of the future ones become `cancelled`
(the phone drops them), new ones are added. Repeating reminders are expanded HORIZON ahead.
"""

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from dateutil.rrule import rrulestr
from sqlalchemy import func, select, text, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.db.models import Reminder, User
from assistant.db.models_reminders import (
    APP_KINDS,
    PHONE_EVENTS,
    AppReminderKind,
    AppReminderStatus,
    FireEvent,
    FireState,
    ReminderEvent,
    ReminderFire,
)
from assistant.db.models_v2 import Device
from assistant.reminders import texts
from assistant.reminders.rules import ALLOWED_OFFSETS

HORIZON = timedelta(days=14)
TOPUP_BEFORE = timedelta(days=1)  # top up when expanded_until is closer than HORIZON - this
MAX_OCCURRENCES = 60
PUSH_FALLBACK = timedelta(minutes=3)
MISSED_AFTER = timedelta(minutes=30)
SNOOZE = timedelta(minutes=10)  # «Отложить на 10 минут» when the phone sends no `meta.until`
SNOOZE_MIN = timedelta(minutes=1)  # «Другое время»: `meta.until` from at + 1 min ...
SNOOZE_MAX = timedelta(hours=48)  # ... to at + 48 h («завтра» from any hour fits)
REPEAT_MINUTES = (5, 10, 15)
TEST_IN = timedelta(minutes=1)
EVENT_FUTURE_SLACK = timedelta(minutes=5)
_RRULE_KEYS = {"FREQ", "BYDAY", "BYMONTHDAY", "INTERVAL"}
_DAYS = {"MO", "TU", "WE", "TH", "FR", "SA", "SU"}

LIVE_FIRE_STATES = (FireState.PLANNED, FireState.FIRED, FireState.SNOOZED)


class ReminderError(ValueError):
    """Input the API turns into 422 (`code`)."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


class VersionConflict(Exception):
    pass


async def lock_user(session: AsyncSession, user_id: int) -> None:
    await session.execute(text("SELECT sync_lock_user(:uid)"), {"uid": user_id})


# --- validation ---


def check_tz(tz: str) -> str:
    try:
        ZoneInfo(tz)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ReminderError("validation_error") from exc
    return tz


def check_rrule(rule: str | None) -> str | None:
    """Only the closed set the phone and the texts understand."""
    if rule is None or not rule.strip():
        return None
    rule = rule.strip().upper().removeprefix("RRULE:")
    try:
        parts = dict(p.split("=", 1) for p in rule.split(";"))
    except ValueError as exc:
        raise ReminderError("validation_error") from exc
    freq = parts.get("FREQ")
    if not set(parts) <= _RRULE_KEYS or freq not in {"DAILY", "WEEKLY", "MONTHLY"}:
        raise ReminderError("validation_error")
    if "INTERVAL" in parts and not (
        parts["INTERVAL"].isdigit() and 1 <= int(parts["INTERVAL"]) <= 12
    ):
        raise ReminderError("validation_error")
    if "BYDAY" in parts and (freq != "WEEKLY" or not set(parts["BYDAY"].split(",")) <= _DAYS):
        raise ReminderError("validation_error")
    if "BYMONTHDAY" in parts and (
        freq != "MONTHLY"
        or not parts["BYMONTHDAY"].isdigit()
        or not 1 <= int(parts["BYMONTHDAY"]) <= 31
    ):
        raise ReminderError("validation_error")
    order = ["FREQ", "INTERVAL", "BYDAY", "BYMONTHDAY"]
    return ";".join(f"{k}={parts[k]}" for k in order if k in parts)


def check_offsets(offsets: Sequence[int]) -> list[int]:
    out = sorted(set(offsets))
    if len(out) != len(offsets) or len(out) > 3 or any(o not in ALLOWED_OFFSETS for o in out):
        raise ReminderError("validation_error")
    return out


# --- occurrences and fires ---


def occurrences(r: Reminder, start: datetime, end: datetime) -> list[datetime]:
    """Event moments (UTC) in [start, end)."""
    assert r.tz is not None
    if not r.rrule:
        return [r.due_at] if start <= r.due_at < end else []
    zone = ZoneInfo(r.tz)
    dtstart = r.due_at.astimezone(zone).replace(tzinfo=None)
    rule = rrulestr(r.rrule, dtstart=dtstart)
    lo = max(start.astimezone(zone).replace(tzinfo=None), dtstart) - timedelta(seconds=1)
    hi = end.astimezone(zone).replace(tzinfo=None)
    out: list[datetime] = []
    for local in rule.between(lo, hi, inc=True):
        moment = local.replace(tzinfo=zone).astimezone(UTC)
        if start <= moment < end:
            out.append(moment)
        if len(out) >= MAX_OCCURRENCES:
            break
    return out


def fire_key(
    reminder_public_id: uuid.UUID, occurrence_at: datetime, offset_min: int, snooze_n: int
) -> str:
    occ = occurrence_at.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    return f"{reminder_public_id}:{occ}:{offset_min}:{snooze_n}"


def _times(fire_at: datetime) -> dict[str, datetime]:
    return {
        "fire_at": fire_at,
        "push_fallback_at": fire_at + PUSH_FALLBACK,
        "missed_at": fire_at + MISSED_AFTER,
    }


async def target_device(session: AsyncSession, user_id: int) -> int | None:
    """R-13: the last active phone, or None when the person chose «звонить на всех»."""
    policy = await session.scalar(select(User.alarm_device_policy).where(User.id == user_id))
    if policy != "last_active":
        return None
    return await session.scalar(
        select(Device.id)
        .where(Device.user_id == user_id, Device.revoked_at.is_(None))
        .order_by(Device.last_active_at.desc().nulls_last(), Device.id.desc())
        .limit(1)
    )


async def plan_fires(
    session: AsyncSession,
    r: Reminder,
    now: datetime,
    *,
    device_id: int | None = None,
    cancel_rest: bool = True,
) -> list[ReminderFire]:
    """Reconcile the future fires of `r` (caller holds the user lock). Returns changed fires."""
    live = r.deleted_at is None and r.status not in (
        AppReminderStatus.CANCELLED,
        AppReminderStatus.DONE,
    )
    horizon_end = now + HORIZON
    wanted: dict[tuple[datetime, int], datetime] = {}
    if live:
        offsets = [0, *sorted(r.offsets or [])]
        for occ in occurrences(r, now - timedelta(days=2), horizon_end + timedelta(days=2)):
            for off in offsets:
                at = occ - timedelta(minutes=off)
                if now < at <= horizon_end or (not r.rrule and now < at):
                    wanted[(occ, off)] = at
    existing = list(
        await session.scalars(
            select(ReminderFire).where(ReminderFire.reminder_id == r.id, ReminderFire.fire_at > now)
        )
    )
    target = device_id if device_id is not None else await target_device(session, r.user_id)
    changed: list[ReminderFire] = []
    seen: set[tuple[datetime, int]] = set()
    for f in existing:
        key = (f.occurrence_at, f.offset_min)
        if f.snooze_n == 0 and key in wanted:
            seen.add(key)
            if f.state == FireState.CANCELLED:
                f.state = FireState.PLANNED
                f.push_sent_at = f.fired_at = f.acked_at = None
                f.target_device_id = target
                changed.append(f)
            elif f.state == FireState.PLANNED and f.target_device_id != target:
                f.target_device_id = target
                changed.append(f)
        elif cancel_rest and f.state in LIVE_FIRE_STATES and f.state != FireState.FIRED:
            f.state = FireState.CANCELLED
            changed.append(f)
    for (occ, off), at in sorted(wanted.items(), key=lambda kv: kv[1]):
        if (occ, off) in seen:
            continue
        # The key may already exist in the past window (not loaded above): skip on conflict.
        stmt = (
            pg_insert(ReminderFire)
            .values(
                public_id=uuid.uuid4(),
                user_id=r.user_id,
                reminder_id=r.id,
                occurrence_at=occ,
                offset_min=off,
                repeat_n=0,
                snooze_n=0,
                state=FireState.PLANNED,
                target_device_id=target,
                **_times(at),
            )
            .on_conflict_do_nothing(constraint="uq_reminder_fires_key")
            .returning(ReminderFire.id)
        )
        new_id = await session.scalar(stmt)
        if new_id is not None:
            fire = await session.get(ReminderFire, new_id)
            assert fire is not None
            changed.append(fire)
    if r.rrule and live:
        r.expanded_until = horizon_end
    await session.flush()
    return changed


# --- create / change / delete ---


@dataclass
class ReminderInput:
    title: str
    due_at: datetime
    tz: str
    body: str | None = None
    rrule: str | None = None
    offsets: Sequence[int] = ()
    level: str = "notification"
    created_via: str | None = None
    parse_source: str | None = None
    sensitivity: str | None = None
    item_id: int | None = None
    client_id: uuid.UUID | None = None
    kind: str = AppReminderKind.NORMAL


def _validated(data: ReminderInput, now: datetime) -> ReminderInput:
    title = " ".join(data.title.split())
    if not 1 <= len(title) <= 200 or data.due_at.tzinfo is None:
        raise ReminderError("validation_error")
    data.title = title
    data.tz = check_tz(data.tz)
    data.rrule = check_rrule(data.rrule)
    data.offsets = check_offsets(data.offsets)
    data.due_at = data.due_at.astimezone(UTC).replace(microsecond=0)
    if not data.rrule and data.due_at <= now:
        raise ReminderError("reminder_in_past")
    return data


async def create(
    session: AsyncSession,
    user_id: int,
    data: ReminderInput,
    now: datetime,
    *,
    device_id: int | None = None,
) -> tuple[Reminder, list[ReminderFire], bool]:
    """New reminder (the person tapped [Сохранить]) and its fires. Same `client_id` again →
    the existing one, `created=False`."""
    await lock_user(session, user_id)
    if data.client_id is not None:
        found = await session.scalar(
            select(Reminder).where(
                Reminder.user_id == user_id,
                Reminder.client_id == data.client_id,
                Reminder.kind.in_(APP_KINDS),
            )
        )
        if found is not None:
            return found, await upcoming_fires(session, found, now), False
    data = _validated(data, now)
    r = Reminder(
        user_id=user_id,
        kind=data.kind,
        due_at=data.due_at,
        title=data.title,
        body=data.body,
        tz=data.tz,
        rrule=data.rrule,
        offsets=list(data.offsets),
        level=data.level,
        created_via=data.created_via,
        parse_source=data.parse_source,
        sensitivity=data.sensitivity,
        item_id=data.item_id,
        client_id=data.client_id,
        status=AppReminderStatus.SCHEDULED,
        attempts=0,
        version=1,
    )
    session.add(r)
    await session.flush()
    fires = await plan_fires(session, r, now, device_id=device_id)
    return r, fires, True


async def get(session: AsyncSession, user_id: int, public_id: uuid.UUID) -> Reminder | None:
    return await session.scalar(
        select(Reminder).where(
            Reminder.user_id == user_id,
            Reminder.public_id == public_id,
            Reminder.kind.in_(APP_KINDS),
        )
    )


_PATCHABLE = (
    "title",
    "body",
    "due_at",
    "tz",
    "rrule",
    "offsets",
    "level",
    "sensitivity",
    "parse_source",
)


async def change(
    session: AsyncSession,
    user_id: int,
    public_id: uuid.UUID,
    version: int,
    fields: dict[str, Any],
    now: datetime,
) -> tuple[Reminder, list[ReminderFire]] | None:
    """The person's own edit (applied at once). None = not found; VersionConflict on `version`."""
    await lock_user(session, user_id)
    r = await get(session, user_id, public_id)
    if r is None or r.deleted_at is not None:
        return None
    if r.version != version:
        raise VersionConflict
    data = ReminderInput(
        title=fields.get("title", r.title) or "",
        due_at=fields.get("due_at", r.due_at),
        tz=fields.get("tz", r.tz) or "",
        body=fields.get("body", r.body),
        rrule=fields.get("rrule", r.rrule),
        offsets=fields.get("offsets", r.offsets or []),
        level=fields.get("level", r.level),
    )
    data = _validated(data, now) if (data.due_at != r.due_at or "rrule" in fields) else _soft(data)
    timing = (data.due_at, data.tz, data.rrule, list(data.offsets)) != (
        r.due_at,
        r.tz,
        r.rrule,
        list(r.offsets or []),
    )
    r.title, r.body, r.tz, r.rrule = data.title, data.body, data.tz, data.rrule
    r.due_at, r.offsets, r.level = data.due_at, list(data.offsets), data.level
    if "sensitivity" in fields:
        r.sensitivity = fields["sensitivity"]
    if "parse_source" in fields:
        r.parse_source = fields["parse_source"]
    elif timing:
        r.parse_source = "user_edit"
    r.version += 1
    fires: list[ReminderFire] = []
    if timing:
        if r.status in (
            AppReminderStatus.DONE,
            AppReminderStatus.MISSED,
            AppReminderStatus.FIRED,
            AppReminderStatus.SNOOZED,
        ):
            r.status = AppReminderStatus.SCHEDULED
        r.snooze_until = None
        fires = await plan_fires(session, r, now)
    await session.flush()
    return r, fires


def _soft(data: ReminderInput) -> ReminderInput:
    """Validation for an edit that leaves the time alone (a past one-off may be renamed)."""
    title = " ".join(data.title.split())
    if not 1 <= len(title) <= 200:
        raise ReminderError("validation_error")
    data.title = title
    data.tz = check_tz(data.tz)
    data.offsets = check_offsets(data.offsets)
    return data


async def delete(
    session: AsyncSession, user_id: int, public_id: uuid.UUID, now: datetime
) -> list[ReminderFire] | None:
    await lock_user(session, user_id)
    r = await get(session, user_id, public_id)
    if r is None:
        return None
    if r.deleted_at is None:
        r.deleted_at = now
        r.status = AppReminderStatus.CANCELLED
        r.version += 1
    fires = list(
        await session.scalars(
            select(ReminderFire).where(
                ReminderFire.reminder_id == r.id, ReminderFire.state.in_(LIVE_FIRE_STATES)
            )
        )
    )
    for f in fires:
        f.state = FireState.CANCELLED
    await session.flush()
    return fires


async def create_test(
    session: AsyncSession, user_id: int, device_id: int | None, now: datetime
) -> tuple[Reminder, list[ReminderFire]]:
    """S15 «Проверить будильник»: an alarm in 1 minute on this phone."""
    tz = await session.scalar(select(User.tz).where(User.id == user_id)) or "Asia/Almaty"
    data = ReminderInput(
        title=texts.TEST_TITLE,
        due_at=now + TEST_IN,
        tz=tz,
        level="alarm",
        created_via="manual_form",
        kind=AppReminderKind.TEST,
    )
    r, fires, _ = await create(session, user_id, data, now, device_id=device_id)
    return r, fires


async def upcoming_fires(session: AsyncSession, r: Reminder, now: datetime) -> list[ReminderFire]:
    return list(
        await session.scalars(
            select(ReminderFire)
            .where(ReminderFire.reminder_id == r.id, ReminderFire.fire_at > now - timedelta(days=1))
            .order_by(ReminderFire.fire_at)
        )
    )


async def window(
    session: AsyncSession, user_id: int, start: datetime, end: datetime
) -> tuple[list[ReminderFire], list[Reminder]]:
    fires = list(
        await session.scalars(
            select(ReminderFire)
            .join(Reminder, Reminder.id == ReminderFire.reminder_id)
            .where(
                ReminderFire.user_id == user_id,
                ReminderFire.fire_at >= start,
                ReminderFire.fire_at < end,
                ReminderFire.state.in_(LIVE_FIRE_STATES),
                Reminder.deleted_at.is_(None),
            )
            .order_by(ReminderFire.fire_at, ReminderFire.id)
            .limit(1000)
        )
    )
    ids = {f.reminder_id for f in fires}
    reminders = (
        list(await session.scalars(select(Reminder).where(Reminder.id.in_(ids)))) if ids else []
    )
    return fires, reminders


# --- last active phone ---


async def mark_active(session: AsyncSession, user_id: int, device_id: int, now: datetime) -> int:
    """This phone is the last active one; future planned fires move to it. Returns how many."""
    await session.execute(
        update(Device)
        .where(Device.id == device_id, Device.user_id == user_id)
        .values(last_active_at=now)
    )
    return await retarget(session, user_id, now)


async def retarget(session: AsyncSession, user_id: int, now: datetime) -> int:
    await lock_user(session, user_id)
    target = await target_device(session, user_id)
    res = await session.execute(
        update(ReminderFire)
        .where(
            ReminderFire.user_id == user_id,
            ReminderFire.state == FireState.PLANNED,
            ReminderFire.fire_at > now,
            ReminderFire.target_device_id.is_distinct_from(target),
        )
        .values(target_device_id=target, updated_at=func.now())
    )
    return int(res.rowcount or 0)  # type: ignore[attr-defined]


# --- events from the phone ---


@dataclass
class EventIn:
    client_id: uuid.UUID
    event: str
    at: datetime
    fire_id: uuid.UUID | None = None
    fire_key: str | None = None
    meta: dict[str, Any] | None = None


async def _find_fire(session: AsyncSession, user_id: int, ev: EventIn) -> ReminderFire | None:
    if ev.fire_id is not None:
        return await session.scalar(
            select(ReminderFire)
            .where(ReminderFire.user_id == user_id, ReminderFire.public_id == ev.fire_id)
            .with_for_update()
        )
    if not ev.fire_key:
        return None
    try:
        rid, rest = ev.fire_key.split(":", 1)
        occ_s, off_s, sn_s = rest.rsplit(":", 2)
        occ = datetime.strptime(occ_s, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=UTC)
        rpub, off, sn = uuid.UUID(rid), int(off_s), int(sn_s)
    except ValueError:
        return None
    return await session.scalar(
        select(ReminderFire)
        .join(Reminder, Reminder.id == ReminderFire.reminder_id)
        .where(
            ReminderFire.user_id == user_id,
            Reminder.public_id == rpub,
            ReminderFire.occurrence_at == occ,
            ReminderFire.offset_min == off,
            ReminderFire.snooze_n == sn,
        )
        .with_for_update(of=ReminderFire)
    )


def snooze_until(ev: "EventIn") -> datetime | None:
    """When a snoozed fire rings again: `meta.until` (the phone's «Другое время»), else at + 10
    min. None: `meta.until` is not an aware ISO time in [at + 1 min, at + 48 h]."""
    at = ev.at.astimezone(UTC).replace(microsecond=0)
    raw = (ev.meta or {}).get("until")
    if raw is None:
        return at + SNOOZE
    try:
        until = datetime.fromisoformat(raw) if isinstance(raw, str) else None
    except ValueError:
        return None
    if until is None or until.tzinfo is None:
        return None
    until = until.astimezone(UTC).replace(microsecond=0)
    return until if at + SNOOZE_MIN <= until <= at + SNOOZE_MAX else None


async def apply_events(
    session: AsyncSession,
    user_id: int,
    device_id: int | None,
    events: Sequence[EventIn],
    now: datetime,
) -> tuple[list[dict[str, str]], list[ReminderFire]]:
    """Journal + state changes, in the order given. Idempotent per (fire, client_id)."""
    await lock_user(session, user_id)
    results: list[dict[str, str]] = []
    changed: dict[int, ReminderFire] = {}
    for ev in events:
        out = {"client_id": str(ev.client_id)}
        results.append(out)
        if ev.event not in PHONE_EVENTS or ev.at.tzinfo is None or ev.at > now + EVENT_FUTURE_SLACK:
            out["status"] = "invalid"
            continue
        if ev.event == FireEvent.SNOOZED and snooze_until(ev) is None:
            out["status"] = "invalid"  # bad «Другое время»: nothing applied, phone keeps its own
            continue
        fire = await _find_fire(session, user_id, ev)
        if fire is None:
            out["status"] = "not_found"
            continue
        row = await session.scalar(
            pg_insert(ReminderEvent)
            .values(
                fire_id=fire.id,
                user_id=user_id,
                device_id=device_id,
                client_id=ev.client_id,
                event=ev.event,
                at=ev.at,
                meta=ev.meta or {},
            )
            .on_conflict_do_nothing(constraint="uq_reminder_events_client")
            .returning(ReminderEvent.id)
        )
        if row is None:
            out["status"] = "duplicate"
            continue
        out["status"] = "applied"
        for f in await _transition(session, fire, ev, now):
            changed[f.id] = f
    await session.flush()
    return results, sorted(changed.values(), key=lambda f: (f.fire_at, f.id))


async def _transition(
    session: AsyncSession, fire: ReminderFire, ev: EventIn, now: datetime
) -> list[ReminderFire]:
    if fire.state == FireState.CANCELLED or ev.event in (
        FireEvent.SCHEDULED_LOCAL,
        FireEvent.SCHEDULE_FAILED,
    ):
        return []
    r = await session.get(Reminder, fire.reminder_id, with_for_update=True)
    assert r is not None
    main = fire.offset_min == 0
    if ev.event in (FireEvent.FIRED_LOCAL, FireEvent.SHOWN, FireEvent.DISMISSED):
        if fire.state != FireState.PLANNED:
            return []
        fire.state, fire.fired_at = FireState.FIRED, ev.at
        if (
            main
            and not r.rrule
            and r.status in (AppReminderStatus.SCHEDULED, AppReminderStatus.SNOOZED)
        ):
            r.status = AppReminderStatus.FIRED
        return [fire]
    if ev.event == FireEvent.ACKED:
        # «Сделано» is for the occurrence: its other live fires are done too.
        same = list(
            await session.scalars(
                select(ReminderFire)
                .where(
                    ReminderFire.reminder_id == fire.reminder_id,
                    ReminderFire.occurrence_at == fire.occurrence_at,
                    ReminderFire.id != fire.id,
                    ReminderFire.state.in_(LIVE_FIRE_STATES),
                )
                .with_for_update()
            )
        )
        out = []
        if fire.state != FireState.ACKED:
            fire.state, fire.acked_at = FireState.ACKED, ev.at
            out.append(fire)
        for f in same:
            f.state, f.acked_at = FireState.ACKED, ev.at
            out.append(f)
        if not r.rrule:
            r.status = AppReminderStatus.DONE
        r.snooze_until = None
        return out
    if ev.event == FireEvent.SNOOZED:
        if fire.state not in (FireState.PLANNED, FireState.FIRED, FireState.MISSED):
            return []
        fire.state = FireState.SNOOZED
        last_n = await session.scalar(
            select(func.max(ReminderFire.snooze_n)).where(
                ReminderFire.reminder_id == fire.reminder_id,
                ReminderFire.occurrence_at == fire.occurrence_at,
                ReminderFire.offset_min == fire.offset_min,
            )
        )
        at = snooze_until(ev)
        assert at is not None  # checked in apply_events
        new_id = await session.scalar(
            pg_insert(ReminderFire)
            .values(
                public_id=uuid.uuid4(),
                user_id=fire.user_id,
                reminder_id=fire.reminder_id,
                occurrence_at=fire.occurrence_at,
                offset_min=fire.offset_min,
                repeat_n=0,
                snooze_n=(last_n or 0) + 1,
                state=FireState.PLANNED,
                target_device_id=fire.target_device_id,
                **_times(at),
            )
            .on_conflict_do_nothing(constraint="uq_reminder_fires_key")
            .returning(ReminderFire.id)
        )
        out = [fire]
        if new_id is not None:
            new = await session.get(ReminderFire, new_id)
            assert new is not None
            out.append(new)
        if main and not r.rrule:
            r.status, r.snooze_until = AppReminderStatus.SNOOZED, at
        return out
    return []


# --- JSON shapes (docs/api/reminders.md) ---


def reminder_dict(r: Reminder, today: Any = None) -> dict[str, Any]:
    assert r.tz is not None and r.title is not None
    zone = ZoneInfo(r.tz)
    local = r.due_at.astimezone(zone).replace(tzinfo=None)
    today = today or datetime.now(UTC).astimezone(zone).date()
    return {
        "id": r.public_id,
        "client_id": r.client_id,
        "title": r.title,
        "body": r.body,
        "due_at": r.due_at,
        "tz": r.tz,
        "local": {"date": local.date().isoformat(), "time": local.strftime("%H:%M")},
        "rrule": r.rrule,
        "offsets": list(r.offsets or []),
        "level": r.level,
        "kind": r.kind,
        "created_via": r.created_via,
        "parse_source": r.parse_source,
        "sensitivity": r.sensitivity,
        "status": str(r.status),
        "snooze_until": r.snooze_until,
        "item_id": None,
        "when_text": texts.when_text(local, r.rrule, r.offsets or [], r.level, today),
        "version": r.version,
        "seq": r.seq,
        "created_at": r.created_at,
        "updated_at": r.updated_at,
        "deleted_at": r.deleted_at,
    }


async def reminders_dicts(session: AsyncSession, rows: Sequence[Reminder]) -> list[dict[str, Any]]:
    item_ids = {r.item_id for r in rows if r.item_id is not None}
    pubs: dict[int, uuid.UUID] = {}
    if item_ids:
        from assistant.db.models import Item

        pubs = dict(
            (await session.execute(select(Item.id, Item.public_id).where(Item.id.in_(item_ids))))
            .tuples()
            .all()
        )
    out = []
    for r in rows:
        d = reminder_dict(r)
        d["item_id"] = pubs.get(r.item_id) if r.item_id is not None else None
        out.append(d)
    return out


async def fires_dicts(session: AsyncSession, fires: Sequence[ReminderFire]) -> list[dict[str, Any]]:
    rids = {f.reminder_id for f in fires}
    dids = {f.target_device_id for f in fires if f.target_device_id is not None}
    rpub: dict[int, uuid.UUID] = {}
    dpub: dict[int, uuid.UUID] = {}
    if rids:
        rpub = dict(
            (
                await session.execute(
                    select(Reminder.id, Reminder.public_id).where(Reminder.id.in_(rids))
                )
            )
            .tuples()
            .all()
        )
    if dids:
        dpub = dict(
            (await session.execute(select(Device.id, Device.public_id).where(Device.id.in_(dids))))
            .tuples()
            .all()
        )
    return [
        {
            "id": f.public_id,
            "reminder_id": rpub[f.reminder_id],
            "key": fire_key(rpub[f.reminder_id], f.occurrence_at, f.offset_min, f.snooze_n),
            "occurrence_at": f.occurrence_at,
            "fire_at": f.fire_at,
            "offset_min": f.offset_min,
            "snooze_n": f.snooze_n,
            "repeat_n": f.repeat_n,
            "state": f.state,
            "target_device_id": dpub.get(f.target_device_id) if f.target_device_id else None,
            "push_fallback_at": f.push_fallback_at,
            "missed_at": f.missed_at,
            "push_sent_at": f.push_sent_at,
            "fired_at": f.fired_at,
            "acked_at": f.acked_at,
            "seq": f.seq,
            "updated_at": f.updated_at,
        }
        for f in fires
    ]
