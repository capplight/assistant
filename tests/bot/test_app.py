from contextlib import asynccontextmanager

from aiogram.types import Update
from aiogram.types import User as TgUser
from fastapi.testclient import TestClient

from assistant.bot import middleware as mw
from assistant.bot.app import (
    SECRET_HEADER,
    WEBHOOK_PATH,
    create_bot,
    create_dispatcher,
    create_webhook_app,
    secret_ok,
)
from assistant.config import Settings


def _settings(**kw) -> Settings:
    return Settings(
        bot_token="123456:TESTTOKEN",
        webhook_base_url="https://example.kz",
        webhook_secret="s3cret",
        **kw,
    )


def test_secret_ok():
    assert secret_ok("s3cret", "s3cret")
    assert not secret_ok("nope", "s3cret")
    assert not secret_ok(None, "s3cret")
    assert not secret_ok("", "")


def test_webhook_rejects_bad_secret_and_health_ok():
    s = _settings()
    app = create_webhook_app(create_bot(s), create_dispatcher(), s)
    client = TestClient(app)  # no `with`: lifespan (set_webhook = network) does not run
    assert client.get("/health").json() == {"status": "ok"}
    assert client.post(WEBHOOK_PATH, json={"update_id": 1}).status_code == 403
    r = client.post(WEBHOOK_PATH, json={"update_id": 1}, headers={SECRET_HEADER: "bad"})
    assert r.status_code == 403


def test_local_api_server():
    bot = create_bot(_settings(telegram_api_base="http://botapi:8081/"))
    assert bot.session.api.is_local
    assert bot.session.api.api_url("T", "getMe") == "http://botapi:8081/botT/getMe"


class FakeSession:
    pass


@asynccontextmanager
async def fake_scope():
    yield FakeSession()


async def test_middleware_skips_already_processed_update(monkeypatch):
    async def already(session, update_id):
        return False

    monkeypatch.setattr(mw.service, "mark_update_processed", already)
    called = []

    async def handler(event, data):
        called.append(event)

    await mw.DbSessionMiddleware(fake_scope)(handler, Update(update_id=1), {})
    assert called == []


async def test_middleware_injects_session_and_user(monkeypatch):
    async def fresh(session, update_id):
        return True

    async def ensure_user(session, telegram_id, first_name):
        return ("user", telegram_id, first_name)

    monkeypatch.setattr(mw.service, "mark_update_processed", fresh)
    monkeypatch.setattr(mw.service, "ensure_user", ensure_user)
    seen = {}

    async def handler(event, data):
        seen.update(data)
        return "ok"

    tg = TgUser(id=7, is_bot=False, first_name="Ержан")
    res = await mw.DbSessionMiddleware(fake_scope)(
        handler, Update(update_id=2), {"event_from_user": tg}
    )
    assert res == "ok"
    assert isinstance(seen["session"], FakeSession)
    assert seen["user"] == ("user", 7, "Ержан")
