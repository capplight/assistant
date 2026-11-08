"""/v1/imports: Telegram Desktop export file → records (spec 4.9, 6.10). Contract:
docs/api/import.md.

Needs the base consents and `telegram_import` (spec 3.2: without it the import is not available).
The file comes through /v1/uploads; the work runs in `python -m assistant.imports`."""

import uuid
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from assistant.api.consent_gate import BASE_CONSENTS, require_consents
from assistant.api.deps import CurrentUser, Db
from assistant.api.errors import ApiError
from assistant.db.models_actions import Action
from assistant.db.models_dedup import Import, ImportStatus
from assistant.db.models_v2 import (
    Consent,
    ConsentKind,
    File,
    FileRole,
    FileState,
    Upload,
    UploadState,
)
from assistant.imports import enqueue_import

router = APIRouter(prefix="/imports", tags=["imports"])
ImportUser = Annotated[CurrentUser, Depends(require_consents(*BASE_CONSENTS,
                                                             ConsentKind.TELEGRAM_IMPORT))]
BaseUser = Annotated[CurrentUser, Depends(require_consents(*BASE_CONSENTS))]
MIMES = {"application/json", "application/zip", "application/x-zip-compressed",
         "application/octet-stream", "text/plain"}  # fmt: skip
OPEN = (ImportStatus.CREATED, ImportStatus.RUNNING)


class TelegramFileIn(BaseModel):
    client_id: uuid.UUID
    upload_id: uuid.UUID


async def import_out(db: Db, imp: Import) -> dict[str, Any]:
    action_id = await db.scalar(select(Action.public_id).where(Action.id == imp.action_id)) \
        if imp.action_id else None  # fmt: skip
    s = imp.summary or {}
    return {
        "id": str(imp.public_id), "client_id": str(imp.client_id) if imp.client_id else None,
        "source": imp.source, "status": imp.status, "error": imp.error,
        "total": imp.total, "processed": imp.processed, "created": imp.created_count,
        "skipped_dups": imp.skipped_dups,
        "seen_before": s.get("seen_before", (imp.cursor or {}).get("seen_before", 0)),
        "skipped_media": imp.skipped_media or {}, "failed": imp.failed,
        "summary_ru": s.get("text_ru"), "action_id": str(action_id) if action_id else None,
        "seq": imp.seq, "created_at": imp.created_at.isoformat(),
        "started_at": imp.started_at.isoformat() if imp.started_at else None,
        "finished_at": imp.finished_at.isoformat() if imp.finished_at else None,
    }  # fmt: skip


@router.post("/telegram/file", status_code=202)
async def telegram_file(body: TelegramFileIn, user: ImportUser, db: Db,
                        response: Response) -> dict[str, Any]:  # fmt: skip
    same = await db.scalar(select(Import).where(Import.user_id == user.id,
                                                Import.client_id == body.client_id))
    if same is not None:
        response.status_code = 200
        return {"import": await import_out(db, same), "created": False}
    upload = await db.scalar(select(Upload).where(Upload.user_id == user.id,
                                                  Upload.public_id == body.upload_id))
    if upload is None:
        raise ApiError(404, "upload_not_found")
    if upload.state != UploadState.COMPLETED or upload.file_id is None:
        raise ApiError(409, "upload_not_ready")
    file = await db.get(File, upload.file_id, with_for_update=True)
    if file is None or file.role != FileRole.ORIGINAL or file.state != FileState.ACTIVE:
        raise ApiError(409, "upload_not_ready")
    used = await db.scalar(select(Import.id).where(Import.file_id == file.id))
    if file.item_id is not None or used:
        raise ApiError(409, "upload_in_use")
    if file.mime.lower() not in MIMES:
        raise ApiError(422, "import_bad_file")
    if await db.scalar(select(Import.id).where(Import.user_id == user.id,
                                               Import.status.in_(OPEN)).limit(1)):
        raise ApiError(409, "import_running")
    consent = await db.scalar(select(Consent.id).where(
        Consent.user_id == user.id, Consent.kind == ConsentKind.TELEGRAM_IMPORT,
        Consent.revoked_at.is_(None)).order_by(Consent.granted_at.desc()).limit(1))  # fmt: skip
    imp = Import(user_id=user.id, client_id=body.client_id, source="telegram_export_file",
                 status=ImportStatus.CREATED, consent_id=consent, file_id=file.id)  # fmt: skip
    try:
        async with db.begin_nested():
            db.add(imp)
            await db.flush()
    except IntegrityError:
        again = await db.scalar(select(Import).where(Import.user_id == user.id,
                                                     Import.client_id == body.client_id))
        if again is None:
            raise
        response.status_code = 200
        return {"import": await import_out(db, again), "created": False}
    await enqueue_import(db, imp)
    await db.flush()
    return {"import": await import_out(db, imp), "created": True}


@router.get("")
async def list_imports(user: BaseUser, db: Db,
                       limit: Annotated[int, Query(ge=1, le=50)] = 10,
                       ) -> dict[str, Any]:  # fmt: skip
    rows = list(await db.scalars(select(Import).where(Import.user_id == user.id)
                                 .order_by(Import.id.desc()).limit(limit)))
    return {"imports": [await import_out(db, i) for i in rows]}


async def _own(db: Db, user: CurrentUser, import_id: uuid.UUID, lock: bool = False) -> Import:
    q = select(Import).where(Import.user_id == user.id, Import.public_id == import_id)
    imp = await db.scalar(q.with_for_update() if lock else q)
    if imp is None:
        raise ApiError(404, "not_found")
    return imp


@router.get("/{import_id}")
async def get_import(import_id: uuid.UUID, user: BaseUser, db: Db) -> dict[str, Any]:
    return {"import": await import_out(db, await _own(db, user, import_id))}


@router.post("/{import_id}/cancel")
async def cancel(import_id: uuid.UUID, user: BaseUser, db: Db) -> dict[str, Any]:
    """Stops after the batch in progress; what was brought stays (and its «Отменить» is in the
    import's action)."""
    imp = await _own(db, user, import_id, lock=True)
    if imp.status in OPEN:
        imp.status, imp.finished_at = ImportStatus.CANCELLED, datetime.now(UTC)
        await db.flush()
    return {"import": await import_out(db, imp)}
