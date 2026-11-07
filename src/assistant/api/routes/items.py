"""/v1/items: create (idempotent by client_id), read, edit, trash (30 days), restore, unmerge.

Needs pd_processing + terms. Voice without ai_cross_border is accepted and stored as
`needs_consent` ("разберу после разрешения"); it is queued once the consent is granted.
The exact-duplicate check runs here, so the response already says `auto_merged` (spec 4.3).
"""

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.api.consent_gate import require_base_consent
from assistant.api.deps import CurrentUser, Db
from assistant.api.errors import ApiError
from assistant.api.schemas import (
    DuplicateOut,
    ItemCreateIn,
    ItemCreateOut,
    ItemFileOut,
    ItemListOut,
    ItemOut,
    ItemPatchIn,
    ReviewFieldOut,
)
from assistant.db.models import Item
from assistant.db.models_v2 import (
    File,
    FileRole,
    FileState,
    HiddenReason,
    KeepReason,
    RecordKind,
    RecordSource,
    RecordStatus,
    Upload,
    UploadState,
)
from assistant.records import (
    CROSS_BORDER_KINDS,
    ai_consent_covers,
    content_hash,
    detect_lang,
    enqueue_ingest,
    find_canonical,
    merge_into,
    normalize_text,
    original_file,
    restore_item,
    trash_file,
    trash_item,
    unmerge,
)

router = APIRouter(prefix="/items", tags=["items"])
GatedUser = Annotated[CurrentUser, Depends(require_base_consent)]

FILE_KINDS = {RecordKind.VOICE, RecordKind.IMAGE, RecordKind.SCREENSHOT, RecordKind.PDF,
              RecordKind.DOCX, RecordKind.XLSX, RecordKind.FILE_OTHER}  # fmt: skip
MIME_KINDS = {
    "application/pdf": RecordKind.PDF,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": RecordKind.DOCX,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": RecordKind.XLSX,
}
# Legacy bot values -> app values (0004 kept the bot's rows as they were).
LEGACY_KIND = {"text": "note", "photo": "image", "video": "file_other", "document": "file_other"}
LEGACY_STATUS = {"done": "ready", "needs_input": "needs_review"}
APP_SOURCES = {str(s) for s in RecordSource}


def kind_from_mime(mime: str) -> RecordKind:
    mime = mime.lower()
    if mime.startswith("image/"):
        return RecordKind.IMAGE
    if mime.startswith("audio/"):
        return RecordKind.VOICE
    return MIME_KINDS.get(mime, RecordKind.FILE_OTHER)


def _review(fields: dict) -> dict[str, ReviewFieldOut]:
    out = {}
    for key, v in (fields or {}).items():
        if isinstance(v, dict):
            state = "verified" if v.get("state") == "verified" else "unverified"
            value = v.get("value")
            out[key] = ReviewFieldOut(
                kind=str(v.get("kind", key)),
                value=None if value is None else str(value),
                state=state,
            )
    return out


def _file_out(f: File) -> ItemFileOut:
    return ItemFileOut(
        id=f.public_id, role=f.role, mime=f.mime, bytes=f.bytes, sha256=f.sha256,
        state=f.state, keep_reason=f.keep_reason, trash_until=f.trash_until,
    )  # fmt: skip


def _error_code(item: Item) -> str | None:
    if item.error is None:
        return None
    # App records store short codes; legacy bot rows hold (redacted) exception text.
    return item.error if item.telegram_chat_id is None else "legacy_failed"


