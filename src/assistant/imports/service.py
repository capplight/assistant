"""Telegram import from a Telegram Desktop export file (spec 6.10, Core week 10).

`POST /v1/imports/telegram/file` makes an `imports` row and the job `import:telegram`. The job:
1. reads the export once from storage (no transaction open), parses it (`telegram.py`), and
   trashes the uploaded file at once: originals are not kept, the text is (decision 8);
2. writes records in short transactions of `BATCH` messages, resumable by `cursor.next`.
   A message already brought by an earlier import (`import_seen`) is skipped and not counted
   again; an exact repeat of a visible record (`content_hash`) is not brought, before any model
   sees it. Records are placed on pages by their `auto_rule` (`added_by=rule`);
3. writes one `import_batch` action («Отменить» moves every brought record to «Удалённые
   записи»), the summary, and schedules the repeat scan (groups `origin=import`) and stacks.
Enrichment then runs lazily, `import_enrich_wave` records at a time (`import:enrich`), on the
one-off import wallet ($1, IMPORT_SUMMARIZE): the records are usable before it and without it.
"""

import logging
from datetime import UTC, datetime, timedelta
from typing import Any, Protocol

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from assistant.actions import record
from assistant.analytics import server_event
from assistant.config import get_settings
from assistant.db import queue
from assistant.db.models import Item, User
from assistant.db.models_actions import ActionKind, Initiator
from assistant.db.models_dedup import DupOrigin, Import, ImportSeen, ImportStatus
from assistant.db.models_v2 import (
    EnrichState,
    File,
    FileState,
    RecordKind,
    RecordSource,
    RecordStatus,
)
from assistant.dedup import schedule_scan
from assistant.dedup.similarity import simhash
from assistant.dedup.texts import import_summary
from assistant.imports.telegram import ExportError, Limits, Message, json_bytes, parse
from assistant.memory import enqueue_embed
from assistant.pages import place_item
from assistant.records import content_hash, detect_lang, enqueue_enrich, find_canonical
from assistant.records.textnorm import detect_review_fields, title_from_text
from assistant.stacks import schedule_rebuild

log = logging.getLogger(__name__)
JOB_IMPORT = "import:telegram"
JOB_ENRICH_WAVE = "import:enrich"
BATCH = 200
WAVE_RECHECK = timedelta(seconds=30)
WAVE_MAX_CHECKS = 240  # 2 hours of waiting for one wave
FAMILY = "telegram"


class ObjectReader(Protocol):  # the object store the API writes uploads to
    async def get(self, key: str) -> bytes | None: ...


def limits() -> Limits:
    st = get_settings()
    return Limits(st.import_max_json_bytes, st.import_max_zip_members, st.import_max_zip_ratio,
                  st.import_max_messages)  # fmt: skip


async def enqueue_import(s: AsyncSession, imp: Import) -> None:
    await queue.enqueue(s, JOB_IMPORT, {"import_id": imp.id},
                        idempotency_key=f"import:{imp.id}:telegram")  # fmt: skip


async def _fail(maker: async_sessionmaker[AsyncSession], import_id: int, code: str) -> None:
    async with maker() as s:
        imp = await s.get(Import, import_id, with_for_update=True)
        if imp is not None:
            imp.status, imp.error, imp.finished_at = ImportStatus.FAILED, code, datetime.now(UTC)
            await _drop_file(s, imp)
        await s.commit()


async def _drop_file(s: AsyncSession, imp: Import) -> None:
    """The export holds everything: it goes to storage:purge at once, never kept."""
    if imp.file_id is None:
        return
    f = await s.get(File, imp.file_id, with_for_update=True)
    if f is not None and f.state in (FileState.ACTIVE, FileState.PINNED):
        f.state, f.trash_until, f.keep_reason, f.pinned_by = (FileState.TRASH,
                                                             datetime.now(UTC), None, None)


