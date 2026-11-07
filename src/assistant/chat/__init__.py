"""The assistant line and «Переписка» (spec 3.13, 5.10, 6.11; F-37, R-52, R-53, R-56).

One conversation per person across all pages. Public surface:
- `ChatService(settings, sessionmaker, router, embedder)`: `start(user_id, locale, ChatRequest)`
  saves the phrase and writes the answer in the background; `resume(user_id, reply_id, after)`
  yields its events (live or a DB snapshot); `drain()` waits for answers being written.
- `store`: conversation rows and their JSON shape (`message_dict`, `messages_dicts`).
- `verify`: the number/date check (R-36), `READ_TOOLS`: the read tools' `ToolSpec`s.
API contract: docs/api/chat.md.
"""

from assistant.chat import store
from assistant.chat.service import ChatReply, ChatRequest, ChatService, ReplyRun
from assistant.chat.tools import READ_TOOLS

__all__ = ["READ_TOOLS", "ChatReply", "ChatRequest", "ChatService", "ReplyRun", "store"]
