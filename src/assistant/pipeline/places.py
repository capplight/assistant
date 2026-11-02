"""Place resolution through Google Places API (New) Text Search, cached in the DB.

Coordinates come only from the provider, never from the model.
"""

import hashlib
import logging
import re
from dataclasses import dataclass
from typing import Protocol

import httpx
from geoalchemy2.elements import WKTElement
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.db.models import ItemPlace, Place, PlaceQuery
from assistant.pipeline.geo import normalize_country, tz_for_country

log = logging.getLogger(__name__)

FIELD_MASK = ",".join(
    f"places.{f}" for f in ("id", "displayName", "formattedAddress", "location",
                            "addressComponents")
)  # fmt: skip


@dataclass
class PlaceHit:
    provider: str
    provider_place_id: str
    name: str
    address: str | None
    lat: float
    lon: float
    city: str | None
    country: str | None
    raw: dict


@dataclass
class ResolvedPlace:
    place_id: int
    name: str
    city: str | None
    country: str | None
    tz: str | None


class PlacesClient(Protocol):
    provider: str

    async def search(self, query: str) -> list[PlaceHit]: ...


def parse_search_response(data: dict, provider: str = "google") -> list[PlaceHit]:
    hits: list[PlaceHit] = []
    for p in data.get("places") or []:
        loc = p.get("location") or {}
        if not p.get("id") or "latitude" not in loc or "longitude" not in loc:
            continue
        city = country = None
        fallback_city = None
        for comp in p.get("addressComponents") or []:
            types = comp.get("types") or []
            if "country" in types:
                country = normalize_country(comp.get("shortText"))
            elif "locality" in types:
                city = comp.get("longText")
            elif "administrative_area_level_1" in types and fallback_city is None:
                fallback_city = comp.get("longText")
        hits.append(
            PlaceHit(
                provider=provider,
                provider_place_id=p["id"],
                name=(p.get("displayName") or {}).get("text") or p["id"],
                address=p.get("formattedAddress"),
                lat=float(loc["latitude"]),
                lon=float(loc["longitude"]),
                city=city or fallback_city,
                country=country,
                raw=p,
            )
        )
    return hits


class GooglePlacesClient:
    provider = "google"
    URL = "https://places.googleapis.com/v1/places:searchText"

    def __init__(
        self, api_key: str, client: httpx.AsyncClient | None = None, language: str = "ru"
    ) -> None:
        self._key, self._language = api_key, language
        self._client = client or httpx.AsyncClient(timeout=15)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def search(self, query: str) -> list[PlaceHit]:
        """Raises on 429/5xx/network (retry); other errors -> [] (logged)."""
        resp = await self._client.post(
            self.URL,
            headers={"X-Goog-Api-Key": self._key, "X-Goog-FieldMask": FIELD_MASK},
            json={"textQuery": query, "languageCode": self._language},
        )
        if resp.status_code == 429 or resp.status_code >= 500:
            resp.raise_for_status()
        if resp.status_code != 200:
            log.warning("places search HTTP %s: %s", resp.status_code, resp.text[:300])
            return []
        return parse_search_response(resp.json(), self.provider)


def normalize_query(query: str) -> str:
    return re.sub(r"\s+", " ", query).strip().casefold()


def query_hash(query: str) -> str:
    return hashlib.sha256(normalize_query(query).encode()).hexdigest()


def pick_hit(hits: list[PlaceHit], country: str | None) -> PlaceHit | None:
    """First hit, but never one in a different country than the item says."""
    for hit in hits:
        if country is None or hit.country is None or hit.country == country:
            return hit
    return None


def point_wkt(lon: float, lat: float) -> WKTElement:
    return WKTElement(f"POINT({lon} {lat})", srid=4326)


class PlaceResolver:
    """DB-backed resolution: PlaceQuery cache -> provider -> Place upsert."""

    def __init__(self, client: PlacesClient | None) -> None:
        self._client = client

    @property
    def enabled(self) -> bool:
        return self._client is not None

    async def resolve(
        self, session: AsyncSession, query: str, country: str | None = None
    ) -> ResolvedPlace | None:
        if self._client is None or not query.strip():
            return None
        qh = query_hash(query)
        cached = await session.get(PlaceQuery, qh)
        if cached is not None:
            if cached.place_id is None:
                return None
            place = await session.get(Place, cached.place_id)
            return _resolved(place) if place else None

        hit = pick_hit(await self._client.search(query), country)
        place_id = await self._upsert(session, hit) if hit else None
        await session.execute(
            insert(PlaceQuery)
            .values(query_hash=qh, query=normalize_query(query), place_id=place_id)
            .on_conflict_do_nothing(index_elements=[PlaceQuery.query_hash])
        )
        if place_id is None:
            return None
        place = await session.get(Place, place_id)
        return _resolved(place) if place else None

    async def _upsert(self, session: AsyncSession, hit: PlaceHit) -> int:
        values = {
            "provider": hit.provider,
            "provider_place_id": hit.provider_place_id,
            "name": hit.name[:500],
            "address": hit.address,
            "city": hit.city,
            "country": hit.country,
            "tz": tz_for_country(hit.country),
            "geom": point_wkt(hit.lon, hit.lat),
            "raw": hit.raw,
        }
        stmt = insert(Place).values(**values)
        stmt = stmt.on_conflict_do_update(
            constraint="uq_places_provider",
            set_={k: stmt.excluded[k] for k in ("name", "address", "city", "country", "geom",
                                                 "raw")},
        ).returning(Place.id)
        return (await session.execute(stmt)).scalar_one()


async def link_item_place(session: AsyncSession, item_id: int, place_id: int) -> None:
    await session.execute(
        insert(ItemPlace).values(item_id=item_id, place_id=place_id).on_conflict_do_nothing()
    )


def _resolved(place: Place) -> ResolvedPlace:
    return ResolvedPlace(
        place_id=place.id,
        name=place.name,
        city=place.city,
        country=place.country,
        tz=place.tz or tz_for_country(place.country),
    )
