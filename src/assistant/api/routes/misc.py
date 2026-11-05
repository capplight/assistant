"""Health, the AI consent-gate probe, and the dev-only local storage PUT target."""

from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy import text

from assistant.api.consent_gate import require_ai_consent
from assistant.api.deps import Ctx, CurrentUser, Db
from assistant.api.errors import ApiError
from assistant.api.schemas import AiPingOut
from assistant.api.storage import LocalObjectStorage, StorageTokenError

health = APIRouter(tags=["service"])
ai = APIRouter(prefix="/ai", tags=["ai"])
dev_storage = APIRouter(prefix="/dev/storage", include_in_schema=False)


@health.get("/healthz")
async def healthz() -> dict[str, bool]:
    return {"ok": True}


@health.get("/readyz")
async def readyz(db: Db) -> dict[str, bool]:
    await db.execute(text("SELECT 1"))
    return {"ok": True}


@ai.post("/ping", response_model=AiPingOut)
async def ai_ping(_: Annotated[CurrentUser, Depends(require_ai_consent)]) -> AiPingOut:
    """Proves the gate: 403 consent_required until pd_processing + terms + ai_cross_border.

    Every real AI/STT endpoint must depend on require_ai_consent the same way.
    """
    return AiPingOut(ok=True)


@dev_storage.put("/{token}", status_code=200)
async def dev_put(token: str, request: Request, ctx: Ctx) -> Response:
    """Stands in for the S3 presigned PUT when STORAGE_BACKEND=local."""
    storage = ctx.storage
    if not isinstance(storage, LocalObjectStorage):
        raise ApiError(404, "not_found")
    try:
        key, _mime, max_size = storage.read_token(token)
    except StorageTokenError as exc:
        raise ApiError(403, "upload_expired") from exc
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > max_size:
            raise ApiError(413, "upload_too_large")
    await storage.put(key, bytes(data))
    return Response(status_code=200)
