"""Per-update outbox: Telegram calls queued by handlers, run only after the DB commit.

Handlers never talk to Telegram directly. They queue replies (and other post-commit work
such as answering a question) here; `DbSessionMiddleware` flushes the outbox after
`session_scope` committed and drops it on rollback. A failed send is logged and swallowed:
it must never roll back or re-run what was already committed.
"""

import logging
from collections.abc import Awaitable, Callable
from functools import partial
from typing import Any

from aiogram.types import CallbackQuery, Message

from assistant.logs import error_text
from assistant.notify import Notifier, OutMessage

log = logging.getLogger(__name__)

Action = Callable[[], Awaitable[Any]]


class Outbox:
    def __init__(self) -> None:
        self._actions: list[Action] = []

    def add(self, action: Action) -> None:
        """Queue any zero-argument coroutine function to run after commit."""
        self._actions.append(action)

    def reply(self, message: Message, text: str, **kw: Any) -> None:
        self.add(partial(message.reply, text, **kw))

    def answer(self, message: Message, text: str, **kw: Any) -> None:
        self.add(partial(message.answer, text, **kw))

    def answer_callback(self, query: CallbackQuery, text: str | None = None) -> None:
        self.add(partial(query.answer, text))

    def notifier(self, real: Notifier) -> Notifier:
        """A Notifier whose sends are queued here instead of going out immediately."""
        return _DeferredNotifier(self, real)

    def __len__(self) -> int:
        return len(self._actions)

    async def flush(self) -> None:
        actions, self._actions = self._actions, []
        for action in actions:
            try:
                await action()
            except Exception as exc:  # blocked bot, flood limit, expired query...
                log.warning("post-commit send failed: %s", error_text(exc))


class _DeferredNotifier:
    def __init__(self, outbox: Outbox, real: Notifier) -> None:
        self._outbox = outbox
        self._real = real

    async def send(self, message: OutMessage) -> None:
        self._outbox.add(partial(self._real.send, message))
