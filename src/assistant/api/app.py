"""FastAPI app factory for the mobile REST API (/v1). Separate from the Telegram bot app."""

import hashlib
import hmac
import logging
from collections.abc import Awaitable, Callable

from fastapi import APIRouter, FastAPI, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from assistant.api.deps import ApiContext
from assistant.api.errors import install_error_handlers
from assistant.api.routes import auth, consents, devices, items, misc, sync, uploads
from assistant.api.sms import SmsSender, make_sms_sender
from assistant.api.storage import LocalObjectStorage, ObjectStorage, make_storage
from assistant.config import Settings, get_settings

log = logging.getLogger(__name__)

API_VERSION = "1"


def _secret(value: str, name: str, settings: Settings) -> bytes:
    if value:
        return value.encode()
    if settings.api_dev_mode:
        log.warning("%s is empty: using an insecure dev secret (API_DEV_MODE=true)", name.upper())
        return hashlib.sha256(f"assistant-dev-{name}".encode()).digest()
    raise RuntimeError(f"{name.upper()} must be set (or API_DEV_MODE=true for local dev)")


def storage_from_settings(settings: Settings) -> ObjectStorage:
    """The object store the API (uploads) and the ingest worker (reads originals) share."""
    jwt_secret = _secret(settings.jwt_secret.get_secret_value(), "jwt_secret", settings)
    return make_storage(
        settings.storage_backend,
        local_dir=settings.storage_local_dir,
        public_base_url=settings.api_public_base_url,
        secret=hmac.digest(jwt_secret, b"storage", "sha256"),
    )


def create_app(
    settings: Settings | None = None,
    *,
    sessionmaker: async_sessionmaker[AsyncSession] | None = None,
    sms: SmsSender | None = None,
    storage: ObjectStorage | None = None,
) -> FastAPI:
    settings = settings or get_settings()
    jwt_secret = _secret(settings.jwt_secret.get_secret_value(), "jwt_secret", settings)
    hash_key = _secret(settings.hash_key.get_secret_value(), "hash_key", settings)
    if sessionmaker is None:
        from assistant.db.session import get_sessionmaker

        sessionmaker = get_sessionmaker()
    storage = storage or storage_from_settings(settings)
    ctx = ApiContext(settings=settings, sessionmaker=sessionmaker,
                     sms=sms or make_sms_sender(settings.sms_provider), storage=storage,
                     jwt_secret=jwt_secret, hash_key=hash_key)  # fmt: skip

    app = FastAPI(title="Assistant API", version=API_VERSION)
    app.state.ctx = ctx
    install_error_handlers(app)

    @app.middleware("http")
    async def _version_header(
        request: Request, call_next: Callable[[Request], Awaitable[Response]]
    ) -> Response:
        response = await call_next(request)
        response.headers["X-Api-Version"] = API_VERSION
        return response

    v1 = APIRouter(prefix="/v1")
    for router in (auth.router, consents.router, devices.router, uploads.router, items.router,
                   sync.router, misc.ai):
        v1.include_router(router)
    if isinstance(storage, LocalObjectStorage):
        v1.include_router(misc.dev_storage)
    app.include_router(v1)
    app.include_router(misc.health)
    return app
