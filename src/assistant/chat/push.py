"""Push «Ответ готов» (spec 6.11 p. 4, R-14): never any text of the answer, at most one per 10
minutes, never in quiet hours, only when the answer finished ≥5 s after the phone left.

`PushSender` is the small client class; production has no push credentials yet, so the default
`LogPushSender` only logs (UNVERIFIED: no real APNs/FCM delivery exists). Tests use
`FakePushSender`. The DB mark (`push_sent_at`) is committed before sending: a failed send is never
retried into a second push, and nothing is rolled back.
"""

import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime, time, timedelta
from typing import Protocol
from zoneinfo import ZoneInfo

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from assistant.db.models_chat import ConversationMessage, Delivery
from assistant.logs import error_text

log = logging.getLogger(__name__)

PUSH_TITLE = "Ответ готов"
LEFT_AT_LEAST = timedelta(seconds=5)
ONE_PER = timedelta(minutes=10)


@dataclass(frozen=True)
class PushTarget:
    provider: str  # fcm | apns | expo ...
    token: str


class PushSender(Protocol):
    async def send(self, targets: list[PushTarget], title: str, data: dict[str, str]) -> int:
        """Send one notification without body text; returns how many were accepted."""
        ...


class LogPushSender:
    """No credentials configured: nothing is delivered (logged for the operator)."""

    async def send(self, targets: list[PushTarget], title: str, data: dict[str, str]) -> int:
        log.info("push not configured: would send %r to %d device(s)", title, len(targets))
        return 0


@dataclass
class FakePushSender:
    sent: list[tuple[list[PushTarget], str, dict[str, str]]] = field(default_factory=list)
    fail: bool = False

    async def send(self, targets: list[PushTarget], title: str, data: dict[str, str]) -> int:
        if self.fail:
            raise RuntimeError("push service down")
        self.sent.append((targets, title, data))
        return len(targets)


def in_quiet_hours(now: datetime, tz: str, quiet_from: time, quiet_to: time) -> bool:
    local = now.astimezone(ZoneInfo(tz)).time()
    if quiet_from == quiet_to:
        return False
    if quiet_from < quiet_to:
        return quiet_from <= local < quiet_to
    return local >= quiet_from or local < quiet_to


async def _claim(session: AsyncSession, reply_pk: int, user_id: int, now: datetime) -> bool:
    """Mark the push as sent if the rules allow one now (one per 10 min per person)."""
    last = await session.scalar(select(func.max(ConversationMessage.push_sent_at)).where(
        ConversationMessage.user_id == user_id))  # fmt: skip
    if last is not None and now - last < ONE_PER:
        return False
    res = await session.execute(text("""
        UPDATE conversation_messages SET push_sent_at = :now
        WHERE id = :r AND push_sent_at IS NULL AND delivery = :d
    """), {"now": now, "r": reply_pk, "d": Delivery.BANNER_PENDING})  # fmt: skip
    return bool(res.rowcount)  # type: ignore[attr-defined]


async def maybe_push(sessionmaker: async_sessionmaker[AsyncSession], sender: PushSender, *,
                     reply_pk: int, reply_id: uuid.UUID, user_id: int, now: datetime,
                     left_at: datetime | None) -> bool:  # fmt: skip
    """Called after the answer is committed with `delivery = banner_pending`. `left_at`: when
    the phone dropped the stream (None: nobody was listening, e.g. finished by the worker)."""
    if left_at is not None and now - left_at < LEFT_AT_LEAST:
        return False
    async with sessionmaker() as session:
        user = (await session.execute(text(
            "SELECT tz, quiet_from, quiet_to FROM users WHERE id = :u"), {"u": user_id})).first()
        if user is None or in_quiet_hours(now, user.tz or "Asia/Almaty", user.quiet_from,
                                          user.quiet_to):  # fmt: skip
            return False
        rows = (await session.execute(text("""
            SELECT push_provider, push_token FROM devices
            WHERE user_id = :u AND revoked_at IS NULL AND push_token IS NOT NULL
            ORDER BY last_active_at DESC NULLS LAST, id DESC
        """), {"u": user_id})).all()  # fmt: skip
        if not rows:
            return False
        if not await _claim(session, reply_pk, user_id, now):
            await session.rollback()
            return False
        await session.commit()
    targets = [PushTarget(r.push_provider or "unknown", r.push_token) for r in rows]
    try:
        await sender.send(targets, PUSH_TITLE, {"type": "chat_reply", "reply_id": str(reply_id)})
    except Exception as exc:  # the answer is saved; a lost push is not retried into a second one
        log.warning("push «Ответ готов» failed: %s", error_text(exc))
    return True
