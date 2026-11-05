"""Mobile API against a real Postgres migrated to head (alembic upgrade head, incl. 0002/0003).

Skipped unless DATABASE_URL is set. Each test runs in one transaction that is rolled back.
"""

import hashlib
import importlib.util
import os
import secrets
import uuid
from pathlib import Path

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from assistant.api import consent_texts
from assistant.db.models import User
from assistant.db.models_v2 import AuthIdentity, Consent, ConsentKind, File, Upload
from tests.api.conftest import client

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set"),
]

MIGRATIONS = Path(__file__).resolve().parents[2] / "migrations" / "versions"


def _grant_body(*kinds: ConsentKind, locale: str = "ru", age: bool = True) -> dict:
    items = []
    for kind in kinds:
        t = consent_texts.current(kind, locale)
        assert t is not None
        items.append({"kind": kind, "version": t.version, "text_hash": t.text_hash,
                      "locale": locale})  # fmt: skip
    return {"consents": items, "screen": "S05", "age_confirmed_18": age}


S05 = (ConsentKind.PD_PROCESSING, ConsentKind.TERMS, ConsentKind.AI_CROSS_BORDER,
       ConsentKind.PUSH_CONTENT, ConsentKind.ANALYTICS)  # fmt: skip


async def _anon(c, key: str | None = None) -> dict:
    r = await c.post("/v1/auth/anonymous", json={"device_key": key or secrets.token_urlsafe(32)})
    assert r.status_code == 200, r.text
    return r.json()


def _auth(tokens: dict) -> dict[str, str]:
    return {"Authorization": f"Bearer {tokens['access_token']}"}


# --- schema / migrations ---


async def test_schema_after_migrations(db_app):
    _, _, s = db_app
    nullable = await s.scalar(text(
        "SELECT is_nullable FROM information_schema.columns "
        "WHERE table_name='users' AND column_name='telegram_id'"))  # fmt: skip
    assert nullable == "YES"
    tables = set(await s.scalars(text(
        "SELECT table_name FROM information_schema.tables "
        "WHERE table_schema='public'")))  # fmt: skip
    assert {"auth_identities", "auth_sessions", "otp_challenges", "devices", "consents",
            "files", "uploads"} <= tables  # fmt: skip
    # text + CHECK, not Postgres ENUM
    enum_cols = list(await s.scalars(text(
        "SELECT table_name || '.' || column_name FROM information_schema.columns "
        "WHERE data_type = 'USER-DEFINED' AND table_name IN ('auth_identities', 'auth_sessions', "
        "'otp_challenges', 'devices', 'consents', 'files', 'uploads')")))  # fmt: skip
    assert enum_cols == []


async def test_check_constraints_reject_bad_values(db_app):
    _, _, s = db_app
    user = User(display_name="x")
    s.add(user)
    await s.flush()
    assert user.public_id is not None and user.telegram_id is None and user.status == "active"
    with pytest.raises(IntegrityError):
        async with s.begin_nested():
            s.add(Consent(user_id=user.id, kind="ai_processing", version="v"))
            await s.flush()
    with pytest.raises(IntegrityError):
        async with s.begin_nested():
            await s.execute(text("UPDATE users SET locale='en' WHERE id=:id"), {"id": user.id})


async def test_legacy_bot_users_keep_working_and_backfill(db_app):
    """Bot-style user (telegram_id, consent_at) gets defaults; 0003 backfill is idempotent."""
    from datetime import UTC, datetime

    _, _, s = db_app
    legacy = User(telegram_id=880000001, first_name="Айгерим", consent_at=datetime.now(UTC))
    s.add(legacy)
    await s.flush()
    spec = importlib.util.spec_from_file_location("m0003", MIGRATIONS / "0003_consents_files.py")
    assert spec and spec.loader
    m0003 = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m0003)
    for _ in range(2):
        await s.execute(text(m0003.BACKFILL_CONSENTS))
    rows = list(await s.scalars(select(Consent).where(Consent.user_id == legacy.id)))
    assert [(c.kind, c.version, c.screen) for c in rows] == [
        ("ai_cross_border", "legacy-bot", "legacy_bot")
    ]


