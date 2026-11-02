"""IANA time zones. tzdata is a dependency, so this works on Windows and slim images too."""

from datetime import tzinfo
from functools import lru_cache
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

DEFAULT_TZ = "Asia/Almaty"  # UTC+5 everywhere in Kazakhstan since 2024-03-01


@lru_cache(maxsize=256)
def get_tz(name: str | None) -> tzinfo:
    """Zone by IANA name; empty or unknown names fall back to Asia/Almaty."""
    try:
        return ZoneInfo(name or DEFAULT_TZ)
    except (ZoneInfoNotFoundError, ValueError):
        return ZoneInfo(DEFAULT_TZ)
