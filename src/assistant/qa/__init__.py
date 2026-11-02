"""Answering the user's questions over their saved items ("что я сохранял про еду в Фукуоке?")."""

from sqlalchemy.ext.asyncio import AsyncSession

from assistant.qa.types import Answer, Location


async def answer(
    session: AsyncSession, user_id: int, question: str, *, location: Location | None = None
) -> Answer:
    """Answer from the user's own items only. Never invent places that are not in their items.

    Without User.consent_at nothing goes to foreign APIs: plain full-text search and a list.
    """
    from assistant.qa import service

    return await service.answer(session, user_id, question, location=location)


async def nearby(
    session: AsyncSession, user_id: int, location: Location, *, radius_m: int = 1500
) -> Answer:
    """Saved places near the user's shared location, closest first."""
    from assistant.qa import service

    return await service.nearby(session, user_id, location, radius_m=radius_m)


__all__ = ["Answer", "Location", "answer", "nearby"]
