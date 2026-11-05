"""SmsSender adapter. Real KZ gateways (Mobizon / SMSC.kz) plug in here; only the fake exists."""

import logging
from dataclasses import dataclass, field
from typing import Protocol

from assistant.api.phone import Phone

log = logging.getLogger(__name__)


class SmsError(Exception):
    """Gateway refused or failed to send."""


class SmsSender(Protocol):
    async def send_otp(self, phone: Phone, code: str, *, locale: str) -> None: ...


def otp_text(code: str, locale: str) -> str:
    if locale == "kk":
        return f"Кіру коды: {code}. Ешкімге айтпаңыз."
    return f"Код для входа: {code}. Никому его не сообщайте."


@dataclass
class FakeSmsSender:
    """Dev/test sender: keeps messages in memory, logs that a code went out (never the code)."""

    sent: list[tuple[str, str]] = field(default_factory=list)  # (e164, text)
    fail: bool = False

    async def send_otp(self, phone: Phone, code: str, *, locale: str) -> None:
        if self.fail:
            raise SmsError("fake gateway failure")
        self.sent.append((phone.e164, otp_text(code, locale)))
        log.info("fake sms: otp sent to %s", phone.masked)

    def last_code_for(self, e164: str) -> str | None:
        for number, text in reversed(self.sent):
            if number == e164:
                return "".join(ch for ch in text if ch.isdigit())
        return None


def make_sms_sender(provider: str) -> SmsSender:
    if provider == "fake":
        return FakeSmsSender()
    raise ValueError(f"sms provider {provider!r} is not implemented yet")
