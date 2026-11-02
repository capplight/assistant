"""Free tier. All limit decisions live here so the policy is easy to change."""

from datetime import UTC, datetime

from assistant.bot.dates import get_tz


def month_start_utc(now: datetime, tz_name: str | None) -> datetime:
    """Start of the current calendar month in the user's timezone, as aware UTC."""
    local = now.astimezone(get_tz(tz_name))
    return local.replace(day=1, hour=0, minute=0, second=0, microsecond=0).astimezone(UTC)


def free_tier_allows(used_this_month: int, limit: int) -> bool:
    """May the user save more items? limit <= 0 means unlimited."""
    if limit <= 0:
        return True
    return used_this_month < limit
