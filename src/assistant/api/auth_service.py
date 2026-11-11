"""Sessions and identities: create users, issue/rotate tokens, OTP challenges."""

import hmac
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.api.deps import ApiContext
from assistant.api.errors import ApiError
from assistant.api.schemas import TokenPair, UserOut
from assistant.api.security import issue_access_token, new_refresh_token
from assistant.db.models import User
from assistant.db.models_v2 import AuthIdentity, AuthProvider, AuthSession, OtpChallenge, UserStatus

OTP_TTL = timedelta(minutes=5)
OTP_MAX_ATTEMPTS = 5
OTP_PER_PHONE_HOUR = 3
OTP_PER_DEVICE_DAY = 10


def _now() -> datetime:
    return datetime.now(UTC)


async def has_verified_phone(db: AsyncSession, user_id: int) -> bool:
    phone = await db.scalar(
        select(AuthIdentity.id).where(
            AuthIdentity.user_id == user_id,
            AuthIdentity.provider == AuthProvider.PHONE,
            AuthIdentity.verified_at.is_not(None),
        )
    )
    return phone is not None


async def user_out(db: AsyncSession, user: User) -> UserOut:
    linked = await has_verified_phone(db, user.id)
    return UserOut(id=user.public_id, display_name=user.display_name, locale=user.locale,
                   tz=user.tz, country=user.country, is_anonymous=not linked,
                   age_confirmed=user.age_confirmed_at is not None)  # fmt: skip


async def issue_session(
    db: AsyncSession,
    ctx: ApiContext,
    user: User,
    *,
    device_id: int | None,
    rotated_from: int | None = None,
) -> TokenPair:
    refresh = new_refresh_token()
    refresh_expires = _now() + timedelta(days=ctx.settings.refresh_token_days)
    session = AuthSession(user_id=user.id, device_id=device_id, rotated_from=rotated_from,
                          refresh_hash=ctx.hash(refresh, purpose="refresh"),
                          expires_at=refresh_expires)  # fmt: skip
    db.add(session)
    await db.flush()
    access, exp = issue_access_token(user.public_id, session.public_id, ctx.jwt_secret,
                                     ctx.settings.access_token_minutes * 60)  # fmt: skip
    user.last_active_at = _now()
    return TokenPair(access_token=access, access_expires_at=datetime.fromtimestamp(exp, UTC),
                     refresh_token=refresh, refresh_expires_at=refresh_expires,
                     user=await user_out(db, user))  # fmt: skip


def ensure_active(user: User) -> None:
    if user.status != UserStatus.ACTIVE:
        raise ApiError(403, "account_blocked")


async def ensure_signin_allowed(db: AsyncSession, ctx: ApiContext, user: User) -> None:
    """Sign-in to an account being deleted (week 16, docs/api/account.md): no tokens, but a short
    «Восстановить» token for `POST /me/deletion/cancel`. Committed before raising (the request's
    transaction is rolled back on the error)."""
    if user.status == UserStatus.DELETION_PENDING:
        from assistant.account import issue_restore, new_restore_token, pending_deletion

        deletion = await pending_deletion(db, user.id)
        if deletion is not None:
            token = new_restore_token()
            until = await issue_restore(db, deletion, ctx.hash(token, purpose="restore"),
                                        minutes=ctx.settings.account_restore_token_minutes,
                                        now=_now())  # fmt: skip
            await db.commit()
            raise ApiError(403, "account_deletion_pending", details={
                "delete_after": deletion.cancel_until.isoformat(), "restore_token": token,
                "restore_expires_at": until.isoformat()})  # fmt: skip
    ensure_active(user)


async def find_identity_user(
    db: AsyncSession, provider: AuthProvider, subject_hash: str
) -> User | None:
    return await db.scalar(
        select(User)
        .join(AuthIdentity, AuthIdentity.user_id == User.id)
        .where(AuthIdentity.provider == provider, AuthIdentity.subject_hash == subject_hash)
    )


