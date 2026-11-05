"""JWT (HS256), refresh tokens, keyed hashes. Stdlib only: no PyJWT/cryptography dependency.

Access token: JWT, 15 min, claims {iss, typ="access", sub=user public_id, sid=session public_id,
iat, exp}. Refresh token: opaque random string; the DB keeps only its HMAC.
"""

import base64
import hashlib
import hmac
import json
import secrets
import time
import uuid
from dataclasses import dataclass
from typing import Any

ISSUER = "assistant"
_HEADER = {"alg": "HS256", "typ": "JWT"}


class TokenError(Exception):
    """Invalid, expired or tampered token."""


def _b64e(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64d(data: str) -> bytes:
    return base64.urlsafe_b64decode(data + "=" * (-len(data) % 4))


def _sign(secret: bytes, signing_input: bytes) -> bytes:
    return hmac.new(secret, signing_input, hashlib.sha256).digest()


def encode_jwt(claims: dict[str, Any], secret: bytes) -> str:
    head = _b64e(json.dumps(_HEADER, separators=(",", ":")).encode())
    body = _b64e(json.dumps(claims, separators=(",", ":")).encode())
    signing_input = f"{head}.{body}".encode("ascii")
    return f"{head}.{body}.{_b64e(_sign(secret, signing_input))}"


def decode_jwt(token: str, secret: bytes, *, now: float | None = None) -> dict[str, Any]:
    try:
        head, body, sig = token.split(".")
        header = json.loads(_b64d(head))
        expected = _sign(secret, f"{head}.{body}".encode("ascii"))
        if header != _HEADER or not hmac.compare_digest(expected, _b64d(sig)):
            raise TokenError("bad signature")
        claims = json.loads(_b64d(body))
    except (ValueError, UnicodeError) as exc:  # binascii.Error and JSONDecodeError are ValueErrors
        raise TokenError("malformed token") from exc
    if not isinstance(claims, dict):
        raise TokenError("malformed claims")
    exp = claims.get("exp")
    if not isinstance(exp, int) or exp <= (time.time() if now is None else now):
        raise TokenError("expired")
    if claims.get("iss") != ISSUER:
        raise TokenError("bad issuer")
    return claims


@dataclass(frozen=True)
class AccessClaims:
    user_public_id: uuid.UUID
    session_public_id: uuid.UUID
    expires_at: int


def issue_access_token(
    user_public_id: uuid.UUID,
    session_public_id: uuid.UUID,
    secret: bytes,
    ttl_seconds: int,
    *,
    now: float | None = None,
) -> tuple[str, int]:
    """Returns (token, exp unix seconds)."""
    iat = int(time.time() if now is None else now)
    exp = iat + ttl_seconds
    claims = {"iss": ISSUER, "typ": "access", "sub": str(user_public_id),
              "sid": str(session_public_id), "iat": iat, "exp": exp}  # fmt: skip
    return encode_jwt(claims, secret), exp


def verify_access_token(token: str, secret: bytes, *, now: float | None = None) -> AccessClaims:
    claims = decode_jwt(token, secret, now=now)
    if claims.get("typ") != "access":
        raise TokenError("not an access token")
    try:
        return AccessClaims(uuid.UUID(claims["sub"]), uuid.UUID(claims["sid"]), claims["exp"])
    except (KeyError, ValueError, TypeError) as exc:
        raise TokenError("malformed claims") from exc


def new_refresh_token() -> str:
    return secrets.token_urlsafe(32)


def keyed_hash(key: bytes, value: str, *, purpose: str) -> str:
    """HMAC-SHA256 hex. `purpose` separates domains (a phone hash never equals a device hash)."""
    return hmac.new(key, f"{purpose}:{value}".encode(), hashlib.sha256).hexdigest()


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def new_otp_code(digits: int = 6) -> str:
    return f"{secrets.randbelow(10**digits):0{digits}d}"
