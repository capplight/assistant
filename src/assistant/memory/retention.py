"""Storage policy and file purge (spec 7.1, 7.2, decision 8, R-34).

The rule «what happens to an original» is one pure function with a decision table in the tests.
Purging the object store follows CLAUDE.md, no transaction during a network call, in three steps
that survive a crash anywhere: mark `purged` (commit), delete the object, set `purged_at`. Marked
but without `purged_at` means the delete isn't confirmed; the next pass does it again (delete is
idempotent). The row and the text stay: `sha256` is what repeats are compared with.

Record purge is `records.store.purge_trashed_items`. Tombstones come from triggers;
`sync_tombstones` is not pruned, because a phone offline for months must still learn what is gone
(open decision).
"""

import enum
import logging
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Protocol

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from assistant.db.models_v2 import File, FileRole, FileState
from assistant.logs import error_text

log = logging.getLogger(__name__)

ALWAYS_KEPT_ROLES = frozenset({FileRole.COMPANY_LOGO, FileRole.COMPANY_TEMPLATE,
                               FileRole.SIGNATURE, FileRole.STAMP})  # fmt: skip
KEEP_BELOW_CONFIDENCE = 0.7
ORPHAN_AFTER = timedelta(days=7)  # an upload no record ever took


class OriginalFate(enum.StrEnum):
    TRASH = "trash"  # text replaces it: goes to the trash for storage_trash_days, then gone
    KEEP_UNSURE = "keep_unsure"  # the text can't replace it until the person confirms it
    KEEP_SIZE = "keep_size"  # the extracted data is no smaller than the file (Excel)
    KEEP_NO_TEXT = "keep_no_text"  # no text can be got from this kind at all
    PIN = "pin"  # the person asked, or it's a logo, template, signature, stamp


@dataclass(frozen=True)
class OriginalFacts:
    role: str = FileRole.ORIGINAL
    has_text: bool = True
    confidence: float | None = 1.0
    confirmed: bool = False  # the person said «Верно» to everything: the text can be trusted
    data_not_smaller: bool = False
    text_possible: bool = True  # False: file_other
    pinned_by_user: bool = False


@dataclass(frozen=True)
class StorageFlags:
    keep_while_unsure: bool = True


def original_fate(facts: OriginalFacts, flags: StorageFlags | None = None) -> OriginalFate:
    """After ingest, or when the person answers «Проверьте» or unpins: what to do with the file."""
    flags = flags or StorageFlags()
    if facts.role in ALWAYS_KEPT_ROLES or facts.pinned_by_user:
        return OriginalFate.PIN
    if not facts.text_possible:
        return OriginalFate.KEEP_NO_TEXT
    if facts.data_not_smaller:
        return OriginalFate.KEEP_SIZE
    low = facts.confidence is not None and facts.confidence < KEEP_BELOW_CONFIDENCE
    unsure = not facts.has_text or (low and not facts.confirmed)
    if unsure and flags.keep_while_unsure:
        return OriginalFate.KEEP_UNSURE
    return OriginalFate.TRASH


class ObjectDeleter(Protocol):
    async def delete(self, key: str) -> None: ...


async def trash_orphan_uploads(session: AsyncSession, now: datetime | None = None) -> int:
    """Originals uploaded a week ago that no record took: nothing would ever remove them."""
    now = now or datetime.now(UTC)
    result = await session.execute(
        update(File)
        .where(File.item_id.is_(None), File.role == FileRole.ORIGINAL,
               File.state == FileState.ACTIVE, File.created_at <= now - ORPHAN_AFTER)
        .values(state=FileState.TRASH, trash_until=now)
    )  # fmt: skip
    return result.rowcount or 0


async def purge_files(maker: async_sessionmaker[AsyncSession], storage: ObjectDeleter,
                      now: datetime | None = None, *, limit: int = 200) -> int:  # fmt: skip
    """`storage:purge`: delete the objects of trashed files whose time is up. Returns how many are
    now confirmed gone. A failed delete is retried on the next pass."""
    now = now or datetime.now(UTC)
    async with maker() as s:
        await trash_orphan_uploads(s, now)
        due = list(
            await s.scalars(
                select(File)
                .where(File.state == FileState.TRASH, File.trash_until <= now)
                .order_by(File.trash_until)
                .limit(limit)
                .with_for_update(skip_locked=True)
            )
        )
        for file in due:  # from here on nobody can pin it
            file.state = FileState.PURGED
        await s.commit()
    async with maker() as s:
        rows = (
            await s.execute(
                select(File.id, File.storage_key)
                .where(File.state == FileState.PURGED, File.purged_at.is_(None))
                .limit(limit)
            )
        ).all()
        await s.commit()
    gone: list[int] = []
    for file_id, key in rows:
        try:
            await storage.delete(key)
            gone.append(file_id)
        except Exception as exc:
            log.warning("file %s: object delete failed: %s", file_id, error_text(exc))
    if gone:
        async with maker() as s:
            await s.execute(update(File).where(File.id.in_(gone)).values(purged_at=now))
            await s.commit()
    return len(gone)
