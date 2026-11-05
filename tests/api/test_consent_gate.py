"""Consent gate without a DB: pure check + endpoints with auth/consent lookups overridden."""

import pytest

from assistant.api import consent_texts
from assistant.api.consent_gate import (
    AI_CONSENTS,
    BASE_CONSENTS,
    ConsentRequired,
    check_consents,
    missing_consents,
)
from assistant.db.models_v2 import ConsentKind
from tests.api.conftest import client, unit_app

ALL_AI = {"pd_processing", "terms", "ai_cross_border"}


def test_missing_consents_lists_in_order():
    assert missing_consents([], AI_CONSENTS) == ["pd_processing", "terms", "ai_cross_border"]
    assert missing_consents(["terms", "pd_processing"], AI_CONSENTS) == ["ai_cross_border"]
    assert missing_consents(ALL_AI, AI_CONSENTS) == []


def test_check_raises_consent_required():
    with pytest.raises(ConsentRequired) as info:
        check_consents({"pd_processing"}, BASE_CONSENTS)
    assert info.value.status == 403 and info.value.code == "consent_required"
    assert info.value.missing == ["terms"]
    check_consents({"pd_processing", "terms", "analytics"}, BASE_CONSENTS)


@pytest.mark.parametrize(
    ("active", "missing"),
    [
        (set(), ["pd_processing", "terms", "ai_cross_border"]),
        ({"pd_processing", "terms"}, ["ai_cross_border"]),  # "Без ИИ" mode
        ({"ai_cross_border"}, ["pd_processing", "terms"]),  # legacy bot consent alone
    ],
)
async def test_ai_ping_blocked_without_consent(tmp_path, active, missing):
    async with client(unit_app(tmp_path, active)) as c:
        r = await c.post("/v1/ai/ping")
    assert r.status_code == 403
    body = r.json()
    assert body["code"] == "consent_required" and body["details"]["missing"] == missing
    assert body["message_ru"] and body["message_kk"]
    assert "ИИ" not in body["message_ru"] and "AI" not in body["message_ru"]


async def test_ai_ping_allowed_with_consent(tmp_path):
    async with client(unit_app(tmp_path, ALL_AI)) as c:
        r = await c.post("/v1/ai/ping")
    assert r.status_code == 200 and r.json() == {"ok": True}
    assert r.headers["X-Api-Version"] == "1"


async def test_ai_ping_requires_auth(tmp_path):
    async with client(unit_app(tmp_path, None)) as c:
        r = await c.post("/v1/ai/ping")
        r2 = await c.post("/v1/ai/ping", headers={"Authorization": "Bearer garbage"})
    assert r.status_code == 401 and r.json()["code"] == "unauthorized"
    assert r2.status_code == 401


async def test_uploads_and_devices_need_base_consent(tmp_path):
    body = {"mime": "image/jpeg", "bytes": 10, "sha256": "a" * 64}
    device = {"client_id": "0193f0c8-0000-7000-8000-000000000001", "platform": "android"}
    async with client(unit_app(tmp_path, {"analytics"})) as c:
        up = await c.post("/v1/uploads", json=body)
        dev = await c.post("/v1/devices", json=device)
    for r in (up, dev):
        assert r.status_code == 403
        assert r.json()["details"]["missing"] == ["pd_processing", "terms"]


async def test_validation_error_shape_hides_values(tmp_path):
    async with client(unit_app(tmp_path, ALL_AI)) as c:
        r = await c.post("/v1/uploads", json={"mime": "x", "bytes": -1, "sha256": "secret-value"})
    assert r.status_code == 422
    body = r.json()
    assert body["code"] == "validation_error" and "secret-value" not in r.text
    assert {tuple(e["loc"]) for e in body["details"]["errors"]} >= {("body", "bytes")}


async def test_upload_size_limit(tmp_path):
    body = {"mime": "video/mp4", "bytes": 50 * 1024 * 1024 + 1, "sha256": "a" * 64}
    async with client(unit_app(tmp_path, ALL_AI)) as c:
        r = await c.post("/v1/uploads", json=body)
    assert r.status_code == 413 and r.json()["code"] == "upload_too_large"


# --- consent texts ---


@pytest.mark.parametrize("kind", [ConsentKind.PD_PROCESSING, ConsentKind.AI_CROSS_BORDER,
                                  ConsentKind.TERMS, ConsentKind.PUSH_CONTENT,
                                  ConsentKind.ANALYTICS])  # fmt: skip
@pytest.mark.parametrize("locale", ["ru", "kk"])
def test_s05_texts_exist_and_hash(kind, locale):
    text = consent_texts.current(kind, locale)
    assert text is not None and len(text.text_hash) == 64
    assert consent_texts.find(kind, text.version, locale) is text
    assert "ИИ" not in text.text


def test_ai_text_lists_providers():
    text = consent_texts.current(ConsentKind.AI_CROSS_BORDER, "ru")
    assert text is not None and list(text.providers) == consent_texts.AI_PROVIDERS
    assert all(p in text.text for p in text.providers)


async def test_consent_text_endpoint_is_public(tmp_path):
    async with client(unit_app(tmp_path, None)) as c:
        r = await c.get("/v1/consents/text", params={"kind": "terms", "locale": "kk"})
        bad = await c.get("/v1/consents/text", params={"kind": "human_review"})
    assert r.status_code == 200
    body = r.json()
    assert body["version"].startswith("terms-") and "18" in body["text"]
    assert body["text_hash"] == consent_texts.current(ConsentKind.TERMS, "kk").text_hash
    assert bad.status_code == 404
