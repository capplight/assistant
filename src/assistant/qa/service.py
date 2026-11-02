"""Q&A orchestration: filters -> retrieval -> grounded answer."""

import logging
from collections.abc import Sequence
from datetime import UTC, date, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.db.models import Trip, User
from assistant.embeddings import Embedder, NullEmbedder, get_embedder
from assistant.qa.compose import (
    NOTHING_FOUND,
    Entry,
    build_data_block,
    entry_from_booking,
    entry_from_item,
    render_answer,
    render_nearby,
    render_plain,
)
from assistant.qa.filters import QueryFilters, heuristic_filters
from assistant.qa.llm import QALLM, AnthropicQALLM
from assistant.qa.retrieval import (
    ANSWER_NEAR_RADIUS_M,
    bookings_stmt,
    fts_stmt,
    item_conditions,
    items_by_ids_stmt,
    near_stmt,
    nearby_stmt,
    recent_stmt,
    rrf,
    vector_stmt,
)
from assistant.qa.types import Answer, Location

log = logging.getLogger(__name__)

NEARBY_LIMIT = 10


def trips_context(trips: Sequence[Trip], today: date) -> str:
    lines = [f"Today: {today.isoformat()}", "<user_trips>"]
    for t in trips:
        dates = f"{t.starts_on or '?'}..{t.ends_on or '?'}"
        lines.append(f"- {t.title} | {t.destination or ''} | {dates}".replace("<", "‹"))
    lines.append("</user_trips>")
    return "\n".join(lines)


async def _extract_filters(
    session: AsyncSession, llm: QALLM | None, user_id: int, question: str, today: date
) -> QueryFilters:
    if llm is None:
        return heuristic_filters(question)
    trips = (
        await session.scalars(
            select(Trip).where(Trip.user_id == user_id).order_by(Trip.created_at.desc()).limit(20)
        )
    ).all()
    try:
        return await llm.extract_filters(question, trips_context(trips, today))
    except Exception as exc:
        log.warning("filter extraction failed, using fallback: %r", exc)
        return heuristic_filters(question)


async def _ids(session: AsyncSession, stmt) -> list[int]:
    if stmt is None:
        return []
    return list((await session.scalars(stmt)).all())


async def retrieve_item_ids(
    session: AsyncSession,
    user_id: int,
    f: QueryFilters,
    query_vec: Sequence[float] | None,
    location: Location | None,
) -> list[int]:
    async def run(filters: QueryFilters) -> list[int]:
        conds = item_conditions(user_id, filters)
        rankings = [await _ids(session, fts_stmt(conds, filters.keywords))]
        if query_vec:
            rankings.append(await _ids(session, vector_stmt(conds, query_vec)))
        if filters.has_structured():
            rankings.append(await _ids(session, recent_stmt(conds)))
        if location is not None:
            rankings.append(
                await _ids(
                    session, near_stmt(conds, location.lat, location.lon, ANSWER_NEAR_RADIUS_M)
                )
            )
        return rrf(rankings)

    ids = await run(f)
    if not ids and f.has_structured():
        # Filters too strict (city spelled differently in the item?): search by words only.
        ids = await run(QueryFilters(keywords=[*f.keywords, *f.city_variants]))
    return ids


async def compose_answer(
    llm: QALLM | None, question: str, entries: list[Entry], today: date
) -> Answer:
    if not entries:
        return Answer(NOTHING_FOUND, [])
    if llm is not None:
        try:
            draft = await llm.compose(question, build_data_block(entries, today))
            text, ids = render_answer(draft, entries)
            return Answer(text, ids)
        except Exception as exc:
            log.warning("answer composition failed, plain list instead: %r", exc)
    text, ids = render_plain(entries)
    return Answer(text, ids)


async def answer(
    session: AsyncSession,
    user_id: int,
    question: str,
    *,
    location: Location | None = None,
    llm: QALLM | None = None,
    embedder: Embedder | None = None,
) -> Answer:
    now = datetime.now(UTC)
    user = await session.get(User, user_id)
    if user is None:
        return Answer(NOTHING_FOUND, [])
    # Nothing leaves for a foreign API before consent: no model, no embedding of the question.
    consent = user.consent_at is not None
    if consent and llm is None:
        llm = AnthropicQALLM()
    if not consent:
        llm = None

    filters = await _extract_filters(session, llm, user_id, question, now.date())

    query_vec: list[float] | None = None
    if consent:
        embedder = embedder or get_embedder()
        if not isinstance(embedder, NullEmbedder):
            try:
                vecs = await embedder.embed([question], "query")
                query_vec = vecs[0] if vecs else None
            except Exception as exc:
                log.warning("query embedding failed: %r", exc)

    ids = await retrieve_item_ids(session, user_id, filters, query_vec, location)
    by_id = {i.id: i for i in (await session.scalars(items_by_ids_stmt(user_id, ids))).all()}
    entries = [entry_from_item(by_id[i]) for i in ids if i in by_id]
    if filters.wants_bookings:
        bookings = (await session.scalars(bookings_stmt(user_id, filters, now))).all()
        entries += [entry_from_booking(b, user.tz) for b in bookings]
    return await compose_answer(llm, question, entries, now.date())


async def nearby(
    session: AsyncSession, user_id: int, location: Location, *, radius_m: int = 1500
) -> Answer:
    stmt = nearby_stmt(user_id, location.lat, location.lon, radius_m, NEARBY_LIMIT)
    rows = []
    seen: set[int] = set()
    for item, place_name, dist in (await session.execute(stmt)).all():
        if item.id in seen:
            continue
        seen.add(item.id)
        rows.append((item, place_name, float(dist)))
        if len(rows) >= NEARBY_LIMIT:
            break
    text, ids = render_nearby(rows, radius_m)
    return Answer(text, ids)
