"""Ingest jobs `ingest:<kind>` (spec 6.1): get the text out of a record, locally where possible.

    POST /v1/items -> items(pending) + files(original) -> job ingest:<kind>
    (idempotency `item:<id>:ingest:v1`) -> text -> exact-duplicate merge -> ready / needs_review

Three short transactions per job; no transaction is open while reading the original from
storage or calling OCR/STT. Enrichment (`ai:enrich`), embeddings and stacks come later (router).

Consent gate: kinds in CROSS_BORDER_KINDS (voice -> STT abroad) run only when ai_cross_border
covers the transcriber's recipient; otherwise the record becomes `needs_consent` and is
re-queued when the consent is granted (`requeue_needs_consent`).
"""

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Protocol

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from assistant.db import queue
from assistant.db.models import Item, Job
from assistant.db.models_v2 import KeepReason, RecordKind, RecordStatus
from assistant.records import store
from assistant.records.adapters import FakeOcr, FakeTranscriber, Ocr, Transcriber
from assistant.records.extract import (
    Extracted,
    ExtractError,
    extract_docx,
    extract_pdf,
    extract_xlsx,
    json_size,
)
from assistant.records.textnorm import (
    content_hash,
    detect_lang,
    detect_review_fields,
    find_links,
    normalize_text,
    title_from_text,
)

log = logging.getLogger(__name__)

JOB_PREFIX = "ingest:"
INGEST_VERSION = 1
TEXT_KINDS = frozenset({RecordKind.NOTE, RecordKind.LINK})
DONE_STATUSES = frozenset({RecordStatus.READY, RecordStatus.NEEDS_REVIEW, RecordStatus.FAILED})
MAX_TEXT_CHARS = 200_000


class BlobReader(Protocol):
    async def get(self, key: str) -> bytes | None: ...


@dataclass
class IngestDeps:
    storage: BlobReader
    ocr: Ocr = field(default_factory=FakeOcr)
    transcriber: Transcriber = field(default_factory=FakeTranscriber)
    ocr_langs: str = "rus+kaz+eng"


def job_kind(kind: str) -> str:
    return f"{JOB_PREFIX}{kind}"


def idempotency_key(item_id: int, suffix: str = "") -> str:
    return f"item:{item_id}:ingest:v{INGEST_VERSION}{suffix}"


async def enqueue_ingest(session: AsyncSession, item: Item, *, suffix: str = "") -> Job:
    return await queue.enqueue(session, job_kind(str(item.kind)), {"item_id": item.id},
                               idempotency_key=idempotency_key(item.id, suffix))  # fmt: skip


async def requeue_needs_consent(session: AsyncSession, user_id: int, grant_marker: str) -> int:
    """After ai_cross_border is granted: put `needs_consent` records back in the queue."""
    if not await store.ai_consent_covers(session, user_id, None):
        return 0
    items = await store.needs_consent_items(session, user_id)
    for item in items:
        item.status = RecordStatus.PENDING
        item.error = None
        await enqueue_ingest(session, item, suffix=f":consent:{grant_marker}")
    return len(items)


@dataclass
class _Result:
    text: str | None
    confidence: float | None = None
    review: dict = field(default_factory=dict)
    meta: dict = field(default_factory=dict)
    lang: str | None = None
    keep_original: KeepReason | None = None


async def run_ingest(maker: async_sessionmaker[AsyncSession], item_id: int,
                     deps: IngestDeps) -> str | None:  # fmt: skip
    """Run one ingest. Returns the final status (None when there was nothing to do).

    Deterministic extraction errors (encrypted PDF, broken file) end as `failed` with a code;
    transient ones (storage, OCR/STT outage) raise, so the queue retries with backoff.
    """
    # 1. claim the record
    async with maker() as s:
        item = await s.get(Item, item_id, with_for_update=True)
        if item is None or item.deleted_at is not None or item.status in DONE_STATUSES:
            await s.commit()
            return None
        kind = str(item.kind)
        if kind in store.CROSS_BORDER_KINDS and not await store.ai_consent_covers(
            s, item.user_id, deps.transcriber.recipient
        ):
            item.status = RecordStatus.NEEDS_CONSENT
            await s.commit()
            return RecordStatus.NEEDS_CONSENT
        file = await store.original_file(s, item.id)
        key, mime, size = (file.storage_key, file.mime, file.bytes) if file else (None, None, 0)
        typed_text = item.text
        item.status = RecordStatus.PROCESSING
        await s.commit()

    # 2. extract (no transaction open)
    try:
        if kind in TEXT_KINDS or key is None:
            result = _Result(text=typed_text)
        else:
            data = await deps.storage.get(key)
            if data is None:
                raise ExtractError("original_missing")
            result = await _extract(kind, data, mime or "", size, deps)
    except ExtractError as exc:
        return await _finish_failed(maker, item_id, exc.code)

    # 3. store the text
    return await _finish(maker, item_id, result)


