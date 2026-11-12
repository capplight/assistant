"""Per-person message limit on the assistant line (week 18, founder 2026-11-12; docs/api/chat.md).

Only phrases the person sends count: user rows of `conversation_messages` without a tap
(`choice`). Background work (resumes, deferred answers, jobs) writes no user rows, so it never
counts and is never refused. A retried `client_id` is answered before this check. Limits by
`users.profile`: `chat_rate_per_minute`, `chat_rate_per_day` (a missing profile = `regular`);
0 or less = no limit. The day is computed in `budget_tz`, like the AI budgets.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.ai.store import period_starts
from assistant.config import Settings

MINUTE = timedelta(seconds=60)


class RateLimited(Exception):
    """`code`: chat_rate_limited (per minute) | chat_daily_limit; `retry_after` in seconds."""

    def __init__(self, code: str, retry_after: int) -> None:
        super().__init__(code)
        self.code, self.retry_after = code, retry_after


@dataclass(frozen=True)
class Limits:
    per_minute: int
    per_day: int


def limits_for(settings: Settings, profile: str | None) -> Limits:
    key = profile or "regular"
    minute = settings.chat_rate_per_minute
    day = settings.chat_rate_per_day
    return Limits(per_minute=minute.get(key, minute.get("regular", 0)),
                  per_day=day.get(key, day.get("regular", 0)))  # fmt: skip


async def check(session: AsyncSession, user_id: int, now: datetime, settings: Settings) -> None:
    """Raise RateLimited when one more phrase would go over a limit. `now`: wall-clock UTC (the
    rows' `created_at` is the database's clock)."""
    profile = await session.scalar(text("SELECT profile FROM users WHERE id = :u"),
                                   {"u": user_id})  # fmt: skip
    lim = limits_for(settings, profile)
    if lim.per_minute <= 0 and lim.per_day <= 0:
        return
    day_start, _ = period_starts(now, settings.budget_tz)
    since = min(day_start, now - MINUTE)
    row = (await session.execute(text("""
        SELECT count(*) FILTER (WHERE created_at > :minute) AS minute_n,
               min(created_at) FILTER (WHERE created_at > :minute) AS minute_first,
               count(*) FILTER (WHERE created_at >= :day) AS day_n
        FROM conversation_messages
        WHERE user_id = :u AND role = 'user' AND created_at >= :since
          AND (choice IS NULL OR jsonb_typeof(choice) <> 'object')  -- JSON null: not a tap
    """), {"u": user_id, "minute": now - MINUTE, "day": day_start, "since": since})).one()
    if lim.per_day > 0 and row.day_n >= lim.per_day:
        next_day = period_starts(day_start + timedelta(hours=36), settings.budget_tz)[0]
        raise RateLimited("chat_daily_limit", max(1, int((next_day - now).total_seconds())))
    if lim.per_minute > 0 and row.minute_n >= lim.per_minute:
        wait = (row.minute_first + MINUTE - now).total_seconds() if row.minute_first else 60
        raise RateLimited("chat_rate_limited", max(1, min(60, int(wait) + 1)))
