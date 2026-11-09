"""Fiscal receipt QR codes (spec 6.13, 5.7 rule 7): the link printed on a Kazakhstan fiscal receipt
leads to an OFD (оператор фискальных данных) page, e.g.
`https://consumer.oofd.kz/?i=<fiscal sign>&f=<register>&s=<sum>&t=<YYYYMMDDTHHMMSS>`.

- `parse_link`: code reads the sum `s` and the time `t` from the link itself (structured data,
  not a phrase: no model, works without AI). Only an allowlisted OFD host is accepted
  (`settings.expenses_ofd_domains` and their subdomains); http/https, ports 80/443, no user info.
- `HttpOfdReader`: fetches the page only for an allowlisted host whose every address is public
  (no private, loopback, link-local, reserved IPs: SSRF), pinned to the vetted IP; each redirect is
  checked again and must stay on the allowlist (≤3); 10 s; 1 MB. Returns the page's text (tags
  stripped) or None. The page is untrusted data.
Tests use `FakeOfdReader`; unit tests never hit the network.
"""

import asyncio
import ipaddress
import logging
import socket
from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from html.parser import HTMLParser
from typing import Protocol
from urllib.parse import parse_qs, urljoin
from zoneinfo import ZoneInfo

import httpx

from assistant.db.models_expenses import AMOUNT_MAX
from assistant.expenses.documents import money
from assistant.logs import error_text

log = logging.getLogger(__name__)

DEFAULT_DOMAINS = ("oofd.kz", "ofd1.kz", "kofd.kz", "wofd.kz")  # [проверить на нед. 0]
ALLOWED_PORTS = (80, 443)
MAX_REDIRECTS = 3
MAX_BYTES = 1_000_000
TIMEOUT_S = 10.0
FISCAL_TZ = ZoneInfo("Asia/Almaty")  # the time on the receipt is the shop's clock
UA = "Mozilla/5.0 (compatible; AssistantReceipts/1.0)"

Resolver = Callable[[str], Awaitable[list[str]]]