# --- auth ---


async def test_anonymous_same_key_same_account(db_app):
    app, _, s = db_app
    key = secrets.token_urlsafe(32)
    async with client(app) as c:
        a = await _anon(c, key)
        b = await _anon(c, key)
        other = await _anon(c)
    assert a["created"] is True and b["created"] is False
    assert a["user"]["id"] == b["user"]["id"] != other["user"]["id"]
    assert a["user"]["is_anonymous"] is True and a["token_type"] == "Bearer"
    # device key is stored only as HMAC
    ids = list(await s.scalars(select(AuthIdentity.subject_hash)))
    assert key not in ids and all(len(h) == 64 for h in ids)


async def test_refresh_rotation_and_reuse_detection(db_app):
    app, _, _ = db_app
    async with client(app) as c:
        t1 = await _anon(c)
        r = await c.post("/v1/auth/refresh", json={"refresh_token": t1["refresh_token"]})
        assert r.status_code == 200
        t2 = r.json()
        assert t2["refresh_token"] != t1["refresh_token"]
        # old access token's session is revoked by rotation
        assert (await c.get("/v1/consents", headers=_auth(t1))).status_code == 401
        assert (await c.get("/v1/consents", headers=_auth(t2))).status_code == 200
        # reuse of the rotated token kills the chain
        reuse = await c.post("/v1/auth/refresh", json={"refresh_token": t1["refresh_token"]})
        assert reuse.status_code == 401 and reuse.json()["code"] == "invalid_refresh"
        assert (await c.get("/v1/consents", headers=_auth(t2))).status_code == 401
        bad = await c.post("/v1/auth/refresh", json={"refresh_token": "x" * 40})
        assert bad.status_code == 401


async def test_logout_revokes_session(db_app):
    app, _, _ = db_app
    async with client(app) as c:
        t = await _anon(c)
        assert (await c.post("/v1/auth/logout", headers=_auth(t))).status_code == 204
        assert (await c.get("/v1/consents", headers=_auth(t))).status_code == 401


async def test_phone_link_then_login_on_new_install(db_app):
    app, sms, _ = db_app
    phone = "+7 701 555 00 11"
    async with client(app) as c:
        anon = await _anon(c)
        r = await c.post("/v1/auth/otp/request", json={"phone": phone}, headers=_auth(anon))
        assert r.status_code == 200, r.text
        challenge = r.json()
        code = sms.last_code_for("+77015550011")
        assert code and challenge["dev_code"] == code
        wrong = await c.post("/v1/auth/otp/verify", json={
            "challenge_id": challenge["challenge_id"], "phone": phone,
            "code": "000000" if code != "000000" else "111111"}, headers=_auth(anon))  # fmt: skip
        assert wrong.status_code == 400 and wrong.json()["code"] == "otp_invalid"
        ok = await c.post("/v1/auth/otp/verify", json={
            "challenge_id": challenge["challenge_id"], "phone": phone, "code": code},
            headers=_auth(anon))  # fmt: skip
        assert ok.status_code == 200, ok.text
        linked = ok.json()
        assert linked["user"]["id"] == anon["user"]["id"]
        assert linked["user"]["is_anonymous"] is False and linked["user"]["country"] == "KZ"
        assert linked["account_switched"] is False
        replay = await c.post("/v1/auth/otp/verify", json={
            "challenge_id": challenge["challenge_id"], "phone": phone, "code": code})  # fmt: skip
        assert replay.status_code == 400 and replay.json()["code"] == "otp_expired"

        # New install: other anonymous account, same phone -> signs into the phone's account.
        fresh = await _anon(c)
        r2 = await c.post("/v1/auth/phone/start", json={"phone": phone}, headers=_auth(fresh))
        code2 = sms.last_code_for("+77015550011")
        v2 = await c.post("/v1/auth/phone/verify", json={
            "challenge_id": r2.json()["challenge_id"], "phone": phone, "code": code2},
            headers=_auth(fresh))  # fmt: skip
        assert v2.status_code == 200
        assert v2.json()["user"]["id"] == anon["user"]["id"]
        assert v2.json()["account_switched"] is True

        # Rate limit: 3 per number per hour
        r3 = await c.post("/v1/auth/otp/request", json={"phone": phone})
        r4 = await c.post("/v1/auth/otp/request", json={"phone": phone})
        assert r3.status_code == 200 and r4.status_code == 429
        assert r4.json()["code"] == "otp_rate_limited" and r4.headers["Retry-After"]

        bad = await c.post("/v1/auth/otp/request", json={"phone": "+7 916 123 45 67"})
        assert bad.status_code == 422 and bad.json()["code"] == "phone_unsupported"


