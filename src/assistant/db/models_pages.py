"""Pages schema: `screen_templates`, `screens`, `screen_items` (migration 0007, frozen SQL).

A page is a view on the shared memory, not a folder (R-46). Allowed values are the StrEnums below
and must match the CHECKs in the migration. `seq` is set by the `sync_seq_bump` trigger.
"""

import enum
import uuid
from datetime import datetime

from sqlalchemy import BigInteger, Boolean, DateTime, FetchedValue, ForeignKey, Integer, Text, Uuid
from sqlalchemy import func as sa_func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from assistant.db.ids import uuid7
from assistant.db.models import Base

TODAY_KEY = "today"
MAX_PAGES = 20  # pages.max_per_user, including «Сегодня»


class ScreenKind(enum.StrEnum):
    SYSTEM_TODAY = "system_today"
    PAGE = "page"


class ScreenCreatedBy(enum.StrEnum):
    SYSTEM = "system"
    ONBOARDING_GALLERY = "onboarding_gallery"
    ONBOARDING_BLANK = "onboarding_blank"
    ONBOARDING_PHRASE = "onboarding_phrase"
    USER = "user"
    AGENT = "agent"


class AddedBy(enum.StrEnum):
    RULE = "rule"
    AGENT = "agent"
    USER = "user"


class UpdatedBy(enum.StrEnum):
    USER = "user"
    AGENT = "agent"


class ScreenTemplate(Base):
    """One immutable catalogue row per (key, version); a change is a new version."""

    __tablename__ = "screen_templates"

    key: Mapped[str] = mapped_column(Text, primary_key=True)
    version: Mapped[int] = mapped_column(Integer, primary_key=True)
    owner: Mapped[str] = mapped_column(Text, server_default="system")
    status: Mapped[str] = mapped_column(Text, server_default="published")
    catalog_visible: Mapped[bool] = mapped_column(Boolean, server_default="true")
    catalog_order: Mapped[int] = mapped_column(Integer, server_default="0")
    title: Mapped[dict] = mapped_column(JSONB)  # {"ru": ..., "kk": ... or null}
    description: Mapped[dict] = mapped_column(JSONB, server_default="{}")
    default_title: Mapped[dict] = mapped_column(JSONB)  # what a new page is called
    icon: Mapped[str] = mapped_column(Text)
    preview_ref: Mapped[str | None] = mapped_column(Text)
    singleton: Mapped[bool] = mapped_column(Boolean)
    facet: Mapped[str] = mapped_column(Text)
    fields: Mapped[list] = mapped_column(JSONB)
    layouts: Mapped[list] = mapped_column(JSONB)
    default_layout: Mapped[str] = mapped_column(Text)
    default_view: Mapped[dict] = mapped_column(JSONB, server_default="{}")
    aggregates: Mapped[list] = mapped_column(JSONB, server_default="[]")
    auto_rule: Mapped[dict] = mapped_column(JSONB)
    ai_hints_ref: Mapped[str | None] = mapped_column(Text)
    min_app_version: Mapped[str | None] = mapped_column(Text)
    migrate_from: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=sa_func.now()
    )


class Screen(Base):
    """A user's page. Removal is soft: its items and links stay (R-50)."""

    __tablename__ = "screens"
    __mapper_args__ = {"eager_defaults": True}  # fetch the trigger-set seq after INSERT/UPDATE

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    public_id: Mapped[uuid.UUID] = mapped_column(Uuid, default=uuid7, unique=True)
    client_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(Text, default=ScreenKind.PAGE)
    template_key: Mapped[str] = mapped_column(Text)
    template_version: Mapped[int] = mapped_column(Integer)
    singleton: Mapped[bool] = mapped_column(Boolean)
    title: Mapped[str] = mapped_column(Text)
    title_kk: Mapped[str | None] = mapped_column(Text)
    icon: Mapped[str] = mapped_column(Text)
    position: Mapped[str] = mapped_column(Text(collation="C"))
    layout: Mapped[str] = mapped_column(Text)
    view_state: Mapped[dict] = mapped_column(JSONB, default=dict)
    field_prefs: Mapped[list] = mapped_column(JSONB, default=list)
    custom_fields: Mapped[list] = mapped_column(JSONB, default=list)
    customized: Mapped[bool] = mapped_column(Boolean, default=False)
    view_version: Mapped[int] = mapped_column(Integer, default=1)
    rule: Mapped[dict | None] = mapped_column(JSONB)  # when set, used instead of auto_rule
    created_by: Mapped[str] = mapped_column(Text, default=ScreenCreatedBy.USER)
    action_id: Mapped[int | None] = mapped_column(BigInteger)
    hidden_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_opened_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    seq: Mapped[int] = mapped_column(
        BigInteger, server_default=FetchedValue(), server_onupdate=FetchedValue()
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=sa_func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=sa_func.now(), onupdate=sa_func.now()
    )
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ScreenItem(Base):
    """Item on a page. `updated_at`/`updated_by` are set by hand: they say who last moved the row
    (the rebase rule in 6.12 reads them), so re-keying a page must not touch them."""

    __tablename__ = "screen_items"
    __mapper_args__ = {"eager_defaults": True}

    screen_id: Mapped[int] = mapped_column(
        ForeignKey("screens.id", ondelete="CASCADE"), primary_key=True
    )
    item_id: Mapped[int] = mapped_column(
        ForeignKey("items.id", ondelete="CASCADE"), primary_key=True
    )
    public_id: Mapped[uuid.UUID] = mapped_column(Uuid, default=uuid7, unique=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    position: Mapped[str | None] = mapped_column(Text(collation="C"))
    group_key: Mapped[str | None] = mapped_column(Text)
    manual_order: Mapped[bool] = mapped_column(Boolean, default=False)
    manual_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    pinned: Mapped[bool] = mapped_column(Boolean, default=False)
    added_by: Mapped[str] = mapped_column(Text, default=AddedBy.RULE)
    removed_by_user_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    seq: Mapped[int] = mapped_column(
        BigInteger, server_default=FetchedValue(), server_onupdate=FetchedValue()
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=sa_func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=sa_func.now()
    )
    updated_by: Mapped[str] = mapped_column(Text, default=UpdatedBy.AGENT)
