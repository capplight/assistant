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
from urllib.parse import urljoin

import httpx

from assistant.db.models import ItemSource
from assistant.logs import error_text

log = logging.getLogger(__name__)

PAGE_MAX_BYTES = 512 * 1024
LINK_PAGE_MAX_BYTES = 5 * 1024 * 1024  # a shared link read in full (spec 6.1: 10 s, 5 MB)
LINK_PAGE_TIMEOUT = 10.0
IMAGE_MAX_BYTES = 5 * 1024 * 1024
MAX_REDIRECTS = 3
ALLOWED_PORTS = frozenset({80, 443})
TOTAL_TIMEOUT = 15.0  # whole page/image fetch incl. redirects; per-op timeout is separate
UA = "Mozilla/5.0 (compatible; TripMemoryBot/1.0)"

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
        page_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._client = client or httpx.AsyncClient(timeout=timeout, headers={"User-Agent": UA})
        # Arbitrary user URLs go through a separate client: no env proxies (the proxy would
        # resolve names itself) and no keep-alive (a pooled connection to an IP must not be
        # reused for another host with a different SNI).
        self._page_client = page_client or client or httpx.AsyncClient(
            timeout=timeout,
            headers={"User-Agent": UA},
            trust_env=False,
            limits=httpx.Limits(max_keepalive_connections=0),
        )
        self._ig_token = instagram_access_token
        self._graph_version = graph_version
        self._timeout = timeout
        self._resolve = resolver or _default_resolver

    async def aclose(self) -> None:
        await self._client.aclose()
        if self._page_client is not self._client:
            await self._page_client.aclose()

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
            log.info("link metadata failed for %s: %s", source, error_text(e))
            return None

    async def fetch_html(self, url: str) -> str | None:
        """A whole html page for its text. Same SSRF guard. None on any failure or non-html."""
        try:
            async with asyncio.timeout(LINK_PAGE_TIMEOUT):
                body, ctype = await self._get_capped_inner(url, LINK_PAGE_MAX_BYTES)
        except Exception as e:
            log.info("page fetch failed: %s", error_text(e))
            return None
        if body is None or "html" not in ctype:
            return None
        return body.decode("utf-8", errors="replace")

    async def fetch_image(self, url: str) -> bytes | None:
        """Small public image (oEmbed thumbnail, og:image). None on any failure or if too big."""
        try:
            body, ctype = await self._get_capped(url, IMAGE_MAX_BYTES)
        except Exception as e:
            log.info("thumbnail fetch failed: %s", error_text(e))
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

    async def _pin(self, url: str) -> tuple[httpx.URL, str, str]:
        """SSRF guard for user-supplied URLs: resolve once, require every address to be
        public and the port to be 80/443, and return the URL rewritten to the vetted IP
        (plus the Host header and TLS SNI/verification name) so httpx never resolves again.
        """
        u = httpx.URL(url)
        if u.scheme not in ("http", "https") or not u.raw_host or u.userinfo:
            raise ValueError("unsupported url")
        if u.port is not None and u.port not in ALLOWED_PORTS:
            raise ValueError("port not allowed")
        host = u.raw_host.decode("ascii")
        addrs = await self._resolve(host)
        if not addrs:
            raise ValueError("host does not resolve")
        ips = [ipaddress.ip_address(a.split("%")[0]) for a in addrs]
        for ip in ips:
            mapped = getattr(ip, "ipv4_mapped", None)
            if not ip.is_global or (mapped is not None and not mapped.is_global):
                raise ValueError("non-public address")
        return u.copy_with(host=str(ips[0])), u.netloc.decode("ascii"), host

    async def _get_capped(self, url: str, cap: int) -> tuple[bytes | None, str]:
        async with asyncio.timeout(TOTAL_TIMEOUT):
            return await self._get_capped_inner(url, cap)

    async def _get_capped_inner(self, url: str, cap: int) -> tuple[bytes | None, str]:
        for _ in range(MAX_REDIRECTS + 1):  # every hop is re-vetted and re-pinned
            pinned, host_header, host = await self._pin(url)
            # sni_hostname: httpcore sends it as SNI and verifies the certificate against it.
            ext = {"sni_hostname": host} if pinned.scheme == "https" else {}
            async with self._page_client.stream(
                "GET", pinned, headers={"Host": host_header}, extensions=ext,
                timeout=self._timeout, follow_redirects=False,
            ) as resp:  # fmt: skip
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