async def run_import(maker: async_sessionmaker[AsyncSession], storage: ObjectReader,
                     import_id: int) -> str:  # fmt: skip
    """Returns the import's status when the job ends."""
    async with maker() as s:
        imp = await s.get(Import, import_id, with_for_update=True)
        if imp is None:
            return "gone"
        if imp.status in (ImportStatus.DONE, ImportStatus.FAILED, ImportStatus.CANCELLED):
            await s.commit()
            return str(imp.status)
        f = await s.get(File, imp.file_id) if imp.file_id else None
        user = await s.get(User, imp.user_id)
        key, tz = (f.storage_key if f else None), (user.tz if user else "Asia/Almaty")
        imp.status = ImportStatus.RUNNING
        imp.started_at = imp.started_at or datetime.now(UTC)
        await s.commit()
    if key is None:
        await _fail(maker, import_id, "import_file_missing")
        return ImportStatus.FAILED
    data = await storage.get(key)
    if data is None:
        await _fail(maker, import_id, "import_file_missing")
        return ImportStatus.FAILED
    try:
        export = parse(json_bytes(data, limits()), limits(), tz or "Asia/Almaty")
    except ExportError as exc:
        await _fail(maker, import_id, exc.code)
        return ImportStatus.FAILED
    del data

    async with maker() as s:
        imp = await s.get(Import, import_id, with_for_update=True)
        assert imp is not None
        imp.total = len(export.messages)
        imp.skipped_media = dict(export.skipped_media)
        imp.failed = export.failed
        start = int((imp.cursor or {}).get("next", 0))
        await _drop_file(s, imp)
        await s.commit()

    for lo in range(start, len(export.messages), BATCH):
        status = await _write_batch(maker, import_id, export.messages[lo:lo + BATCH], lo)
        if status == ImportStatus.CANCELLED:
            break  # what was brought keeps its «Отменить» and its summary
    return await _finish(maker, import_id, export)


async def _write_batch(maker: async_sessionmaker[AsyncSession], import_id: int,
                       batch: list[Message], lo: int) -> str:  # fmt: skip
    async with maker() as s:
        imp = await s.get(Import, import_id, with_for_update=True)
        assert imp is not None
        if imp.status == ImportStatus.CANCELLED:
            await s.commit()
            return ImportStatus.CANCELLED
        uid = imp.user_id
        seen = set(await s.scalars(select(ImportSeen.external_id).where(
            ImportSeen.user_id == uid, ImportSeen.source_family == FAMILY,
            ImportSeen.external_id.in_([m.external_id for m in batch]))))  # fmt: skip
        created: list[int] = list((imp.cursor or {}).get("created", []))
        again = int((imp.cursor or {}).get("seen_before", 0))
        for m in batch:
            if m.external_id in seen:
                again += 1
                continue
            h = content_hash(m.text)
            canonical = await find_canonical(s, uid, content_hash=h) if h else None
            item_id = canonical.id if canonical is not None else None
            if canonical is not None:
                imp.skipped_dups += 1
            else:
                item = _new_item(uid, import_id, m, h)
                s.add(item)
                await s.flush()
                await place_item(s, item)
                await enqueue_embed(s, item)
                item_id = item.id
                created.append(item.id)
                imp.created_count += 1
            await s.execute(insert(ImportSeen).values(
                user_id=uid, source_family=FAMILY, external_id=m.external_id, item_id=item_id,
                import_id=import_id).on_conflict_do_nothing(constraint="uq_import_seen"))
            seen.add(m.external_id)
        imp.processed = lo + len(batch)
        imp.cursor = {"next": lo + len(batch), "created": created, "seen_before": again}
        await s.commit()
    return ImportStatus.RUNNING


def _new_item(user_id: int, import_id: int, m: Message, h: str | None) -> Item:
    meta: dict[str, Any] = {"import_id": import_id,
                            "telegram": {"chat": "saved_messages", "id": m.external_id}}
    if m.forwarded_from:
        meta["forwarded_from"] = m.forwarded_from
    if m.media:
        meta["media_not_kept"] = m.media
    if m.urls:
        meta["links"] = list(m.urls)
    title = title_from_text(m.text)
    if title:
        meta["title_source"] = "text"
    return Item(user_id=user_id, kind=RecordKind.TG_MESSAGE, source=RecordSource.IMPORT_TELEGRAM,
                status=RecordStatus.READY, title=title, text=m.text,
                text_lang=detect_lang(m.text), content_hash=h, simhash=simhash(m.text),
                review_fields=detect_review_fields(m.text), source_meta=meta,
                occurred_at=m.occurred_at, processed_at=datetime.now(UTC))  # fmt: skip


