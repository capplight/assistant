"""Outgoing messages to users from outside a bot handler (worker, scheduler).

Modules depend on the Notifier protocol, not on aiogram, so tests pass a FakeNotifier.
"""

from dataclasses import dataclass, field
from typing import Protocol


@dataclass
class Button:
    text: str
    callback_data: str  # <= 64 bytes, Telegram limit


@dataclass
class OutMessage:
    chat_id: int
    text: str
    reply_to_message_id: int | None = None
    buttons: list[list[Button]] = field(default_factory=list)  # rows of inline buttons


class Notifier(Protocol):
    async def send(self, message: OutMessage) -> None: ...


class TelegramNotifier:
    def __init__(self, bot) -> None:  # aiogram.Bot; untyped to keep aiogram out of imports here
        self._bot = bot

    async def send(self, message: OutMessage) -> None:
        from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup, ReplyParameters

        markup = None
        if message.buttons:
            markup = InlineKeyboardMarkup(
                inline_keyboard=[
                    [InlineKeyboardButton(text=b.text, callback_data=b.callback_data) for b in row]
                    for row in message.buttons
                ]
            )
        reply = (
            ReplyParameters(
                message_id=message.reply_to_message_id, allow_sending_without_reply=True
            )
            if message.reply_to_message_id
            else None
        )
        await self._bot.send_message(
            message.chat_id, message.text, reply_markup=markup, reply_parameters=reply
        )


class FakeNotifier:
    """Collects messages instead of sending. For tests."""

    def __init__(self) -> None:
        self.sent: list[OutMessage] = []

    async def send(self, message: OutMessage) -> None:
        self.sent.append(message)
