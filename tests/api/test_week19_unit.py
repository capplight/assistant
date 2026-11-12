"""Week 19 without a database: the beta scope switches (Ф-33...Ф-44, GET /v1/features, gates on
statements and receipt QR, the change tools offered to the line) and the message limit rules."""

import uuid
from pathlib import Path

import pytest
from pydantic import ValidationError

from assistant.api.app import create_app
from assistant.api.schemas import ConsentsIn
from assistant.api.sms import FakeSmsSender
from assistant.chat import ChatService
from assistant.chat.context import VIEW_OFF_LINE
from assistant.chat.limits import limits_for
from assistant.config import Settings
from tests.api.conftest import client, make_settings, make_storage, unit_app

ALL_ON = ("feature_statements_pdf", "feature_receipt_qr", "feature_board",
          "feature_assistant_views", "feature_page_settings_full", "feature_today_proposals",
          "feature_today_tiles", "feature_telegram_login", "feature_personal_mail",
          "feature_setup_for_other")  # fmt: skip


def test_defaults_are_the_founders_decisions() -> None:
    s = Settings(_env_file=None)  # type: ignore[call-arg]
    assert not any(getattr(s, name) for name in ALL_ON)
    assert (s.today_tips_days, s.today_tips_per_day) == (7, 1)
    assert s.pages_on_first_use and s.pages_first_use_keys == ["shopping", "expenses", "documents"]
    assert s.chat_rate_per_minute["family_beta"] > s.chat_rate_per_minute["regular"] > 0
    assert s.chat_rate_per_day["family_beta"] > s.chat_rate_per_day["regular"] > 0


def test_switches_come_from_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FEATURE_BOARD", "true")
    monkeypatch.setenv("TODAY_TIPS_DAYS", "0")
    monkeypatch.setenv("CHAT_RATE_PER_MINUTE", '{"regular": 3}')
    s = Settings(_env_file=None)  # type: ignore[call-arg]
    assert s.feature_board and s.today_tips_days == 0 and s.chat_rate_per_minute == {"regular": 3}


async def test_features_endpoint_without_sign_in(tmp_path: Path) -> None:
    async with client(unit_app(tmp_path, None)) as c:
        r = await c.get("/v1/features")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body == {
        "statements_pdf": False, "receipt_qr": False, "board": False, "assistant_views": False,
        "page_settings_full": False, "telegram_login": False, "personal_mail": False,
        "setup_for_other": False, "consent_screen": "welcome",
        "today": {"tips_days": 7, "tips_per_day": 1, "proposals": False, "tiles": False},
        "pages": {"default": ["today", "notes", "tasks"],
                  "first_use": ["shopping", "expenses", "documents"]},
    }  # fmt: skip
    assert "max-age" in r.headers["cache-control"]


async def test_features_follow_settings(tmp_path: Path) -> None:
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    engine = create_async_engine("postgresql+asyncpg://nobody:nothing@127.0.0.1:1/none")
    on = {name: True for name in ALL_ON}
    app = create_app(make_settings(**on, pages_on_first_use=False),
                     sessionmaker=async_sessionmaker(engine), sms=FakeSmsSender(),
                     storage=make_storage(tmp_path))  # fmt: skip
    async with client(app) as c:
        body = (await c.get("/v1/features")).json()
    assert body["board"] and body["statements_pdf"] and body["today"]["tiles"]
    assert body["pages"]["first_use"] == []


def test_consents_accept_the_welcome_screen() -> None:
    item = {"kind": "terms", "version": "1", "text_hash": "a" * 64, "locale": "ru"}
    assert ConsentsIn(consents=[item], screen="welcome").screen == "welcome"  # type: ignore[list-item]
    assert ConsentsIn(consents=[item], screen="S05").screen == "S05"  # type: ignore[list-item]
    with pytest.raises(ValidationError):
        ConsentsIn(consents=[item], screen="elsewhere")  # type: ignore[arg-type, list-item]


async def test_statements_and_qr_are_off(tmp_path: Path) -> None:
    app = unit_app(tmp_path, {"pd_processing", "terms", "ai_cross_border"})
    async with client(app) as c:
        r = await c.post("/v1/expenses/from-qr", json={"client_id": str(uuid.uuid4()),
                                                       "url": "https://consumer.oofd.kz/?i=1"})
        assert r.status_code == 403, r.text
        assert r.json()["code"] == "feature_off"
        assert r.json()["details"] == {"feature": "receipt_qr"}
        assert r.json()["message_ru"] and r.json()["message_kk"]
        r = await c.post("/v1/expenses/statements", json={"client_id": str(uuid.uuid4()),
                                                          "item_id": str(uuid.uuid4())})
        assert r.status_code == 403, r.text
        assert r.json()["details"] == {"feature": "statements_pdf"}


def _service(**kw: object) -> ChatService:
    return ChatService(make_settings(**kw), None, None, None)  # type: ignore[arg-type]


def test_set_view_is_not_offered_while_views_are_off() -> None:
    off = {t.name for t in _service()._mutating()}
    assert "set_view" not in off and {"create", "update", "move", "reorder"} <= off
    assert "rename_page" in off  # renaming a page by asking stays (Ф-39 is views only)
    on = {t.name for t in _service(feature_assistant_views=True)._mutating()}
    assert on == (off - {"rename_page"}) | {"set_view"}
    assert "«⋯»" in VIEW_OFF_LINE


def test_limits_by_profile() -> None:
    s = make_settings(chat_rate_per_minute={"regular": 5, "family_beta": 20},
                      chat_rate_per_day={"regular": 50})  # fmt: skip
    assert limits_for(s, "family_beta").per_minute == 20
    assert limits_for(s, "family_beta").per_day == 50  # no entry: the regular one
    assert limits_for(s, "work").per_minute == 5 and limits_for(s, None).per_day == 50


def test_an_empty_map_means_no_limit() -> None:
    s = make_settings(chat_rate_per_minute={}, chat_rate_per_day={})
    assert limits_for(s, "regular") == limits_for(s, "family_beta")
    assert limits_for(s, "regular").per_minute == 0 and limits_for(s, "regular").per_day == 0
