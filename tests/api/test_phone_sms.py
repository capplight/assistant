import pytest

from assistant.api.phone import PhoneError, normalize_phone
from assistant.api.sms import FakeSmsSender, SmsError, make_sms_sender, otp_text


@pytest.mark.parametrize(
    ("raw", "e164", "country"),
    [
        ("+7 701 123 45 67", "+77011234567", "KZ"),
        ("8 (701) 123-45-67", "+77011234567", "KZ"),
        ("+7 600 000 00 00", "+76000000000", "KZ"),
        ("+996 555 123 456", "+996555123456", "KG"),
    ],
)
def test_supported_numbers(raw, e164, country):
    phone = normalize_phone(raw)
    assert (phone.e164, phone.country) == (e164, country)


@pytest.mark.parametrize(
    "raw", ["+7 916 123 45 67", "+1 202 555 0100", "+7701", "+99655512345", "hello", "77011234567"]
)
def test_rejected_numbers(raw):
    with pytest.raises(PhoneError):
        normalize_phone(raw)


def test_masked_hides_middle():
    assert normalize_phone("+77011234567").masked == "+7701***67"


async def test_fake_sms_keeps_code_and_does_not_log_it(caplog):
    sms = FakeSmsSender()
    phone = normalize_phone("+77011234567")
    with caplog.at_level("INFO"):
        await sms.send_otp(phone, "123456", locale="ru")
    assert sms.last_code_for("+77011234567") == "123456"
    assert sms.sent[0][1] == otp_text("123456", "ru")
    assert "123456" not in caplog.text and "+77011234567" not in caplog.text


async def test_fake_sms_failure_and_kk_text():
    assert "Кіру коды" in otp_text("000111", "kk")
    with pytest.raises(SmsError):
        await FakeSmsSender(fail=True).send_otp(normalize_phone("+996555123456"), "1", locale="ru")


def test_only_fake_provider_exists():
    assert isinstance(make_sms_sender("fake"), FakeSmsSender)
    with pytest.raises(ValueError):
        make_sms_sender("mobizon")
