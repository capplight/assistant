"""Hybrid search over all of a person's records (spec 6.9, 4.4): words + typos + meaning -> RRF.

Arms, each its own ranked list of up to ARM_LIMIT records, fused by `rrf` (k=60):
  fts_ru      `tsv_ru`: Russian word forms
  fts_simple  `tsv_simple`: word beginnings, for Kazakh, names, numbers, anything else
  typos       `tsv_spelled`, for the query's words that no record has
  vector      cosine over the person's chunks of the current model

Typos go through `tsv_spelled`, each word written by `search_translit`, not through trigrams on the
text: trigrams on every text cost seconds at 1 000 records (measured: about 0.2 microseconds a
character, per query word). «молако» is spelled like «молоко» there, so most typos are one index
lookup. Only a word spelled like nothing goes to the person's vocabulary (`ts_stat`) for its closest
relatives by trigrams. Words a person has used number in the thousands, and they are short. This
covers the whole text. Only live, visible records are read, so nothing deleted can come back as a
suggestion. A word that some record has means what it says and isn't treated as a typo at all. The
GIN trgm index on titles (spec 3.3) isn't used by this.

The vector arm reads the person's chunks exactly and does not use the HNSW index: that index is
over everybody's chunks, and with a user filter it returns too few (one person is a tiny share of a
graph). A person's chunks number in the thousands, which an exact scan handles in milliseconds.

Words are joined with OR, never AND: «куда я записала размер обуви сына» must find a note that has
only some of them; the more found, the higher it ranks.

`query_vector` is computed by the caller, outside any transaction (`embed_query`).
"""

import asyncio
import logging
import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.db.models_v2 import RecordKind
from assistant.embeddings import ChunkEmbedder
from assistant.logs import error_text
from assistant.memory.fold import fold, tokens, translit
from assistant.qa.retrieval import rrf

log = logging.getLogger(__name__)

ARM_LIMIT = 50
TYPO_SIMILARITY = 0.4  # trigram similarity of whole words, after `translit`
TYPO_WITHIN_BEST = 0.2  # with an exact word there, its far relatives are noise
TYPO_WORDS_PER_TOKEN = 8
TYPO_LENGTH_SLACK = 3  # a word this much longer or shorter isn't a typo; saves most of the work
TYPO_MIN_LEN = 3
PREFIX_MIN_LEN = 3
SNIPPET_CHARS = 200
LOOK_FOR_TYPO_IN = 4000  # characters; a snippet is only a preview

MATCHED_WORDS = "words"
MATCHED_TYPO = "typo"
MATCHED_MEANING = "meaning"

# Legacy bot kinds (0004 kept the rows) that the API shows as these.
_PLAIN_WORD = re.compile(r"\w+")  # a lexeme can be a URL or an email: no typo arm for those
_LEGACY_KINDS: dict[str, tuple[str, ...]] = {
    RecordKind.NOTE: ("text",),
    RecordKind.IMAGE: ("photo",),
    RecordKind.FILE_OTHER: ("video", "document"),
}


@dataclass
class PageRef:
    id: uuid.UUID
    title: str
    icon: str


@dataclass
class Hit:
    item_id: uuid.UUID
    kind: str
    status: str
    title: str | None
    snippet: str
    highlights: list[list[int]]
    occurred_at: datetime | None
    created_at: datetime
    ai_generated: bool
    ai_fields: list[str]
    pages: list[PageRef] = field(default_factory=list)
    matched_by: list[str] = field(default_factory=list)


@dataclass
class SearchResult:
    hits: list[Hit]
    semantic: bool


async def embed_query(embedder: ChunkEmbedder, query: str, seconds: float) -> list[float] | None:
    """The query's vector, or None when search by meaning can't run now (spec 8.1). No DB here."""
    if not embedder.dim or not query.strip():
        return None
    try:
        async with asyncio.timeout(seconds):
            vectors = await embedder.embed([query], "query")
    except Exception as exc:  # slow or down: words and typos still answer
        log.warning("query embedding failed: %s", error_text(exc) or type(exc).__name__)
        return None
    return vectors[0] if vectors else None


def tsquery_text(words: list[str]) -> str:
    """`'молоко':* | 'хлеб':*`. Words are \\w+ only, so no tsquery syntax can get in."""
    return " | ".join(f"'{w}':*" if len(w) >= PREFIX_MIN_LEN else f"'{w}'" for w in words)


