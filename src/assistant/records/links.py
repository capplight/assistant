"""Content of a shared link (spec 5.7 rule 7, 6.1): only URLs the person sent, never model output.

Instagram and TikTok: oEmbed metadata only; videos and their pages are never fetched. Other sites:
the page through the SSRF-guarded client in `assistant.pipeline` (public addresses only, ports
80/443, every redirect re-checked, 10 s, 5 MB) and its main text through trafilatura.
Whatever comes back is untrusted data. A failed fetch never fails the record.
"""

import asyncio
import logging
from dataclasses import asdict, dataclass
from typing import Protocol

from assistant.db.models import ItemSource
from assistant.links import detect_source
from assistant.logs import error_text
from assistant.pipeline import LinkMetadataClient, parse_page_meta

log = logging.getLogger(__name__)

METADATA_ONLY = frozenset({ItemSource.INSTAGRAM, ItemSource.TIKTOK, ItemSource.WHATSAPP})
MAX_PAGE_TEXT = 50_000


@dataclass
class LinkContent:
    source: str
    title: str | None = None
    author: str | None = None
    description: str | None = None
    thumbnail_url: str | None = None
    text: str | None = None

    def meta(self) -> dict:
        """What goes to source_meta.link: everything but the text."""
        data = asdict(self)
        data.pop("text")
        return {k: v for k, v in data.items() if v}


class LinkReader(Protocol):
    async def read(self, url: str) -> LinkContent | None: ...


def extract_main_text(html: str) -> str | None:
    """Main text of a page, or None. Parses a string; trafilatura never fetches anything here."""
    try:
        import trafilatura

        text = trafilatura.extract(html, include_comments=False, include_tables=True,
                                   favor_precision=True)  # fmt: skip
    except Exception as exc:  # hostile or broken html must not fail the record
        log.info("page text extraction failed: %s", error_text(exc))
        return None
    return text[:MAX_PAGE_TEXT] if text else None


class WebLinkReader:
    def __init__(self, client: LinkMetadataClient) -> None:
        self.client = client

    async def read(self, url: str) -> LinkContent | None:
        source = detect_source(url)
        if source in METADATA_ONLY:
            meta = await self.client.fetch(url, source)
            if meta is None:
                return None
            return LinkContent(source=str(source), title=meta.title, author=meta.author,
                               description=meta.description,
                               thumbnail_url=meta.thumbnail_url)  # fmt: skip
        html = await self.client.fetch_html(url)
        if html is None:
            return None
        meta = await asyncio.to_thread(parse_page_meta, html)
        text = await asyncio.to_thread(extract_main_text, html)
        if meta is None and text is None:
            return None
        return LinkContent(source=str(source), text=text, title=meta.title if meta else None,
                           description=meta.description if meta else None,
                           thumbnail_url=meta.thumbnail_url if meta else None)  # fmt: skip


class FakeLinkReader:
    """Canned content for tests and offline dev."""

    def __init__(self, content: LinkContent | None = None) -> None:
        self.content = content
        self.urls: list[str] = []

    async def read(self, url: str) -> LinkContent | None:
        self.urls.append(url)
        return self.content
