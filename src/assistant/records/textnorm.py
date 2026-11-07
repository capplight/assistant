"""Text helpers shared by POST /v1/items and the ingest jobs. Pure functions, no I/O.

`content_hash` is also computed on the phone (spec 6.3) and must match byte for byte:

    1. Unicode NFKC        2. lowercase        3. every char that is not a letter or digit
    (Unicode L*/N*) -> space        4. collapse spaces, trim        5. sha256 hex of UTF-8

    JS: sha256(s.normalize("NFKC").toLowerCase().replace(/[^\\p{L}\\p{N}]+/gu, " ").trim())

Empty after step 4 -> no hash (nothing to compare).
"""

import hashlib
import re
import unicodedata

_ZERO_WIDTH = dict.fromkeys(map(ord, "​‌‍⁠﻿"))
_BLANK_LINES = re.compile(r"\n{3,}")
_SPACES = re.compile(r"[ \t ]+")
_URL = re.compile(r"https?://[^\s<>\"']+", re.IGNORECASE)

KK_LETTERS = set("әғқңөұүһі")


def normalize_text(text: str) -> str:
    """Canonical stored text: NFC, no zero-width chars, \\n line ends, trimmed lines."""
    text = unicodedata.normalize("NFC", text).translate(_ZERO_WIDTH)
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = [_SPACES.sub(" ", line).strip() for line in text.split("\n")]
    return _BLANK_LINES.sub("\n\n", "\n".join(lines)).strip()


def hash_basis(text: str) -> str:
    text = unicodedata.normalize("NFKC", text).lower()
    chars = [c if unicodedata.category(c)[0] in "LN" else " " for c in text]
    return " ".join("".join(chars).split())


def content_hash(text: str | None) -> str | None:
    if not text:
        return None
    basis = hash_basis(text)
    return hashlib.sha256(basis.encode()).hexdigest() if basis else None


def detect_lang(text: str | None) -> str | None:
    """ru|kk|en|other by script; None when there are no letters. fastText lid comes later."""
    if not text:
        return None
    letters = [c for c in text.lower() if c.isalpha()]
    if not letters:
        return None
    if any(c in KK_LETTERS for c in letters):
        return "kk"
    cyr = sum("а" <= c <= "я" or c == "ё" for c in letters)
    lat = sum("a" <= c <= "z" for c in letters)
    if cyr >= lat and cyr / len(letters) > 0.3:
        return "ru"
    if lat / len(letters) > 0.3:
        return "en"
    return "other"


def find_links(text: str | None) -> list[str]:
    if not text:
        return []
    return list(dict.fromkeys(m.rstrip(".,;:!?)»") for m in _URL.findall(text)))


# --- "Проверьте" fields (spec 6.1): numbers OCR/STT can get wrong ---

_REVIEW_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("iban", re.compile(r"\bKZ\d{2}(?:\s?[A-Z0-9]){16}\b")),
    ("phone", re.compile(
        r"(?<![\d+])(?:\+996(?:[\s\-()]*\d){9}|(?:\+7|8)(?:[\s\-()]*\d){10})(?!\d)")),
    ("iin_bin", re.compile(r"(?<!\d)\d{12}(?!\d)")),
    ("amount", re.compile(
        r"(?<![\d.,])\d{1,3}(?:[  ]?\d{3})*(?:[.,]\d{1,2})?\s?"
        r"(?:₸|тг\b|тенге|KZT|сом\b|KGS|руб\b|₽|USD|\$|EUR|€)", re.IGNORECASE)),
    ("doc_number", re.compile(r"№\s?[A-ZА-Я0-9][A-ZА-Я0-9\-/]{2,}", re.IGNORECASE)),
]  # fmt: skip


def detect_review_fields(text: str | None) -> dict[str, dict]:
    """{"phone_1": {"kind": "phone", "value": "+7 701 ...", "state": "unverified"}, ...}"""
    if not text:
        return {}
    found: dict[str, dict] = {}
    taken: list[tuple[int, int]] = []
    for kind, pattern in _REVIEW_PATTERNS:
        n = 0
        for m in pattern.finditer(text):
            if any(m.start() < end and start < m.end() for start, end in taken):
                continue  # already part of an IBAN / phone
            taken.append((m.start(), m.end()))
            n += 1
            found[f"{kind}_{n}"] = {"kind": kind, "value": m.group(0).strip(),
                                    "state": "unverified"}  # fmt: skip
    return found


def title_from_text(text: str | None, limit: int = 80) -> str | None:
    """First non-empty line, cut at a word boundary."""
    if not text:
        return None
    first = next((line.strip() for line in text.split("\n") if line.strip()), "")
    if len(first) <= limit:
        return first or None
    cut = first[:limit].rsplit(" ", 1)[0]
    return (cut or first[:limit]) + "…"