def kinds_for(kind: str) -> list[str]:
    return [kind, *_LEGACY_KINDS.get(kind, ())]


@dataclass
class _Filters:
    sql: str
    params: dict


def _filters(user_id: int, *, screen_id: int | None, kind: str | None, start: datetime | None,
             end: datetime | None) -> _Filters:  # fmt: skip
    sql = "i.user_id = :uid AND i.deleted_at IS NULL AND i.hidden_reason IS NULL"
    params: dict = {"uid": user_id}
    if kind is not None:
        sql += " AND i.kind = ANY(:kinds)"
        params["kinds"] = kinds_for(kind)
    if start is not None:
        sql += " AND coalesce(i.occurred_at, i.created_at) >= :start"
        params["start"] = start
    if end is not None:
        sql += " AND coalesce(i.occurred_at, i.created_at) <= :end"
        params["end"] = end
    if screen_id is not None:
        sql += (" AND EXISTS (SELECT 1 FROM screen_items si WHERE si.item_id = i.id"
                " AND si.screen_id = :screen AND si.removed_by_user_at IS NULL)")  # fmt: skip
        params["screen"] = screen_id
    return _Filters(sql, params)


async def _fts(session: AsyncSession, f: _Filters, column: str, config: str,
               query: str) -> list[int]:  # fmt: skip
    # `column` and `config` come from this module's constants.
    rows = await session.execute(
        text(f"""
            SELECT i.id FROM items i, to_tsquery('{config}', :q) tq
            WHERE {f.sql} AND i.{column} @@ tq
            ORDER BY ts_rank(i.{column}, tq, 1) DESC, i.id DESC
            LIMIT {ARM_LIMIT}
        """),
        {**f.params, "q": query},
    )
    return [r[0] for r in rows]


async def spelling_of_unknown(session: AsyncSession, user_id: int,
                              words: list[str]) -> tuple[list[str], list[str]]:  # fmt: skip
    """For the query's words that no live record has: (spelled like some record's word, spelled like
    nothing), both in `translit` form."""
    rows = await session.execute(
        text("""
            SELECT w.word, EXISTS (
                SELECT 1 FROM items i
                WHERE i.user_id = :uid AND i.deleted_at IS NULL AND i.hidden_reason IS NULL
                  AND i.tsv_spelled @@ to_tsquery('simple', quote_literal(w.spelled) || ':*')
            ) AS spelled_known
            FROM unnest(CAST(:words AS text[]), CAST(:spelled AS text[])) AS w(word, spelled)
            WHERE NOT EXISTS (
                SELECT 1 FROM items i
                WHERE i.user_id = :uid AND i.deleted_at IS NULL AND i.hidden_reason IS NULL
                  AND (i.tsv_simple @@ to_tsquery('simple', quote_literal(w.word) || ':*')
                       OR i.tsv_ru @@ to_tsquery('russian', quote_literal(w.word) || ':*'))
            )
        """),
        {"uid": user_id, "words": words, "spelled": [translit(w) for w in words]},
    )
    known: list[str] = []
    unknown: list[str] = []
    for word, spelled_known in rows:
        (known if spelled_known else unknown).append(translit(word))
    return known, unknown


async def close_words(session: AsyncSession, user_id: int, spelled: list[str]) -> list[str]:
    """Words of this person's live records (`translit` form) closest to these ones."""
    records = ("SELECT tsv_spelled FROM items WHERE user_id = "  # an int, into ts_stat's SQL text
               f"{int(user_id)} AND deleted_at IS NULL AND hidden_reason IS NULL")  # fmt: skip
    rows = await session.execute(
        text("""
            WITH vocabulary AS MATERIALIZED (
                SELECT word FROM ts_stat(:records)
                WHERE char_length(word) BETWEEN :shortest AND :longest
            )
            SELECT wanted.spelled AS token, near.word, near.score
            FROM unnest(CAST(:wanted AS text[])) AS wanted(spelled)
            CROSS JOIN LATERAL (
                SELECT v.word, similarity(v.word, wanted.spelled) AS score
                FROM vocabulary v
                WHERE abs(char_length(v.word) - char_length(wanted.spelled)) <= :slack
                ORDER BY score DESC, v.word
                LIMIT :per_token
            ) near
            WHERE near.score >= :min_score
        """),
        {"records": records, "wanted": spelled, "slack": TYPO_LENGTH_SLACK,
         "shortest": max(TYPO_MIN_LEN, min(map(len, spelled)) - TYPO_LENGTH_SLACK),
         "longest": max(map(len, spelled)) + TYPO_LENGTH_SLACK,
         "per_token": TYPO_WORDS_PER_TOKEN, "min_score": TYPO_SIMILARITY},
    )  # fmt: skip
    found = rows.all()
    best: dict[str, float] = {}
    for row in found:
        best[row.token] = max(best.get(row.token, 0.0), row.score)
    return list(dict.fromkeys(row.word for row in found
                              if row.score >= best[row.token] - TYPO_WITHIN_BEST))  # fmt: skip


