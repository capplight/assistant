"""Search and summaries schema: `chunks`, `screen_summaries` (migration 0009, frozen SQL).

`items.tsv_simple`, `tsv_ru`, `tsv_spelled` are generated columns read only by raw SQL in
assistant.memory.search, so they are not mapped on Item.
"""

from datetime import datetime

from pgvector.sqlalchemy import Vector
from sqlalchemy import BigInteger, DateTime, FetchedValue, ForeignKey, Integer, Text, func
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from assistant.db.models import EMBEDDING_DIM, Base


class Chunk(Base):
    """A piece of a record's text with its embedding. Replaced as a whole when the text changes."""

    __tablename__ = "chunks"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    item_id: Mapped[int] = mapped_column(ForeignKey("items.id", ondelete="CASCADE"))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    ord: Mapped[int] = mapped_column(Integer)
    text: Mapped[str] = mapped_column(Text)
    token_count: Mapped[int] = mapped_column(Integer)  # estimated: no tokenizer on this side
    embedding: Mapped[list[float]] = mapped_column(Vector(EMBEDDING_DIM))
    embedding_model: Mapped[str] = mapped_column(Text)
    embedded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    source_sha: Mapped[str] = mapped_column(Text)  # hash of what was embedded


class ScreenSummary(Base):
    """A page's summary, counted by code (layer 3 of the chat context). `item_count` and
    `last_titles` are kept by triggers in the transaction that changes the page; `aggregates` by
    assistant.memory.summaries. `seq` is set by the `sync_seq_bump` trigger."""

    __tablename__ = "screen_summaries"
    __mapper_args__ = {"eager_defaults": True}

    screen_id: Mapped[int] = mapped_column(
        ForeignKey("screens.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[int] = mapped_column(BigInteger)
    item_count: Mapped[int] = mapped_column(Integer, server_default="0")
    last_titles: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default="{}")
    aggregates: Mapped[dict] = mapped_column(JSONB, server_default="{}")
    seq: Mapped[int] = mapped_column(
        BigInteger, server_default=FetchedValue(), server_onupdate=FetchedValue()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
