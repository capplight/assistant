"""/v1/reminders: alarms and reminders (week 8). Contract: docs/api/reminders.md.

Base consents for everything. Parsing a phrase goes to the model only with `ai_cross_border`
(the consent gate's check); without it, and when code cannot read the phrase, the phone gets
the manual form. Nothing is created from a phrase until the phone POSTs the confirmed draft.
"""

import uuid
from datetime import UTC, datetime, time, timedelta
from typing import Annotated, Any
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import select

from assistant.api.consent_gate import AI_CONSENTS, missing_consents, require_base_consent
from assistant.api.deps import Ctx, CurrentUser, Db, get_active_consent_kinds
from assistant.api.errors import ApiError
from assistant.api.schemas import (
    FireOut,
    FiresWindowOut,
    ReminderActiveOut,
    ReminderEventResult,
    ReminderEventsIn,
    ReminderEventsOut,
    ReminderIn,
    ReminderListOut,
    ReminderLocal,
    ReminderOut,
    ReminderParseIn,
    ReminderParseResultOut,
    ReminderPatchIn,
    ReminderSettingsOut,
    ReminderSettingsPatchIn,
    ReminderWithFiresOut,
)
from assistant.db.models import Item, Reminder, User
from assistant.db.models_reminders import AppReminderKind, AppReminderStatus
from assistant.db.models_v2 import ConsentKind, Device
from assistant.reminders import parse_phrase, service
from assistant.reminders.parse import drafts_dicts
from assistant.reminders.rules import ALLOWED_OFFSETS

router = APIRouter(prefix="/reminders", tags=["reminders"])
GatedUser = Annotated[CurrentUser, Depends(require_base_consent)]
Kinds = Annotated[frozenset[str], Depends(get_active_consent_kinds)]
MAX_WINDOW = timedelta(days=31)


def _now() -> datetime:
    return datetime.now(UTC).replace(microsecond=0)


async def _user_tz(db: Db, user_id: int) -> str:
    return await db.scalar(select(User.tz).where(User.id == user_id)) or "Asia/Almaty"


def _due(due_at: datetime | None, local: ReminderLocal | None, tz: str) -> datetime:
    if due_at is not None:
        return due_at
    assert local is not None
    try:
        naive = datetime.fromisoformat(f"{local.date}T{local.time}")
        return naive.replace(tzinfo=ZoneInfo(tz)).astimezone(UTC)
    except (ValueError, KeyError) as exc:
        raise ApiError(422, "validation_error") from exc


def _tz(tz: str) -> str:
    try:
        return service.check_tz(tz)
    except service.ReminderError as exc:
        raise ApiError(422, exc.code) from exc


def _error(exc: service.ReminderError) -> ApiError:
    return ApiError(422, exc.code)


async def _with_fires(db: Db, r: Reminder, fires: list[Any]) -> ReminderWithFiresOut:
    rem = (await service.reminders_dicts(db, [r]))[0]
    return ReminderWithFiresOut(
        reminder=ReminderOut.model_validate(rem),
        fires=[FireOut.model_validate(f) for f in await service.fires_dicts(db, fires)],
    )


# --- settings, parse, test, events, window: before /{id} ---


