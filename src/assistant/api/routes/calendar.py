"""/v1/calendar (Ф-89, direction A; contract docs/api/calendar.md): the entries of a range of
local days — to-dos with a time or a day, repeats expanded with their own occurrences, timed
reminders that are not a to-do's alert, plan steps with a time. Read only: changes go through
`/v1/tasks` and `/v1/reminders` (actions with «Отменить»)."""

from datetime import UTC, date, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select

from assistant.api.consent_gate import require_base_consent
from assistant.api.deps import CurrentUser, Db
from assistant.api.errors import ApiError
from assistant.db.models import User
from assistant.tasks import calendar as cal

router = APIRouter(prefix="/calendar", tags=["calendar"])
GatedUser = Annotated[CurrentUser, Depends(require_base_consent)]


@router.get("")
async def calendar(user: GatedUser, db: Db,
                   from_: Annotated[str, Query(alias="from")],
                   to: str) -> dict[str, Any]:  # fmt: skip
    try:
        start, end = date.fromisoformat(from_), date.fromisoformat(to)
    except ValueError as exc:
        raise ApiError(400, "range_invalid") from exc
    tz = await db.scalar(select(User.tz).where(User.id == user.id)) or cal.DEFAULT_TZ
    try:
        win = cal.Window(tz, start, end)
    except cal.CalendarError as exc:
        raise ApiError(400, "range_invalid") from exc
    now = datetime.now(UTC).replace(microsecond=0)
    return {"tz": tz, "from": start.isoformat(), "to": end.isoformat(), "now": now,
            "entries": await cal.entries(db, user.id, win, now)}


__all__ = ["router"]