def item_out(item: Item, files: list[File], canonical_public_id: uuid.UUID | None) -> ItemOut:
    kind, source, status = str(item.kind), str(item.source), str(item.status)
    return ItemOut(
        id=item.public_id, client_id=item.client_id,
        kind=LEGACY_KIND.get(kind, kind),
        source=source if source in APP_SOURCES else RecordSource.BOT_FORWARD,
        status=LEGACY_STATUS.get(status, status),
        title=item.title, text=item.text if item.text is not None else item.raw_text,
        text_lang=item.text_lang, summary=item.summary,
        review_fields=_review(item.review_fields), merged_fragments=item.merged_fragments or [],
        source_meta=item.source_meta or {}, confidence=item.confidence,
        ai_generated=item.ai_generated, content_hash=item.content_hash,
        original_sha256=item.original_sha256, canonical_id=canonical_public_id,
        hidden_reason=item.hidden_reason, error=_error_code(item),
        files=[_file_out(f) for f in files], seq=item.seq, occurred_at=item.occurred_at,
        created_at=item.created_at, updated_at=item.updated_at, deleted_at=item.deleted_at,
        purge_after=item.purge_after,
    )  # fmt: skip


async def items_out(db: AsyncSession, items: list[Item]) -> list[ItemOut]:
    """Serialize with their files and canonical public ids in two queries."""
    if not items:
        return []
    ids = [i.id for i in items]
    files: dict[int, list[File]] = {}
    for f in await db.scalars(select(File).where(File.item_id.in_(ids)).order_by(File.id)):
        files.setdefault(f.item_id or 0, []).append(f)
    canon_ids = {i.canonical_item_id for i in items if i.canonical_item_id is not None}
    canon: dict[int, uuid.UUID] = {}
    if canon_ids:
        rows = await db.execute(select(Item.id, Item.public_id).where(Item.id.in_(canon_ids)))
        canon = {row.id: row.public_id for row in rows}
    return [item_out(i, files.get(i.id, []), canon.get(i.canonical_item_id or 0)) for i in items]


async def one_out(db: AsyncSession, item: Item) -> ItemOut:
    return (await items_out(db, [item]))[0]


async def _get(db: AsyncSession, user: CurrentUser, item_id: uuid.UUID,
               *, lock: bool = False) -> Item:  # fmt: skip
    stmt = select(Item).where(Item.user_id == user.id, Item.public_id == item_id)
    if lock:
        stmt = stmt.with_for_update()
    item = await db.scalar(stmt)
    if item is None:
        raise ApiError(404, "not_found")
    return item


async def _duplicate(db: AsyncSession, item: Item) -> DuplicateOut | None:
    if item.hidden_reason != HiddenReason.DUPLICATE_MERGED or item.canonical_item_id is None:
        return None
    canonical = await db.get(Item, item.canonical_item_id)
    if canonical is None:
        return None
    return DuplicateOut(canonical_id=canonical.public_id,
                        canonical_created_at=canonical.occurred_at or canonical.created_at,
                        undo_path=f"/v1/items/{item.public_id}/unmerge")  # fmt: skip


async def _create_out(db: AsyncSession, item: Item, created: bool) -> ItemCreateOut:
    dup = await _duplicate(db, item)
    return ItemCreateOut(item=await one_out(db, item), created=created,
                         auto_merged=dup is not None, duplicate=dup)  # fmt: skip


def _resolve_kind(body: ItemCreateIn, upload_mime: str | None) -> RecordKind:
    given = RecordKind(body.kind) if body.kind else None
    if upload_mime is not None:
        if given is None:
            return kind_from_mime(upload_mime)
        if given not in FILE_KINDS:
            raise ApiError(422, "item_kind_mismatch")
        return given
    if body.url is not None:
        if given not in (None, RecordKind.LINK):
            raise ApiError(422, "item_kind_mismatch")
        return RecordKind.LINK
    if given not in (None, RecordKind.NOTE, RecordKind.LINK):
        raise ApiError(422, "item_kind_mismatch")
    return given or RecordKind.NOTE


async def _completed_file(db: AsyncSession, user: CurrentUser, upload_id: uuid.UUID) -> File:
    upload = await db.scalar(
        select(Upload).where(Upload.user_id == user.id, Upload.public_id == upload_id)
    )
    if upload is None:
        raise ApiError(404, "upload_not_found")
    if upload.state != UploadState.COMPLETED or upload.file_id is None:
        raise ApiError(409, "upload_not_ready")
    file = await db.get(File, upload.file_id, with_for_update=True)
    if file is None or file.role != FileRole.ORIGINAL:
        raise ApiError(409, "upload_not_ready")
    if file.item_id is not None:
        raise ApiError(409, "upload_in_use")
    return file


