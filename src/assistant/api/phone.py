"""Phone normalization for sign-in: Kazakhstan (+7 6xx/7xx) and Kyrgyzstan (+996) only.

Deliberately tiny instead of `phonenumbers`: we accept two plans and reject the rest.
"""

import re
from dataclasses import dataclass

_JUNK = re.compile(r"[\s()\-.]")


@dataclass(frozen=True)
class Phone:
    e164: str  # +77011234567
    country: str  # KZ | KG

    @property
    def masked(self) -> str:
        """For logs: +7701***67."""
        return f"{self.e164[:5]}***{self.e164[-2:]}"


class PhoneError(ValueError):
    pass


def normalize_phone(raw: str) -> Phone:
    digits = _JUNK.sub("", raw.strip())
    if digits.startswith("8") and len(digits) == 11:  # local KZ format 8 7xx xxx xx xx
        digits = "+7" + digits[1:]
    if not digits.startswith("+") or not digits[1:].isdigit():
        raise PhoneError("not a phone number")
    if digits.startswith("+996"):
        if len(digits) != 13:  # +996 + 9 digits
            raise PhoneError("bad KG number length")
        return Phone(digits, "KG")
    if digits.startswith("+7"):
        if len(digits) != 12:  # +7 + 10 digits
            raise PhoneError("bad +7 number length")
        if digits[2] not in "67":  # +7 9xx etc. are Russian numbers, not supported
            raise PhoneError("not a Kazakhstan number")
        return Phone(digits, "KZ")
    raise PhoneError("unsupported country code")
