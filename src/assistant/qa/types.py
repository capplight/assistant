"""Public data types of the Q&A package (re-exported from assistant.qa)."""

from dataclasses import dataclass, field


@dataclass
class Location:
    lat: float
    lon: float


@dataclass
class Answer:
    text: str
    item_ids: list[int] = field(default_factory=list)  # items the answer is based on
