"""Where a КП line's price comes from (spec 6.7 step 2, R-29, US-21): the price list → past КП →
«укажите цену». The model never writes a price: code finds candidates, takes an exact one itself,
and for the rest the model may only pick one of the candidates' ids (or none).

`price_source`: `price_list:<price list id>#<position id>` · `past_kp:<document id>#v<n>` ·
`manual` (the person typed it) · `missing`. The phone's label comes from it (`label`): «из
прайса», «из КП ТОО Арман, 3 окт»; «цену поставил я» is never written.
"""

import re
import uuid
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.db.models_kp import Document, KpPriceHistory, PriceList, PriceListItem
from assistant.kp.calc import money
from assistant.kp.norm import digits, name_norm, unit_norm, units_agree

SIMILAR_FROM = 0.3  # pg_trgm's default threshold for `%`
MONTHS = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"]


@dataclass
class Candidate:
    ref: str  # the price_source it would give
    kind: str  # price_list | past_kp
    name: str
    unit: str | None
    price: Decimal
    similarity: float
    exact: bool  # the same name (normalised) and a unit that agrees
    client: str | None = None  # past_kp: whose КП
    when: datetime | None = None


def client_key(client: dict[str, Any] | None) -> str | None:
    client = client or {}
    bin_ = digits(client.get("bin"))
    if len(bin_) == 12:
        return f"bin:{bin_}"
    name = name_norm(client.get("name"))
    return f"name:{name}" if name else None


async def from_price_list(session: AsyncSession, user_id: int, name: str, unit: str | None,
                          limit: int) -> list[Candidate]:  # fmt: skip
    norm = name_norm(name)
    if not norm:
        return []
    sim = func.similarity(PriceListItem.name_norm, norm).label("sim")
    rows = (await session.execute(
        select(PriceListItem, PriceList.public_id, sim)
        .join(PriceList, PriceList.id == PriceListItem.price_list_id)
        .where(PriceListItem.user_id == user_id, PriceListItem.deleted_at.is_(None),
               PriceList.deleted_at.is_(None), PriceList.active.is_(True),
               or_(PriceListItem.name_norm == norm, PriceListItem.name_norm.op("%")(norm)))
        .order_by(sim.desc(), PriceList.uploaded_at.desc(), PriceListItem.id.desc())
        .limit(limit * 2))).all()  # fmt: skip
    out = []
    for it, list_id, s in rows:
        exact = it.name_norm == norm and units_agree(it.unit, unit)
        out.append(Candidate(ref=f"price_list:{list_id}#{it.public_id}", kind="price_list",
                             name=it.name, unit=it.unit, price=money(it.price),
                             similarity=float(s or 0), exact=exact))  # fmt: skip
    out.sort(key=lambda c: (not c.exact, -c.similarity))
    return out[:limit]


async def from_history(session: AsyncSession, user_id: int, name: str, unit: str | None,
                       key: str | None) -> Candidate | None:  # fmt: skip
    """The last price of this position in a live past КП; this client's own price first."""
    norm = name_norm(name)
    if not norm:
        return None
    rows = (await session.execute(
        select(KpPriceHistory, Document.public_id)
        .join(Document, Document.id == KpPriceHistory.document_id)
        .where(KpPriceHistory.user_id == user_id, KpPriceHistory.name_norm == norm,
               Document.deleted_at.is_(None))
        .order_by(KpPriceHistory.id.desc()).limit(50))).all()  # fmt: skip
    rows = [(h, d) for h, d in rows if units_agree(h.unit, unit)]
    if not rows:
        return None
    mine = [(h, d) for h, d in rows if key and h.client_key == key]
    h, doc_id = (mine or rows)[0]
    return Candidate(ref=f"past_kp:{doc_id}#v{h.version_n}", kind="past_kp", name=h.name,
                     unit=h.unit, price=money(h.unit_price), similarity=1.0, exact=True,
                     client=h.client_name, when=h.sent_at or h.created_at)  # fmt: skip


async def record_history(session: AsyncSession, doc: Document, n: int, items: list[dict],
                         currency: str) -> None:  # fmt: skip
    """The document's prices for later КП: its current version's priced lines (one set per
    document, so a draft corrected twice does not count twice)."""
    await session.execute(delete(KpPriceHistory).where(KpPriceHistory.document_id == doc.id))
    key = client_key(doc.client)
    for it in items:
        if it.get("unit_price") in (None, ""):
            continue
        session.add(KpPriceHistory(user_id=doc.user_id, name=it["name"],
                                   name_norm=name_norm(it["name"]), unit=unit_norm(it.get("unit")),
                                   unit_price=money(Decimal(str(it["unit_price"]))),
                                   currency=currency, document_id=doc.id, version_n=n,
                                   client_name=(doc.client or {}).get("name"), client_key=key))


_REF = re.compile(r"^(price_list|past_kp):([0-9a-f-]{36})#(v?\d+|[0-9a-f-]{36})$")


def parse_ref(ref: str | None) -> tuple[str, uuid.UUID, str] | None:
    m = _REF.match(ref or "")
    if not m:
        return None
    return m.group(1), uuid.UUID(m.group(2)), m.group(3)


async def labels(session: AsyncSession, user_id: int, refs: set[str],
                 tz: ZoneInfo) -> dict[str, str]:  # fmt: skip
    """price_source → the phone's caption («из прайса», «из КП ТОО Арман, 3 окт»)."""
    out: dict[str, str] = {}
    lists: dict[uuid.UUID, str] = {}
    docs: dict[uuid.UUID, Document] = {}
    want_lists = {p[1] for r in refs if (p := parse_ref(r)) and p[0] == "price_list"}
    want_docs = {p[1] for r in refs if (p := parse_ref(r)) and p[0] == "past_kp"}
    if want_lists:
        lists = dict((await session.execute(select(PriceList.public_id, PriceList.title).where(
            PriceList.user_id == user_id, PriceList.public_id.in_(want_lists)))).tuples().all())
    if want_docs:
        docs = {d.public_id: d for d in await session.scalars(select(Document).where(
            Document.user_id == user_id, Document.public_id.in_(want_docs)))}
    for ref in refs:
        p = parse_ref(ref)
        if ref == "manual":
            out[ref] = ""  # the person typed it: no caption
        elif ref == "missing":
            out[ref] = "укажите цену"
        elif p and p[0] == "price_list":
            title = lists.get(p[1])
            out[ref] = f"из прайса «{title}»" if title and title != "Мои цены" else "из прайса"
        elif p and p[0] == "past_kp":
            d = docs.get(p[1])
            if d is None:
                out[ref] = "из прошлого КП"
            else:
                local = d.created_at.astimezone(tz)
                who = (d.client or {}).get("name")
                out[ref] = (f"из КП {who}, " if who else "из КП от ") + \
                    f"{local.day} {MONTHS[local.month - 1]}"
    return out


__all__ = ["Candidate", "client_key", "from_history", "from_price_list", "labels", "parse_ref",
           "record_history"]  # fmt: skip
