"""Chunks: the job `embed:item` (spec 1, worker-embed). Text -> chunks -> embeddings, locally.

One job row per record (`item:<id>:embed:v1`), put back in the queue whenever the record changes, so
A -> B -> A embeds again and the jobs table doesn't grow with every edit. The job itself is safe to
repeat: `source_sha` says what the stored chunks were made from, and the same text costs nothing.

No transaction is open during the embedding call. Chunks are stored only if the text is still the
one embedded; otherwise the job embeds the new text. Nothing here writes to `items`: no `seq` bump.
Trashed records keep their chunks (search filters them; restoring needs no work); a purge removes
them by FK cascade. Hidden ones (merged, voice fragments) have none.
"""

import hashlib

from sqlalchemy import delete, exists, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from assistant.db import queue
from assistant.db.models import EMBEDDING_DIM, Item, JobStatus
from assistant.db.models_search import Chunk
from assistant.embeddings import ChunkEmbedder
from assistant.memory.chunking import TextChunk, chunk_text

JOB_EMBED = "embed:item"
EMBED_VERSION = 1
MAX_RETRIES_ON_EDIT = 3


def embed_key(item_id: int) -> str:
    return f"item:{item_id}:embed:v{EMBED_VERSION}"


async def enqueue_embed(session: AsyncSession, item: Item) -> None:
    """Call after a record's text or title changed, in the same transaction as the change."""
    await queue.enqueue_again(session, JOB_EMBED, {"item_id": item.id}, embed_key(item.id))


def body_of(item: Item) -> str:
    caption = (item.source_meta or {}).get("caption")
    text = item.text if item.text is not None else item.raw_text
    return "\n\n".join(part for part in (caption, text) if part and part.strip())


def fingerprint(title: str | None, body: str) -> str:
    return hashlib.sha256(f"{title or ''}\0{body}".encode()).hexdigest()


def inputs_for(title: str | None, chunks: list[TextChunk]) -> list[str]:
    """Each chunk is embedded with the record's title in front: a piece of a long document says
    little on its own. The title isn't stored in the chunk's text."""
    if not title:
        return [c.text for c in chunks]
    return [c.text if c.text.startswith(title) else f"{title}\n{c.text}" for c in chunks]


async def run_embed(maker: async_sessionmaker[AsyncSession], embedder: ChunkEmbedder,
                    item_id: int) -> int | None:  # fmt: skip
    """Returns the number of chunks now stored; None if there was nothing to do."""
    for _ in range(MAX_RETRIES_ON_EDIT):
        async with maker() as s:
            item = await s.get(Item, item_id)
            if item is None:
                return None
            if item.hidden_reason is not None:
                await s.execute(delete(Chunk).where(Chunk.item_id == item_id))
                await s.commit()
                return None
            title, body, user_id = item.title, body_of(item), item.user_id
            sha = fingerprint(title, body)
            current = await s.scalar(
                select(exists().where(Chunk.item_id == item_id, Chunk.source_sha == sha,
                                      Chunk.embedding_model == embedder.model))
            )  # fmt: skip
            await s.commit()
        if current:
            return None

        pieces = chunk_text(body)
        vectors = await embedder.embed(inputs_for(title, pieces), "document") if pieces else []
        if len(vectors) != len(pieces) or any(len(v) != EMBEDDING_DIM for v in vectors):
            raise ValueError("embedder returned a wrong count or size")

        async with maker() as s:
            item = await s.get(Item, item_id, with_for_update=True,
                               populate_existing=True)  # fmt: skip
            if item is None:
                await s.commit()
                return None
            if fingerprint(item.title, body_of(item)) != sha:
                await s.commit()
                continue  # edited while embedding
            await s.execute(delete(Chunk).where(Chunk.item_id == item_id))
            s.add_all(
                Chunk(item_id=item_id, user_id=user_id, ord=c.ord, text=c.text,
                      token_count=c.token_count, embedding=v, embedding_model=embedder.model,
                      source_sha=sha)
                for c, v in zip(pieces, vectors, strict=True)
            )  # fmt: skip
            await s.commit()
        return len(pieces)
    raise RuntimeError("the record kept changing while being embedded")


async def enqueue_missing(session: AsyncSession, model: str, *, limit: int = 200) -> int:
    """Records with no chunks of the current model: saved before this existed, or a new model
    (spec 3.3, "фоновый re-embed"). A job that is queued or running is left alone."""
    body = func.btrim(func.coalesce(Item.text, Item.raw_text,
                                    Item.source_meta["caption"].astext, ""))  # fmt: skip
    has_chunks = exists().where(Chunk.item_id == Item.id, Chunk.embedding_model == model)
    ids = list(
        await session.scalars(
            select(Item.id)
            .where(Item.deleted_at.is_(None), Item.hidden_reason.is_(None), body != "",
                   ~has_chunks)
            .order_by(Item.id.desc())
            .limit(limit)
        )
    )  # fmt: skip
    for item_id in ids:
        await queue.enqueue_again(session, JOB_EMBED, {"item_id": item_id}, embed_key(item_id),
                                  again_if=(JobStatus.DONE, JobStatus.FAILED))  # fmt: skip
    return len(ids)