class QrError(ValueError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass
class Fiscal:
    url: str
    domain: str
    sign: str | None
    register: str | None
    amount: Decimal | None
    at: datetime | None  # aware UTC

    @property
    def ref(self) -> str | None:
        if self.sign and self.register:
            return f"ofd:{self.register}:{self.sign}"
        return None


def host_allowed(host: str, domains: Iterable[str]) -> bool:
    h = host.lower().rstrip(".")
    return any(h == d or h.endswith("." + d) for d in (x.lower().strip(".") for x in domains))


def _is_ip(host: str) -> bool:
    """A bare IP is never an OFD."""
    try:
        ipaddress.ip_address(host.strip("[]"))
    except ValueError:
        return False
    return True


def _first(q: dict[str, list[str]], *names: str) -> str | None:
    for n in names:
        v = q.get(n)
        if v and v[0].strip():
            return v[0].strip()
    return None


def parse_link(url: str, domains: Iterable[str]) -> Fiscal:
    """Raises QrError(`qr_not_fiscal`) for anything that is not an allowlisted OFD link."""
    try:
        u = httpx.URL(url.strip())
    except Exception as exc:
        raise QrError("qr_not_fiscal") from exc
    if u.scheme not in ("http", "https") or not u.host or u.userinfo:
        raise QrError("qr_not_fiscal")
    if u.port is not None and u.port not in ALLOWED_PORTS:
        raise QrError("qr_not_fiscal")
    if _is_ip(u.host) or not host_allowed(u.host, domains):
        raise QrError("qr_not_fiscal")
    q = parse_qs(u.query.decode("ascii", "replace") if isinstance(u.query, bytes) else u.query)
    amount = None
    s = _first(q, "s", "sum")
    if s:
        try:
            v = money(Decimal(s.replace(",", ".")))
            amount = v if 0 < v <= AMOUNT_MAX else None
        except Exception:
            amount = None
    at = None
    t = _first(q, "t")
    if t:
        for fmt in ("%Y%m%dT%H%M%S", "%Y%m%dT%H%M", "%Y%m%d"):
            try:
                at = datetime.strptime(t, fmt).replace(tzinfo=FISCAL_TZ).astimezone(ZoneInfo("UTC"))
                break
            except ValueError:
                continue
    return Fiscal(url=str(u), domain=u.host.lower(), sign=_first(q, "i", "fp"),
                  register=_first(q, "f", "rn"), amount=amount, at=at)  # fmt: skip


class OfdReader(Protocol):
    async def read(self, url: str) -> str | None: ...


class _Text(HTMLParser):
    SKIP = {"script", "style", "noscript", "head", "template"}

    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []
        self.skip = 0

    def handle_starttag(self, tag: str, attrs: list) -> None:
        if tag in self.SKIP:
            self.skip += 1
        elif tag in ("br", "p", "div", "tr", "li", "h1", "h2", "h3", "table"):
            self.parts.append("\n")
        elif tag in ("td", "th"):
            self.parts.append(" ")

    def handle_endtag(self, tag: str) -> None:
        if tag in self.SKIP and self.skip:
            self.skip -= 1

    def handle_data(self, data: str) -> None:
        if not self.skip:
            self.parts.append(data)


def page_text(html: str) -> str:
    p = _Text()
    try:
        p.feed(html)
    except Exception:  # broken html: what was read so far
        pass
    lines = [" ".join(line.split()) for line in "".join(p.parts).splitlines()]
    return "\n".join(line for line in lines if line)[:50_000]


async def _default_resolver(host: str) -> list[str]:
    infos = await asyncio.get_running_loop().getaddrinfo(host, None, type=socket.SOCK_STREAM)
    return [str(i[4][0]) for i in infos]


def public(ip_text: str) -> bool:
    ip = ipaddress.ip_address(ip_text.split("%")[0])
    mapped = getattr(ip, "ipv4_mapped", None)
    return ip.is_global and (mapped is None or mapped.is_global)


class HttpOfdReader:
    def __init__(self, domains: Iterable[str], *, resolver: Resolver | None = None,
                 client: httpx.AsyncClient | None = None,
                 timeout: float = TIMEOUT_S) -> None:  # fmt: skip
        self.domains = tuple(domains)
        self._resolve = resolver or _default_resolver
        # No env proxies (a proxy would resolve names itself), no keep-alive across hosts.
        self._client = client or httpx.AsyncClient(
            timeout=timeout, headers={"User-Agent": UA}, trust_env=False,
            limits=httpx.Limits(max_keepalive_connections=0))  # fmt: skip
        self._timeout = timeout

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _pin(self, url: str) -> tuple[httpx.URL, str, str]:
        u = httpx.URL(url)
        if u.scheme not in ("http", "https") or not u.host or u.userinfo:
            raise QrError("qr_not_fiscal")
        if u.port is not None and u.port not in ALLOWED_PORTS:
            raise QrError("qr_not_fiscal")
        if not host_allowed(u.host, self.domains):
            raise QrError("qr_not_fiscal")  # a redirect off the allowlist
        addrs = await self._resolve(u.host)
        if not addrs or not all(public(a) for a in addrs):
            raise QrError("qr_private_address")
        return u.copy_with(host=addrs[0].split("%")[0]), u.netloc.decode("ascii"), u.host

    async def read(self, url: str) -> str | None:
        try:
            async with asyncio.timeout(self._timeout):
                return await self._read(url)
        except QrError as exc:
            log.info("ofd page refused: %s", exc.code)
            return None
        except Exception as exc:  # a dead OFD page never fails the receipt
            log.info("ofd page failed: %s", error_text(exc))
            return None

    async def _read(self, url: str) -> str | None:
        for _ in range(MAX_REDIRECTS + 1):
            pinned, host_header, host = await self._pin(url)
            ext = {"sni_hostname": host} if pinned.scheme == "https" else {}
            async with self._client.stream("GET", pinned, headers={"Host": host_header},
                                           extensions=ext, follow_redirects=False) as resp:
                if resp.is_redirect and "location" in resp.headers:
                    url = urljoin(url, resp.headers["location"])
                    continue
                if resp.status_code != 200:
                    return None
                ctype = resp.headers.get("content-type", "").lower()
                if "html" not in ctype and "text" not in ctype:
                    return None
                chunks: list[bytes] = []
                size = 0
                async for chunk in resp.aiter_bytes():
                    chunks.append(chunk)
                    size += len(chunk)
                    if size >= MAX_BYTES:
                        break
                html = b"".join(chunks)[:MAX_BYTES].decode(resp.encoding or "utf-8", "replace")
                return page_text(html)
        return None


class FakeOfdReader:
    """Canned pages for tests and dev: {url: text}. Records every url asked."""

    def __init__(self, pages: dict[str, str] | None = None) -> None:
        self.pages = pages or {}
        self.urls: list[str] = []

    async def read(self, url: str) -> str | None:
        self.urls.append(url)
        return self.pages.get(url)


__all__ = ["DEFAULT_DOMAINS", "FakeOfdReader", "Fiscal", "HttpOfdReader", "OfdReader", "QrError",
           "host_allowed", "page_text", "parse_link", "public"]  # fmt: skip
