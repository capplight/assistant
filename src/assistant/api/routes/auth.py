"""/v1/auth: anonymous account, refresh rotation, logout, phone OTP (+7 KZ / +996 KG)."""

import logging
from datetime import UTC, datetime

from fastapi import APIRouter, Request, Response

from assistant.api import auth_service as svc
from assistant.api.consent_gate import AI_CONSENTS, BASE_CONSENTS, missing_consents
from assistant.api.deps import (
    AuthUser,
    Ctx,
    Db,
    OptionalUser,
    active_consent_kinds,
    client_ip_hash,
)
from assistant.api.errors import ApiError
from assistant.api.phone import Phone, PhoneError, normalize_phone
from assistant.api.schemas import (
    AnonymousIn,
    AnonymousOut,
    OtpRequestIn,
    OtpRequestOut,
    OtpVerifyIn,
    OtpVerifyOut,
    RefreshIn,
    TokenPair,
)
from assistant.api.security import new_otp_code
from assistant.api.sms import FakeSmsSender, SmsError
from assistant.db.models import User
from assistant.db.models_v2 import AuthIdentity, AuthProvider, AuthSession, OtpChallenge, OtpPurpose
from assistant.logs import error_text

log = logging.getLogger(__name__)
router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/anonymous", response_model=AnonymousOut)
async def anonymous(body: AnonymousIn, ctx: Ctx, db: Db) -> AnonymousOut:
    user, created = await svc.anonymous_sign_in(db, ctx, body.device_key, locale=body.locale,
                                                tz=body.tz)  # fmt: skip
    pair = await svc.issue_session(db, ctx, user, device_id=None)
    return AnonymousOut(**pair.model_dump(), created=created)


@router.post("/refresh", response_model=TokenPair)
async def refresh(body: RefreshIn, ctx: Ctx, db: Db) -> TokenPair:
    return await svc.rotate_refresh(db, ctx, body.refresh_token)


@router.post("/logout", status_code=204)
async def logout(user: AuthUser, db: Db) -> Response:
    session = await db.get(AuthSession, user.session_id)
    if session is not None and session.revoked_at is None:
        session.revoked_at = datetime.now(UTC)
    return Response(status_code=204)


def _phone(raw: str) -> Phone:
    try:
        return normalize_phone(raw)
    except PhoneError as exc:
        raise ApiError(422, "phone_unsupported") from exc


@router.post("/otp/request", response_model=OtpRequestOut)
@router.post("/phone/start", response_model=OtpRequestOut, include_in_schema=False)
async def otp_request(
    body: OtpRequestIn, request: Request, user: OptionalUser, ctx: Ctx, db: Db
) -> OtpRequestOut:
    phone = _phone(body.phone)
    phone_hash = ctx.hash(phone.e164, purpose="phone")
    device_id = user.device_id if user else None
    await svc.check_otp_limits(db, phone_hash, device_id)
    purpose = body.purpose or (OtpPurpose.LINK if user else OtpPurpose.LOGIN)
    code = new_otp_code()
    challenge = OtpChallenge(phone_hash=phone_hash, purpose=purpose, code_hash="",
                             expires_at=datetime.now(UTC) + svc.OTP_TTL,
                             user_id=user.id if user else None, device_id=device_id,
                             ip_hash=client_ip_hash(request, ctx))  # fmt: skip
    db.add(challenge)
    await db.flush()
    challenge.code_hash = svc.otp_code_hash(ctx, challenge.public_id, code)
    await db.commit()  # never hold a transaction across the SMS gateway call
    try:
        await ctx.sms.send_otp(phone, code, locale=user.locale if user else "ru")
    except SmsError as exc:
        log.warning("otp sms failed for %s: %s", phone.masked, error_text(exc))
        raise ApiError(502, "sms_failed") from exc
    dev_code = code if ctx.settings.api_dev_mode and isinstance(ctx.sms, FakeSmsSender) else None
    return OtpRequestOut(challenge_id=challenge.public_id, expires_at=challenge.expires_at,
                         dev_code=dev_code)  # fmt: skip


@router.post("/otp/verify", response_model=OtpVerifyOut)
@router.post("/phone/verify", response_model=OtpVerifyOut, include_in_schema=False)
async def otp_verify(body: OtpVerifyIn, user: OptionalUser, ctx: Ctx, db: Db) -> OtpVerifyOut:
    """Link the phone to the signed-in (anonymous) account, or sign into the phone's account.

    Phone known  -> tokens for its account (account_switched when that differs from the caller).
    Phone new    -> attached to the caller; without a caller a new account is created.
    """
    phone = _phone(body.phone)
    phone_hash = ctx.hash(phone.e164, purpose="phone")
    await svc.consume_otp(db, ctx, body.challenge_id, phone_hash, body.code)
    now = datetime.now(UTC)
    owner = await svc.find_identity_user(db, AuthProvider.PHONE, phone_hash)
    switched = False
    if owner is not None:
        await svc.ensure_signin_allowed(db, ctx, owner)
        switched = user is not None and owner.id != user.id
        target = owner
    else:
        if user is not None:
            target = await db.get(User, user.id)
            assert target is not None
        else:
            target = User(locale="ru", language="ru")
            db.add(target)
            await db.flush()
        db.add(AuthIdentity(user_id=target.id, provider=AuthProvider.PHONE,
                            subject_hash=phone_hash, verified_at=now))  # fmt: skip
        target.country = target.country or phone.country
    device_id = user.device_id if user is not None and not switched else None
    pair = await svc.issue_session(db, ctx, target, device_id=device_id)
    # Consents stay with their account: nothing is copied from the caller's (docs/api/auth.md).
    kinds = await active_consent_kinds(db, target.id)
    return OtpVerifyOut(**pair.model_dump(), account_switched=switched,
                        app_enabled=not missing_consents(kinds, BASE_CONSENTS),
                        ai_enabled=not missing_consents(kinds, AI_CONSENTS))  # fmt: skip
