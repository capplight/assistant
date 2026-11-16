"""Memory about the person and conversation search (migration 0030, frozen SQL).

`memory_facts`: one short fact per row (assistant.chat.memory). `message_embeddings`: a past
turn's vector, kept apart from `conversation_messages` so it never moves the message's sync `seq`.
`conversation_messages.tsv` is a generated column read only by raw SQL (assistant.chat.recall).
"""

import enum
import uuid
from datetime import date, datetime

from pgvector.sqlalchemy import Vector
from sqlalchemy import BigInteger, Date, DateTime, ForeignKey, Integer, Text, Uuid, func, text
from sqlalchemy.orm import Mapped, mapped_column

from assistant.db.models import EMBEDDING_DIM, Base


class FactKind(enum.StrEnum):
    PERSON = "person"
    PLACE = "place"
    PREFERENCE = "preference"
    ROUTINE = "routine"
    PROJECT = "project"  # «Ремонт кухни: мастер Серик», «Поездка в Стамбул 10–15 дек.»
    AGREEMENT = "agreement"  # «итоги трат показывай в тенге»
    OTHER = "other"


class FactSource(enum.StrEnum):
    SAID = "said"  # the person's own words
    MATERIAL = "material"  # their saved / forwarded materials: «из материала» (Ф-70)


class MemoryFact(Base):
    __tablename__ = "memory_facts"
    __mapper_args__ = {"eager_defaults": True}

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    public_id: Mapped[uuid.UUID] = mapped_column(Uuid, server_default=text("gen_random_uuid()"))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(Text)
    text: Mapped[str] = mapped_column(Text)
    fact_key: Mapped[str] = mapped_column(Text)
    source: Mapped[str] = mapped_column(Text, default=FactSource.SAID)
    source_message_id: Mapped[int | None] = mapped_column(
        ForeignKey("conversation_messages.id", ondelete="SET NULL"))
    source_item_id: Mapped[int | None] = mapped_column(
        ForeignKey("items.id", ondelete="SET NULL"))
    mentions: Mapped[int] = mapped_column(Integer, default=1)
    valid_until: Mapped[date | None] = mapped_column(Date)
    embedding: Mapped[list[float] | None] = mapped_column(Vector(EMBEDDING_DIM))
    embedding_model: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
    last_seen_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now())


class MessageEmbedding(Base):
    __tablename__ = "message_embeddings"

    message_id: Mapped[int] = mapped_column(
        ForeignKey("conversation_messages.id", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    embedding: Mapped[list[float]] = mapped_column(Vector(EMBEDDING_DIM))
    embedding_model: Mapped[str] = mapped_column(Text)
    embedded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now())
