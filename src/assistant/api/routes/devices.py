"""/v1/devices: register/update (upsert by client_id) and revoke. Needs pd_processing + terms."""

import uuid
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Response
from sqlalchemy import select, update

from assistant.api.consent_gate import require_base_consent
from assistant.api.deps import CurrentUser, Db
from assistant.api.errors import ApiError
from assistant.api.schemas import DeviceIn, DeviceOut
from assistant.db.models_v2 import AuthSession, Device

router = APIRouter(prefix="/devices", tags=["devices"])
GatedUser = Annotated[CurrentUser, Depends(require_base_consent)]


def _out(d: Device) -> DeviceOut:
    return DeviceOut(id=d.public_id, client_id=d.client_id, platform=d.platform,
                     app_version=d.app_version, push_provider=d.push_provider,
                     has_push_token=bool(d.push_token), capabilities=d.capabilities,
                     last_active_at=d.last_active_at)  # fmt: skip


@router.post("", response_model=DeviceOut)
async def upsert_device(body: DeviceIn, user: GatedUser, db: Db) -> DeviceOut:
    """Repeat POST with the same client_id updates the row (this is also the PATCH path).

    Binds the current session to the device (last-active-phone alarms, OTP limits).
    """
    now = datetime.now(UTC)
    device = await db.scalar(
        select(Device).where(Device.user_id == user.id, Device.client_id == body.client_id)
    )
    if device is None:
        device = Device(user_id=user.id, client_id=body.client_id, platform=body.platform)
        db.add(device)
    fields = body.model_dump(exclude={"client_id"})
    for name, value in fields.items():
        setattr(device, name, value)
    device.last_active_at = now
    device.revoked_at = None
    await db.flush()
    if body.push_token:
        # A push token belongs to one install: drop it from any other row (re-login, new account).
        await db.execute(
            update(Device)
            .where(Device.push_token == body.push_token, Device.id != device.id)
            .values(push_token=None)
        )
    session = await db.get(AuthSession, user.session_id)
    if session is not None:
        session.device_id = device.id
    return _out(device)


@router.delete("/{device_id}", status_code=204)
async def revoke_device(device_id: uuid.UUID, user: GatedUser, db: Db) -> Response:
    device = await db.scalar(
        select(Device).where(Device.user_id == user.id, Device.public_id == device_id)
    )
    if device is None:
        raise ApiError(404, "not_found")
    device.revoked_at = datetime.now(UTC)
    device.push_token = None
    return Response(status_code=204)
