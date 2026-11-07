"""/v1/consents: texts with version + hash, batch grant (S05), history, revocation.

Auth required, but not gated: without consents these are the only endpoints that work.
"""

from datetime import UTC, datetime

from fastapi import APIRouter, Request
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.api import consent_texts
from assistant.api.consent_gate import AI_CONSENTS, BASE_CONSENTS, missing_consents
from assistant.api.deps import AuthUser, Ctx, Db, client_ip_hash
from assistant.api.errors import ApiError
from assistant.api.schemas import ConsentOut, ConsentsIn, ConsentsOut, ConsentTextOut, LocaleStr
from assistant.db.models import User
from assistant.db.models_v2 import Consent, ConsentKind
from assistant.records import requeue_needs_consent

router = APIRouter(prefix="/consents", tags=["consents"])


def _out(c: Consent) -> ConsentOut:
    return ConsentOut(id=c.public_id, kind=c.kind, version=c.version, providers=list(c.providers),
                      text_hash=c.text_hash, locale=c.locale, screen=c.screen,
                      granted_at=c.granted_at, revoked_at=c.revoked_at)  # fmt: skip


async def _state(db: AsyncSession, user_id: int) -> ConsentsOut:
    rows = list(
        await db.scalars(
            select(Consent)
            .where(Consent.user_id == user_id)
            .order_by(Consent.granted_at.desc(), Consent.id.desc())
        )
    )
    active: dict[str, Consent] = {}
    for c in rows:
        if c.revoked_at is None and c.kind not in active:
            active[c.kind] = c
    kinds = set(active)
    return ConsentsOut(active=[_out(c) for c in active.values()], history=[_out(c) for c in rows],
                       ai_enabled=not missing_consents(kinds, AI_CONSENTS),
                       app_enabled=not missing_consents(kinds, BASE_CONSENTS))  # fmt: skip


@router.get("/text", response_model=ConsentTextOut)
async def get_text(kind: ConsentKind, locale: LocaleStr = "ru") -> ConsentTextOut:
    text = consent_texts.current(kind, locale)
    if text is None:
        raise ApiError(404, "not_found")
    return ConsentTextOut(kind=text.kind, version=text.version, locale=text.locale, text=text.text,
                          text_hash=text.text_hash, providers=list(text.providers))  # fmt: skip


@router.get("", response_model=ConsentsOut)
async def list_consents(user: AuthUser, db: Db) -> ConsentsOut:
    return await _state(db, user.id)


@router.post("", response_model=ConsentsOut)
async def grant(
    body: ConsentsIn, request: Request, user: AuthUser, ctx: Ctx, db: Db
) -> ConsentsOut:
    """Record what the person accepted. Each item must match a known text by version + hash.

    Re-sending an already active version is a no-op (idempotent retries from the outbox).
    """
    known = []
    for item in body.consents:
        text = consent_texts.find(item.kind, item.version, item.locale)
        if text is None or text.text_hash != item.text_hash:
            raise ApiError(409, "consent_unknown_version", details={"kind": str(item.kind)})
        known.append(text)
    if any(t.kind == ConsentKind.TERMS for t in known) and not body.age_confirmed_18:
        raise ApiError(422, "age_confirmation_required")

    now = datetime.now(UTC)
    ip_hash = client_ip_hash(request, ctx)
    ai_granted = False
    for text in known:
        exists = await db.scalar(
            select(Consent.id).where(Consent.user_id == user.id, Consent.kind == text.kind,
                                     Consent.version == text.version,
                                     Consent.revoked_at.is_(None))
        )  # fmt: skip
        if exists is not None:
            continue
        db.add(Consent(user_id=user.id, kind=text.kind, version=text.version,
                       providers=list(text.providers), text_hash=text.text_hash,
                       locale=text.locale, granted_at=now, device_id=user.device_id,
                       ip_hash=ip_hash, screen=body.screen))  # fmt: skip
        ai_granted = ai_granted or text.kind == ConsentKind.AI_CROSS_BORDER
        if text.kind == ConsentKind.TERMS:
            row = await db.get(User, user.id)
            if row is not None and row.age_confirmed_at is None:
                row.age_confirmed_at = now
    await db.flush()
    if ai_granted:  # voice saved in "Без ИИ" mode: "разберу после разрешения"
        await requeue_needs_consent(db, user.id, grant_marker=now.strftime("%Y%m%dT%H%M%S%f"))
    return await _state(db, user.id)


@router.delete("/{kind}", response_model=ConsentsOut)
async def revoke(kind: ConsentKind, user: AuthUser, db: Db) -> ConsentsOut:
    """Revocation: the feature switches off, data stays (deletion is a separate flow)."""
    await db.execute(
        update(Consent)
        .where(Consent.user_id == user.id, Consent.kind == kind, Consent.revoked_at.is_(None))
        .values(revoked_at=datetime.now(UTC))
    )
    return await _state(db, user.id)
