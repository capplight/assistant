"""POST /v1/events: product events from the phone, in batches (spec 3.8, R-40, F-35). Contract:
docs/api/events.md. Written only with the `analytics` consent; anything off the registry is
dropped, never stored."""

import uuid
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from assistant.analytics import EventIn, write_batch
from assistant.api.consent_gate import require_base_consent
from assistant.api.deps import CurrentUser, Db

router = APIRouter(prefix="/events", tags=["events"])
BaseUser = Annotated[CurrentUser, Depends(require_base_consent)]


class EventBody(BaseModel):
    client_id: uuid.UUID
    name: str = Field(min_length=1, max_length=64)
    props: dict[str, Any] = Field(default_factory=dict)
    client_ts: datetime | None = None


class EventsIn(BaseModel):
    events: list[EventBody] = Field(min_length=1, max_length=200)
    platform: str | None = None
    app_version: str | None = Field(default=None, max_length=40)


@router.post("", status_code=202)
async def post_events(body: EventsIn, user: BaseUser, db: Db) -> dict[str, Any]:
    accepted, dropped = await write_batch(
        db, user.id, user.device_id,
        [EventIn(e.client_id, e.name, e.props, e.client_ts) for e in body.events],
        platform=body.platform, app_version=body.app_version)  # fmt: skip
    return {"accepted": accepted, "dropped": dropped}
