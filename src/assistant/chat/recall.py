"""Search over the whole conversation (Ф-60; vision-2026-11-review §5.4 step 5): «что мне
советовали про кафе в Стамбуле?» finds the turn a year later, not only what the rolling summary
kept.

- By words now: `conversation_messages.tsv` ('russian' config: «плитку» finds «плитка»), any word.
- By meaning when the embedder is on (TEI in KZ, or DeepInfra when the person's consent lists it):
  `message_embeddings`, filled in the background by the chat worker (`embed_pending`).
- Both lists are merged by rank (RRF, k = 60), and each hit comes back as a turn: what the person
  said and what was answered, with its date.
Never searched: shared text (it is data, not the person's words), deleted messages, unfinished
answers. Used by the read tool `search_chat` and, for a phrase that points to the past («как в
прошлый раз», «мы обсуждали»), as a context layer (`context.py`).
"""

import logging
import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from assistant.embeddings import embedder_available
from assistant.memory import query_embedding_allowed

log = logging.getLogger(__name__)

RRF_K = 60
CANDIDATES = 20
TURN_CHARS = 300
EMBED_CHARS = 1000
EMBED_BATCH = 64
_WORD = re.compile(r"[^\W_]{3,}")
_STOP = {"что", "как", "где", "когда", "мне", "мой", "моя", "мои", "это", "был", "была", "было",
         "про", "для", "или", "так", "там", "тут", "ещё", "еще", "уже", "все", "всё", "ты", "вы",
         "мы", "они", "его", "она", "он", "тот", "эти", "который", "которая", "помнишь",
         "говорил", "говорила", "обсуждали", "прошлый", "раз", "советовали", "советовал"}
# «как в прошлый раз», «мы обсуждали», «я говорил», «помнишь»: the phrase points to the past
_PAST = re.compile(r"(?:в\s+прошлый\s+раз|как\s+тогда|мы\s+(?:обсуждали|говорили)|"
                   r"(?:я|ты)\s+(?:говорил|говорила|писал|писала|советовал|советовала|"
                   r"спрашивал|спрашивала)|помнишь|напомни,?\s+что\s+мы|раньше\s+(?:говорил|"
                   r"писал)|ты\s+мне\s+(?:советовал|сказал)|өткенде)", re.IGNORECASE)


@dataclass
class Turn:
    message_id: int  # the person's phrase (or the answer when the phrase is gone)
    at: datetime
    said: str
    answered: str


def points_to_past(phrase: str) -> bool:
    return bool(_PAST.search(phrase))


def query_words(query: str) -> list[str]:
    words = [w for w in _WORD.findall(query.lower().replace("ё", "е")) if w not in _STOP]
    return list(dict.fromkeys(words))[:12]


async def _by_words(s: AsyncSession, user_id: int, words: list[str],
                    before_id: int | None) -> list[int]:  # fmt: skip
    if not words:
        return []
    rows = await s.execute(text("""
        SELECT m.id FROM conversation_messages m,
             to_tsquery('russian', :q) q
        WHERE m.user_id = :u AND m.deleted_at IS NULL AND m.state = 'done'
          AND m.role IN ('user', 'assistant') AND m.content <> ''
          AND m.input_kind IS DISTINCT FROM 'share' AND m.tsv @@ q
          AND (CAST(:b AS bigint) IS NULL OR m.id < :b)
        ORDER BY ts_rank_cd(m.tsv, q) DESC, m.id DESC LIMIT :n
    """), {"u": user_id, "q": " | ".join(words), "b": before_id, "n": CANDIDATES})
    return [r.id for r in rows]


async def _by_meaning(s: AsyncSession, user_id: int, vector: list[float], before_id: int | None,
                      min_similarity: float) -> list[int]:  # fmt: skip
    rows = await s.execute(text("""
        SELECT m.id, 1 - (e.embedding <=> CAST(:v AS vector)) AS sim
        FROM message_embeddings e JOIN conversation_messages m ON m.id = e.message_id
        WHERE e.user_id = :u AND m.deleted_at IS NULL AND m.state = 'done'
          AND (CAST(:b AS bigint) IS NULL OR m.id < :b)
        ORDER BY e.embedding <=> CAST(:v AS vector) LIMIT :n
    """), {"u": user_id, "v": str(vector), "b": before_id, "n": CANDIDATES})
    return [r.id for r in rows if r.sim >= min_similarity]


