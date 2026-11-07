"""/v1/me: the account's own settings. Today only the name (S04b «Как к вам обращаться?», R-37)."""

from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.api import auth_service as svc
from assistant.api.consent_gate import require_base_consent
from assistant.api.deps import CurrentUser, Db
from assistant.api.errors import ApiError
from assistant.api.schemas import MePatchIn, UserOut
from assistant.db.models import User
from assistant.records import normalize_text

router = APIRouter(prefix="/me", tags=["me"])
GatedUser = Annotated[CurrentUser, Depends(require_base_consent)]


async def _row(db: AsyncSession, user: CurrentUser) -> User:
    row = await db.get(User, user.id)
    if row is None:
        raise ApiError(401, "unauthorized")
    return row


@router.get("", response_model=UserOut)
async def get_me(user: GatedUser, db: Db) -> UserOut:
    return await svc.user_out(db, await _row(db, user))


@router.patch("", response_model=UserOut)
async def patch_me(body: MePatchIn, user: GatedUser, db: Db) -> UserOut:
    """A field left out stays as it is. A null or blank name clears it: «Добрый день» again."""
    row = await _row(db, user)
    if "display_name" in body.model_fields_set:
        name = " ".join(normalize_text(body.display_name or "").split())
        row.display_name = name or None
    return await svc.user_out(db, row)
