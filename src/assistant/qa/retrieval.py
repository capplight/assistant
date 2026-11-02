"""Search over the user's own items: SQL filters + full-text + vector + nearby, fused by RRF.

Statement builders return SQLAlchemy selects and do no I/O, so tests compile them to SQL.
"""

from collections.abc import Sequence
from datetime import UTC, date, datetime, time, timedelta

from geoalchemy2 import Geography
from sqlalchemy import ColumnElement, Select, cast, func, literal, or_, select
from sqlalchemy.dialects.postgresql import REGCONFIG

from assistant.db.models import (
    Booking,
    Category,
    Item,
    ItemPlace,
    ItemStatus,
    Place,
    Trip,
)
from assistant.qa.filters import QueryFilters

SEARCHABLE_STATUSES = (ItemStatus.DONE, ItemStatus.NEEDS_INPUT)
ARM_LIMIT = 30
TOP_K = 15
RRF_K = 60
ANSWER_NEAR_RADIUS_M = 5000
BOOKINGS_LIMIT = 10


def rrf(rankings: Sequence[Sequence[int]], *, k: int = RRF_K, limit: int = TOP_K) -> list[int]:
    """Reciprocal rank fusion: score(id) = sum over rankings of 1 / (k + rank), rank from 1.

    Duplicates inside one ranking count once (first position). Ties keep first-seen order.
    """
    scores: dict[int, float] = {}
    for ranking in rankings:
        seen: set[int] = set()
        for rank, item_id in enumerate(ranking, 1):
            if item_id in seen:
                continue
            seen.add(item_id)
            scores[item_id] = scores.get(item_id, 0.0) + 1.0 / (k + rank)
    order = {item_id: n for n, item_id in enumerate(scores)}
    return sorted(scores, key=lambda i: (-scores[i], order[i]))[:limit]


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _day_start_utc(d: date) -> datetime:
    # Day bounds in UTC are close enough for "what did I save last week".
    return datetime.combine(d, time(0, 0), tzinfo=UTC)


def trip_ids_subquery(user_id: int, hint: str) -> Select[tuple[int]]:
    pattern = f"%{_escape_like(hint.strip())}%"
    return select(Trip.id).where(
        Trip.user_id == user_id,
        or_(Trip.title.ilike(pattern, escape="\\"), Trip.destination.ilike(pattern, escape="\\")),
    )


def item_conditions(user_id: int, f: QueryFilters) -> list[ColumnElement[bool]]:
    """WHERE clauses shared by every arm. Always scoped to the user's own searchable items."""
    conds: list[ColumnElement[bool]] = [
        Item.user_id == user_id,
        Item.status.in_(SEARCHABLE_STATUSES),
    ]
    cities = [c.strip() for c in f.city_variants if c and c.strip()]
    if cities:
        conds.append(or_(*[Item.city.ilike(_escape_like(c), escape="\\") for c in cities]))
    elif f.country:
        conds.append(Item.country == f.country.strip().upper()[:2])
    categories = [Category(c) for c in f.categories]
    if categories:
        conds.append(Item.category.in_(categories))
    if f.trip_hint and f.trip_hint.strip():
        conds.append(Item.trip_id.in_(trip_ids_subquery(user_id, f.trip_hint)))
    d_from, d_to = f.parsed_dates()
    if d_from:
        conds.append(Item.created_at >= _day_start_utc(d_from))
    if d_to:
        conds.append(Item.created_at < _day_start_utc(d_to + timedelta(days=1)))
    return conds


def websearch_text(keywords: Sequence[str]) -> str:
    """Keywords -> websearch_to_tsquery input: any keyword matches; phrases stay quoted."""
    parts = []
    for kw in keywords:
        kw = kw.replace('"', " ").replace("-", " ").strip()
        if not kw:
            continue
        parts.append(f'"{kw}"' if " " in kw else kw)
    return " or ".join(dict.fromkeys(parts))


