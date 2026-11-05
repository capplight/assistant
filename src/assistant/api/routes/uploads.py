"""/v1/uploads: presigned PUT (<= 50 MB, sha256 declared up front) and completion -> File.

Flow: POST /v1/uploads -> PUT bytes to `put.url` with `put.headers`
-> POST /v1/uploads/{id}/complete.
Needs pd_processing + terms (files are personal data; no AI involved here).
"""

import uuid
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.api.consent_gate import require_base_consent
from assistant.api.deps import ApiContext, Ctx, CurrentUser, Db
from assistant.api.errors import ApiError
from assistant.api.schemas import PresignedPutOut, UploadIn, UploadOut
from assistant.api.storage import object_key
from assistant.db.ids import uuid7
from assistant.db.models_v2 import File, Upload, UploadState

router = APIRouter(prefix="/uploads", tags=["uploads"])
GatedUser = Annotated[CurrentUser, Depends(require_base_consent)]


async def _file_public_id(db: AsyncSession, upload: Upload) -> uuid.UUID | None:
    if upload.file_id is None:
        return None
    return await db.scalar(select(File.public_id).where(File.id == upload.file_id))


async def _out(db: AsyncSession, ctx: ApiContext, upload: Upload) -> UploadOut:
    put = None
    if upload.state == UploadState.PENDING:
        signed = await ctx.storage.presign_put(
            upload.storage_key,
            mime=upload.mime,
            size=upload.bytes,
            sha256=upload.sha256,
            ttl_seconds=ctx.settings.upload_url_ttl_seconds,
        )
        put = PresignedPutOut(
            url=signed.url,
            method=signed.method,
            headers=signed.headers,
            expires_at=datetime.fromtimestamp(signed.expires_at, UTC),
        )
        upload.expires_at = put.expires_at
    return UploadOut(id=upload.public_id, state=upload.state, put=put,
                     file_id=await _file_public_id(db, upload))  # fmt: skip


@router.post("", response_model=UploadOut)
async def create_upload(body: UploadIn, user: GatedUser, ctx: Ctx, db: Db) -> UploadOut:
    if body.bytes > ctx.settings.upload_max_bytes:
        raise ApiError(413, "upload_too_large")
    if body.client_id is not None:
        existing = await db.scalar(
            select(Upload).where(Upload.user_id == user.id, Upload.client_id == body.client_id)
        )
        if existing is not None:  # retry: same upload, fresh URL while still pending
            return await _out(db, ctx, existing)
    public_id = uuid7()
    upload = Upload(public_id=public_id, user_id=user.id, client_id=body.client_id,
                    role=body.role, mime=body.mime, bytes=body.bytes, sha256=body.sha256,
                    storage_key=object_key(str(user.public_id), str(public_id)),
                    expires_at=datetime.now(UTC))  # fmt: skip
    db.add(upload)
    await db.flush()
    return await _out(db, ctx, upload)


@router.post("/{upload_id}/complete", response_model=UploadOut)
async def complete_upload(upload_id: uuid.UUID, user: GatedUser, ctx: Ctx, db: Db) -> UploadOut:
    upload = await db.scalar(
        select(Upload).where(Upload.user_id == user.id, Upload.public_id == upload_id)
    )
    if upload is None:
        raise ApiError(404, "upload_not_found")
    if upload.state == UploadState.COMPLETED:
        return await _out(db, ctx, upload)
    if upload.state != UploadState.PENDING:
        raise ApiError(409, "upload_expired")
    await db.commit()  # no transaction open across the storage call

    info = await ctx.storage.head(upload.storage_key)
    if info is None:
        raise ApiError(409, "upload_not_found")
    if info.bytes != upload.bytes or (info.sha256 is not None and info.sha256 != upload.sha256):
        upload.state = UploadState.FAILED
        upload.error = f"size {info.bytes} != {upload.bytes} or sha256 mismatch"
        await db.commit()
        await ctx.storage.delete(upload.storage_key)
        raise ApiError(409, "upload_mismatch")

    file = File(user_id=user.id, role=upload.role, storage_key=upload.storage_key,
                mime=upload.mime, bytes=upload.bytes, sha256=upload.sha256)  # fmt: skip
    db.add(file)
    await db.flush()
    upload.state = UploadState.COMPLETED
    upload.completed_at = datetime.now(UTC)
    upload.file_id = file.id
    return UploadOut(id=upload.public_id, state=upload.state, put=None, file_id=file.public_id)