async def _finish(maker: async_sessionmaker[AsyncSession], import_id: int, export: Any) -> str:
    async with maker() as s:
        imp = await s.get(Import, import_id, with_for_update=True)
        assert imp is not None
        cancelled = imp.status == ImportStatus.CANCELLED
        created = list((imp.cursor or {}).get("created", []))
        again = int((imp.cursor or {}).get("seen_before", 0))
        now = datetime.now(UTC)
        text = import_summary(imp.created_count, imp.skipped_dups, imp.skipped_media, imp.failed)
        if again:
            text += f" Уже были раньше: {again}."
        if imp.action_id is None and created:
            pubs = dict((await s.execute(select(Item.id, Item.public_id)
                                         .where(Item.id.in_(created)))).all())  # type: ignore[arg-type]
            action = await record(
                s, user_id=imp.user_id, kind=ActionKind.IMPORT_BATCH, initiated_by=Initiator.USER,
                summary={"ru": text, "kk": None},
                changes=[{"item_id": str(pubs[i]), "title": "", "kind": "create",
                          "page_id": None, "text": "Из Telegram"} for i in created if i in pubs],
                inverse=[{"op": "delete_entity_soft", "entity": "items", "id": str(pubs[i])}
                         for i in reversed(created) if i in pubs],
                now=now, source_item_ids=created[:5000],
                extra={"import_id": str(imp.public_id)},
            )  # fmt: skip
            imp.action_id = action.id
        imp.summary = {"text_ru": text, "created": imp.created_count,
                       "skipped_dups": imp.skipped_dups, "seen_before": again,
                       "skipped_media": imp.skipped_media, "failed": imp.failed,
                       "service": export.service, "empty": export.empty}  # fmt: skip
        imp.cursor = {k: v for k, v in (imp.cursor or {}).items() if k != "created"}
        if not cancelled:
            imp.status, imp.finished_at = ImportStatus.DONE, now
        await schedule_scan(s, imp.user_id, origin=DupOrigin.IMPORT, import_id=imp.id,
                            delay_s=0)  # fmt: skip
        if created:
            await queue.enqueue(s, JOB_ENRICH_WAVE, {"import_id": imp.id},
                                idempotency_key=f"import:{imp.id}:enrich:0")  # fmt: skip
        await schedule_rebuild(s, imp.user_id)
        await server_event(s, imp.user_id, "import_completed",
                           {"method": "file", "items": imp.created_count,
                            "skipped": imp.skipped_dups})  # fmt: skip
        status = str(imp.status)
        await s.commit()
    return status


async def run_enrich_wave(maker: async_sessionmaker[AsyncSession], import_id: int,
                          wave: int = 0, checks: int = 0) -> int:  # fmt: skip
    """Send the next `import_enrich_wave` brought records to enrichment, once the previous wave is
    through. Returns how many were sent (0: nothing left, the waves stop). A wave still waiting
    after `WAVE_MAX_CHECKS` looks (no enrichment worker, a long outage) stops the waves; the
    records keep `enrich_state` NULL and nothing else depends on them."""
    size = get_settings().import_enrich_wave
    async with maker() as s:
        imp = await s.get(Import, import_id)
        if imp is None or imp.status == ImportStatus.CANCELLED:
            await s.commit()
            return 0
        mine = (Item.user_id == imp.user_id, Item.source_meta["import_id"].as_integer() == imp.id,
                Item.deleted_at.is_(None), Item.hidden_reason.is_(None))
        waiting = await s.scalar(select(func.count()).select_from(Item).where(
            *mine, Item.enrich_state == EnrichState.PENDING))  # fmt: skip
        if waiting:
            if checks >= WAVE_MAX_CHECKS:
                await s.commit()
                return 0
            nxt, sent, checks = wave, 0, checks + 1
        else:
            todo = list(await s.scalars(select(Item).where(*mine, Item.enrich_state.is_(None))
                                        .order_by(Item.occurred_at.desc(), Item.id.desc())
                                        .limit(size).with_for_update()))  # fmt: skip
            for it in todo:
                await enqueue_enrich(s, it)
            nxt, sent, checks = wave + 1, len(todo), 0
            if not todo:
                await s.commit()
                return 0
        await queue.enqueue(s, JOB_ENRICH_WAVE,
                            {"import_id": import_id, "wave": nxt, "checks": checks},
                            idempotency_key=f"import:{import_id}:enrich:{nxt}:{checks}",
                            run_after=datetime.now(UTC) + WAVE_RECHECK)  # fmt: skip
        await s.commit()
    return sent
