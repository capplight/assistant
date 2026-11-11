"""/v1/me/deletion and /v1/export: «Мои данные» (S24, S32; F-26, F-27; US-19, US-20). Contract:
docs/api/account.md. Only a signed-in token is needed, not the base consents: a person who withdrew
them can still take their data and delete the account.
"""

import hmac
import logging
import uuid
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Query, Response
from pydantic import BaseModel, Field
from sqlalchemy import select

from assistant import account
from assistant.api import auth_service as svc
from assistant.api.deps import AuthUser, Ctx, Db, client_ip_hash
from assistant.api.errors import ApiError
from assistant.api.phone import PhoneError, normalize_phone
from assistant.api.schemas import OtpRequestOut, TokenPair
from assistant.api.security import new_otp_code
from assistant.api.sms import FakeSmsSender, SmsError
from assistant.db import queue
from assistant.db.models import User
from assistant.db.models_account import DataExport, DeletionVia, ExportStatus
from assistant.db.models_v2 import AuthIdentity, AuthProvider, OtpChallenge, OtpPurpose, UserStatus
from assistant.logs import error_text

log = logging.getLogger(__name__)
router = APIRouter(tags=["account"])
EXPORTS_LISTED = 5
MONTHS = ("января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября",
          "октября", "ноября", "декабря")  # fmt: skip


def _now() -> datetime:
    return datetime.now(UTC)


def ru_date(when: datetime, tz: str) -> str:
    from zoneinfo import ZoneInfo

    local = when.astimezone(ZoneInfo(tz or "Asia/Almaty"))
    return f"{local.day} {MONTHS[local.month - 1]}"


def deletion_points(grace_days: int, *, phone: bool) -> list[str]:
    """S32 / W-01: what will happen, in the person's words (2-design 5.2)."""
    if grace_days <= 0:
        return ["Вход закроется сразу.", "Удалю всё за сутки. Отменить будет нельзя.",
                "Копии на резервных серверах исчезнут не позже 30 дней.",
                "Через поддержку вернуть нельзя."]  # fmt: skip
    how = "войдите по SMS" if phone else "откройте приложение"
    return ["Вход закроется сразу.", f"{_days(grace_days)} можно передумать — {how}.",
            "Потом удалю всё за сутки.",
            "Копии на резервных серверах исчезнут не позже 30 дней.",
            "Через поддержку вернуть нельзя."]  # fmt: skip


def _days(n: int) -> str:
    if n % 10 == 1 and n % 100 != 11:
        word = "день"
    elif n % 10 in (2, 3, 4) and n % 100 not in (12, 13, 14):
        word = "дня"
    else:
        word = "дней"
    return f"{n} {word}"


def pending_message(delete_after: datetime, tz: str, *, phone: bool, grace_days: int) -> str:
    if grace_days <= 0:
        return "Аккаунт удаляется. Удалю всё за сутки."
    how = "войдите по SMS" if phone else "откройте приложение"
    return f"Аккаунт удаляется. До {ru_date(delete_after, tz)} можно передумать: {how}."


async def _phone_hash(db: Db, user_id: int) -> str | None:
    return await db.scalar(select(AuthIdentity.subject_hash).where(
        AuthIdentity.user_id == user_id, AuthIdentity.provider == AuthProvider.PHONE,
        AuthIdentity.verified_at.is_not(None)).limit(1))  # fmt: skip


async def _user(db: Db, user_id: int) -> User:
    row = await db.get(User, user_id)
    if row is None:
        raise ApiError(401, "unauthorized")
    return row


# --- deletion ---


class DeletionStateOut(BaseModel):
    status: str
    needs_sms: bool
    grace_days: int
    delete_after: datetime | None
    points_ru: list[str]


class DeletionOtpIn(BaseModel):
    phone: str = Field(min_length=10, max_length=20)


class DeletionIn(BaseModel):
    challenge_id: uuid.UUID | None = None
    code: str | None = Field(default=None, min_length=4, max_length=8)
    confirm: bool | None = None


class DeletionOut(BaseModel):
    status: Literal["deletion_pending"] = "deletion_pending"
    requested_at: datetime
    delete_after: datetime
    grace_days: int
    message_ru: str


class CancelIn(BaseModel):
    restore_token: str = Field(min_length=10, max_length=200)


@router.get("/me/deletion", response_model=DeletionStateOut)
async def deletion_state(user: AuthUser, db: Db, ctx: Ctx) -> DeletionStateOut:
    row = await _user(db, user.id)
    phone = await _phone_hash(db, user.id) is not None
    grace = ctx.settings.account_delete_grace_days
    return DeletionStateOut(status=row.status, needs_sms=phone, grace_days=grace,
                            delete_after=row.delete_after,
                            points_ru=deletion_points(grace, phone=phone))  # fmt: skip


