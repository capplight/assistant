"""Manual order, pure code (spec 6.12, R-54): who wins between two phones and where a row goes.

No DB here (the pattern of `pipeline/core.py`); `assistant.actions.manual` runs it on the rows.

- `wins`: last-writer-wins for one row (or one tab) moved on two phones offline. The later
  `client_ts` wins, equal times by the larger `client_id` as a lowercase string. The clock only
  moves forward, so the result does not depend on the order the calls arrive in.
- `place`: the key for a moved row. The phone's own key is used when it can be trusted (valid,
  short enough, computed against the current key space): two phones moving different rows then
  give the same result whatever the arrival order. Otherwise the key goes right after the row the
  person saw above (or right before the one below) among the rows as they are now.
- `TIMED_TEMPLATES` (week 11а, proposal 2.3): on «Дела» a row with a time (its record has a live
  reminder) stands where its time puts it. Neither the person («Выше / Ниже», drag) nor the
  assistant («Разложи») moves it by `position`; «Перенести время» is the way. Rows without a
  time keep the person's order. `pages.service.timed_items` finds such rows.
"""

import uuid
from bisect import bisect_left, bisect_right
from dataclasses import dataclass
from datetime import datetime

from assistant.pages import lexorank

TIMED_TEMPLATES = ("tasks",)  # pages whose rows with a time are ordered by the time


@dataclass(frozen=True, order=True)
class Stamp:
    """When the person did it on the phone, and the call's id (the tie-break)."""

    ts: datetime
    client_id: str

    @classmethod
    def of(cls, ts: datetime, client_id: uuid.UUID, now: datetime) -> "Stamp":
        # A phone clock ahead of ours counts as now: it cannot win every future move.
        return cls(min(ts, now), str(client_id).lower())


def wins(new: Stamp, current: Stamp | None) -> bool:
    return current is None or new > current


def stamp_of(ts: datetime | None, client_id: uuid.UUID | None) -> Stamp | None:
    if ts is None or client_id is None:
        return None
    return Stamp(ts, str(client_id).lower())


def trusted(key: str | None) -> bool:
    return key is not None and len(key) <= lexorank.MAX_LENGTH and lexorank.is_valid(key)


class NeedRekey(Exception):
    """The gap can't take a key (equal neighbours, or the key would be too long)."""


def slot(others: list[str], *, after: str | None, before: str | None) -> str:
    """A key right after `after` (else right before `before`) among the sorted keys of the other
    rows. `after` and `before` are keys of rows in `others`; None means "no such anchor"."""
    if after is not None:
        if bisect_right(others, after) - bisect_left(others, after) > 1:
            raise NeedRekey  # rows share that key: there is no "right after" one of them
        i = bisect_right(others, after)
        low, high = after, others[i] if i < len(others) else None
    elif before is not None:
        if bisect_right(others, before) - bisect_left(others, before) > 1:
            raise NeedRekey
        i = bisect_left(others, before)
        low, high = (others[i - 1] if i > 0 else None), before
    else:
        raise ValueError("no anchor")
    key = lexorank.between(low, high)
    if len(key) > lexorank.MAX_LENGTH:
        raise NeedRekey
    return key
