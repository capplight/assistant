"""Download files the user sent to the bot (Bot API getFile + file endpoint)."""

import asyncio
import logging
from dataclasses import dataclass
from pathlib import Path

import httpx

log = logging.getLogger(__name__)

PUBLIC_API = "https://api.telegram.org"
PUBLIC_LIMIT = 20 * 1024 * 1024  # api.telegram.org refuses getFile above 20 MB
LOCAL_LIMIT = 2000 * 1024 * 1024


class FileTooBigError(Exception):
    pass


@dataclass
class TelegramFile:
    data: bytes
    file_path: str

    @property
    def filename(self) -> str:
        return self.file_path.rsplit("/", 1)[-1] or "file"


class TelegramFiles:
    """Never put URLs into exception messages or logs: they contain the bot token."""

    def __init__(
        self, token: str, api_base: str = "", client: httpx.AsyncClient | None = None
    ) -> None:
        self._token = token
        self._base = (api_base or PUBLIC_API).rstrip("/")
        self.limit = PUBLIC_LIMIT if self._base == PUBLIC_API else LOCAL_LIMIT
        self._client = client or httpx.AsyncClient(timeout=60)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def download(self, file_id: str) -> TelegramFile:
        """Raises FileTooBigError when over the limit, httpx errors on network problems."""
        resp = await self._client.post(
            f"{self._base}/bot{self._token}/getFile", data={"file_id": file_id}
        )
        payload = resp.json() if resp.headers.get("content-type", "").startswith(
            "application/json"
        ) else {}
        if not payload.get("ok"):
            desc = str(payload.get("description", ""))
            if "too big" in desc.lower():
                raise FileTooBigError(desc)
            raise _status_error("getFile", resp, desc)
        result = payload["result"]
        size = result.get("file_size") or 0
        if size > self.limit:
            raise FileTooBigError(f"{size} bytes")
        file_path: str = result.get("file_path") or ""
        if not file_path:
            raise FileTooBigError("no file_path (file is likely over the limit)")

        # A local Bot API server (--local) returns an absolute path on its own disk.
        if self._base != PUBLIC_API and Path(file_path).is_absolute():
            data = await asyncio.to_thread(_read_local, file_path)
            if data is not None:
                return TelegramFile(data, file_path)

        chunks: list[bytes] = []
        total = 0
        async with self._client.stream(
            "GET", f"{self._base}/file/bot{self._token}/{file_path}"
        ) as r:
            if r.status_code != 200:
                raise _status_error("file download", r)
            async for chunk in r.aiter_bytes():
                total += len(chunk)
                if total > self.limit:
                    raise FileTooBigError(f"> {self.limit} bytes")
                chunks.append(chunk)
        return TelegramFile(b"".join(chunks), file_path)


def _status_error(what: str, resp: httpx.Response, desc: str = "") -> httpx.HTTPStatusError:
    """Like raise_for_status(), but the message never contains the URL: Bot API URLs carry
    the bot token (/bot<token>/...), and this text ends up in logs and DB error columns.
    The status code stays on .response, so errors.is_transient() still classifies it."""
    msg = f"Telegram {what} failed: HTTP {resp.status_code}" + (f" ({desc[:200]})" if desc else "")
    return httpx.HTTPStatusError(msg, request=resp.request, response=resp)


def _read_local(path: str) -> bytes | None:
    p = Path(path)
    return p.read_bytes() if p.is_file() else None
