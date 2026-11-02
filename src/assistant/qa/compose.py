"""Pure text building for Q&A: data block for the model and the final Russian answer."""

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime

from assistant.db.models import Booking, Item
from assistant.qa._tz import get_tz
from assistant.qa.llm import AnswerDraft

MAX_PICKS = 8
PLAIN_LIMIT = 5
SUMMARY_CHARS = 400
TELEGRAM_LIMIT = 4000

NOTHING_FOUND = (
    "Среди сохранённого ничего такого не нашёл. Пересылай мне рилсы, посты, скрины и брони — "
    "я всё запомню и потом подскажу."
)
NOTHING_NEARBY = (
    "Рядом (до {radius}) ничего из сохранённого не нашёл. Пересылай места, которые хочешь "
    "посетить, — подскажу, когда окажешься рядом."
)

CATEGORY_RU = {
    "food": "еда",
    "beach": "пляж",
    "sight": "достопримечательность",
    "stay": "жильё",
    "transport": "транспорт",
    "booking": "бронь",
    "tip": "совет",
    "shopping": "шопинг",
    "other": "другое",
}


@dataclass
class Entry:
    """One retrieved record, numbered for the model (ref = position + 1)."""

    kind: str  # "item" | "booking"
    id: int
    title: str
    city: str | None = None
    url: str | None = None
    summary: str | None = None
    category: str | None = None
    when: str | None = None  # bookings: local start time, rendered
    code: str | None = None
    item_id: int | None = None  # bookings: the item it came from


def _clip(text: str | None, n: int) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


def entry_from_item(item: Item) -> Entry:
    title = _clip(item.title or item.summary or item.raw_text or "Без названия", 120)
    return Entry(
        kind="item",
        id=item.id,
        title=title,
        city=item.city,
        url=item.url,
        summary=item.summary,
        category=str(item.category.value) if item.category else None,
    )


def format_local(dt: datetime | None, tz_name: str | None) -> str | None:
    if dt is None:
        return None
    local = dt.astimezone(get_tz(tz_name))
    return f"{local:%d.%m %H:%M}"


def entry_from_booking(booking: Booking, fallback_tz: str | None) -> Entry:
    return Entry(
        kind="booking",
        id=booking.id,
        title=_clip(booking.title, 120),
        when=format_local(booking.starts_at, booking.tz or fallback_tz),
        code=booking.confirmation_code,
        item_id=booking.item_id,
        category=str(booking.type.value) if booking.type else None,
    )


def _data(text: str | None) -> str:
    """Untrusted text inside the data block: no way to fake a closing tag."""
    return (text or "").replace("<", "‹").replace(">", "›")


def build_data_block(entries: Sequence[Entry], today: date) -> str:
    lines = [f"Today: {today.isoformat()}", "<saved_data>"]
    for ref, e in enumerate(entries, 1):
        parts = [f"[{ref}] {e.kind}", f"title: {_data(e.title)}"]
        if e.category:
            parts.append(f"category: {e.category}")
        if e.city:
            parts.append(f"city: {_data(e.city)}")
        if e.when:
            parts.append(f"starts: {e.when}")
        if e.summary:
            parts.append(f"summary: {_data(_clip(e.summary, SUMMARY_CHARS))}")
        lines.append(" | ".join(parts))
    lines.append("</saved_data>")
    return "\n".join(lines)


def _entry_line(n: int, e: Entry, note: str | None) -> str:
    if e.kind == "booking":
        line = f"{n}. {e.title}"
        if e.when:
            line += f", {e.when}"
        if e.code:
            line += f", код брони {e.code}"
    else:
        line = f"{n}. {e.title}"
        if e.city:
            line += f", {e.city}"
    if note:
        line += f" — {note.strip()}"
    if e.kind == "item" and e.url:
        line += f"\n   {e.url}"
    return line


def _ids(entries: Sequence[Entry]) -> list[int]:
    ids: list[int] = []
    for e in entries:
        iid = e.id if e.kind == "item" else e.item_id
        if iid is not None and iid not in ids:
            ids.append(iid)
    return ids


def _fit(text: str) -> str:
    return text if len(text) <= TELEGRAM_LIMIT else text[: TELEGRAM_LIMIT - 1] + "…"


def render_answer(draft: AnswerDraft, entries: Sequence[Entry]) -> tuple[str, list[int]]:
    """Draft from the model -> final text. Refs outside the list are dropped (no inventions)."""
    chosen: list[tuple[Entry, str]] = []
    used: set[int] = set()
    for pick in draft.picks:
        if 1 <= pick.ref <= len(entries) and pick.ref not in used:
            used.add(pick.ref)
            chosen.append((entries[pick.ref - 1], _clip(pick.note, 120)))
        if len(chosen) >= MAX_PICKS:
            break
    if not chosen:
        intro = draft.intro.strip()
        return (intro or NOTHING_FOUND), []
    lines = [draft.intro.strip()] if draft.intro.strip() else []
    lines += [_entry_line(n, e, note) for n, (e, note) in enumerate(chosen, 1)]
    return _fit("\n".join(lines)), _ids([e for e, _ in chosen])


def render_plain(entries: Sequence[Entry]) -> tuple[str, list[int]]:
    """Answer without a model call: the top results as they are."""
    if not entries:
        return NOTHING_FOUND, []
    top = list(entries[:PLAIN_LIMIT])
    lines = ["Вот что нашёл среди сохранённого:"]
    lines += [_entry_line(n, e, None) for n, e in enumerate(top, 1)]
    return _fit("\n".join(lines)), _ids(top)


def format_distance(meters: float) -> str:
    if meters < 1000:
        return f"{max(10, round(meters / 10) * 10)} м"
    km = round(meters / 1000, 1)
    return f"{km:g} км".replace(".", ",")


def render_nearby(
    rows: Sequence[tuple[Item, str | None, float]], radius_m: int
) -> tuple[str, list[int]]:
    """rows: (item, place name, distance m), closest first, item ids unique."""
    if not rows:
        return NOTHING_NEARBY.format(radius=format_distance(radius_m)), []
    lines = ["Рядом сохранённое:"]
    for n, (item, place_name, dist) in enumerate(rows, 1):
        title = _clip(item.title or place_name or item.summary or "Место", 100)
        line = f"{n}. {title} — {format_distance(dist)}"
        if item.url:
            line += f"\n   {item.url}"
        lines.append(line)
    return _fit("\n".join(lines)), [item.id for item, _, _ in rows]