async def test_otp_attempts_are_counted_and_capped(db_app):
    app, sms, _ = db_app
    phone = "+996555000111"
    async with client(app) as c:
        r = await c.post("/v1/auth/otp/request", json={"phone": phone})
        cid = r.json()["challenge_id"]
        code = sms.last_code_for(phone)
        wrong = "000000" if code != "000000" else "111111"
        for _ in range(5):
            w = await c.post("/v1/auth/otp/verify",
                             json={"challenge_id": cid, "phone": phone, "code": wrong})  # fmt: skip
            assert w.json()["code"] == "otp_invalid"
        late = await c.post("/v1/auth/otp/verify",
                            json={"challenge_id": cid, "phone": phone, "code": code})  # fmt: skip
    assert late.status_code == 400 and late.json()["code"] == "otp_expired"


# --- consents + gate ---


async def test_consent_flow_and_ai_gate(db_app):
    app, _, s = db_app
    async with client(app) as c:
        t = await _anon(c)
        h = _auth(t)
        blocked = await c.post("/v1/ai/ping", headers=h)
        assert blocked.status_code == 403 and blocked.json()["code"] == "consent_required"

        no_age = await c.post("/v1/consents", json=_grant_body(*S05, age=False), headers=h)
        assert no_age.status_code == 422 and no_age.json()["code"] == "age_confirmation_required"
        tampered = _grant_body(ConsentKind.PD_PROCESSING)
        tampered["consents"][0]["text_hash"] = "0" * 64
        assert (await c.post("/v1/consents", json=tampered, headers=h)).status_code == 409

        # "Без ИИ": everything except ai_cross_border and push_content
        no_ai = _grant_body(ConsentKind.PD_PROCESSING, ConsentKind.TERMS, ConsentKind.ANALYTICS)
        r = await c.post("/v1/consents", json=no_ai, headers=h)
        assert r.status_code == 200
        assert r.json()["app_enabled"] is True and r.json()["ai_enabled"] is False
        assert (await c.post("/v1/ai/ping", headers=h)).json()["details"]["missing"] == [
            "ai_cross_border"
        ]

        r = await c.post("/v1/consents", json=_grant_body(*S05), headers=h)
        state = r.json()
        assert state["ai_enabled"] is True and len(state["active"]) == 5
        assert len(state["history"]) == 5  # re-sent active versions are not duplicated
        ai = next(x for x in state["active"] if x["kind"] == "ai_cross_border")
        assert ai["providers"] == consent_texts.AI_PROVIDERS and ai["screen"] == "S05"
        assert (await c.post("/v1/ai/ping", headers=h)).status_code == 200

        revoked = await c.delete("/v1/consents/ai_cross_border", headers=h)
        assert revoked.json()["ai_enabled"] is False and revoked.json()["app_enabled"] is True
        assert (await c.post("/v1/ai/ping", headers=h)).status_code == 403
        history = (await c.get("/v1/consents", headers=h)).json()["history"]
        assert any(x["kind"] == "ai_cross_border" and x["revoked_at"] for x in history)

    user = await s.scalar(select(User).where(User.public_id == uuid.UUID(t["user"]["id"])))
    assert user is not None and user.age_confirmed_at is not None


