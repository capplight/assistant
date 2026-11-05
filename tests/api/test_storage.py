import hashlib
import time

import pytest

from assistant.api.storage import StorageTokenError, object_key
from tests.api.conftest import client, make_storage, unit_app


async def test_local_presign_put_head_delete(tmp_path):
    storage = make_storage(tmp_path)
    key = object_key("user-1", "upload-1")
    signed = await storage.presign_put(key, mime="image/png", size=5, sha256="0" * 64,
                                       ttl_seconds=60)  # fmt: skip
    assert signed.method == "PUT" and signed.headers == {"Content-Type": "image/png"}
    token = signed.url.rsplit("/", 1)[1]
    assert storage.read_token(token) == (key, "image/png", 5)

    assert await storage.head(key) is None
    await storage.put(key, b"hello")
    info = await storage.head(key)
    assert info is not None and info.bytes == 5
    assert info.sha256 == hashlib.sha256(b"hello").hexdigest()
    await storage.delete(key)
    assert await storage.head(key) is None


def test_token_tamper_and_expiry(tmp_path):
    storage = make_storage(tmp_path)
    token = storage.make_token("u/a/b", mime="text/plain", size=1, exp=int(time.time()) + 60)
    body, sig = token.split(".")
    with pytest.raises(StorageTokenError):
        storage.read_token(f"{body}x.{sig}")
    with pytest.raises(StorageTokenError):
        make_storage(tmp_path / "other").read_token(token.replace(sig, sig[::-1]))
    old = storage.make_token("u/a/b", mime="text/plain", size=1, exp=int(time.time()) - 1)
    with pytest.raises(StorageTokenError, match="expired"):
        storage.read_token(old)


async def test_key_cannot_escape_root(tmp_path):
    with pytest.raises(StorageTokenError):
        await make_storage(tmp_path / "root").put("../evil", b"x")


async def test_dev_put_endpoint(tmp_path):
    app = unit_app(tmp_path, None)
    storage = app.state.ctx.storage
    signed = await storage.presign_put("u/x/y", mime="text/plain", size=4, sha256="0" * 64,
                                       ttl_seconds=60)  # fmt: skip
    path = signed.url.removeprefix("http://test")
    async with client(app) as c:
        too_big = await c.put(path, content=b"12345")
        ok = await c.put(path, content=b"1234", headers=signed.headers)
        bad = await c.put("/v1/dev/storage/nope.nope", content=b"1")
    assert too_big.status_code == 413
    assert ok.status_code == 200
    assert (await storage.head("u/x/y")).bytes == 4
    assert bad.status_code == 403
