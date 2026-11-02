"""One DB transaction per update + idempotency + user upsert."""

from collections.abc import Awaitable, Callable
from contextlib import AbstractAsyncContextManager
from typing import Any

from aiogram import BaseMiddleware
from aiogram.types import TelegramObject, Update
from aiogram.types import User as TgUser
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.bot import service
from assistant.db.session import session_scope

SessionFactory = Callable[[], AbstractAsyncContextManager[AsyncSession]]


class DbSessionMiddleware(BaseMiddleware):
    """Outer middleware on `dp.update`.

    Opens `session_scope()` (commit on success, rollback on error), records the update_id in
    ProcessedUpdate (a retried update is skipped), upserts the User and injects
    `session` and `user` into handler data. On error the transaction rolls back, including
    the ProcessedUpdate row, so Telegram's retry is handled again.
    """

    def __init__(self, session_factory: SessionFactory = session_scope) -> None:
        self._session_factory = session_factory

    async def __call__(
        self,
        handler: Callable[[TelegramObject, dict[str, Any]], Awaitable[Any]],
        event: TelegramObject,
        data: dict[str, Any],
    ) -> Any:
        async with self._session_factory() as session:
            if isinstance(event, Update) and not await service.mark_update_processed(
                session, event.update_id
            ):
                return None
            tg_user: TgUser | None = data.get("event_from_user")
            data["session"] = session
            data["user"] = (
                await service.ensure_user(session, tg_user.id, tg_user.first_name)
                if tg_user is not None and not tg_user.is_bot
                else None
            )
            return await handler(event, data)
