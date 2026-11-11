"""Data export and account deletion (migration 0022; spec 3.7 `account_deletions`, 4.9, 7.2;
contract docs/api/account.md)."""

import enum
import uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Text, Uuid, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from assistant.db.ids import uuid7
from assistant.db.models import Base


class DeletionVia(enum.StrEnum):
    APP = "app"
    WEB = "web"


class ExportStatus(enum.StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    READY = "ready"
    FAILED = "failed"
    EXPIRED = "expired"


class AccountDeletion(Base):
    """One request to delete an account. No FK to users: it outlives the account (user_id is
    cleared by the purge, `report` keeps counts only)."""

    __tablename__ = "account_deletions"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    public_id: Mapped[uuid.UUID] = mapped_column(Uuid, default=uuid7, unique=True)
    user_id: Mapped[int | None] = mapped_column(BigInteger)
    via: Mapped[str] = mapped_column(Text)
    requested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True),
                                                   server_default=func.now())
    cancel_until: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    executed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    report: Mapped[dict] = mapped_column(JSONB, default=dict)
    restore_hash: Mapped[str | None] = mapped_column(Text)
    restore_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class DataExport(Base):
    """«Скачать мои данные»: one ZIP in object storage, kept 24 h."""

    __tablename__ = "data_exports"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    public_id: Mapped[uuid.UUID] = mapped_column(Uuid, default=uuid7, unique=True)
    client_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    status: Mapped[str] = mapped_column(Text, default=ExportStatus.QUEUED)
    storage_key: Mapped[str | None] = mapped_column(Text)
    bytes: Mapped[int | None] = mapped_column(BigInteger)
    counts: Mapped[dict] = mapped_column(JSONB, default=dict)
    error: Mapped[str | None] = mapped_column(Text)
    requested_at: Mapped[datetime] = mapped_column(DateTime(timezone=True),
                                                   server_default=func.now())
    ready_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