@router.post("", response_model=ItemCreateOut, status_code=201)
async def create_item(body: ItemCreateIn, user: GatedUser, db: Db,
                      response: Response) -> ItemCreateOut:  # fmt: skip
    existing = await db.scalar(
        select(Item).where(Item.user_id == user.id, Item.client_id == body.client_id)
    )
    if existing is not None:
        response.status_code = 200
        return await _create_out(db, existing, created=False)

    has_text = body.text is not None and body.text.strip() != ""
    if body.upload_id is not None and body.url is not None:
        raise ApiError(422, "validation_error")  # one source per record
    if body.upload_id is None and body.url is None and not has_text:
        raise ApiError(422, "validation_error")  # nothing to store
    file = await _completed_file(db, user, body.upload_id) if body.upload_id else None
    kind = _resolve_kind(body, file.mime if file else None)

    meta: dict = {}
    text: str | None = None
    if file is not None:
        if has_text:
            meta["caption"] = normalize_text(body.text or "")
    else:
        text = normalize_text(body.text or "") if has_text else None
        if body.url is not None:
            meta["url"] = body.url
            text = f"{text}\n\n{body.url}" if text else body.url

    item = Item(user_id=user.id, client_id=body.client_id, kind=kind, source=body.source,
                status=RecordStatus.PENDING, title=body.title, text=text,
                text_lang=detect_lang(text), content_hash=content_hash(text),
                original_sha256=file.sha256 if file else None, source_meta=meta,
                occurred_at=body.occurred_at)  # fmt: skip
    try:
        async with db.begin_nested():
            db.add(item)
            await db.flush()
    except IntegrityError:  # the same client_id raced in from a parallel retry
        again = await db.scalar(
            select(Item).where(Item.user_id == user.id, Item.client_id == body.client_id)
        )
        if again is None:
            raise
        response.status_code = 200
        return await _create_out(db, again, created=False)
    if item.occurred_at is None:
        item.occurred_at = item.created_at

    if file is not None:
        file.item_id = item.id
    canonical = await find_canonical(db, user.id, content_hash=item.content_hash,
                                     original_sha256=item.original_sha256,
                                     exclude_id=item.id)  # fmt: skip
    if canonical is not None:
        merge_into(item, canonical)
        item.status = RecordStatus.READY  # hidden; not extracted unless unmerged
        if file is not None:
            trash_file(file)
    elif kind in CROSS_BORDER_KINDS and not await ai_consent_covers(db, user.id, None):
        item.status = RecordStatus.NEEDS_CONSENT
    else:
        await enqueue_ingest(db, item)
    await db.flush()
    return await _create_out(db, item, created=True)


@router.get("", response_model=ItemListOut)
async def list_items(
    user: GatedUser, db: Db,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    cursor: uuid.UUID | None = None,
) -> ItemListOut:  # fmt: skip
    """Visible records, newest first. `next_cursor` = id of the last one on the page."""
    stmt = select(Item).where(Item.user_id == user.id, Item.deleted_at.is_(None),
                              Item.hidden_reason.is_(None))  # fmt: skip
    return await _page(db, user, stmt, limit, cursor)


@router.get("/trash", response_model=ItemListOut)
async def list_trash(
    user: GatedUser, db: Db,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    cursor: uuid.UUID | None = None,
) -> ItemListOut:  # fmt: skip
    """Trash ("Удалённые записи"): trashed records until purge_after (30 days)."""
    stmt = select(Item).where(Item.user_id == user.id, Item.deleted_at.is_not(None))
    return await _page(db, user, stmt, limit, cursor)


