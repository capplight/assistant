"""ObjectStorage adapter (S3 in KZ). Dev implementation: local filesystem + signed PUT URLs that
this API serves itself (`PUT /v1/dev/storage/{token}`), so the phone flow is identical.

Keys are `u/<user public_id>/<upload public id>`: account purge deletes by prefix (spec 7.2).
"""

import asyncio
import base64
import hashlib
import hmac
import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol


@dataclass(frozen=True)
class PresignedPut:
    url: str
    method: str
    headers: dict[str, str]
    expires_at: int  # unix seconds


@dataclass(frozen=True)
class ObjectInfo:
    bytes: int
    sha256: str | None  # hex, when the store can tell (S3 with ChecksumSHA256, local)


class ObjectStorage(Protocol):
    async def presign_put(
        self, key: str, *, mime: str, size: int, sha256: str, ttl_seconds: int
    ) -> PresignedPut: ...

    async def head(self, key: str) -> ObjectInfo | None: ...

    async def get(self, key: str) -> bytes | None: ...  # ingest reads originals

    async def delete(self, key: str) -> None: ...


def object_key(user_public_id: str, upload_public_id: str) -> str:
    return f"u/{user_public_id}/{upload_public_id}"


class StorageTokenError(Exception):
    pass


class LocalObjectStorage:
    """Filesystem stub. URLs are HMAC-signed {key, exp, size, mime}; never use in production."""

    def __init__(self, root: Path, public_base_url: str, secret: bytes) -> None:
        self.root = root
        self.public_base_url = public_base_url.rstrip("/")
        self._secret = secret

    def _path(self, key: str) -> Path:
        path = (self.root / key).resolve()
        if self.root.resolve() not in path.parents:
            raise StorageTokenError("key escapes storage root")
        return path

    def _sign(self, payload: bytes) -> str:
        mac = hmac.new(self._secret, payload, hashlib.sha256).digest()
        return base64.urlsafe_b64encode(mac).rstrip(b"=").decode()

    def make_token(self, key: str, *, mime: str, size: int, exp: int) -> str:
        payload = json.dumps({"k": key, "m": mime, "s": size, "e": exp}, separators=(",", ":"))
        raw = payload.encode()
        body = base64.urlsafe_b64encode(raw).rstrip(b"=").decode()
        return f"{body}.{self._sign(raw)}"

    def read_token(self, token: str, *, now: float | None = None) -> tuple[str, str, int]:
        """Returns (key, mime, max size)."""
        try:
            body, sig = token.split(".")
            raw = base64.urlsafe_b64decode(body + "=" * (-len(body) % 4))
            if not hmac.compare_digest(sig, self._sign(raw)):
                raise StorageTokenError("bad signature")
            data = json.loads(raw)
            key, mime, size, exp = str(data["k"]), str(data["m"]), int(data["s"]), int(data["e"])
        except (ValueError, KeyError, TypeError) as exc:
            raise StorageTokenError("malformed token") from exc
        if exp <= (time.time() if now is None else now):
            raise StorageTokenError("expired")
        return key, mime, size

    async def presign_put(
        self, key: str, *, mime: str, size: int, sha256: str, ttl_seconds: int
    ) -> PresignedPut:
        exp = int(time.time()) + ttl_seconds
        token = self.make_token(key, mime=mime, size=size, exp=exp)
        return PresignedPut(
            url=f"{self.public_base_url}/v1/dev/storage/{token}",
            method="PUT",
            headers={"Content-Type": mime},
            expires_at=exp,
        )

    async def put(self, key: str, data: bytes) -> None:
        path = self._path(key)

        def write() -> None:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)

        await asyncio.to_thread(write)

    async def head(self, key: str) -> ObjectInfo | None:
        path = self._path(key)

        def stat() -> ObjectInfo | None:
            if not path.is_file():
                return None
            data = path.read_bytes()
            return ObjectInfo(len(data), hashlib.sha256(data).hexdigest())

        return await asyncio.to_thread(stat)

    async def get(self, key: str) -> bytes | None:
        path = self._path(key)

        def read() -> bytes | None:
            return path.read_bytes() if path.is_file() else None

        return await asyncio.to_thread(read)

    async def delete(self, key: str) -> None:
        await asyncio.to_thread(self._path(key).unlink, missing_ok=True)


def make_storage(
    backend: str, *, local_dir: str, public_base_url: str, secret: bytes
) -> ObjectStorage:
    if backend == "local":
        return LocalObjectStorage(Path(local_dir), public_base_url, secret)
    raise ValueError(f"storage backend {backend!r} is not implemented yet (S3 via aioboto3: next)")