async def anonymous_sign_in(
    db: AsyncSession, ctx: ApiContext, device_key: str, *, locale: str, tz: str
) -> tuple[User, bool]:
    """Returns (user, created). Same device key = same account (reinstall keeps the Keychain)."""
    subject = ctx.hash(device_key, purpose="anon_device")
    user = await find_identity_user(db, AuthProvider.ANON_DEVICE, subject)
    if user is not None:
        await ensure_signin_allowed(db, ctx, user)
        return user, False
    try:
        async with db.begin_nested():
            user = User(locale=locale, language=locale, tz=tz)
            db.add(user)
            await db.flush()
            db.add(AuthIdentity(user_id=user.id, provider=AuthProvider.ANON_DEVICE,
                                subject_hash=subject, verified_at=_now()))  # fmt: skip
            await db.flush()
    except IntegrityError:  # concurrent first launch with the same key
        user = await find_identity_user(db, AuthProvider.ANON_DEVICE, subject)
        if user is None:
            raise
        await ensure_signin_allowed(db, ctx, user)
        return user, False
    return user, True


def _refresh_rejected(linked: bool | None) -> ApiError:
    """`account_linked` tells the phone how to recover (docs/api/auth.md): true = phone sign-in,
    false = POST /auth/anonymous, null = this token is unknown, use what the phone remembers."""
    return ApiError(401, "invalid_refresh", details={"account_linked": linked})


async def rotate_refresh(db: AsyncSession, ctx: ApiContext, refresh_token: str) -> TokenPair:
    refresh_hash = ctx.hash(refresh_token, purpose="refresh")
    session = await db.scalar(
        select(AuthSession).where(AuthSession.refresh_hash == refresh_hash).with_for_update()
    )
    if session is None:
        raise _refresh_rejected(None)
    linked = await has_verified_phone(db, session.user_id)
    now = _now()
    if session.revoked_at is not None:
        # Reuse of a rotated token: someone else may hold the chain. Revoke all of the user's
        # sessions on that device (or all, if unknown) and force sign-in.
        stmt = update(AuthSession).where(
            AuthSession.user_id == session.user_id, AuthSession.revoked_at.is_(None)
        )
        if session.device_id is not None:
            stmt = stmt.where(AuthSession.device_id == session.device_id)
        await db.execute(stmt.values(revoked_at=now))
        await db.commit()
        raise _refresh_rejected(linked)
    if session.expires_at <= now:
        raise _refresh_rejected(linked)
    user = await db.get(User, session.user_id)
    assert user is not None  # FK
    ensure_active(user)
    session.revoked_at = now
    return await issue_session(db, ctx, user, device_id=session.device_id, rotated_from=session.id)


def otp_code_hash(ctx: ApiContext, challenge_public_id: uuid.UUID, code: str) -> str:
    return ctx.hash(f"{challenge_public_id}:{code}", purpose="otp")


async def check_otp_limits(
    db: AsyncSession, phone_hash: str, device_id: int | None
) -> None:
    now = _now()
    per_phone = await db.scalar(
        select(func.count()).where(OtpChallenge.phone_hash == phone_hash,
                                   OtpChallenge.created_at > now - timedelta(hours=1))
    )  # fmt: skip
    if (per_phone or 0) >= OTP_PER_PHONE_HOUR:
        raise ApiError(429, "otp_rate_limited", retry_after=3600)
    if device_id is not None:
        per_device = await db.scalar(
            select(func.count()).where(OtpChallenge.device_id == device_id,
                                       OtpChallenge.created_at > now - timedelta(days=1))
        )  # fmt: skip
        if (per_device or 0) >= OTP_PER_DEVICE_DAY:
            raise ApiError(429, "otp_rate_limited", retry_after=86400)


async def consume_otp(
    db: AsyncSession, ctx: ApiContext, challenge_public_id: uuid.UUID, phone_hash: str, code: str
) -> OtpChallenge:
    """Validates the code. Wrong attempts are committed before raising."""
    challenge = await db.scalar(
        select(OtpChallenge).where(OtpChallenge.public_id == challenge_public_id).with_for_update()
    )
    now = _now()
    if challenge is None or challenge.phone_hash != phone_hash:
        raise ApiError(400, "otp_invalid")
    if (challenge.consumed_at is not None or challenge.expires_at <= now
            or challenge.attempts >= OTP_MAX_ATTEMPTS):  # fmt: skip
        raise ApiError(400, "otp_expired")
    if not hmac.compare_digest(challenge.code_hash, otp_code_hash(ctx, challenge_public_id, code)):
        challenge.attempts += 1
        await db.commit()
        raise ApiError(400, "otp_invalid")
    challenge.consumed_at = now
    return challenge