async def send_code(db: Db, ctx: Ctx, phone_raw: str, *, purpose: OtpPurpose,
                    user_id: int | None, device_id: int | None, ip_hash: str | None,
                    expected_hash: str | None = None) -> OtpRequestOut:  # fmt: skip
    """An SMS code for deletion (app or web). `expected_hash`: the number must be this one."""
    try:
        phone = normalize_phone(phone_raw)
    except PhoneError as exc:
        raise ApiError(422, "phone_unsupported") from exc
    phone_hash = ctx.hash(phone.e164, purpose="phone")
    if expected_hash is not None and not hmac.compare_digest(phone_hash, expected_hash):
        raise ApiError(422, "phone_mismatch")
    await svc.check_otp_limits(db, phone_hash, device_id)
    code = new_otp_code()
    challenge = OtpChallenge(phone_hash=phone_hash, purpose=purpose, code_hash="",
                             expires_at=_now() + svc.OTP_TTL, user_id=user_id,
                             device_id=device_id, ip_hash=ip_hash)  # fmt: skip
    db.add(challenge)
    await db.flush()
    challenge.code_hash = svc.otp_code_hash(ctx, challenge.public_id, code)
    await db.commit()  # never hold a transaction across the SMS gateway call
    if user_id is not None:
        try:
            await ctx.sms.send_otp(phone, code, locale="ru")
        except SmsError as exc:
            log.warning("deletion sms failed for %s: %s", phone.masked, error_text(exc))
            raise ApiError(502, "sms_failed") from exc
    dev = code if ctx.settings.api_dev_mode and isinstance(ctx.sms, FakeSmsSender) else None
    return OtpRequestOut(challenge_id=challenge.public_id, expires_at=challenge.expires_at,
                         dev_code=dev if user_id is not None else None)  # fmt: skip


@router.post("/me/deletion/otp", response_model=OtpRequestOut)
async def deletion_otp(body: DeletionOtpIn, user: AuthUser, db: Db, ctx: Ctx) -> OtpRequestOut:
    expected = await _phone_hash(db, user.id)
    if expected is None:
        raise ApiError(422, "validation_error")  # anonymous: the button, no SMS
    return await send_code(db, ctx, body.phone, purpose=OtpPurpose.DELETE_CONFIRM,
                           user_id=user.id, device_id=user.device_id, ip_hash=None,
                           expected_hash=expected)  # fmt: skip


async def confirm_code(db: Db, ctx: Ctx, challenge_id: uuid.UUID, code: str, *,
                       purpose: OtpPurpose) -> OtpChallenge:  # fmt: skip
    challenge = await db.scalar(select(OtpChallenge).where(
        OtpChallenge.public_id == challenge_id, OtpChallenge.purpose == purpose))
    if challenge is None:
        raise ApiError(400, "otp_invalid")
    return await svc.consume_otp(db, ctx, challenge_id, challenge.phone_hash, code)


async def start_deletion(db: Db, ctx: Ctx, row: User, *, via: DeletionVia,
                         phone: bool) -> DeletionOut:  # fmt: skip
    grace = ctx.settings.account_delete_grace_days
    deletion = await account.request_deletion(db, row, via=via, grace_days=grace, now=_now())
    return DeletionOut(requested_at=deletion.requested_at, delete_after=deletion.cancel_until,
                       grace_days=grace,
                       message_ru=pending_message(deletion.cancel_until, row.tz, phone=phone,
                                                  grace_days=grace))  # fmt: skip


@router.post("/me/deletion", response_model=DeletionOut, status_code=202)
async def request_deletion(body: DeletionIn, user: AuthUser, db: Db, ctx: Ctx) -> DeletionOut:
    row = await _user(db, user.id)
    phone_hash = await _phone_hash(db, user.id)
    if phone_hash is not None:
        if body.challenge_id is None or not body.code or body.confirm:
            raise ApiError(422, "validation_error")
        challenge = await confirm_code(db, ctx, body.challenge_id, body.code,
                                       purpose=OtpPurpose.DELETE_CONFIRM)  # fmt: skip
        if challenge.user_id != user.id or challenge.phone_hash != phone_hash:
            raise ApiError(400, "otp_invalid")
    elif body.confirm is not True or body.code or body.challenge_id:
        raise ApiError(422, "validation_error")
    return await start_deletion(db, ctx, row, via=DeletionVia.APP, phone=phone_hash is not None)


@router.post("/me/deletion/cancel", response_model=TokenPair)
async def cancel_deletion(body: CancelIn, db: Db, ctx: Ctx) -> TokenPair:
    """«Восстановить»: no bearer (sign-in is closed); the token came with the refused sign-in."""
    try:
        row = await account.cancel_deletion(db, ctx.hash(body.restore_token, purpose="restore"),
                                            now=_now())  # fmt: skip
    except account.RestoreInvalid as exc:
        raise ApiError(400, "restore_invalid") from exc
    except account.DeletionDone as exc:
        raise ApiError(410, "deletion_done") from exc
    return await svc.issue_session(db, ctx, row, device_id=None)


# --- export ---


