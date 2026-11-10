"""КП and «Мой прайс» (migration 0020, frozen SQL; spec 3.6). Allowed values are the StrEnums below
and must match the CHECKs in the migration. `documents.seq` is set by the `sync_seq_bump` trigger.
"""

import enum
import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    FetchedValue,
    ForeignKey,
    Integer,
    LargeBinary,
    Numeric,
    String,
    Text,
    Uuid,
    func,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from assistant.db.ids import uuid7
from assistant.db.models import Base


class LegalForm(enum.StrEnum):
    IP = "ip"  # ИП
    TOO = "too"  # ТОО
    AO = "ao"  # АО
    OTHER = "other"


class DocKind(enum.StrEnum):
    KP = "kp"
    LETTER = "letter"


class DocStatus(enum.StrEnum):
    EXTRACTING = "extracting"  # KP_EXTRACT reads the ТЗ (job `kp:extract`)
    DRAFT = "draft"
    READY = "ready"  # a PDF was made of the current version
    SENT = "sent"  # week 15
    ARCHIVED = "archived"
    FAILED = "failed"  # nothing could be read; `error` says why


class DealStatus(enum.StrEnum):
    """The card file's status strip (template-screens §2.5), set by the person."""

    DRAFT = "draft"
    SENT = "sent"
    SEEN = "seen"
    ACCEPTED = "accepted"
    DECLINED = "declined"


class VersionAuthor(enum.StrEnum):
    INITIAL = "initial"
    TAP_EDIT = "tap_edit"
    AGENT_REQUEST = "agent_request"  # week 15: a phrase (KP_EDIT)
    REVERT = "revert"


class PriceListSource(enum.StrEnum):
    UPLOAD = "upload"
    TYPED_SEQUENCE = "typed_sequence"
    VOICE = "voice"


def _now() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), server_default=func.now())


class DocTemplate(Base):
    __tablename__ = "doc_templates"
    __mapper_args__ = {"eager_defaults": True}

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    public_id: Mapped[uuid.UUID] = mapped_column(Uuid, default=uuid7, unique=True)
    owner: Mapped[str] = mapped_column(Text)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(Text)
    engine: Mapped[str] = mapped_column(Text)
    version: Mapped[int] = mapped_column(Integer)
    storage_key: Mapped[str] = mapped_column(Text)
    template_hash: Mapped[str] = mapped_column(Text)
    fonts_hash: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = _now()


