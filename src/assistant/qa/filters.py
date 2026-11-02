"""What the question asks for, as structured filters (filled by the model or a fallback)."""

import re
from datetime import date
from typing import Literal

from pydantic import BaseModel, Field

CategoryName = Literal[
    "food", "beach", "sight", "stay", "transport", "booking", "tip", "shopping", "other"
]


class QueryFilters(BaseModel):
    """Structured-output schema for filter extraction. Empty values mean "no filter"."""

    city_variants: list[str] = Field(
        default_factory=list,
        description="The city the question is about, spelled several ways: Russian, English, "
        "local (e.g. ['Фукуок', 'Phu Quoc', 'Phú Quốc']). Empty if no city.",
    )
    country: str | None = Field(
        default=None, description="ISO 3166-1 alpha-2 code if a country is meant, else null."
    )
    categories: list[CategoryName] = Field(
        default_factory=list, description="Categories asked about; empty = any."
    )
    trip_hint: str | None = Field(
        default=None, description="Words naming one of the user's trips, if the question names one."
    )
    date_from: str | None = Field(
        default=None, description="YYYY-MM-DD, start of the period the user saved things in."
    )
    date_to: str | None = Field(
        default=None, description="YYYY-MM-DD, inclusive end of that period."
    )
    keywords: list[str] = Field(
        default_factory=list,
        description="Search words for full-text search: dishes, place names, topics, with "
        "Russian/English/Vietnamese spellings and transliterations. No stop words.",
    )
    wants_bookings: bool = Field(
        default=False, description="True if the user asks about flights, hotels, transfers, tours."
    )

    def parsed_dates(self) -> tuple[date | None, date | None]:
        return _parse_date(self.date_from), _parse_date(self.date_to)

    def has_structured(self) -> bool:
        """True when SQL filters alone narrow the items (worth a 'recent matching' arm)."""
        return bool(
            self.city_variants
            or self.country
            or self.categories
            or self.trip_hint
            or self.date_from
            or self.date_to
        )


def _parse_date(value: str | None) -> date | None:
    if not value:
        return None
    try:
        return date.fromisoformat(value[:10])
    except ValueError:
        return None


_STOPWORDS = frozenset(
    """что где как какой какая какие каких куда когда мне меня мой моя мои мою про для это эти
    все всё был была были есть там тут сохранял сохраняла сохранил сохранила сохранено
    помнишь напомни покажи скажи можно нужно ещё еще или and the what where""".split()
)
_BOOKING_MARKERS = (
    "бронь",
    "брони",
    "рейс",
    "вылет",
    "отел",
    "гостиниц",
    "заселен",
    "билет",
    "трансфер",
    "экскурси",
    "flight",
    "hotel",
)
_WORD = re.compile(r"[\w'-]+", re.UNICODE)


def heuristic_filters(question: str) -> QueryFilters:
    """Fallback without a model call (no consent yet, or the model failed)."""
    low = question.casefold()
    words = [w for w in _WORD.findall(low) if len(w) >= 3 and w not in _STOPWORDS]
    seen: dict[str, None] = dict.fromkeys(words)
    return QueryFilters(
        keywords=list(seen)[:8],
        wants_bookings=any(m in low for m in _BOOKING_MARKERS),
    )
