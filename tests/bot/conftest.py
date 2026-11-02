from datetime import UTC, datetime
from typing import Any

from aiogram.types import Message


def make_message(**fields: Any) -> Message:
    data: dict[str, Any] = {
        "message_id": 10,
        "date": int(datetime(2026, 11, 2, tzinfo=UTC).timestamp()),
        "chat": {"id": 555, "type": "private"},
        "from": {"id": 555, "is_bot": False, "first_name": "Айгерим"},
    }
    data.update(fields)
    return Message.model_validate(data)


CHANNEL_ORIGIN = {
    "type": "channel",
    "date": 1700000000,
    "chat": {"id": -100123, "type": "channel", "title": "Travel KZ"},
    "message_id": 77,
}
USER_ORIGIN = {
    "type": "user",
    "date": 1700000000,
    "sender_user": {"id": 42, "is_bot": False, "first_name": "Друг"},
}
