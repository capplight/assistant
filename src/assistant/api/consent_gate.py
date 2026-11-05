"""Consent gate (spec 7.5): the single place that decides whether a request may proceed.

- Without active pd_processing + terms the API serves only auth and consent endpoints.
- Anything that calls AI or STT additionally needs active ai_cross_border.
Endpoints declare it with `Depends(require_consents(...))` or `Depends(require_ai_consent)`;
the failure is 403 {code: "consent_required", details: {missing: [...]}}.
"""

from collections.abc import Awaitable, Callable, Iterable
from typing import Annotated

from fastapi import Depends

from assistant.api.deps import CurrentUser, get_active_consent_kinds, get_current_user
from assistant.api.errors import ApiError
from assistant.db.models_v2 import ConsentKind

BASE_CONSENTS: tuple[ConsentKind, ...] = (ConsentKind.PD_PROCESSING, ConsentKind.TERMS)
AI_CONSENTS: tuple[ConsentKind, ...] = (*BASE_CONSENTS, ConsentKind.AI_CROSS_BORDER)


class ConsentRequired(ApiError):
    def __init__(self, missing: list[str]) -> None:
        super().__init__(403, "consent_required", details={"missing": missing})
        self.missing = missing


def missing_consents(active: Iterable[str], required: Iterable[ConsentKind]) -> list[str]:
    have = set(active)
    return [str(kind) for kind in required if kind not in have]


def check_consents(active: Iterable[str], required: Iterable[ConsentKind]) -> None:
    missing = missing_consents(active, required)
    if missing:
        raise ConsentRequired(missing)


def require_consents(*required: ConsentKind) -> Callable[..., Awaitable[CurrentUser]]:
    async def dependency(
        user: Annotated[CurrentUser, Depends(get_current_user)],
        active: Annotated[frozenset[str], Depends(get_active_consent_kinds)],
    ) -> CurrentUser:
        check_consents(active, required)
        return user

    return dependency


require_base_consent = require_consents(*BASE_CONSENTS)
require_ai_consent = require_consents(*AI_CONSENTS)
