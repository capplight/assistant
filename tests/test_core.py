from datetime import timedelta

from assistant.db.models import ItemSource
from assistant.db.queue import backoff
from assistant.links import detect_source, extract_urls, normalize_url, url_hash


def test_same_reel_with_tracking_params_dedups():
    a = "https://www.instagram.com/reel/C1abc/?igsh=MTc4"
    b = "https://instagram.com/reel/C1abc/"
    assert url_hash(a) == url_hash(b)


def test_normalize_keeps_meaningful_query():
    assert normalize_url("https://youtube.com/watch?v=xyz&si=abc") == "https://youtube.com/watch?v=xyz"


def test_detect_source():
    assert detect_source("https://vt.tiktok.com/ZSabc/") is ItemSource.TIKTOK
    assert detect_source("https://t.me/travelkz/123") is ItemSource.TELEGRAM
    assert detect_source("https://instagr.am/p/x") is ItemSource.INSTAGRAM
    assert detect_source("https://booking.com/hotel") is ItemSource.WEB


def test_extract_urls_strips_trailing_punctuation():
    text = "смотри (https://www.tiktok.com/@a/video/1). и https://t.me/c/2!"
    assert extract_urls(text) == ["https://www.tiktok.com/@a/video/1", "https://t.me/c/2"]


def test_backoff_grows_and_caps():
    assert backoff(1) == timedelta(seconds=15)
    assert backoff(2) == timedelta(minutes=1)
    assert backoff(10) == timedelta(hours=1)
