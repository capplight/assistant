"""URL helpers shared by the bot (dedup at intake) and the pipeline (routing by source)."""

import hashlib
import re
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from assistant.db.models import ItemSource

URL_RE = re.compile(r"https?://[^\s<>\"'«»]+", re.IGNORECASE)

# Tracking params that make the same reel look like different URLs.
_DROP_PARAMS = {"igsh", "igshid", "utm_source", "utm_medium", "utm_campaign", "utm_content",
                "utm_term", "si", "is_from_webapp", "sender_device", "_r", "_t", "fbclid"}

_SOURCES: list[tuple[re.Pattern[str], ItemSource]] = [
    (re.compile(r"(^|\.)instagram\.com$|(^|\.)instagr\.am$"), ItemSource.INSTAGRAM),
    (re.compile(r"(^|\.)tiktok\.com$"), ItemSource.TIKTOK),
    (re.compile(r"(^|\.)t\.me$|(^|\.)telegram\.me$"), ItemSource.TELEGRAM),
    (re.compile(r"(^|\.)wa\.me$|(^|\.)whatsapp\.com$"), ItemSource.WHATSAPP),
    (re.compile(r"(^|\.)youtube\.com$|(^|\.)youtu\.be$"), ItemSource.YOUTUBE),
]


def extract_urls(text: str | None) -> list[str]:
    if not text:
        return []
    return [u.rstrip(".,;:!?)]}") for u in URL_RE.findall(text)]


def normalize_url(url: str) -> str:
    parts = urlsplit(url.strip())
    host = (parts.hostname or "").lower().removeprefix("www.").removeprefix("m.")
    query = urlencode([(k, v) for k, v in parse_qsl(parts.query) if k.lower() not in _DROP_PARAMS])
    path = parts.path.rstrip("/") or "/"
    return urlunsplit(("https", host, path, query, ""))


def url_hash(url: str) -> str:
    return hashlib.sha256(normalize_url(url).encode()).hexdigest()


def detect_source(url: str) -> ItemSource:
    host = (urlsplit(url).hostname or "").lower()
    for pattern, source in _SOURCES:
        if pattern.search(host):
            return source
    return ItemSource.WEB
