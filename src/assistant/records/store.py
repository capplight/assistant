"""Record (items) operations shared by the API and the ingest jobs: exact-duplicate merge,
trash/restore/purge, original-file policy, the consent check for cross-border steps.

Every function works inside the caller's transaction and never does network I/O.
"""

from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.db.models import Item
from assistant.db.models_v2 import (
    Consent,
    ConsentKind,
    File,
    FileRole,
    FileState,
    HiddenReason,
    KeepReason,
    RecordKind,
    RecordStatus,
)

ITEM_TRASH_DAYS = 30  # "Удалённые записи" (spec 7.2, R-33)
ORIGINAL_TRASH_DAYS = 7  # storage.trash_days (decision 8)
KEEP_BELOW_CONFIDENCE = 0.7  # storage.keep_while_unsure
AI_KINDS = (ConsentKind.PD_PROCESSING, ConsentKind.TERMS, ConsentKind.AI_CROSS_BORDER)

# Kinds whose ingest sends data abroad (STT). Everything else in ingest runs locally in KZ.
CROSS_BORDER_KINDS = frozenset({RecordKind.VOICE})


def now_utc() -> datetime:
    return datetime.now(UTC)


# --- duplicates (spec 6.3, exact, on save) ---


async def find_canonical(
    session: AsyncSession,
    user_id: int,
    *,
    content_hash: str | None = None,
    original_sha256: str | None = None,
    exclude_id: int | None = None,
) -> Item | None:
    """Oldest visible record with the same normalized-text hash or the same original bytes."""
    if content_hash is None and original_sha256 is None:
        return None
    stmt = select(Item).where(
        Item.user_id == user_id, Item.deleted_at.is_(None), Item.hidden_reason.is_(None)
    )
    if content_hash is not None:
        stmt = stmt.where(Item.content_hash == content_hash)
    else:
        stmt = stmt.where(Item.original_sha256 == original_sha256)
    if exclude_id is not None:
        stmt = stmt.where(Item.id != exclude_id)
    return await session.scalar(stmt.order_by(Item.id).limit(1))


def merge_into(item: Item, canonical: Item, now: datetime | None = None) -> None:
    """Hide `item` as an exact repeat of `canonical`; note where it came from on the canonical."""
    now = now or now_utc()
    item.hidden_reason = HiddenReason.DUPLICATE_MERGED
    item.canonical_item_id = canonical.id
    occurred = item.occurred_at or item.created_at or now
    fragment = {"item_id": str(item.public_id), "kind": str(item.kind),
                "source": str(item.source), "occurred_at": occurred.isoformat(),
                "merged_at": now.isoformat()}  # fmt: skip
    canonical.merged_fragments = [*(canonical.merged_fragments or []), fragment]


async def unmerge(session: AsyncSession, item: Item) -> Item | None:
    """Undo an automatic merge ("Отменить"). Returns the former canonical record."""
    if item.hidden_reason != HiddenReason.DUPLICATE_MERGED or item.canonical_item_id is None:
        return None
    canonical = await session.get(Item, item.canonical_item_id, with_for_update=True)
    item.hidden_reason = None
    item.canonical_item_id = None
    marker = item.source_meta or {}
    item.source_meta = {**marker, "unmerged": True}  # never auto-merge this one again
    if canonical is not None:
        public = str(item.public_id)
        canonical.merged_fragments = [
            f for f in (canonical.merged_fragments or []) if f.get("item_id") != public
        ]
    return canonical


# --- trash (records: 30 days; originals: 7 days) ---


def trash_item(item: Item, now: datetime | None = None) -> None:
    if item.deleted_at is not None:
        return
    now = now or now_utc()
    item.deleted_at = now
    item.purge_after = now + timedelta(days=ITEM_TRASH_DAYS)


def restore_item(item: Item) -> None:
    item.deleted_at = None
    item.purge_after = None


async def purge_trashed_items(session: AsyncSession, now: datetime | None = None,
                              limit: int = 500) -> int:  # fmt: skip
    """Hard-delete records whose 30 days in trash are over. The delete trigger writes a sync
    tombstone; their still-active originals go to the file trash for storage:purge."""
    now = now or now_utc()
    ids = list(
        await session.scalars(
            select(Item.id)
            .where(Item.deleted_at.is_not(None), Item.purge_after <= now)
            .order_by(Item.purge_after)
            .limit(limit)
            .with_for_update(skip_locked=True)
        )
    )
    if not ids:
        return 0
    await session.execute(
        update(File)
        .where(File.item_id.in_(ids), File.state == FileState.ACTIVE)
        .values(state=FileState.TRASH, trash_until=now, keep_reason=None)
    )
    await session.execute(delete(Item).where(Item.id.in_(ids)))
    return len(ids)


def trash_file(file: File, now: datetime | None = None) -> None:
    if file.state != FileState.ACTIVE:
        return  # pinned stays, trash keeps its date, purged is gone
    file.state = FileState.TRASH
    file.trash_until = (now or now_utc()) + timedelta(days=ORIGINAL_TRASH_DAYS)
    file.keep_reason = None


def keep_file(file: File, reason: KeepReason) -> None:
    if file.state == FileState.ACTIVE:
        file.keep_reason = reason


async def original_file(session: AsyncSession, item_id: int, *, lock: bool = False) -> File | None:
    stmt = (
        select(File)
        .where(File.item_id == item_id, File.role == FileRole.ORIGINAL)
        .order_by(File.id)
        .limit(1)
    )
    if lock:
        stmt = stmt.with_for_update()
    return await session.scalar(stmt)


# --- consent gate for jobs (spec 7.5: router + ingest, not UI) ---


async def ai_consent_covers(session: AsyncSession, user_id: int, recipient: str | None) -> bool:
    """pd_processing + terms + ai_cross_border active, and the recipient (e.g. "Groq") is in the
    providers of the latest active ai_cross_border grant. recipient=None: only the kinds."""
    rows = list(
        await session.execute(
            select(Consent.kind, Consent.providers)
            .where(Consent.user_id == user_id, Consent.revoked_at.is_(None),
                   Consent.kind.in_([str(k) for k in AI_KINDS]))
            .order_by(Consent.granted_at.desc(), Consent.id.desc())
        )
    )  # fmt: skip
    kinds = {row.kind for row in rows}
    if not all(str(k) in kinds for k in AI_KINDS):
        return False
    if recipient is None:
        return True
    latest_ai = next(row for row in rows if row.kind == ConsentKind.AI_CROSS_BORDER)
    return recipient.lower() in {p.lower() for p in latest_ai.providers or []}


async def needs_consent_items(session: AsyncSession, user_id: int) -> list[Item]:
    return list(
        await session.scalars(
            select(Item)
            .where(Item.user_id == user_id, Item.status == RecordStatus.NEEDS_CONSENT,
                   Item.deleted_at.is_(None))
            .with_for_update()
        )
    )  # fmt: skip