async def _typos(session: AsyncSession, f: _Filters, user_id: int, words: list[str]) -> list[int]:
    long_enough = [w for w in words if len(w) >= TYPO_MIN_LEN]
    if not long_enough:
        return []
    known, unknown = await spelling_of_unknown(session, user_id, long_enough)
    near = await close_words(session, user_id, unknown) if unknown else []
    parts = [f"'{w}':*" for w in known] + [f"'{w}'" for w in near if _PLAIN_WORD.fullmatch(w)]
    return await _fts(session, f, "tsv_spelled", "simple", " | ".join(parts)) if parts else []


async def _vector(session: AsyncSession, f: _Filters, vector: list[float], model: str,
                  min_similarity: float) -> dict[int, str]:  # fmt: skip
    """Item id -> its closest chunk's text, closest first. MATERIALIZED keeps the planner off the
    global HNSW index (see the module docstring)."""
    rows = await session.execute(
        text(f"""
            WITH mine AS MATERIALIZED (
                SELECT c.item_id, c.text, c.embedding <=> CAST(:v AS vector) AS distance
                FROM chunks c JOIN items i ON i.id = c.item_id
                WHERE c.user_id = :uid AND c.embedding_model = :model AND {f.sql}
            ), best AS (
                SELECT DISTINCT ON (item_id) item_id, text, distance FROM mine
                WHERE distance <= :max_distance
                ORDER BY item_id, distance
            )
            SELECT item_id, text FROM best ORDER BY distance, item_id DESC LIMIT {ARM_LIMIT}
        """),
        {**f.params, "v": str(vector), "model": model, "max_distance": 1 - min_similarity},
    )
    return {r[0]: r[1] for r in rows}


def _utf16(text_: str) -> int:
    return len(text_.encode("utf-16-le")) // 2


def _trigrams(word: str) -> set[str]:
    padded = f"  {word} "
    return {padded[n:n + 3] for n in range(len(padded) - 2)}  # fmt: skip


def _spans(folded: str, words: list[str]) -> list[tuple[int, int]]:
    """Where the query's words start in the text, whole found words. Typos: the closest word."""
    spans: list[tuple[int, int]] = []
    found = list(re.finditer(r"\w+", folded))
    for word in words:
        start = word[:max(3, len(word) - 2)]
        hits = [m.span() for m in found if m.group().startswith(start)]
        if hits:
            spans.extend(hits[:3])
            continue
        wanted = _trigrams(translit(word))
        best, best_score = None, TYPO_SIMILARITY
        seen: dict[str, float] = {}
        for m in found:
            if m.start() > LOOK_FOR_TYPO_IN:
                break
            have = m.group()
            if have not in seen:
                got = _trigrams(translit(have))
                seen[have] = len(wanted & got) / len(wanted | got)
            if seen[have] >= best_score and (best is None or seen[have] > best_score):
                best, best_score = m.span(), seen[have]
        if best is not None:
            spans.append(best)
    return sorted(set(spans))


