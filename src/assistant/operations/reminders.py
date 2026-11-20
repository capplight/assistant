"""Operations of reminders (Ф-95): create, change (time, title, level…), delete (cancel), each
one action with «Отменить». `api/routes/reminders.py` and the assistant line call these."""

import uuid
from datetime import UTC, datetime
from typing import Any, Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.actions import engine, record
from assistant.db.models import Item, Reminder
from assistant.db.models_actions import Action, ActionKind, Initiator
from assistant.db.models_reminders import AppReminderKind
from assistant.operations.registry import Operation, OpError, OpResult, register

TOUCHED = ("reminders", "calendar", "today")


def lower(text: str) -> str:
    return text if len(text) > 1 and text[1].isupper() else text[:1].lower() + text[1:]


def saved(r: Reminder, now: datetime | None = None) -> str:
    """«Напомню завтра в 7:00» on the reminder's clock."""
    from assistant.reminders.texts import saved_text

    zone = ZoneInfo(r.tz or "Asia/Almaty")
    local = r.due_at.astimezone(zone).replace(tzinfo=None)
    return saved_text(local, r.rrule, (now or datetime.now(UTC)).astimezone(zone).date())


async def write_action(session: AsyncSession, user_id: int, r: Reminder, kind: str,
                       sentence: str, inverse: list[dict[str, Any]], *, by: str, now: datetime,
                       name: str, client_id: uuid.UUID | None = None,
                       message_pk: int | None = None) -> Action | None:  # fmt: skip
    """«Что я сделал» + «Отменить» for a change of a reminder (R-33, week 9)."""
    if not inverse or r.kind != AppReminderKind.NORMAL:
        return None
    action = await record(
        session, user_id=user_id, kind=kind, initiated_by=by,
        summary={"ru": sentence, "kk": None},
        changes=[{"item_id": None, "reminder_id": str(r.public_id), "title": r.title or "",
                  "kind": "reminder", "page_id": None, "text": sentence}],
        inverse=inverse, now=now, client_id=client_id, message_id=message_pk,
        extra={"op": name, "touched": list(TOUCHED)})  # fmt: skip
    await session.flush()
    return action


class ReminderRef(BaseModel):
    model_config = ConfigDict(extra="forbid")
    reminder_id: uuid.UUID


async def _delete(session: AsyncSession, user_id: int, args: ReminderRef, *, by: str,
                  now: datetime, client_id: uuid.UUID | None = None,
                  message_pk: int | None = None, **_: Any) -> OpResult:  # fmt: skip
    from assistant.reminders import service

    current = await service.get(session, user_id, args.reminder_id)
    if current is None:
        raise OpError("not_found", 404)
    before = engine.reminder_state(current)
    fires = await service.delete(session, user_id, args.reminder_id, now)
    sentence = (f"Удалил напоминание «{current.title or ''}»" if by == Initiator.USER
                else f"Больше не напомню: {lower(current.title or '')}")  # fmt: skip
    out = OpResult(sentence=sentence, touched=TOUCHED,
                   data={"reminder": current, "fires": fires or []})  # fmt: skip
    if before["deleted"]:
        return out
    out.inverse = [{"op": "restore_reminder", "id": str(current.public_id), "state": before,
                    "expect": current.version}]  # fmt: skip
    out.action = await write_action(session, user_id, current, ActionKind.EDIT_REMINDER,
                                    sentence, out.inverse, by=by, now=now,
                                    name="reminders.delete", client_id=client_id,
                                    message_pk=message_pk)  # fmt: skip
    out.actions = [out.action] if out.action else []
    return out


class ReminderCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str
    due_at: datetime
    tz: str = "Asia/Almaty"
    body: str | None = None
    rrule: str | None = None
    offsets: list[int] = Field(default_factory=list)
    level: str = "notification"
    created_via: str | None = None
    parse_source: str | None = None
    sensitivity: str | None = None
    item_id: uuid.UUID | None = None  # the record it is about
    duration_min: int | None = None