async def _page(db: AsyncSession, user: CurrentUser, stmt, limit: int,  # type: ignore[no-untyped-def]
                cursor: uuid.UUID | None) -> ItemListOut:  # fmt: skip
    if cursor is not None:
        after = await db.scalar(
            select(Item.id).where(Item.user_id == user.id, Item.public_id == cursor)
        )
        if after is None:
            raise ApiError(404, "not_found")
        stmt = stmt.where(Item.id < after)
    rows = list(await db.scalars(stmt.order_by(Item.id.desc()).limit(limit + 1)))
    page = rows[:limit]
    next_cursor = str(page[-1].public_id) if len(rows) > limit else None
    return ItemListOut(items=await items_out(db, page), next_cursor=next_cursor)


@router.get("/{item_id}", response_model=ItemOut)
async def get_item(item_id: uuid.UUID, user: GatedUser, db: Db) -> ItemOut:
    return await one_out(db, await _get(db, user, item_id))


@router.patch("/{item_id}", response_model=ItemOut)
async def patch_item(item_id: uuid.UUID, body: ItemPatchIn, user: GatedUser, db: Db) -> ItemOut:
    item = await _get(db, user, item_id, lock=True)
    if body.base_seq is not None and body.base_seq != item.seq:
        raise ApiError(409, "conflict", details={"seq": item.seq})
    if item.deleted_at is not None:
        raise ApiError(409, "item_deleted")
    if "title" in body.model_fields_set:
        item.title = body.title.strip() if body.title and body.title.strip() else None
    if "text" in body.model_fields_set and body.text is not None:
        text = normalize_text(body.text) or None
        item.text = text
        item.text_lang = detect_lang(text)
        item.content_hash = content_hash(text)
    if body.verify:
        fields = {k: dict(v) for k, v in (item.review_fields or {}).items()}
        for key in body.verify:
            if key in fields:
                fields[key]["state"] = "verified"
        item.review_fields = fields
        if all(v.get("state") == "verified" for v in fields.values()):
            if item.status == RecordStatus.NEEDS_REVIEW:
                item.status = RecordStatus.READY
            file = await original_file(db, item.id, lock=True)
            if file is not None and file.keep_reason == KeepReason.LOW_CONFIDENCE:
                trash_file(file)  # the confirmed text now replaces the original (rule 8)
    await db.flush()
    return await one_out(db, item)


@router.delete("/{item_id}", response_model=ItemOut)
async def delete_item(item_id: uuid.UUID, user: GatedUser, db: Db) -> ItemOut:
    """Soft delete: in "Удалённые записи" for 30 days (purge_after), then gone for good."""
    item = await _get(db, user, item_id, lock=True)
    trash_item(item)
    await db.flush()
    return await one_out(db, item)


@router.post("/{item_id}/restore", response_model=ItemOut)
async def restore(item_id: uuid.UUID, user: GatedUser, db: Db) -> ItemOut:
    item = await _get(db, user, item_id, lock=True)
    restore_item(item)
    await db.flush()
    return await one_out(db, item)


@router.post("/{item_id}/unmerge", response_model=ItemOut)
async def unmerge_item(item_id: uuid.UUID, user: GatedUser, db: Db) -> ItemOut:
    """Undo ("Отменить") an automatic exact-duplicate merge: the record is visible again."""
    item = await _get(db, user, item_id, lock=True)
    if await unmerge(db, item) is None and item.hidden_reason is not None:
        raise ApiError(409, "conflict")
    file = await original_file(db, item.id, lock=True)
    if file is not None and file.state == FileState.TRASH:
        file.state, file.trash_until = FileState.ACTIVE, None
    if item.text is None and file is not None:
        item.status = RecordStatus.PENDING
        if str(item.kind) in CROSS_BORDER_KINDS and not await ai_consent_covers(db, user.id, None):
            item.status = RecordStatus.NEEDS_CONSENT
        else:
            await enqueue_ingest(db, item, suffix=f":unmerge:{uuid.uuid4().hex[:12]}")
    await db.flush()
    return await one_out(db, item)
