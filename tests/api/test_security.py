import time
import uuid

import pytest

from assistant.api.security import (
    TokenError,
    decode_jwt,
    encode_jwt,
    issue_access_token,
    keyed_hash,
    new_otp_code,
    verify_access_token,
)
from assistant.db.ids import uuid7

SECRET = b"s" * 32


def test_access_token_roundtrip():
    user, sid = uuid.uuid4(), uuid.uuid4()
    token, exp = issue_access_token(user, sid, SECRET, 900)
    claims = verify_access_token(token, SECRET)
    assert claims.user_public_id == user and claims.session_public_id == sid
    assert claims.expires_at == exp and exp - time.time() <= 900


def test_expired_token_rejected():
    token, _ = issue_access_token(uuid.uuid4(), uuid.uuid4(), SECRET, 900, now=time.time() - 1000)
    with pytest.raises(TokenError, match="expired"):
        verify_access_token(token, SECRET)


def test_tampered_or_foreign_secret_rejected():
    token, _ = issue_access_token(uuid.uuid4(), uuid.uuid4(), SECRET, 900)
    with pytest.raises(TokenError):
        verify_access_token(token, b"other-secret")
    head, body, sig = token.split(".")
    forged = encode_jwt({"iss": "assistant", "typ": "access", "sub": str(uuid.uuid4()),
                         "sid": str(uuid.uuid4()), "exp": int(time.time()) + 60}, b"x")  # fmt: skip
    with pytest.raises(TokenError):
        verify_access_token(f"{head}.{forged.split('.')[1]}.{sig}", SECRET)
    for junk in ["", "a.b", "a.b.c", "....", "ü.ü.ü"]:
        with pytest.raises(TokenError):
            verify_access_token(junk, SECRET)


def test_alg_none_rejected():
    import base64
    import json

    def b64(d: dict) -> str:
        return base64.urlsafe_b64encode(json.dumps(d).encode()).rstrip(b"=").decode()

    token = f"{b64({'alg': 'none', 'typ': 'JWT'})}.{b64({'exp': 9999999999})}."
    with pytest.raises(TokenError):
        decode_jwt(token, SECRET)


def test_non_access_token_rejected():
    claims = {"iss": "assistant", "typ": "refresh", "sub": str(uuid.uuid4()),
              "sid": str(uuid.uuid4()), "exp": int(time.time()) + 60}  # fmt: skip
    token = encode_jwt(claims, SECRET)
    with pytest.raises(TokenError, match="not an access token"):
        verify_access_token(token, SECRET)


def test_keyed_hash_separates_purposes():
    a = keyed_hash(b"k", "+77011234567", purpose="phone")
    assert a == keyed_hash(b"k", "+77011234567", purpose="phone")
    assert a != keyed_hash(b"k", "+77011234567", purpose="anon_device")
    assert a != keyed_hash(b"k2", "+77011234567", purpose="phone")
    assert len(a) == 64


def test_otp_code_shape():
    codes = {new_otp_code() for _ in range(50)}
    assert all(len(c) == 6 and c.isdigit() for c in codes) and len(codes) > 1


def test_uuid7_version_and_order():
    a, b = uuid7(), uuid7()
    assert a.version == 7 and a.variant == uuid.RFC_4122
    time.sleep(0.002)
    c = uuid7()
    assert c > a and c > b
