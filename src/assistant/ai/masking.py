"""PII masking before any AI call (spec 5.7, R-24).

Found values are replaced by placeholders `⟨KIND_n⟩`; the table lives only in this object (one
per task, never stored or logged). After the answer the router puts the values back.

Kinds: EMAIL, IBAN (mod-97), CARD (Luhn), BIN (KZ IIN/BIN, 12 digits + checksum), ID (passport /
ID card next to a keyword), PHONE (+7 / 8 / +996 and other + international numbers).
Phones and emails can stay visible for tasks that need them (ENRICH): `mask_contacts=False`.
"""

import re
from collections.abc import Callable
from typing import Any

_OPEN, _CLOSE = "⟨", "⟩"
_PLACEHOLDER_RE = re.compile(r"⟨([A-Z]+)_(\d+)⟩")

_EMAIL_RE = re.compile(r"(?<![\w.+-])[\w.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")
_IBAN_RE = re.compile(r"\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,3})?\b")
_CARD_RE = re.compile(r"(?<![\d])\d(?:[ -]?\d){12,18}(?![\d])")
_BIN_RE = re.compile(r"(?<![\d])\d{12}(?![\d])")
_ID_RE = re.compile(
    r"(?i)(?:удостоверени\w*|удост\.?|уд\.|паспорт\w*|passport|жеке куәлік\w*|ID)"
    r"\s*(?:№|N|No\.?|#)?\s*([NnН]?\s?\d{8,9})\b"
)
_PASSPORT_RE = re.compile(r"(?<![\w])[NН]\d{8}(?![\d])")
_PHONE_RE = re.compile(
    r"(?<![\w+])(?:"
    r"(?:\+7|8)[\s-]?\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}"
    r"|\+996[\s-]?\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{3}"
    r"|\+\d{1,3}(?:[\s-]?\(?\d{2,4}\)?){2,4}[\s-]?\d{2,4}"
    r")(?![\d])"
)


def luhn_ok(digits: str) -> bool:
    total = 0
    for i, ch in enumerate(reversed(digits)):
        d = int(ch)
        if i % 2 == 1:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


def iban_ok(value: str) -> bool:
    v = value.replace(" ", "")
    if not 15 <= len(v) <= 34:
        return False
    rearranged = v[4:] + v[:4]
    num = "".join(str(int(c, 36)) for c in rearranged)
    return int(num) % 97 == 1


def iin_bin_ok(digits: str) -> bool:
    """Kazakhstan IIN/BIN control digit (12th) with the two weight series."""
    if len(digits) != 12 or not digits.isdigit():
        return False
    nums = [int(c) for c in digits]
    w1 = list(range(1, 12))
    w2 = [3, 4, 5, 6, 7, 8, 9, 10, 11, 1, 2]
    check = sum(a * b for a, b in zip(nums[:11], w1, strict=True)) % 11
    if check == 10:
        check = sum(a * b for a, b in zip(nums[:11], w2, strict=True)) % 11
        if check == 10:
            return False
    return check == nums[11]


class Masker:
    def __init__(self, *, mask_contacts: bool = True) -> None:
        self.mask_contacts = mask_contacts
        self._by_value: dict[tuple[str, str], str] = {}
        self._by_placeholder: dict[str, str] = {}
        self._counters: dict[str, int] = {}

    def __len__(self) -> int:
        return len(self._by_placeholder)

    def _placeholder(self, kind: str, value: str) -> str:
        key = (kind, value)
        if key in self._by_value:
            return self._by_value[key]
        n = self._counters.get(kind, 0) + 1
        self._counters[kind] = n
        ph = f"{_OPEN}{kind}_{n}{_CLOSE}"
        self._by_value[key] = ph
        self._by_placeholder[ph] = value
        return ph

    def _sub(
        self, text: str, regex: re.Pattern[str], kind: str,
        check: Callable[[str], bool] | None = None, group: int = 0,
    ) -> str:  # fmt: skip
        def repl(m: re.Match[str]) -> str:
            value = m.group(group)
            if check is not None and not check(value):
                return m.group(0)
            ph = self._placeholder(kind, value)
            if group == 0:
                return ph
            start, end = m.start(group) - m.start(0), m.end(group) - m.start(0)
            whole = m.group(0)
            return whole[:start] + ph + whole[end:]

        return regex.sub(repl, text)

    def mask(self, text: str) -> str:
        # Text can't smuggle our own placeholder syntax (unmask would then "restore" it).
        text = text.replace(_OPEN, "‹").replace(_CLOSE, "›")
        if self.mask_contacts:
            text = self._sub(text, _EMAIL_RE, "EMAIL")
        text = self._sub(text, _IBAN_RE, "IBAN", iban_ok)
        text = self._sub(text, _CARD_RE, "CARD",
                         lambda v: luhn_ok(re.sub(r"\D", "", v)) and not _BIN_RE.fullmatch(v))
        text = self._sub(text, _BIN_RE, "BIN", iin_bin_ok)
        text = self._sub(text, _ID_RE, "ID", group=1)
        text = self._sub(text, _PASSPORT_RE, "ID")
        if self.mask_contacts:
            text = self._sub(text, _PHONE_RE, "PHONE")
        return text  # fmt: skip

    def unmask(self, text: str) -> str:
        if not self._by_placeholder:
            return text
        return _PLACEHOLDER_RE.sub(lambda m: self._by_placeholder.get(m.group(0), m.group(0)),
                                   text)  # fmt: skip

    def unmask_obj(self, obj: Any) -> Any:
        """Unmask every string inside dicts/lists (a model_dump or tool-call arguments)."""
        if isinstance(obj, str):
            return self.unmask(obj)
        if isinstance(obj, dict):
            return {k: self.unmask_obj(v) for k, v in obj.items()}
        if isinstance(obj, list):
            return [self.unmask_obj(v) for v in obj]
        return obj
