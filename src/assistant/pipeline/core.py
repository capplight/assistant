"""Item orchestration without the DB: inputs -> extraction (with escalation) -> decision.

The DB layer (service.py) loads plain data, calls run_pipeline(), then applies the Outcome.
"""

import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import datetime

from assistant.db.models import ItemStatus
from assistant.pipeline.errors import NeedsInputError
from assistant.pipeline.geo import load_zone
from assistant.pipeline.inputs import Gatherer, ItemData, TripContext
from assistant.pipeline.llm import Extractor
from assistant.pipeline.logic import (
    BookingDraft,
    Decision,
    TripInfo,
    ZoneLoader,
    choose_trip,
    decide,
    needs_escalation,
    place_options,
    validate_booking,
)
from assistant.pipeline.places import ResolvedPlace
from assistant.pipeline.schema import Extraction

log = logging.getLogger(__name__)

ResolvePlace = Callable[[str, str | None], Awaitable[ResolvedPlace | None]]


@dataclass
class PipelineContext:
    item: ItemData
    user_tz: str | None
    trips: list[TripInfo]
    existing_trip_id: int | None
    now: datetime


@dataclass
class Outcome:
    status: ItemStatus
    decision: Decision | None = None
    extraction: Extraction | None = None
    escalated: bool = False
    trip: TripInfo | None = None
    place: ResolvedPlace | None = None
    booking: BookingDraft | None = None
    options: list[str] = field(default_factory=list)  # NEEDS_INPUT place choices
    user_text: str | None = None  # NEEDS_INPUT without options: what to ask
    error: str | None = None


async def extract_with_escalation(
    extractor: Extractor, inputs, threshold: float
) -> tuple[Extraction, bool]:
    ex = await extractor.extract(inputs, strong=False)
    if needs_escalation(ex, threshold):
        log.info("escalating (kind=%s conf=%.2f)", ex.kind, ex.confidence)
        return await extractor.extract(inputs, strong=True), True
    return ex, False


async def run_pipeline(
    ctx: PipelineContext,
    *,
    gatherer: Gatherer,
    extractor: Extractor,
    resolve_place: ResolvePlace,
    threshold: float,
    zone_loader: ZoneLoader = load_zone,
) -> Outcome:
    trip_ctx = [
        TripContext(t.title, t.destination, t.starts_on, t.ends_on) for t in ctx.trips
    ]
    try:
        inputs = await gatherer.gather(ctx.item, today=ctx.now.date(), trips=trip_ctx)
    except NeedsInputError as e:
        return Outcome(status=ItemStatus.NEEDS_INPUT, user_text=e.user_text, error=str(e))

    ex, escalated = await extract_with_escalation(extractor, inputs, threshold)
    decision = decide(ex, threshold)
    out = Outcome(status=ItemStatus.DONE, decision=decision, extraction=ex, escalated=escalated)

    if decision == "ask":
        out.status = ItemStatus.NEEDS_INPUT
        out.options = place_options(ex)
    elif decision == "resolve" and ex.place_query:
        out.place = await resolve_place(ex.place_query, ex.country)
    elif decision == "booking":
        assert ex.booking is not None
        ex.category = "booking"
        if ex.place_query and ex.booking.type in ("hotel", "tour"):
            out.place = await resolve_place(ex.place_query, ex.country)

    city = (out.place.city if out.place else None) or ex.city
    country = (out.place.country if out.place else None) or ex.country
    out.trip = choose_trip(ctx.trips, ctx.existing_trip_id, city, country)

    if decision == "booking" and ex.booking is not None:
        out.booking = validate_booking(
            ex.booking,
            now=ctx.now,
            place_tz=out.place.tz if out.place else None,
            trip=out.trip,
            user_tz=ctx.user_tz,
            loader=zone_loader,
        )
    return out
