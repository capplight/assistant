"""/v1/search, /v1/pages/{id}/summary, /v1/items/{id}/original/pin. Contract: docs/api/search.md."""

import uuid
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select

from assistant.api.consent_gate import require_base_consent
from assistant.api.deps import Ctx, CurrentUser, Db
from assistant.api.errors import ApiError
from assistant.api.routes.items import _file_out
from assistant.api.schemas import (
    ItemFileOut,
    PageRefOut,
    PageSummaryOut,
    SearchHitOut,
    SearchOut,
)
from assistant.config import get_settings
from assistant.db.models import Item
from assistant.db.models_pages import Screen
from assistant.db.models_search import ScreenSummary
from assistant.db.models_v2 import FileState, KeepReason, PinnedBy, RecordKind
from assistant.memory import (
    Hit,
    OriginalFacts,
    OriginalFate,
    StorageFlags,
    embed_query,
    original_fate,
    search_records,
)
from assistant.records import original_file, trash_file

router = APIRouter(prefix="/search", tags=["search"])
pages_router = APIRouter(prefix="/pages", tags=["pages"])
items_router = APIRouter(prefix="/items", tags=["items"])
GatedUser = Annotated[CurrentUser, Depends(require_base_consent)]

# Legacy bot values -> app values, as in GET /items.
_LEGACY_KIND = {"text": "note", "photo": "image", "video": "file_other", "document": "file_other"}
_LEGACY_STATUS = {"done": "ready", "needs_input": "needs_review"}


def _aware(value: datetime | None) -> datetime | None:
    if value is None or value.tzinfo is not None:
        return value
    return value.replace(tzinfo=UTC)


def _hit_out(hit: Hit) -> SearchHitOut:
    return SearchHitOut(
        item_id=hit.item_id, kind=_LEGACY_KIND.get(hit.kind, hit.kind),
        status=_LEGACY_STATUS.get(hit.status, hit.status), title=hit.title, snippet=hit.snippet,
        highlights=hit.highlights, occurred_at=hit.occurred_at, created_at=hit.created_at,
        ai_label=(get_settings().label_ai_generated
                  if hit.ai_generated or hit.ai_fields else None),
        pages=[PageRefOut(id=p.id, title=p.title, icon=p.icon) for p in hit.pages],
        matched_by=hit.matched_by,
    )  # fmt: skip


async def _page_id(db: Db, user: CurrentUser, page_id: uuid.UUID) -> int:
    screen = await db.scalar(
        select(Screen.id).where(Screen.user_id == user.id, Screen.public_id == page_id,
                                Screen.deleted_at.is_(None))
    )  # fmt: skip
    if screen is None:
        raise ApiError(404, "not_found")
    return screen


@router.get("", response_model=SearchOut)
async def search(
    user: GatedUser, db: Db, ctx: Ctx,
    q: Annotated[str, Query(min_length=1, max_length=200)],
    page_id: uuid.UUID | None = None,
    kind: RecordKind | None = None,
    start: Annotated[datetime | None, Query(alias="from")] = None,
    end: Annotated[datetime | None, Query(alias="to")] = None,
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
) -> SearchOut:  # fmt: skip
    screen_id = await _page_id(db, user, page_id) if page_id is not None else None
    settings = ctx.settings
    await db.commit()  # no transaction stays open across the embedder call
    vector = await embed_query(ctx.embedder, q, settings.search_embed_timeout_seconds)
    result = await search_records(
        db, user.id, q, query_vector=vector, model=ctx.embedder.model,
        min_similarity=settings.search_vector_min_similarity, screen_id=screen_id,
        kind=str(kind) if kind else None, start=_aware(start), end=_aware(end), limit=limit,
    )  # fmt: skip
    return SearchOut(results=[_hit_out(h) for h in result.hits], semantic=result.semantic)


@pages_router.get("/{page_id}/summary", response_model=PageSummaryOut)
async def page_summary(page_id: uuid.UUID, user: GatedUser, db: Db) -> PageSummaryOut:
    screen = await _page_id(db, user, page_id)
    row = await db.get(ScreenSummary, screen)
    if row is None:  # every page gets one by trigger
        raise ApiError(404, "not_found")
    return summary_out(row, page_id)


def summary_out(row: ScreenSummary, page_id: uuid.UUID) -> PageSummaryOut:
    return PageSummaryOut(
        page_id=page_id, item_count=row.item_count, last_titles=row.last_titles,
        aggregates=row.aggregates, seq=row.seq, updated_at=row.updated_at,
    )  # fmt: skip


async def _original(db: Db, user: CurrentUser, item_id: uuid.UUID):  # type: ignore[no-untyped-def]
    item = await db.scalar(
        select(Item).where(Item.user_id == user.id, Item.public_id == item_id)
    )  # fmt: skip
    file = await original_file(db, item.id, lock=True) if item is not None else None
    if item is None or file is None:
        raise ApiError(404, "not_found")
    return item, file


@items_router.post("/{item_id}/original/pin", response_model=ItemFileOut)
async def pin_original(item_id: uuid.UUID, user: GatedUser, db: Db, ctx: Ctx) -> ItemFileOut:
    """«Сохранить оригинал». Also brings it back from the trash, while it's there."""
    if not ctx.settings.storage_pin_enabled:
        raise ApiError(403, "pin_disabled")
    _, file = await _original(db, user, item_id)
    if file.state == FileState.PURGED:
        raise ApiError(409, "original_purged")
    if file.state != FileState.PINNED:
        file.state, file.trash_until = FileState.PINNED, None
        file.pinned_by, file.keep_reason = PinnedBy.USER, KeepReason.USER_PIN
        await db.flush()
    return _file_out(file)


@items_router.delete("/{item_id}/original/pin", response_model=ItemFileOut)
async def unpin_original(item_id: uuid.UUID, user: GatedUser, db: Db, ctx: Ctx) -> ItemFileOut:
    item, file = await _original(db, user, item_id)
    if file.state != FileState.PINNED:
        return _file_out(file)
    if file.pinned_by == PinnedBy.POLICY:
        raise ApiError(409, "original_system")
    fields = (item.review_fields or {}).values()
    confirmed = bool(fields) and all(v.get("state") == "verified" for v in fields)
    fate = original_fate(
        OriginalFacts(has_text=bool(item.text), confidence=item.confidence,
                      confirmed=confirmed, text_possible=item.kind != RecordKind.FILE_OTHER),
        StorageFlags(keep_while_unsure=ctx.settings.storage_keep_while_unsure),
    )  # fmt: skip
    file.state, file.pinned_by, file.keep_reason = FileState.ACTIVE, None, None
    if fate == OriginalFate.TRASH:
        trash_file(file)
    else:
        file.keep_reason = KeepReason.LOW_CONFIDENCE
    await db.flush()
    return _file_out(file)
