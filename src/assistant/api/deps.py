"""FastAPI dependencies: app context, DB session, current user, active consents.

Tests override `get_current_user` / `get_active_consent_kinds` / `get_db` to run without a DB.
"""

import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from assistant.api.errors import ApiError
from assistant.api.security import TokenError, keyed_hash, verify_access_token
from assistant.api.sms import SmsSender
from assistant.api.storage import ObjectStorage
from assistant.config import Settings
from assistant.db.models import User
from assistant.db.models_v2 import AuthSession, Consent, UserStatus


@dataclass
class ApiContext:
    settings: Settings
    sessionmaker: async_sessionmaker[AsyncSession]
    sms: SmsSender
    storage: ObjectStorage
    jwt_secret: bytes
    hash_key: bytes

    def hash(self, value: str, *, purpose: str) -> str:
        return keyed_hash(self.hash_key, value, purpose=purpose)


@dataclass(frozen=True)
class CurrentUser:
    id: int
    public_id: uuid.UUID
    session_id: int
    device_id: int | None
    locale: str


def get_ctx(request: Request) -> ApiContext:
    ctx: ApiContext = request.app.state.ctx
    return ctx


Ctx = Annotated[ApiContext, Depends(get_ctx)]


async def get_db(ctx: Ctx) -> AsyncIterator[AsyncSession]:
    """One transaction per request: commit on success, rollback on error."""
    async with ctx.sessionmaker() as session:
        try:
            yield session
            await session.commit()
        except BaseException:
            await session.rollback()
            raise


Db = Annotated[AsyncSession, Depends(get_db)]


def client_ip_hash(request: Request, ctx: ApiContext) -> str | None:
    host = request.client.host if request.client else None
    return ctx.hash(host, purpose="ip") if host else None


def _bearer(request: Request) -> str | None:
    header = request.headers.get("authorization", "")
    scheme, _, token = header.partition(" ")
    return token.strip() if scheme.lower() == "bearer" and token.strip() else None


async def _load_user(token: str, ctx: ApiContext, db: AsyncSession) -> CurrentUser:
    try:
        claims = verify_access_token(token, ctx.jwt_secret)
    except TokenError as exc:
        raise ApiError(401, "unauthorized") from exc
    row = (
        await db.execute(
            select(AuthSession, User)
            .join(User, User.id == AuthSession.user_id)
            .where(AuthSession.public_id == claims.session_public_id)
        )
    ).first()
    if row is None:
        raise ApiError(401, "unauthorized")
    session, user = row.tuple()
    if session.revoked_at is not None or user.public_id != claims.user_public_id:
        raise ApiError(401, "unauthorized")
    if user.status != UserStatus.ACTIVE:
        raise ApiError(403, "account_blocked")
    return CurrentUser(user.id, user.public_id, session.id, session.device_id, user.locale)


async def get_current_user(request: Request, ctx: Ctx, db: Db) -> CurrentUser:
    token = _bearer(request)
    if token is None:
        raise ApiError(401, "unauthorized")
    return await _load_user(token, ctx, db)


async def get_optional_user(request: Request, ctx: Ctx, db: Db) -> CurrentUser | None:
    token = _bearer(request)
    return None if token is None else await _load_user(token, ctx, db)


async def active_consent_kinds(db: AsyncSession, user_id: int) -> frozenset[str]:
    rows = await db.scalars(
        select(Consent.kind)
        .where(Consent.user_id == user_id, Consent.revoked_at.is_(None))
        .distinct()
    )
    return frozenset(rows)


async def get_active_consent_kinds(
    user: Annotated[CurrentUser, Depends(get_current_user)], db: Db
) -> frozenset[str]:
    return await active_consent_kinds(db, user.id)


AuthUser = Annotated[CurrentUser, Depends(get_current_user)]
OptionalUser = Annotated[CurrentUser | None, Depends(get_optional_user)]
