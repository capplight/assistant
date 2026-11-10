"""Field encryption for the company profile's БИН/ИИН and bank details (spec 7.4: «Прикладное
AES-256-GCM … БИН/IBAN профиля компании»). `company_profiles.bin_iin_enc` and `bank_enc` hold
`b"k1" + nonce(12) + AES-GCM(ciphertext + tag)`; the associated data binds a value to its user and
field, so a value copied to another row does not open.

The key is `settings.kp_field_key` (32 bytes, base64). In dev mode (`api_dev_mode=true`) an empty
key falls back to a fixed dev key, like the JWT secret. Production keys come from the KMS in KZ
(envelope encryption); this class is the place to swap that in. The «k1» prefix is the key id, so
a rotation can read old rows.
"""

import base64
import hashlib
import json
import os
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

KEY_ID = b"k1"


class CipherError(ValueError):
    pass


class FieldCipher:
    def __init__(self, key: bytes) -> None:
        if len(key) != 32:
            raise CipherError("the field key must be 32 bytes")
        self._aead = AESGCM(key)

    @classmethod
    def from_settings(cls, settings: Any) -> "FieldCipher":
        raw = settings.kp_field_key.get_secret_value()
        if raw:
            return cls(base64.b64decode(raw))
        if settings.api_dev_mode:
            return cls(hashlib.sha256(b"assistant-dev-kp-field-key").digest())
        raise CipherError("KP_FIELD_KEY must be set (or API_DEV_MODE=true for local dev)")

    @staticmethod
    def _aad(user_id: int, name: str) -> bytes:
        return f"{user_id}:{name}".encode()

    def seal(self, user_id: int, name: str, value: Any) -> bytes | None:
        if value in (None, "", {}, []):
            return None
        nonce = os.urandom(12)
        data = json.dumps(value, ensure_ascii=False, sort_keys=True).encode()
        return KEY_ID + nonce + self._aead.encrypt(nonce, data, self._aad(user_id, name))

    def open(self, user_id: int, name: str, blob: bytes | None) -> Any:
        if not blob:
            return None
        if blob[:2] != KEY_ID:
            raise CipherError("unknown key id")
        try:
            data = self._aead.decrypt(blob[2:14], blob[14:], self._aad(user_id, name))
        except Exception as exc:  # InvalidTag: wrong key, row or field
            raise CipherError("cannot open the field") from exc
        return json.loads(data)


def b64(blob: bytes | None) -> str | None:
    return base64.b64encode(blob).decode() if blob else None


def unb64(text: str | None) -> bytes | None:
    return base64.b64decode(text) if text else None


__all__ = ["CipherError", "FieldCipher", "b64", "unb64"]
