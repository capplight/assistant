"""One DB transaction per update + idempotency + user upsert + post-commit outbox."""

from collections.abc import Awaitable, Callable
from contextlib import AbstractAsyncContextManager
from typing import Any

from aiogram import BaseMiddleware
from aiogram.types import TelegramObject, Update
from aiogram.types import User as TgUser
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.bot import service
from assistant.bot.outbox import Outbox
from assistant.db.session import session_scope

SessionFactory = Callable[[], AbstractAsyncContextManager[AsyncSession]]


class DbSessionMiddleware(BaseMiddleware):
    """Outer middleware on `dp.update`.

    Opens `session_scope()` (commit on success, rollback on error), records the update_id in
    ProcessedUpdate (a retried update is skipped), upserts the User and injects `session`,
    `user`, `outbox` and `session_factory` into handler data.

    Handlers queue every Telegram call in `outbox`; it is flushed only after the commit
    succeeded, so the user never sees "Принял ✓" for something that was not saved. Work
    that needs network calls (answering questions) is also queued there and runs after the
    commit with its own short session, so the users row lock from the upsert is not held.

    On error the transaction rolls back (including the ProcessedUpdate row), the outbox is
    dropped and `handlers.on_error` tells the user something went wrong. The error is marked
    handled and the webhook answers 200, so Telegram does NOT redeliver the update: the user
    has to send it again.
    """

    def __init__(self, session_factory: SessionFactory = session_scope) -> None:
        self._session_factory = session_factory

    async def __call__(
        self,
        handler: Callable[[TelegramObject, dict[str, Any]], Awaitable[Any]],
        event: TelegramObject,
        data: dict[str, Any],
    ) -> Any:
        outbox = Outbox()
        async with self._session_factory() as session:
            if isinstance(event, Update) and not await service.mark_update_processed(
                session, event.update_id
            ):
                return None
            tg_user: TgUser | None = data.get("event_from_user")
            data["session"] = session
            data["session_factory"] = self._session_factory
            data["outbox"] = outbox
            data["user"] = (
                await service.ensure_user(session, tg_user.id, tg_user.first_name)
                if tg_user is not None and not tg_user.is_bot
                else None
            )
            result = await handler(event, data)
        # Committed: only now talk to Telegram. Failures are logged inside flush().
        await outbox.flush()
        return result
