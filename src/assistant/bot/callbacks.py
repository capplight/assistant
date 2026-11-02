"""callback_data formats and their parsing. Keep every value <= 64 bytes (Telegram limit)."""

from dataclasses import dataclass

from assistant.pipeline import CB_BOOKING, CB_PICK

CONSENT_YES = "consent:yes"
DELETE_YES = "del:yes"
DELETE_NO = "del:no"
CB_TRIP = "trip"


@dataclass(frozen=True)
class Consent:
    pass


@dataclass(frozen=True)
class DeleteAll:
    confirmed: bool


@dataclass(frozen=True)
class SwitchTrip:
    trip_id: int


@dataclass(frozen=True)
class Pick:
    item_id: int
    option_index: int


@dataclass(frozen=True)
class BookingAnswer:
    booking_id: int
    ok: bool


Callback = Consent | DeleteAll | SwitchTrip | Pick | BookingAnswer


def trip_cb(trip_id: int) -> str:
    return f"{CB_TRIP}:{trip_id}"


def _int(s: str) -> int | None:
    try:
        return int(s)
    except ValueError:
        return None


def parse_callback(data: str | None) -> Callback | None:
    """Parse callback_data; None for anything unknown or malformed."""
    if not data:
        return None
    if data == CONSENT_YES:
        return Consent()
    if data in (DELETE_YES, DELETE_NO):
        return DeleteAll(confirmed=data == DELETE_YES)
    parts = data.split(":")
    prefix = parts[0]
    if prefix == CB_TRIP and len(parts) == 2:
        trip_id = _int(parts[1])
        return SwitchTrip(trip_id) if trip_id is not None and trip_id > 0 else None
    if prefix == CB_PICK and len(parts) == 3:
        item_id, idx = _int(parts[1]), _int(parts[2])
        if item_id is None or idx is None or item_id <= 0 or idx < -1:
            return None
        return Pick(item_id, idx)
    if prefix == CB_BOOKING and len(parts) == 3 and parts[2] in ("ok", "no"):
        booking_id = _int(parts[1])
        if booking_id is None or booking_id <= 0:
            return None
        return BookingAnswer(booking_id, ok=parts[2] == "ok")
    return None
