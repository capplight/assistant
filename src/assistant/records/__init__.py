"""Records (items): text normalization, exact-duplicate merge, trash, ingest jobs.

Public surface for other modules (api, future router/enrichment):
- textnorm: `normalize_text`, `content_hash` (same algorithm as the phone), `detect_lang`
- store: `find_canonical`, `merge_into`, `unmerge`, `trash_item`, `restore_item`,
  `purge_trashed_items`, `trash_file`, `original_file`, `ai_consent_covers`
- ingest: `enqueue_ingest`, `requeue_needs_consent`, `run_ingest`, `IngestDeps`, `JOB_PREFIX`
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
from assistant.records.ingest import (
    JOB_PREFIX,
    IngestDeps,
    enqueue_ingest,
    requeue_needs_consent,
    run_ingest,
)
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

__all__ = [
    "CROSS_BORDER_KINDS", "ITEM_TRASH_DAYS", "JOB_PREFIX", "FakeOcr", "FakeTranscriber",
    "IngestDeps", "Ocr", "OcrResult", "TesseractOcr", "Transcriber", "Transcript",
    "ai_consent_covers", "content_hash", "detect_lang", "enqueue_ingest", "find_canonical",
    "make_ocr", "make_transcriber", "merge_into", "normalize_text", "original_file",
    "purge_trashed_items", "requeue_needs_consent", "restore_item", "run_ingest", "trash_file",
    "trash_item", "unmerge",
]  # fmt: skip