# --- devices ---


async def test_device_upsert_binds_session_and_moves_push_token(db_app):
    app, _, _ = db_app
    device = {"client_id": "0193f0c8-0000-7000-8000-0000000000aa", "platform": "android",
              "app_version": "0.1.0", "push_provider": "fcm", "push_token": "tok-1",
              "capabilities": {"exact_alarm_granted": False}}  # fmt: skip
    async with client(app) as c:
        a, b = await _anon(c), await _anon(c)
        for t in (a, b):
            await c.post("/v1/consents", json=_grant_body(*S05), headers=_auth(t))
        r1 = await c.post("/v1/devices", json=device, headers=_auth(a))
        assert r1.status_code == 200, r1.text
        r2 = await c.post("/v1/devices", json={**device, "app_version": "0.2.0"},
                          headers=_auth(a))  # fmt: skip
        assert r2.json()["id"] == r1.json()["id"] and r2.json()["app_version"] == "0.2.0"
        assert r2.json()["has_push_token"] is True
        other = await c.post("/v1/devices", json={**device, "client_id":
                             "0193f0c8-0000-7000-8000-0000000000bb"}, headers=_auth(b))  # fmt: skip
        assert other.json()["has_push_token"] is True
        gone = await c.delete(f"/v1/devices/{r1.json()['id']}", headers=_auth(a))
        assert gone.status_code == 204


# --- uploads ---


async def test_upload_presign_put_complete(db_app):
    app, _, s = db_app
    data = b"%PDF-1.7 fake"
    sha = hashlib.sha256(data).hexdigest()
    body = {"client_id": "0193f0c8-0000-7000-8000-0000000000cc", "mime": "application/pdf",
            "bytes": len(data), "sha256": sha}  # fmt: skip
    async with client(app) as c:
        t = await _anon(c)
        h = _auth(t)
        await c.post("/v1/consents", json=_grant_body(ConsentKind.PD_PROCESSING,
                                                       ConsentKind.TERMS), headers=h)  # fmt: skip
        r = await c.post("/v1/uploads", json=body, headers=h)
        assert r.status_code == 200, r.text
        up = r.json()
        assert up["state"] == "pending" and up["put"]["method"] == "PUT" and up["file_id"] is None
        again = (await c.post("/v1/uploads", json=body, headers=h)).json()
        assert again["id"] == up["id"]  # idempotent by client_id

        early = await c.post(f"/v1/uploads/{up['id']}/complete", headers=h)
        assert early.status_code == 409 and early.json()["code"] == "upload_not_found"

        url = up["put"]["url"].removeprefix("http://test")
        assert (await c.put(url, content=data, headers=up["put"]["headers"])).status_code == 200
        done = await c.post(f"/v1/uploads/{up['id']}/complete", headers=h)
        assert done.status_code == 200, done.text
        assert done.json()["state"] == "completed" and done.json()["file_id"]
        twice = await c.post(f"/v1/uploads/{up['id']}/complete", headers=h)
        assert twice.json()["file_id"] == done.json()["file_id"]

        # sha256 mismatch -> failed, object removed
        bad = (await c.post("/v1/uploads", json={**body, "client_id": None, "sha256": "b" * 64},
                            headers=h)).json()  # fmt: skip
        await c.put(bad["put"]["url"].removeprefix("http://test"), content=data)
        mismatch = await c.post(f"/v1/uploads/{bad['id']}/complete", headers=h)
        assert mismatch.status_code == 409 and mismatch.json()["code"] == "upload_mismatch"

    file_id = uuid.UUID(done.json()["file_id"])
    file = await s.scalar(select(File).where(File.public_id == file_id))
    assert file is not None and file.sha256 == sha and file.state == "active"
    assert file.storage_key.startswith(f"u/{t['user']['id']}/")
    failed = await s.scalar(select(Upload).where(Upload.public_id == uuid.UUID(bad["id"])))
    assert failed is not None and failed.state == "failed"
