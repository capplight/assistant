from datetime import UTC, datetime

from assistant.bot.limits import free_tier_allows, month_start_utc


def test_free_tier():
    assert free_tier_allows(0, 30)
    assert free_tier_allows(29, 30)
    assert not free_tier_allows(30, 30)
    assert not free_tier_allows(31, 30)
    assert free_tier_allows(1000, 0)  # 0 = unlimited


def test_month_start_in_user_tz():
    # 31 Oct 20:00 UTC is already 1 Nov 01:00 in Almaty (UTC+5)
    now = datetime(2026, 10, 31, 20, 0, tzinfo=UTC)
    assert month_start_utc(now, "Asia/Almaty") == datetime(2026, 10, 31, 19, 0, tzinfo=UTC)