def fts_stmt(conds: Sequence[ColumnElement[bool]], keywords: Sequence[str]) -> Select | None:
    text = websearch_text(keywords)
    if not text:
        return None
    query = func.websearch_to_tsquery(cast(literal("simple"), REGCONFIG), text)
    return (
        select(Item.id)
        .where(*conds, Item.tsv.op("@@")(query))
        .order_by(func.ts_rank_cd(Item.tsv, query).desc(), Item.id.desc())
        .limit(ARM_LIMIT)
    )


def vector_stmt(conds: Sequence[ColumnElement[bool]], embedding: Sequence[float]) -> Select:
    return (
        select(Item.id)
        .where(*conds, Item.embedding.is_not(None))
        .order_by(Item.embedding.cosine_distance(list(embedding)))
        .limit(ARM_LIMIT)
    )


def recent_stmt(conds: Sequence[ColumnElement[bool]]) -> Select:
    """Newest items matching the SQL filters alone ("еда в Фукуоке" with no keyword hits)."""
    return select(Item.id).where(*conds).order_by(Item.created_at.desc()).limit(ARM_LIMIT)


def geo_point(lat: float, lon: float) -> ColumnElement:
    return cast(func.ST_MakePoint(lon, lat), Geography(geometry_type="POINT", srid=4326))


def near_stmt(
    conds: Sequence[ColumnElement[bool]], lat: float, lon: float, radius_m: int
) -> Select:
    point = geo_point(lat, lon)
    return (
        select(Item.id)
        .join(ItemPlace, ItemPlace.item_id == Item.id)
        .join(Place, Place.id == ItemPlace.place_id)
        .where(*conds, func.ST_DWithin(Place.geom, point, radius_m))
        .group_by(Item.id)
        .order_by(func.min(func.ST_Distance(Place.geom, point)))
        .limit(ARM_LIMIT)
    )


def items_by_ids_stmt(user_id: int, ids: Sequence[int]) -> Select[tuple[Item]]:
    return select(Item).where(Item.user_id == user_id, Item.id.in_(list(ids)))


def bookings_stmt(user_id: int, f: QueryFilters, now: datetime) -> Select[tuple[Booking]]:
    """Confirmed bookings; without a period, upcoming ones (and those started in the last day)."""
    stmt = select(Booking).where(Booking.user_id == user_id, Booking.confirmed_at.is_not(None))
    d_from, d_to = f.parsed_dates()
    if d_from or d_to:
        if d_from:
            stmt = stmt.where(Booking.starts_at >= _day_start_utc(d_from))
        if d_to:
            stmt = stmt.where(Booking.starts_at < _day_start_utc(d_to + timedelta(days=1)))
    else:
        stmt = stmt.where(
            or_(Booking.starts_at.is_(None), Booking.starts_at >= now - timedelta(days=1))
        )
    if f.trip_hint and f.trip_hint.strip():
        stmt = stmt.where(Booking.trip_id.in_(trip_ids_subquery(user_id, f.trip_hint)))
    return stmt.order_by(Booking.starts_at.asc().nulls_last()).limit(BOOKINGS_LIMIT)


def nearby_stmt(user_id: int, lat: float, lon: float, radius_m: int, limit: int) -> Select:
    """(Item, place name, distance in metres) rows, closest first. One item may repeat."""
    point = geo_point(lat, lon)
    distance = func.ST_Distance(Place.geom, point).label("distance_m")
    return (
        select(Item, Place.name, distance)
        .join(ItemPlace, ItemPlace.item_id == Item.id)
        .join(Place, Place.id == ItemPlace.place_id)
        .where(
            Item.user_id == user_id,
            Item.status.in_(SEARCHABLE_STATUSES),
            Place.geom.is_not(None),
            func.ST_DWithin(Place.geom, point, radius_m),
        )
        .order_by(distance)
        .limit(limit * 3)
    )
