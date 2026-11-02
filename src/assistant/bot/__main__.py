"""`python -m assistant.bot`: long polling without WEBHOOK_BASE_URL, webhook server with it."""

import asyncio

from assistant.bot.app import create_bot, create_dispatcher, create_webhook_app
from assistant.config import get_settings
from assistant.logs import configure_logging


async def _polling() -> None:
    settings = get_settings()
    bot = create_bot(settings)
    dp = create_dispatcher()
    await bot.delete_webhook(drop_pending_updates=False)
    try:
        await dp.start_polling(bot, allowed_updates=dp.resolve_used_update_types())
    finally:
        await bot.session.close()


def main() -> None:
    settings = get_settings()
    configure_logging(settings.log_level)
    if not settings.webhook_base_url:
        asyncio.run(_polling())
        return
    import uvicorn

    app = create_webhook_app(create_bot(settings), create_dispatcher(), settings)
    uvicorn.run(app, host="0.0.0.0", port=8080, log_level=settings.log_level.lower())


if __name__ == "__main__":
    main()
