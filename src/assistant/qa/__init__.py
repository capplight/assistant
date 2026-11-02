"""Answering the user's questions over their saved items ("что я сохранял про еду в Фукуоке?")."""

from dataclasses import dataclass, field

from sqlalchemy.ext.asyncio import AsyncSession


@dataclass
class Location:
    lat: float
    lon: float


@dataclass
class Answer:
    text: str
    item_ids: list[int] = field(default_factory=list)  # items the answer is based on


async def answer(
    session: AsyncSession, user_id: int, question: str, *, location: Location | None = None
) -> Answer:
    """Answer from the user's own items only. Never invent places that are not in their items."""
    raise NotImplementedError


async def nearby(
    session: AsyncSession, user_id: int, location: Location, *, radius_m: int = 1500
) -> Answer:
    """Saved places near the user's shared location, closest first."""
    raise NotImplementedError
