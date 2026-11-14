"""Memory: chunks + embeddings, hybrid search, storage policy, page summaries (spec 6.9, 7, 3.10).

Public surface for other modules:
- `enqueue_embed(session, item)`: after a record's text or title changed, in the same transaction.
- `search_records`, `embed_query`, `SearchResult`, `Hit`: the search, for chat's `search` tool too.
- `original_fate`, `OriginalFacts`, `OriginalFate`, `StorageFlags`, `purge_files`: storage policy.
- `rebuild_summaries`: the nightly repair of `screen_summaries`.
Worker entry: `python -m assistant.memory`. API contract: docs/api/search.md.
"""

from assistant.memory.embed_jobs import JOB_EMBED, enqueue_embed, enqueue_missing, run_embed
from assistant.memory.retention import (
    OriginalFacts,
    OriginalFate,
    StorageFlags,
    original_fate,
    purge_files,
    trash_orphan_uploads,
)
from assistant.memory.search import Hit, PageRef, SearchResult, embed_query, search_records
from assistant.memory.summaries import rebuild_summaries
from assistant.memory.value import Value, asks_value, find_value, value_of_answer

__all__ = [
    "Value",
    "asks_value",
    "find_value",
    "value_of_answer",
    "JOB_EMBED", "Hit", "OriginalFacts", "OriginalFate", "PageRef", "SearchResult", "StorageFlags",
    "embed_query", "enqueue_embed", "enqueue_missing", "original_fate", "purge_files",
    "rebuild_summaries", "run_embed", "search_records", "trash_orphan_uploads",
]  # fmt: skip
