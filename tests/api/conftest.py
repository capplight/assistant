import uuid
from collections.abc import AsyncIterator
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from assistant.api.app import create_app
from assistant.api.deps import CurrentUser, get_active_consent_kinds, get_current_user
from assistant.api.sms import FakeSmsSender
from assistant.api.storage import LocalObjectStorage
from assistant.config import Settings

JWT_SECRET = "test-jwt-secret-0123456789abcdef"
HASH_KEY = "test-hash-key-0123456789abcdef"


def make_settings(**kw: object) -> Settings:
    base: dict[str, object] = dict(
        jwt_secret=JWT_SECRET,
        hash_key=HASH_KEY,
        api_public_base_url="http://test",
        api_dev_mode=True,
    )
    base.update(kw)
    return Settings(_env_file=None, **base)  # type: ignore[call-arg, arg-type]


def make_storage(root: Path) -> LocalObjectStorage:
    return LocalObjectStorage(root, "http://test", b"storage-secret")


def client(app: FastAPI) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


FAKE_USER = CurrentUser(id=1, public_id=uuid.uuid4(), session_id=1, device_id=None, locale="ru")


def unit_app(tmp_path: Path, active_kinds: set[str] | None) -> FastAPI:
    """App without a DB: auth and consent lookup are overridden (None = not signed in)."""
    # Lazy engine: never connects unless a handler runs a query.
    engine = create_async_engine("postgresql+asyncpg://nobody:nothing@127.0.0.1:1/none")
    app = create_app(make_settings(), sessionmaker=async_sessionmaker(engine),
                     sms=FakeSmsSender(), storage=make_storage(tmp_path))  # fmt: skip
    if active_kinds is not None:
        app.dependency_overrides[get_current_user] = lambda: FAKE_USER
        app.dependency_overrides[get_active_consent_kinds] = lambda: frozenset(active_kinds)
    return app


@pytest.fixture
async def db_app(tmp_path: Path) -> AsyncIterator[tuple[FastAPI, FakeSmsSender, AsyncSession]]:
    """App on a real Postgres; everything runs in one outer transaction that is rolled back.

    Endpoint commits become savepoint releases (join_transaction_mode="create_savepoint").
    """
    import os

    engine = create_async_engine(os.environ["DATABASE_URL"])
    async with engine.connect() as conn:
        trans = await conn.begin()
        maker = async_sessionmaker(bind=conn, expire_on_commit=False,
                                   join_transaction_mode="create_savepoint")  # fmt: skip
        sms = FakeSmsSender()
        app = create_app(make_settings(), sessionmaker=maker, sms=sms,
                         storage=make_storage(tmp_path))  # fmt: skip
        check = maker()
        # Worker tests claim the oldest job first, so a job left behind breaks them in odd ways.
        left = await check.scalar(text("SELECT count(*) FROM jobs"))
        assert not left, (
            f"{left} committed jobs in this test database: a test leaked them, or it ran before "
            "the leak was fixed. Fix the test; on an old database run DELETE FROM jobs once."
        )
        await check.commit()
        try:
            yield app, sms, check
        finally:
            await check.close()
            await trans.rollback()
    await engine.dispose()