class CompanyProfile(Base):
    __tablename__ = "company_profiles"
    __mapper_args__ = {"eager_defaults": True}

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    public_id: Mapped[uuid.UUID] = mapped_column(Uuid, default=uuid7, unique=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), unique=True)
    name: Mapped[str | None] = mapped_column(Text)
    legal_form: Mapped[str | None] = mapped_column(Text)
    bin_iin_enc: Mapped[bytes | None] = mapped_column(LargeBinary)
    address: Mapped[str | None] = mapped_column(Text)
    bank_enc: Mapped[bytes | None] = mapped_column(LargeBinary)
    contacts: Mapped[dict] = mapped_column(JSONB, default=dict)
    signer: Mapped[dict] = mapped_column(JSONB, default=dict)
    vat_payer: Mapped[bool | None] = mapped_column(Boolean)
    logo_file_id: Mapped[int | None] = mapped_column(ForeignKey("files.id", ondelete="SET NULL"))
    signature_file_id: Mapped[int | None] = mapped_column(
        ForeignKey("files.id", ondelete="SET NULL"))
    stamp_file_id: Mapped[int | None] = mapped_column(ForeignKey("files.id", ondelete="SET NULL"))
    template_id: Mapped[int | None] = mapped_column(
        ForeignKey("doc_templates.id", ondelete="SET NULL"))
    default_terms: Mapped[dict] = mapped_column(JSONB, default=dict)
    review_fields: Mapped[list[str]] = mapped_column(ARRAY(Text), default=list)
    source: Mapped[str] = mapped_column(Text, default="typed")
    version: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = _now()
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class PriceList(Base):
    __tablename__ = "price_lists"
    __mapper_args__ = {"eager_defaults": True}

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    public_id: Mapped[uuid.UUID] = mapped_column(Uuid, default=uuid7, unique=True)
    client_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    item_id: Mapped[int | None] = mapped_column(ForeignKey("items.id", ondelete="SET NULL"))
    file_id: Mapped[int | None] = mapped_column(ForeignKey("files.id", ondelete="SET NULL"))
    source: Mapped[str] = mapped_column(Text)
    title: Mapped[str] = mapped_column(Text)
    reader: Mapped[str | None] = mapped_column(Text)  # table | model
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    uploaded_at: Mapped[datetime] = _now()
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class PriceListItem(Base):
    __tablename__ = "price_list_items"
    __mapper_args__ = {"eager_defaults": True}

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    public_id: Mapped[uuid.UUID] = mapped_column(Uuid, default=uuid7, unique=True)
    client_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    price_list_id: Mapped[int] = mapped_column(ForeignKey("price_lists.id", ondelete="CASCADE"))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    sku: Mapped[str | None] = mapped_column(Text)
    name: Mapped[str] = mapped_column(Text)
    name_norm: Mapped[str] = mapped_column(Text)
    unit: Mapped[str | None] = mapped_column(Text)
    price: Mapped[Decimal] = mapped_column(Numeric(14, 2))
    currency: Mapped[str] = mapped_column(String(3), default="KZT")
    review_fields: Mapped[list[str]] = mapped_column(ARRAY(Text), default=list)
    source_ref: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = _now()
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Document(Base):
    __tablename__ = "documents"
    __mapper_args__ = {"eager_defaults": True}

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    public_id: Mapped[uuid.UUID] = mapped_column(Uuid, default=uuid7, unique=True)
    client_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    item_id: Mapped[int] = mapped_column(ForeignKey("items.id", ondelete="CASCADE"), unique=True)
    kind: Mapped[str] = mapped_column(Text, default=DocKind.KP)
    title: Mapped[str] = mapped_column(Text)
    number: Mapped[str | None] = mapped_column(Text)
    year: Mapped[int | None] = mapped_column(Integer)
    seq_no: Mapped[int | None] = mapped_column(Integer)
    client: Mapped[dict] = mapped_column(JSONB, default=dict)
    status: Mapped[str] = mapped_column(Text)
    deal_status: Mapped[str] = mapped_column(Text, default=DealStatus.DRAFT)
    current_version_n: Mapped[int | None] = mapped_column(Integer)
    sent_version_n: Mapped[int | None] = mapped_column(Integer)
    source_item_ids: Mapped[list[int]] = mapped_column(ARRAY(BigInteger), default=list)
    request_text: Mapped[str | None] = mapped_column(Text)
    deal_active: Mapped[bool] = mapped_column(Boolean, default=True)
    ai_generated: Mapped[bool] = mapped_column(Boolean, default=True)
    progress: Mapped[dict] = mapped_column(JSONB, default=dict)
    draft: Mapped[dict] = mapped_column(JSONB, default=dict)
    error: Mapped[str | None] = mapped_column(Text)
    version: Mapped[int] = mapped_column(Integer, default=1)
    seq: Mapped[int] = mapped_column(
        BigInteger, server_default=FetchedValue(), server_onupdate=FetchedValue()
    )
    created_at: Mapped[datetime] = _now()
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class DocumentVersion(Base):
    __tablename__ = "document_versions"
    __mapper_args__ = {"eager_defaults": True}

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    public_id: Mapped[uuid.UUID] = mapped_column(Uuid, default=uuid7, unique=True)
    document_id: Mapped[int] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    n: Mapped[int] = mapped_column(Integer)
    data: Mapped[dict] = mapped_column(JSONB)
    totals: Mapped[dict] = mapped_column(JSONB)
    calc_version: Mapped[str] = mapped_column(Text)
    vat_rate: Mapped[Decimal | None] = mapped_column(Numeric(5, 2))
    vat_mode: Mapped[str] = mapped_column(Text)
    template_id: Mapped[int | None] = mapped_column(
        ForeignKey("doc_templates.id", ondelete="SET NULL"))
    patch: Mapped[list] = mapped_column(JSONB, default=list)
    changed_paths: Mapped[list[str]] = mapped_column(ARRAY(Text), default=list)
    author: Mapped[str] = mapped_column(Text)
    request_text: Mapped[str | None] = mapped_column(Text)
    render_file_id: Mapped[int | None] = mapped_column(ForeignKey("files.id", ondelete="SET NULL"))
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    sent_channel: Mapped[str | None] = mapped_column(Text)
    ai_generated: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = _now()


class KpPriceHistory(Base):
    __tablename__ = "kp_price_history"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(Text)
    name_norm: Mapped[str] = mapped_column(Text)
    unit: Mapped[str | None] = mapped_column(Text)
    unit_price: Mapped[Decimal] = mapped_column(Numeric(14, 2))
    currency: Mapped[str] = mapped_column(String(3), default="KZT")
    document_id: Mapped[int] = mapped_column(ForeignKey("documents.id", ondelete="CASCADE"))
    version_n: Mapped[int] = mapped_column(Integer)
    client_name: Mapped[str | None] = mapped_column(Text)
    client_key: Mapped[str | None] = mapped_column(Text)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = _now()