async def _create(session: AsyncSession, user_id: int, args: ReminderCreate, *, by: str,
                  now: datetime, client_id: uuid.UUID | None = None,
                  message_pk: int | None = None, **_: Any) -> OpResult:  # fmt: skip
    """`data`: reminder, fires, created (False: this `client_id` made it already)."""
    from assistant.reminders import service

    item_pk = None
    if args.item_id is not None:
        item_pk = await session.scalar(select(Item.id).where(Item.user_id == user_id,
                                                             Item.public_id == args.item_id))
        if item_pk is None:
            raise OpError("not_found", 404)
    data = service.ReminderInput(
        title=args.title, due_at=args.due_at, tz=args.tz, body=args.body, rrule=args.rrule,
        offsets=args.offsets, level=args.level, created_via=args.created_via,
        parse_source=args.parse_source, sensitivity=args.sensitivity, item_id=item_pk,
        client_id=client_id, duration_min=args.duration_min)  # fmt: skip
    try:
        r, fires, created = await service.create(session, user_id, data, now)
    except service.ReminderError as exc:
        raise OpError(exc.code) from exc
    out = OpResult(touched=TOUCHED, data={"reminder": r, "fires": fires, "created": created})
    if not created:
        return out
    out.sentence = f"{saved(r, now)}: {lower(r.title or '')}"
    out.inverse = [{"op": "cancel_reminder", "id": str(r.public_id), "expect": r.version}]
    out.action = await write_action(session, user_id, r, ActionKind.CREATE_REMINDER,
                                    out.sentence, out.inverse, by=by, now=now,
                                    name="reminders.create", client_id=client_id,
                                    message_pk=message_pk)  # fmt: skip
    out.actions = [out.action] if out.action else []
    return out


class ReminderUpdate(BaseModel):
    """Only the fields given change (`model_fields_set`). `version`: the one the phone saw
    (409 `conflict` when it moved on); None = the current one (the line, just read)."""

    model_config = ConfigDict(extra="forbid")
    reminder_id: uuid.UUID
    version: int | None = None
    title: str | None = None
    body: str | None = None
    due_at: datetime | None = None
    tz: str | None = None
    rrule: str | None = None
    offsets: list[int] | None = None
    level: str | None = None
    sensitivity: Literal["health"] | None = None
    duration_min: int | None = None


async def _update(session: AsyncSession, user_id: int, args: ReminderUpdate, *, by: str,
                  now: datetime, client_id: uuid.UUID | None = None,
                  message_pk: int | None = None, **_: Any) -> OpResult:  # fmt: skip
    from assistant.reminders import service

    sent = args.model_fields_set - {"reminder_id", "version"}
    fields: dict[str, Any] = {k: getattr(args, k) for k in sent}
    if "tz" in fields and fields["tz"] is None:
        fields.pop("tz")
    if ("title" in fields and fields["title"] is None) or (
            "level" in fields and fields["level"] is None) or (
            "due_at" in fields and fields["due_at"] is None):  # fmt: skip
        raise OpError("validation_error")
    if "offsets" in fields and fields["offsets"] is None:
        fields["offsets"] = []
    current = await service.get(session, user_id, args.reminder_id)
    if current is None:
        raise OpError("not_found", 404)
    before = engine.reminder_state(current)
    try:
        res = await service.change(session, user_id, args.reminder_id,
                                   current.version if args.version is None else args.version,
                                   fields, now)  # fmt: skip
    except service.VersionConflict as exc:
        raise OpError("conflict", 409) from exc
    except service.ReminderError as exc:
        raise OpError(exc.code) from exc
    if res is None:
        raise OpError("not_found", 404)
    r, fires = res
    out = OpResult(touched=TOUCHED, data={"reminder": r, "fires": fires})
    if engine.reminder_state(r) == before:
        return out
    moved = before["due_at"] != r.due_at.isoformat() or before["rrule"] != r.rrule
    title = r.title or ""
    if by == Initiator.USER:
        out.sentence = (f"Вы перенесли напоминание «{title}»: {lower(saved(r, now))}" if moved
                        else f"Изменил напоминание «{title}»")  # fmt: skip
    else:
        out.sentence = (f"Перенёс напоминание «{title}»: {lower(saved(r, now))}" if moved
                        else f"Изменил напоминание «{title}»")  # fmt: skip
    out.inverse = [{"op": "restore_reminder", "id": str(r.public_id), "state": before,
                    "expect": r.version}]  # fmt: skip
    out.action = await write_action(session, user_id, r, ActionKind.EDIT_REMINDER, out.sentence,
                                    out.inverse, by=by, now=now, name="reminders.update",
                                    client_id=client_id, message_pk=message_pk)  # fmt: skip
    out.actions = [out.action] if out.action else []
    return out


register(Operation("reminders.create", "reminders", "safe", ReminderCreate, execute=_create,
                   description="a reminder at a moment (with a repeat), set at once"))
register(Operation("reminders.update", "reminders", "safe", ReminderUpdate, execute=_update,
                   description="a reminder moved to another time, renamed or its level changed"))
register(Operation("reminders.delete", "reminders", "safe", ReminderRef, execute=_delete,
                   description="cancel a reminder (its alarms stop), with «Отменить»"))