def _rrf(*lists: list[int]) -> list[int]:
    score: dict[int, float] = {}
    for ids in lists:
        for rank, mid in enumerate(ids):
            score[mid] = score.get(mid, 0.0) + 1.0 / (RRF_K + rank + 1)
    return sorted(score, key=lambda m: (-score[m], -m))


def _short(value: str) -> str:
    value = " ".join(value.split())
    return value if len(value) <= TURN_CHARS else value[:TURN_CHARS - 1] + "…"


async def search_history(s: AsyncSession, user_id: int, query: str, *,
                         vector: list[float] | None = None, before_id: int | None = None,
                         limit: int = 5, min_similarity: float = 0.45) -> list[Turn]:  # fmt: skip
    """Past turns about `query`, best first. `before_id`: only older than this message (what the
    context already shows word for word is not repeated)."""
    words = await _by_words(s, user_id, query_words(query), before_id)
    meaning = await _by_meaning(s, user_id, vector, before_id, min_similarity) if vector else []
    ranked = _rrf(words, meaning)
    if not ranked:
        return []
    rows = {r.id: r for r in await s.execute(text("""
        SELECT m.id, m.role, m.content, m.created_at, m.reply_to_id,
               (SELECT a.content FROM conversation_messages a
                WHERE a.reply_to_id = m.id AND a.role = 'assistant' AND a.state = 'done'
                  AND a.deleted_at IS NULL ORDER BY a.id LIMIT 1) AS answer,
               (SELECT q.content FROM conversation_messages q
                WHERE q.id = m.reply_to_id AND q.deleted_at IS NULL
                  AND q.input_kind IS DISTINCT FROM 'share') AS question
        FROM conversation_messages m WHERE m.id = ANY(:ids)
    """), {"ids": ranked})}  # fmt: skip
    out: list[Turn] = []
    seen: set[int] = set()
    for mid in ranked:
        r = rows.get(mid)
        if r is None:
            continue
        if r.role == "user":
            key, said, answered = r.id, r.content, r.answer or ""
        else:
            key, said, answered = r.reply_to_id or r.id, r.question or "", r.content
        if key in seen:
            continue
        seen.add(key)
        out.append(Turn(key, r.created_at, _short(said), _short(answered)))
        if len(out) >= limit:
            break
    return out


async def embed_pending(maker: async_sessionmaker[AsyncSession], embedder: Any,
                        limit: int = EMBED_BATCH) -> int:  # fmt: skip
    """Vectors for past turns that have none (chat worker). Only for people whose embedding may
    run (KZ server, or the consent lists the provider abroad). Returns how many were stored."""
    if not embedder_available(embedder):
        return 0
    async with maker() as s:
        rows = (await s.execute(text("""
            SELECT m.id, m.user_id, m.content FROM conversation_messages m
            WHERE m.deleted_at IS NULL AND m.state = 'done' AND m.role IN ('user', 'assistant')
              AND m.content <> '' AND m.input_kind IS DISTINCT FROM 'share'
              AND NOT EXISTS (SELECT 1 FROM message_embeddings e WHERE e.message_id = m.id)
            ORDER BY m.id DESC LIMIT :n
        """), {"n": limit})).all()  # fmt: skip
        allowed: dict[int, bool] = {}
        for uid in {r.user_id for r in rows}:
            allowed[uid] = await query_embedding_allowed(s, uid, embedder)
        await s.commit()
    todo = [r for r in rows if allowed.get(r.user_id)]
    if not todo:
        return 0
    try:
        vectors = await embedder.embed([r.content[:EMBED_CHARS] for r in todo], "document")
    except Exception as exc:  # down / no balance: words still find everything
        log.info("chat: message embeddings unavailable: %s", type(exc).__name__)
        return 0
    async with maker() as s:
        for r, v in zip(todo, vectors, strict=False):
            await s.execute(text("""
                INSERT INTO message_embeddings (message_id, user_id, embedding, embedding_model)
                VALUES (:m, :u, CAST(:v AS vector), :model) ON CONFLICT DO NOTHING
            """), {"m": r.id, "u": r.user_id, "v": str(v), "model": embedder.model})
        await s.commit()
    return min(len(todo), len(vectors))
