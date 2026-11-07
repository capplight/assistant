"""Records (items): text normalization, exact-duplicate merge, trash, ingest jobs.

Public surface for other modules (api, future router/enrichment):
- textnorm: `normalize_text`, `content_hash` (same algorithm as the phone), `detect_lang`
- store: `find_canonical`, `merge_into`, `unmerge`, `trash_item`, `restore_item`,
  `purge_trashed_items`, `trash_file`, `original_file`, `ai_consent_covers`
- ingest: `enqueue_ingest`, `requeue_needs_consent`, `run_ingest`, `IngestDeps`, `JOB_PREFIX`
- enrich: `Envelope`, `enqueue_enrich`, `run_enrich`, `promote_if_waiting`, `JOB_ENRICH`
- batching: `flush_batches`, `poll_batches`, `batch_tick`
- voice: `enqueue_sweep`, `children`, `sweep_recording`
- links: `LinkReader`, `LinkContent`, `WebLinkReader`, `FakeLinkReader`
- adapters: `Ocr`, `Transcriber` (+ Tesseract / fakes), `make_ocr`, `make_transcriber`
Worker entry: `python -m assistant.records`.
"""

from assistant.records.adapters import (
    FakeOcr,
    FakeTranscriber,
    Ocr,
    OcrResult,
    TesseractOcr,
    Transcriber,
    Transcript,
    make_ocr,
    make_transcriber,
)
from assistant.records.batching import batch_tick, flush_batches, poll_batches
from assistant.records.enrich import (
    JOB_ENRICH,
    Envelope,
    enqueue_enrich,
    promote_if_waiting,
    run_enrich,
)
from assistant.records.ingest import (
    JOB_PREFIX,
    IngestDeps,
    enqueue_ingest,
    requeue_needs_consent,
    run_ingest,
)
from assistant.records.links import FakeLinkReader, LinkContent, LinkReader, WebLinkReader
from assistant.records.store import (
    CROSS_BORDER_KINDS,
    ITEM_TRASH_DAYS,
    ai_consent_covers,
    find_canonical,
    merge_into,
    original_file,
    purge_trashed_items,
    restore_item,
    trash_file,
    trash_item,
    unmerge,
)
from assistant.records.textnorm import content_hash, detect_lang, normalize_text
from assistant.records.voice import children, enqueue_sweep, sweep_recording

__all__ = [
    "CROSS_BORDER_KINDS", "ITEM_TRASH_DAYS", "JOB_ENRICH", "JOB_PREFIX", "Envelope",
    "FakeLinkReader", "FakeOcr", "FakeTranscriber",
    "IngestDeps", "LinkContent", "LinkReader", "Ocr", "OcrResult", "TesseractOcr", "Transcriber",
    "Transcript", "WebLinkReader",
    "ai_consent_covers", "batch_tick", "children", "content_hash", "detect_lang", "enqueue_enrich",
    "enqueue_ingest", "enqueue_sweep", "find_canonical", "flush_batches",
    "make_ocr", "make_transcriber", "merge_into", "normalize_text", "original_file", "poll_batches",
    "promote_if_waiting", "purge_trashed_items", "requeue_needs_consent", "restore_item",
    "run_enrich", "run_ingest", "sweep_recording", "trash_file", "trash_item", "unmerge",
]  # fmt: skip