async def _settings_out(
    db: Db, ctx: Ctx, user_id: int, kinds: frozenset[str]
) -> ReminderSettingsOut:
    u = await db.get(User, user_id)
    assert u is not None
    return ReminderSettingsOut(
        parser="rules_first" if ctx.settings.reminders_rules_first else "llm",
        quiet_from=u.quiet_from.strftime("%H:%M"),
        quiet_to=u.quiet_to.strftime("%H:%M"),
        alarm_device_policy=u.alarm_device_policy,  # type: ignore[arg-type]
        push_content=ConsentKind.PUSH_CONTENT in kinds,
        snooze_minutes=int(service.SNOOZE.total_seconds() // 60),
        snooze_max_hours=int(service.SNOOZE_MAX.total_seconds() // 3600),
        repeat_minutes=list(service.REPEAT_MINUTES),
        push_fallback_minutes=int(service.PUSH_FALLBACK.total_seconds() // 60),
        missed_minutes=int(service.MISSED_AFTER.total_seconds() // 60),
        offsets_allowed=list(ALLOWED_OFFSETS),
        horizon_days=service.HORIZON.days,
    )


@router.get("/settings", response_model=ReminderSettingsOut)
async def get_settings(user: GatedUser, db: Db, ctx: Ctx, kinds: Kinds) -> ReminderSettingsOut:
    return await _settings_out(db, ctx, user.id, kinds)


@router.patch("/settings", response_model=ReminderSettingsOut)
async def patch_settings(
    body: ReminderSettingsPatchIn, user: GatedUser, db: Db, ctx: Ctx, kinds: Kinds
) -> ReminderSettingsOut:
    u = await db.get(User, user.id)
    assert u is not None
    if body.quiet_from is not None:
        u.quiet_from = time.fromisoformat(body.quiet_from)
    if body.quiet_to is not None:
        u.quiet_to = time.fromisoformat(body.quiet_to)
    policy_changed = (
        body.alarm_device_policy is not None and body.alarm_device_policy != u.alarm_device_policy
    )
    if body.alarm_device_policy is not None:
        u.alarm_device_policy = body.alarm_device_policy
    await db.flush()
    if policy_changed:
        await service.retarget(db, user.id, _now())
    return await _settings_out(db, ctx, user.id, kinds)


@router.post("/parse", response_model=ReminderParseResultOut)
async def parse(
    body: ReminderParseIn, user: GatedUser, db: Db, ctx: Ctx, kinds: Kinds
) -> ReminderParseResultOut:
    """«Как понял» (S13): nothing is saved."""
    tz = _tz(body.tz) if body.tz else await _user_tz(db, user.id)
    now = _now()
    ai_allowed = not missing_consents(kinds, AI_CONSENTS)
    rules_first = ctx.settings.reminders_rules_first
    await db.commit()  # no transaction stays open across the model call
    outcome = await parse_phrase(
        body.text,
        now=now,
        tz=tz,
        created_via=body.created_via,
        rules_first=rules_first,
        ai_allowed=ai_allowed,
        router=ctx.ai_router,
        user_id=user.id,
    )
    drafts = drafts_dicts(outcome.drafts, now, tz)
    return ReminderParseResultOut.model_validate(
        {
            "status": outcome.status,
            "source": outcome.source,
            "reason": outcome.reason,
            "message": outcome.message,
            "draft": drafts[0] if drafts and outcome.status != "ambiguous" else None,
            "options": drafts if outcome.status == "ambiguous" else [],
            "parser": "rules_first" if rules_first else "llm",
        }
    )


@router.post("/test", response_model=ReminderWithFiresOut, status_code=201)
async def test_alarm(user: GatedUser, db: Db) -> ReminderWithFiresOut:
    r, fires = await service.create_test(db, user.id, user.device_id, _now())
    return await _with_fires(db, r, fires)


@router.post("/events", response_model=ReminderEventsOut)
async def events(body: ReminderEventsIn, user: GatedUser, db: Db) -> ReminderEventsOut:
    evs = [
        service.EventIn(
            client_id=e.client_id,
            event=e.event,
            at=e.at,
            fire_id=e.fire_id,
            fire_key=e.fire_key,
            meta=e.meta,
        )
        for e in body.events
    ]
    results, fires = await service.apply_events(db, user.id, user.device_id, evs, _now())
    return ReminderEventsOut(
        results=[ReminderEventResult.model_validate(r) for r in results],
        fires=[FireOut.model_validate(f) for f in await service.fires_dicts(db, fires)],
    )


@router.post("/active", response_model=ReminderActiveOut)
async def active(user: GatedUser, db: Db) -> ReminderActiveOut:
    """The last active phone (R-13): call on app start / foreground."""
    if user.device_id is None:
        raise ApiError(409, "device_unknown")
    device = await db.get(Device, user.device_id)
    if device is None or device.revoked_at is not None:
        raise ApiError(409, "device_unknown")
    n = await service.mark_active(db, user.id, device.id, datetime.now(UTC))  # full precision
    return ReminderActiveOut(device_id=device.public_id, retargeted=n)


@router.get("/fires", response_model=FiresWindowOut)
async def fires_window(
    user: GatedUser,
    db: Db,
    from_: Annotated[datetime | None, Query(alias="from")] = None,
    to: Annotated[datetime | None, Query()] = None,
) -> FiresWindowOut:
    now = _now()
    start = from_ or now - timedelta(hours=1)
    end = to or now + service.HORIZON
    if start.tzinfo is None or end.tzinfo is None or not start < end or end - start > MAX_WINDOW:
        raise ApiError(422, "validation_error")
    fires, rems = await service.window(db, user.id, start, end)
    device = await db.get(Device, user.device_id) if user.device_id else None
    return FiresWindowOut(
        device_id=device.public_id if device else None,
        fires=[FireOut.model_validate(f) for f in await service.fires_dicts(db, fires)],
        reminders=[ReminderOut.model_validate(d) for d in await service.reminders_dicts(db, rems)],
    )


# --- CRUD ---


@router.post("", response_model=ReminderWithFiresOut, status_code=201)
async def create(
    body: ReminderIn, user: GatedUser, db: Db, response: Response
) -> ReminderWithFiresOut:
    tz = _tz(body.tz) if body.tz else await _user_tz(db, user.id)
    item_pk = None
    if body.item_id is not None:
        item_pk = await db.scalar(
            select(Item.id).where(Item.user_id == user.id, Item.public_id == body.item_id)
        )
        if item_pk is None:
            raise ApiError(404, "not_found")
    data = service.ReminderInput(
        title=body.title,
        due_at=_due(body.due_at, body.local, tz),
        tz=tz,
        body=body.body,
        rrule=body.rrule,
        offsets=body.offsets,
        level=body.level,
        created_via=body.created_via,
        parse_source=body.parse_source,
        sensitivity=body.sensitivity,
        item_id=item_pk,
        client_id=body.client_id,
    )
    try:
        r, fires, created = await service.create(db, user.id, data, _now())
    except service.ReminderError as exc:
        raise _error(exc) from exc
    if not created:
        response.status_code = 200
    return await _with_fires(db, r, fires)


@router.get("", response_model=ReminderListOut)
async def list_reminders(user: GatedUser, db: Db, include_done: bool = False) -> ReminderListOut:
    q = select(Reminder).where(
        Reminder.user_id == user.id,
        Reminder.deleted_at.is_(None),
        Reminder.kind == AppReminderKind.NORMAL,
    )
    if not include_done:
        q = q.where(Reminder.status.not_in((AppReminderStatus.DONE, AppReminderStatus.CANCELLED)))
    rows = list(await db.scalars(q.order_by(Reminder.due_at.desc()).limit(500)))
    return ReminderListOut(
        reminders=[ReminderOut.model_validate(d) for d in await service.reminders_dicts(db, rows)]
    )


@router.get("/{reminder_id}", response_model=ReminderWithFiresOut)
async def get_one(reminder_id: uuid.UUID, user: GatedUser, db: Db) -> ReminderWithFiresOut:
    r = await service.get(db, user.id, reminder_id)
    if r is None:
        raise ApiError(404, "not_found")
    return await _with_fires(db, r, await service.upcoming_fires(db, r, _now()))


@router.patch("/{reminder_id}", response_model=ReminderWithFiresOut)
async def patch(
    reminder_id: uuid.UUID, body: ReminderPatchIn, user: GatedUser, db: Db
) -> ReminderWithFiresOut:
    sent = body.model_fields_set - {"version"}
    fields: dict[str, Any] = {k: getattr(body, k) for k in sent if k not in ("local", "due_at")}
    if "tz" in fields and fields["tz"] is None:
        fields.pop("tz")
    if ("title" in fields and fields["title"] is None) or (
        "level" in fields and fields["level"] is None
    ):
        raise ApiError(422, "validation_error")
    if "offsets" in fields and fields["offsets"] is None:
        fields["offsets"] = []
    if "due_at" in sent or "local" in sent:
        current = await service.get(db, user.id, reminder_id)
        if current is None:
            raise ApiError(404, "not_found")
        tz = fields.get("tz") or current.tz or await _user_tz(db, user.id)
        fields["due_at"] = _due(body.due_at, body.local if body.due_at is None else None, tz)
    try:
        out = await service.change(db, user.id, reminder_id, body.version, fields, _now())
    except service.VersionConflict as exc:
        raise ApiError(409, "conflict") from exc
    except service.ReminderError as exc:
        raise _error(exc) from exc
    if out is None:
        raise ApiError(404, "not_found")
    r, fires = out
    return await _with_fires(db, r, fires)


@router.delete("/{reminder_id}", status_code=204)
async def delete(reminder_id: uuid.UUID, user: GatedUser, db: Db) -> Response:
    if await service.delete(db, user.id, reminder_id, _now()) is None:
        raise ApiError(404, "not_found")
    return Response(status_code=204)


__all__ = ["router"]
