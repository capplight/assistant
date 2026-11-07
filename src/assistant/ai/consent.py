"""Shared consent check for anything that sends data abroad to an AI provider (spec 5.1, 7.5).

The API consent gate (`api/consent_gate.py`) stops requests early; this is the last check right
before a provider call, used by workers too. It reads the same `consents` table: the active
ai_cross_border grant (latest, not revoked) and its provider list.
"""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.db.models_v2 import Consent, ConsentKind

LEGACY_BOT_VERSION = "legacy-bot"


def normalize_providers(names: list[str] | tuple[str, ...]) -> frozenset[str]:
    return frozenset(n.strip().lower() for n in names if n and n.strip())


async def ai_consent_providers(
    session: AsyncSession, user_id: int, *, legacy_providers: tuple[str, ...] = ("anthropic",)
) -> frozenset[str] | None:
    """Providers the user agreed to send data to; None = no active ai_cross_border consent.

    Legacy bot grants (backfilled in 0003) carry no list: the bot only used Anthropic.
    """
    row = (
        await session.execute(
            select(Consent.version, Consent.providers)
            .where(
                Consent.user_id == user_id,
                Consent.kind == ConsentKind.AI_CROSS_BORDER,
                Consent.revoked_at.is_(None),
            )
            .order_by(Consent.granted_at.desc(), Consent.id.desc())
            .limit(1)
        )
    ).first()
    if row is None:
        return None
    version, providers = row
    allowed = normalize_providers(list(providers or []))
    if not allowed and version == LEGACY_BOT_VERSION:
        return normalize_providers(list(legacy_providers))
    return allowed