def make_snippet(body: str, words: list[str]) -> tuple[str, list[list[int]]]:
    """A piece of the text around the first found word, and where the words are in it (offsets in
    UTF-16 units: what JS `slice` wants)."""
    spans = _spans(fold(body), words) if words else []
    start = 0
    if spans:
        start = max(0, spans[0][0] - SNIPPET_CHARS // 3)
        if start > 0:  # from a word's start
            space = body.find(" ", start, spans[0][0])
            start = space + 1 if space >= 0 else start
    end = min(len(body), start + SNIPPET_CHARS)
    if end < len(body):
        space = body.rfind(" ", start + SNIPPET_CHARS // 2, end)
        end = space if space >= 0 else end
    prefix = "…" if start > 0 else ""
    suffix = "…" if end < len(body) else ""
    piece = body[start:end]
    marks = [
        [_utf16(prefix + body[start:a]), _utf16(prefix + body[start:b])]
        for a, b in spans if a >= start and b <= end
    ]  # fmt: skip
    return prefix + piece + suffix, marks


async def _pages(session: AsyncSession, ids: list[int]) -> dict[int, list[PageRef]]:
    rows = await session.execute(
        text("""
            SELECT si.item_id, s.public_id, s.title, s.icon
            FROM screen_items si JOIN screens s ON s.id = si.screen_id
            WHERE si.item_id = ANY(:ids) AND si.removed_by_user_at IS NULL
              AND s.deleted_at IS NULL AND s.hidden_at IS NULL
            ORDER BY s.position, s.public_id
        """),
        {"ids": ids},
    )
    out: dict[int, list[PageRef]] = {}
    for item_id, public_id, title, icon in rows:
        out.setdefault(item_id, []).append(PageRef(public_id, title, icon))
    return out


async def search_records(
    session: AsyncSession, user_id: int, query: str, *,
    query_vector: list[float] | None = None, model: str = "", min_similarity: float = 0.45,
    screen_id: int | None = None, kind: str | None = None, start: datetime | None = None,
    end: datetime | None = None, limit: int = 20,
) -> SearchResult:  # fmt: skip
    """Ranked records of one person. Only reads. `screen_id` is an internal id the caller already
    checked belongs to this person."""
    words = tokens(query)
    if not words:
        return SearchResult([], False)
    f = _filters(user_id, screen_id=screen_id, kind=kind, start=start, end=end)
    tsq = tsquery_text(words)
    fts_ru = await _fts(session, f, "tsv_ru", "russian", tsq)
    fts_simple = await _fts(session, f, "tsv_simple", "simple", tsq)
    typos = await _typos(session, f, user_id, words)
    semantic = query_vector is not None and bool(model)
    near: dict[int, str] = {}
    if semantic:
        near = await _vector(session, f, query_vector, model, min_similarity)  # type: ignore[arg-type]

    ids = rrf([fts_ru, fts_simple, typos, list(near)], limit=limit)
    if not ids:
        return SearchResult([], semantic)

    rows = await session.execute(
        text("""
            SELECT i.id, i.public_id, i.kind, i.status, i.title, i.occurred_at, i.created_at,
                   i.ai_generated, i.ai_fields, i.source_meta->>'caption' AS caption,
                   left(coalesce(i.text, i.raw_text, i.summary, ''), 20000) AS body
            FROM items i WHERE i.id = ANY(:ids)
        """),
        {"ids": ids},
    )
    by_id = {r.id: r for r in rows}
    pages = await _pages(session, ids)
    words_hit = set(fts_ru) | set(fts_simple)
    typo_hit = set(typos)

    hits: list[Hit] = []
    for item_id in ids:
        r = by_id[item_id]
        matched = []
        if item_id in words_hit:
            matched.append(MATCHED_WORDS)
        if item_id in typo_hit and item_id not in words_hit:
            matched.append(MATCHED_TYPO)
        if item_id in near:
            matched.append(MATCHED_MEANING)
        only_meaning = matched == [MATCHED_MEANING]
        body = near[item_id] if only_meaning else "\n".join(p for p in (r.caption, r.body) if p)
        snippet, marks = make_snippet(" ".join((body or r.title or "").split()),
                                      [] if only_meaning else words)  # fmt: skip
        hits.append(Hit(item_id=r.public_id, kind=r.kind, status=r.status, title=r.title,
                        snippet=snippet, highlights=marks, occurred_at=r.occurred_at,
                        created_at=r.created_at, ai_generated=r.ai_generated,
                        ai_fields=r.ai_fields or [], pages=pages.get(item_id, []),
                        matched_by=matched))  # fmt: skip
    return SearchResult(hits, semantic)
