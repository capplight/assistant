"""Link metadata without downloading videos: TikTok/Instagram oEmbed, page <title>/og tags.

Every public method returns None on any failure; a missing caption must never fail an item.
"""

import asyncio
import ipaddress
import logging
import re
import socket
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from html import unescape
from html.parser import HTMLParser
from urllib.parse import urljoin, urlsplit

import httpx

from assistant.db.models import ItemSource

log = logging.getLogger(__name__)

PAGE_MAX_BYTES = 512 * 1024
IMAGE_MAX_BYTES = 5 * 1024 * 1024
MAX_REDIRECTS = 3

Resolver = Callable[[str], Awaitable[list[str]]]


@dataclass
class LinkMeta:
    title: str | None = None  # caption for reels/TikToks, <title>/og:title for pages
    author: str | None = None
    description: str | None = None
    thumbnail_url: str | None = None

    def text(self) -> str:
        parts = [
            f"Автор: {self.author}" if self.author else None,
            self.title,
            self.description if self.description != self.title else None,
        ]
        return "\n".join(p for p in parts if p)


async def _default_resolver(host: str) -> list[str]:
    infos = await asyncio.get_running_loop().getaddrinfo(host, None, type=socket.SOCK_STREAM)
    return [info[4][0] for info in infos]


def _strip_tags(html: str) -> str:
    text = re.sub(r"<[^>]+>", " ", html)
    return re.sub(r"\s+", " ", unescape(text)).strip()


class _MetaParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.title: str | None = None
        self.meta: dict[str, str] = {}
        self._in_title = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag == "title":
            self._in_title = True
        elif tag == "meta":
            a = {k.lower(): (v or "") for k, v in attrs}
            key = (a.get("property") or a.get("name") or "").lower()
            if key and "content" in a and key not in self.meta:
                self.meta[key] = a["content"].strip()

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self._in_title = False

    def handle_data(self, data: str) -> None:
        if self._in_title and data.strip():
            self.title = ((self.title or "") + data).strip()


def parse_page_meta(html: str) -> LinkMeta | None:
    parser = _MetaParser()
    try:
        parser.feed(html)
    except Exception:  # malformed html: keep whatever was parsed
        log.debug("html parse error", exc_info=True)
    m = parser.meta
    title = m.get("og:title") or m.get("twitter:title") or parser.title
    desc = m.get("og:description") or m.get("description") or m.get("twitter:description")
    if not title and not desc:
        return None
    return LinkMeta(title=title, description=desc, thumbnail_url=m.get("og:image"))


def parse_oembed(data: dict) -> LinkMeta | None:
    """TikTok and Instagram oEmbed payloads. Instagram may omit `title`; fall back to the
    caption text inside the embed html."""
    if not isinstance(data, dict):
        return None
    title = data.get("title") or None
    if not title and isinstance(data.get("html"), str):
        title = _strip_tags(data["html"])[:2000] or None
    meta = LinkMeta(
        title=title,
        author=data.get("author_name") or data.get("author_unique_id") or None,
        thumbnail_url=data.get("thumbnail_url") or None,
    )
    return meta if (meta.title or meta.author or meta.thumbnail_url) else None


class LinkMetadataClient:
    TIKTOK_URL = "https://www.tiktok.com/oembed"
    GRAPH_URL = "https://graph.facebook.com/{version}/instagram_oembed"

    def __init__(
        self,
        client: httpx.AsyncClient | None = None,
        *,
        instagram_access_token: str | None = None,
        graph_version: str = "v23.0",
        timeout: float = 6.0,
        resolver: Resolver | None = None,
    ) -> None:
        self._client = client or httpx.AsyncClient(
            timeout=timeout, headers={"User-Agent": "Mozilla/5.0 (compatible; TripMemoryBot/1.0)"}
        )
        self._ig_token = instagram_access_token
        self._graph_version = graph_version
        self._timeout = timeout
        self._resolve = resolver or _default_resolver

    async def aclose(self) -> None:
        await self._client.aclose()

    async def fetch(self, url: str, source: ItemSource) -> LinkMeta | None:
        try:
            if source is ItemSource.TIKTOK:
                return await self._oembed(self.TIKTOK_URL, {"url": url})
            if source is ItemSource.INSTAGRAM:
                params = {"url": url, "omitscript": "true"}
                if self._ig_token:
                    params["access_token"] = self._ig_token
                return await self._oembed(
                    self.GRAPH_URL.format(version=self._graph_version), params
                )
            if source is ItemSource.WHATSAPP:
                return None  # chat links carry nothing useful
            return await self._page(url)
        except Exception as e:  # never fail an item because of metadata
            log.info("link metadata failed for %s: %r", source, e)
            return None

    async def fetch_image(self, url: str) -> bytes | None:
        """Small public image (oEmbed thumbnail, og:image). None on any failure or if too big."""
        try:
            body, ctype = await self._get_capped(url, IMAGE_MAX_BYTES)
        except Exception as e:
            log.info("thumbnail fetch failed: %r", e)
            return None
        if body is None or not ctype.startswith("image/"):
            return None
        return body

    async def _oembed(self, endpoint: str, params: dict[str, str]) -> LinkMeta | None:
        resp = await self._client.get(endpoint, params=params, timeout=self._timeout)
        if resp.status_code != 200:
            log.info("oembed %s -> HTTP %s", endpoint, resp.status_code)
            return None
        return parse_oembed(resp.json())

    async def _page(self, url: str) -> LinkMeta | None:
        body, ctype = await self._get_capped(url, PAGE_MAX_BYTES)
        if body is None or "html" not in ctype:
            return None
        return parse_page_meta(body.decode("utf-8", errors="replace"))

    async def _check_public(self, url: str) -> None:
        """SSRF guard: user-supplied URLs must not reach private networks."""
        parts = urlsplit(url)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            raise ValueError("unsupported url")
        for addr in await self._resolve(parts.hostname):
            ip = ipaddress.ip_address(addr.split("%")[0])
            if not ip.is_global:
                raise ValueError(f"non-public address for {parts.hostname}")

    async def _get_capped(self, url: str, cap: int) -> tuple[bytes | None, str]:
        for _ in range(MAX_REDIRECTS + 1):
            await self._check_public(url)
            async with self._client.stream(
                "GET", url, timeout=self._timeout, follow_redirects=False
            ) as resp:
                if resp.is_redirect and "location" in resp.headers:
                    url = urljoin(url, resp.headers["location"])
                    continue
                if resp.status_code != 200:
                    return None, ""
                ctype = resp.headers.get("content-type", "").lower()
                declared = resp.headers.get("content-length")
                if declared and declared.isdigit() and int(declared) > cap and "html" not in ctype:
                    return None, ctype
                chunks: list[bytes] = []
                size = 0
                async for chunk in resp.aiter_bytes():
                    chunks.append(chunk)
                    size += len(chunk)
                    if size >= cap:
                        if "html" not in ctype:
                            return None, ctype  # truncated image is useless
                        break  # the head of an html page has what we need
                return b"".join(chunks)[:cap], ctype
        return None, ""