class ExportIn(BaseModel):
    client_id: uuid.UUID | None = None


class ExportOut(BaseModel):
    id: uuid.UUID
    status: str
    requested_at: datetime
    ready_at: datetime | None
    expires_at: datetime | None
    bytes: int | None
    download_url: str | None
    error: str | None


def _link_token(ctx: Ctx, e: DataExport) -> str:
    assert e.expires_at is not None
    exp = int(e.expires_at.timestamp())
    return f"{exp}.{ctx.hash(f'export:{e.public_id}:{exp}', purpose='export_link')}"


def export_out(ctx: Ctx, e: DataExport, now: datetime | None = None) -> ExportOut:
    now = now or _now()
    status = e.status
    if status == ExportStatus.READY and e.expires_at is not None and e.expires_at <= now:
        status = ExportStatus.EXPIRED  # the sweep runs hourly; the link is over already
    url = None
    if status == ExportStatus.READY:
        base = ctx.settings.api_public_base_url.rstrip("/")
        url = f"{base}/v1/export/{e.public_id}/file?token={_link_token(ctx, e)}"
    error = "Не получилось собрать архив. Попробуйте ещё раз." \
        if status == ExportStatus.FAILED else None  # fmt: skip
    return ExportOut(id=e.public_id, status=status, requested_at=e.requested_at,
                     ready_at=e.ready_at, expires_at=e.expires_at, bytes=e.bytes,
                     download_url=url, error=error)  # fmt: skip


@router.post("/export", status_code=202)
async def start_export(user: AuthUser, db: Db, ctx: Ctx, response: Response,
                       body: ExportIn | None = None) -> dict[str, Any]:  # fmt: skip
    from assistant.pages import lock_user

    body = body or ExportIn()
    await lock_user(db, user.id)
    if body.client_id is not None:
        same = await db.scalar(select(DataExport).where(DataExport.user_id == user.id,
                                                        DataExport.client_id == body.client_id))
        if same is not None:
            response.status_code = 200
            return {"export": export_out(ctx, same)}
    running = await db.scalar(select(DataExport).where(
        DataExport.user_id == user.id,
        DataExport.status.in_([ExportStatus.QUEUED, ExportStatus.RUNNING]))
        .order_by(DataExport.id.desc()).limit(1))  # fmt: skip
    if running is not None:
        response.status_code = 200
        return {"export": export_out(ctx, running)}
    e = DataExport(user_id=user.id, client_id=body.client_id, status=ExportStatus.QUEUED,
                   requested_at=_now(), counts={})  # fmt: skip
    db.add(e)
    await db.flush()
    await queue.enqueue(db, account.JOB_EXPORT, {"export_id": e.id, "user_id": user.id},
                        idempotency_key=f"account:export:{e.id}")  # fmt: skip
    return {"export": export_out(ctx, e)}


@router.get("/export")
async def list_exports(user: AuthUser, db: Db, ctx: Ctx) -> dict[str, Any]:
    rows = await db.scalars(select(DataExport).where(DataExport.user_id == user.id)
                            .order_by(DataExport.id.desc()).limit(EXPORTS_LISTED))
    return {"exports": [export_out(ctx, e) for e in rows]}


@router.get("/export/{export_id}")
async def get_export(export_id: uuid.UUID, user: AuthUser, db: Db, ctx: Ctx) -> dict[str, Any]:
    e = await db.scalar(select(DataExport).where(DataExport.user_id == user.id,
                                                 DataExport.public_id == export_id))
    if e is None:
        raise ApiError(404, "not_found")
    return {"export": export_out(ctx, e)}


@router.get("/export/{export_id}/file", response_model=None)
async def download_export(
    export_id: uuid.UUID, db: Db, ctx: Ctx, token: Annotated[str, Query(max_length=200)] = ""
) -> Response:
    """The link itself is the permission (24 h): it opens in a browser or the share sheet."""
    e = await db.scalar(select(DataExport).where(DataExport.public_id == export_id))
    if e is None or e.expires_at is None or not hmac.compare_digest(token, _link_token(ctx, e)):
        raise ApiError(404, "not_found")
    owner = await db.get(User, e.user_id)
    if owner is None or owner.status != UserStatus.ACTIVE:
        raise ApiError(404, "not_found")
    if e.status != ExportStatus.READY or e.expires_at <= _now() or not e.storage_key:
        raise ApiError(410, "export_expired")
    key, day = e.storage_key, (e.ready_at or e.requested_at).date().isoformat()
    await db.commit()  # no transaction open across the storage read
    data = await ctx.storage.get(key)
    if data is None:
        raise ApiError(410, "export_expired")
    return Response(content=data, media_type="application/zip", headers={
        "Content-Disposition": f'attachment; filename="moi-dannye-{day}.zip"',
        "Cache-Control": "private, no-store"})  # fmt: skip


__all__ = ["client_ip_hash", "confirm_code", "deletion_points", "pending_message", "router",
           "send_code", "start_deletion"]
