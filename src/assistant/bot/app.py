"""Bot/Dispatcher construction and the webhook FastAPI app."""

import hmac
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from aiogram import Bot, Dispatcher
from aiogram.client.session.aiohttp import AiohttpSession
from aiogram.client.telegram import TelegramAPIServer
from aiogram.types import Update
from fastapi import FastAPI, Request, Response

from assistant.bot.handlers import build_router
from assistant.bot.middleware import DbSessionMiddleware, SessionFactory
from assistant.config import Settings
from assistant.db.session import session_scope

log = logging.getLogger(__name__)

WEBHOOK_PATH = "/telegram/webhook"
SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token"


def create_bot(settings: Settings) -> Bot:
    session = None
    if settings.telegram_api_base:
        session = AiohttpSession(
            api=TelegramAPIServer.from_base(settings.telegram_api_base, is_local=True)
        )
    return Bot(token=settings.bot_token.get_secret_value(), session=session)


def create_dispatcher(session_factory: SessionFactory = session_scope) -> Dispatcher:
    dp = Dispatcher()
    dp.update.outer_middleware(DbSessionMiddleware(session_factory))
    dp.include_router(build_router())
    return dp


def secret_ok(received: str | None, expected: str) -> bool:
    return bool(expected) and received is not None and hmac.compare_digest(received, expected)


def create_webhook_app(bot: Bot, dp: Dispatcher, settings: Settings) -> FastAPI:
    secret = settings.webhook_secret.get_secret_value()
    if not secret:
        raise RuntimeError("WEBHOOK_SECRET must be set in webhook mode")
    url = settings.webhook_base_url.rstrip("/") + WEBHOOK_PATH

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        await bot.set_webhook(
            url, secret_token=secret, allowed_updates=dp.resolve_used_update_types()
        )
        log.info("webhook set to %s", url)
        try:
            yield
        finally:
            await bot.session.close()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post(WEBHOOK_PATH)
    async def webhook(request: Request) -> Response:
        if not secret_ok(request.headers.get(SECRET_HEADER), secret):
            return Response(status_code=403)
        update = Update.model_validate(await request.json(), context={"bot": bot})
        try:
            await dp.feed_update(bot, update)
        except Exception:
            # Already rolled back. Answer 200 so one broken update doesn't block the chat
            # with endless retries; it is logged for investigation.
            log.exception("failed to handle update %s", update.update_id)
        return Response(status_code=200)

    return app