async def _extract(kind: str, data: bytes, mime: str, size: int, deps: IngestDeps) -> _Result:
    if kind in (RecordKind.IMAGE, RecordKind.SCREENSHOT):
        ocr = await deps.ocr.recognize(data, langs=deps.ocr_langs)
        review = detect_review_fields(ocr.text)
        return _Result(text=ocr.text, confidence=ocr.confidence, review=review,
                       meta={"ocr": deps.ocr.name})  # fmt: skip
    if kind == RecordKind.VOICE:
        tr = await deps.transcriber.transcribe(data, mime=mime, lang_hint=None)
        review = detect_review_fields(tr.text)
        if tr.confidence < store.KEEP_BELOW_CONFIDENCE:
            review["transcript"] = {"kind": "transcript", "value": None, "state": "unverified"}
        meta = {"stt": deps.transcriber.name}
        if tr.segments:
            meta["segments"] = tr.segments
        return _Result(text=tr.text, confidence=tr.confidence, review=review, meta=meta,
                       lang=tr.lang)  # fmt: skip
    if kind == RecordKind.PDF:
        ex = await asyncio.to_thread(extract_pdf, data)
        return await _pdf_result(ex, deps)
    if kind == RecordKind.DOCX:
        ex = await asyncio.to_thread(extract_docx, data)
        return _Result(text=ex.text, confidence=1.0, meta={"docx": ex.meta, "tables": ex.tables})
    if kind == RecordKind.XLSX:
        ex = await asyncio.to_thread(extract_xlsx, data)
        keep = KeepReason.SIZE_RULE if json_size(ex.tables) >= size else None
        return _Result(text=ex.text, confidence=1.0, meta={"xlsx": ex.meta, "sheets": ex.tables},
                       keep_original=keep)  # fmt: skip
    # file_other and anything without an extractor: keep the original, no text.
    return _Result(text=None, confidence=None, keep_original=KeepReason.LOW_CONFIDENCE)


async def _pdf_result(ex: Extracted, deps: IngestDeps) -> _Result:
    pages = list(ex.pages)
    confs: list[float] = []
    review: dict = {}
    for number, png in ex.ocr_pages:
        ocr = await deps.ocr.recognize(png, langs=deps.ocr_langs)
        if len(ocr.text.strip()) > len(pages[number - 1]):
            pages[number - 1] = ocr.text.strip()
            confs.append(ocr.confidence)
    text = "\n\n".join(p for p in pages if p)
    if confs:
        review = detect_review_fields(text)
    meta = {"pdf": {**ex.meta, "ocr_pages": len(confs),
                    "more_pages": ex.meta["pages_total"] > ex.meta["pages_read"]},
            "tables": ex.tables}  # fmt: skip
    return _Result(text=text, confidence=min(confs) if confs else 1.0, review=review, meta=meta)


async def _finish(maker: async_sessionmaker[AsyncSession], item_id: int,
                  result: _Result) -> str | None:  # fmt: skip
    async with maker() as s:
        item = await s.get(Item, item_id, with_for_update=True)
        if item is None or item.deleted_at is not None:
            await s.commit()
            return None
        now = store.now_utc()
        text = normalize_text(result.text)[:MAX_TEXT_CHARS] if result.text else None
        item.text = text or None
        item.text_lang = result.lang if result.lang in ("ru", "kk", "en") else detect_lang(text)
        if not item.title:
            item.title = title_from_text(text)
        item.confidence = result.confidence
        meta = dict(item.source_meta or {})
        meta.update(result.meta)
        links = find_links(text)
        if links:
            meta["links"] = links
        item.source_meta = meta
        # Keep what the person already confirmed ("Верно" is never undone by a re-run).
        old = item.review_fields or {}
        item.review_fields = {k: (old[k] if old.get(k, {}).get("state") == "verified" else v)
                              for k, v in result.review.items()}  # fmt: skip
        item.content_hash = content_hash(text)
        item.processed_at = now
        item.error = None

        unsure = not text or (result.confidence is not None
                              and result.confidence < store.KEEP_BELOW_CONFIDENCE)  # fmt: skip
        has_open_review = any(v.get("state") != "verified" for v in item.review_fields.values())
        if kind_needs_text(str(item.kind)) and (unsure or has_open_review):
            item.status = RecordStatus.NEEDS_REVIEW
        else:
            item.status = RecordStatus.READY

        file = await store.original_file(s, item.id, lock=True)
        if file is not None:
            if result.keep_original is not None:
                store.keep_file(file, result.keep_original)
            elif unsure:
                store.keep_file(file, KeepReason.LOW_CONFIDENCE)
            else:
                store.trash_file(file, now)

        if (item.hidden_reason is None and item.content_hash
                and not (item.source_meta or {}).get("unmerged")):  # fmt: skip
            canonical = await store.find_canonical(s, item.user_id,
                                                   content_hash=item.content_hash,
                                                   exclude_id=item.id)  # fmt: skip
            if canonical is not None and canonical.id < item.id:
                store.merge_into(item, canonical, now)
                if file is not None:
                    store.trash_file(file, now)
        status = str(item.status)
        await s.commit()
    return status


def kind_needs_text(kind: str) -> bool:
    return kind not in (RecordKind.FILE_OTHER,)


async def _finish_failed(maker: async_sessionmaker[AsyncSession], item_id: int,
                         code: str) -> str:  # fmt: skip
    async with maker() as s:
        item = await s.get(Item, item_id, with_for_update=True)
        if item is not None:
            item.status = RecordStatus.FAILED
            item.error = code
            item.processed_at = store.now_utc()
            file = await store.original_file(s, item.id, lock=True)
            if file is not None:
                store.keep_file(file, KeepReason.LOW_CONFIDENCE)  # nothing replaced it
        await s.commit()
    log.info("ingest item %s failed: %s", item_id, code)
    return RecordStatus.FAILED


async def give_up(maker: async_sessionmaker[AsyncSession], item_id: int) -> None:
    """Called by the worker when the queue gave up on the job (all retries failed)."""
    await _finish_failed(maker, item_id, "ingest_failed")
