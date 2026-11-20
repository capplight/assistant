"""Operations of reminders (phase 0): delete (cancel) a reminder with «Отменить»."""

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.actions import engine, record
from assistant.db.models_actions import ActionKind
from assistant.db.models_reminders import AppReminderKind
from assistant.operations.registry import Operation, OpError, OpResult, register


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
    sentence = f"Удалил напоминание «{current.title or ''}»"
    out = OpResult(sentence=sentence, touched=("reminders", "calendar"),
                   data={"reminder": current, "fires": fires or []})  # fmt: skip
    if before["deleted"] or current.kind != AppReminderKind.NORMAL:
        return out
    out.inverse = [{"op": "restore_reminder", "id": str(current.public_id), "state": before,
                    "expect": current.version}]  # fmt: skip
    out.action = await record(
        session, user_id=user_id, kind=ActionKind.EDIT_REMINDER, initiated_by=by,
        summary={"ru": sentence, "kk": None},
        changes=[{"item_id": None, "reminder_id": str(current.public_id),
                  "title": current.title or "", "kind": "reminder", "page_id": None,
                  "text": sentence}],
        inverse=out.inverse, now=now, client_id=client_id, message_id=message_pk,
        extra={"op": "reminders.delete", "touched": list(out.touched)})  # fmt: skip
    out.actions = [out.action]
    await session.flush()
    return out


register(Operation("reminders.delete", "reminders", "safe", ReminderRef, execute=_delete,
                   description="cancel a reminder (its alarms stop), with «Отменить»"))
