"""Structured output schema of the extraction call (also stored in Item.extracted)."""

from typing import Literal

from pydantic import BaseModel, Field

ExtractionKind = Literal["place", "booking", "tip", "note"]
CategoryValue = Literal[
    "food", "beach", "sight", "stay", "transport", "booking", "tip", "shopping", "other"
]
BookingTypeValue = Literal["flight", "hotel", "transfer", "tour", "other"]


class BookingExtract(BaseModel):
    type: BookingTypeValue
    title: str = Field(description="Short title, e.g. 'Рейс Алматы — Фукуок' or the hotel name")
    confirmation_code: str | None = Field(
        description="Booking reference / PNR exactly as printed, or null"
    )
    start_local: str | None = Field(
        description="Local wall-clock start 'YYYY-MM-DDTHH:MM' (flight: departure time at the "
        "departure airport; hotel: check-in). Null if not visible."
    )
    end_local: str | None = Field(
        description="Local wall-clock end 'YYYY-MM-DDTHH:MM' (flight: arrival time at the "
        "arrival airport; hotel: check-out), or null"
    )
    location_city: str | None = Field(
        description="City where the booking starts (flight: departure city)"
    )
    location_country: str | None = Field(description="ISO 3166-1 alpha-2 of location_city")
    arrival_city: str | None = Field(description="Flights/transfers: arrival city, else null")
    arrival_country: str | None = Field(description="ISO 3166-1 alpha-2 of arrival_city")
    flight_number: str | None = Field(description="e.g. 'KC 925', or null")
    departure_airport: str | None = Field(description="IATA code, 3 letters, or null")
    arrival_airport: str | None = Field(description="IATA code, 3 letters, or null")
    details: str | None = Field(description="Other useful details in Russian, one line, or null")


class Extraction(BaseModel):
    kind: ExtractionKind
    title: str = Field(description="Short name of the place/thing, in its original language")
    summary_ru: str = Field(description="1-2 sentences in Russian: what it is and why it's useful")
    category: CategoryValue
    city: str | None
    country: str | None = Field(description="ISO 3166-1 alpha-2, e.g. 'VN'")
    place_query: str | None = Field(
        description="Text to search in a maps service, e.g. 'Bánh Mì Phượng, Hội An'. "
        "Null if no specific place."
    )
    place_candidates: list[str] = Field(
        description="Up to 3 alternative place names when it is unclear which place is meant"
    )
    booking: BookingExtract | None = Field(description="Only when kind is 'booking', else null")
    confidence: float = Field(description="0..1, how sure you are about kind, title and place")
