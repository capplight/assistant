"""КП documents and versions in the DB (spec 3.6, 6.7; contract docs/api/kp.md).

A КП has its own record (`items.kind = kp`, `ai_generated = true`) on «Документы», so it is
found by search, goes to the trash with «Отменить», and is a card in the card file. Each change is
a new `document_versions` row: `data` (the model's data, never sums), `totals` (kp/calc.py),
`calc_version`, `vat_rate`, `vat_mode`, `patch`, `changed_paths`. Writers take the per-user sync
lock first; the caller writes the action and commits.
"""

import re
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import func, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.db.models import Item, User
from assistant.db.models_kp import (
    DealStatus,
    DocKind,
    DocStatus,
    DocTemplate,
    Document,
    DocumentVersion,
)
from assistant.db.models_v2 import File, RecordKind, RecordSource, RecordStatus
from assistant.kp import calc, prices, vat
from assistant.kp.norm import name_norm
from assistant.pages import first_use_page, lock_user, place_item
from assistant.records import content_hash, normalize_text

PAGE_TEMPLATE = "documents"
JOB_EXTRACT = "kp:extract"
DEAL_TEXT = {"draft": "Черновик", "sent": "Отправлено", "seen": "Видел", "accepted": "Принято",
             "declined": "Не принято"}  # fmt: skip


class KpError(ValueError):
    def __init__(self, status: int, code: str, details: dict | None = None) -> None:
        super().__init__(code)
        self.status, self.code, self.details = status, code, details


async def user_tz(session: AsyncSession, user_id: int) -> ZoneInfo:
    return ZoneInfo(await session.scalar(select(User.tz).where(User.id == user_id))
                    or "Asia/Almaty")  # fmt: skip


async def get(session: AsyncSession, user_id: int, public_id: uuid.UUID,
              lock: bool = False) -> Document:  # fmt: skip
    q = select(Document).where(Document.user_id == user_id, Document.public_id == public_id)
    doc = await session.scalar(q.with_for_update() if lock else q)
    if doc is None:
        raise KpError(404, "not_found")
    return doc


async def version(session: AsyncSession, doc: Document, n: int | None = None) -> DocumentVersion:
    n = n or doc.current_version_n
    v = await session.scalar(select(DocumentVersion).where(
        DocumentVersion.document_id == doc.id, DocumentVersion.n == n)) if n else None
    if v is None:
        raise KpError(404, "not_found")
    return v


async def system_template(session: AsyncSession) -> DocTemplate | None:
    return await session.scalar(select(DocTemplate).where(
        DocTemplate.user_id.is_(None), DocTemplate.kind == "kp", DocTemplate.engine == "html")
        .order_by(DocTemplate.version.desc()).limit(1))  # fmt: skip


async def next_number(session: AsyncSession, user_id: int, year: int,
                      prefix: str) -> tuple[int, str]:  # fmt: skip
    """«КП-2026-014»: the next number of the year. The caller holds the user lock."""
    last = await session.scalar(select(func.max(Document.seq_no)).where(
        Document.user_id == user_id, Document.kind == DocKind.KP, Document.year == year)) or 0
    n = last + 1
    return n, f"{prefix}-{year}-{n:03d}"


def compute(data: dict[str, Any], *, rates: list[dict[str, str]],
            rounding: str) -> tuple[calc.Totals, Decimal | None]:  # fmt: skip
    mode = (data.get("vat") or {}).get("mode") or "none"
    rate = vat.rate_on(rates, date.fromisoformat(data["date"])) if mode != "none" else None
    totals = calc.compute(calc.lines_of(data.get("items") or []), vat_mode=mode, vat_rate=rate,
                          rounding=rounding,
                          discount_total_pct=Decimal(str(data.get("discount_total_pct") or "0")))
    return totals, rate


def title_of(doc: Document, data: dict[str, Any]) -> str:
    who = (data.get("client") or {}).get("name")
    short = re.sub(r"^КП-\d{4}-0*", "", doc.number or "") if doc.number else ""
    base = f"КП № {short}" if short else "КП"
    return (f"{base} · {who}" if who else base)[:200]


def record_text(data: dict[str, Any], total: Decimal) -> str:
    """The КП record's text (search: «Что я обещал ТОО Арман и на какую сумму?»)."""
    who = (data.get("client") or {}).get("name")
    head = f"КП {data.get('number') or ''} от {data.get('date')}".strip()
    names = "; ".join(f"{it['name']} — {it.get('volume') or it['qty']} {it.get('unit') or ''}"
                      .strip()
                      for it in (data.get("items") or [])[:60])  # fmt: skip
    money_text = calc.format_money(total, data.get("currency") or "KZT")
    return normalize_text("\n".join(x for x in (head, f"Клиент: {who}" if who else None,
                                                f"Итого: {money_text}", names) if x))


@dataclass
class Created:
    doc: Document
    item: Item


async def create(session: AsyncSession, user_id: int, *, sources: list[Item], wishes: str | None,
                 client_id: uuid.UUID | None, now: datetime) -> Created:  # fmt: skip
    """The КП's record and document, status `extracting`; the job is queued by the caller."""
    await lock_user(session, user_id)
    item = Item(user_id=user_id, client_id=uuid.uuid4(), kind=RecordKind.KP,
                source=RecordSource.SYSTEM, status=RecordStatus.READY, title="КП",
                text=None, ai_generated=True, source_meta={"kp": True})  # fmt: skip
    session.add(item)
    await session.flush()
    item.occurred_at = item.created_at
    doc = Document(user_id=user_id, client_id=client_id, item_id=item.id, kind=DocKind.KP,
                   title="КП", status=DocStatus.EXTRACTING, deal_status=DealStatus.DRAFT,
                   source_item_ids=[s.id for s in sources], request_text=wishes,
                   progress={"state": "reading", "done": 0, "total": 0, "parts_done": 0,
                             "parts_total": 0}, draft={})  # fmt: skip
    session.add(doc)
    await session.flush()
    await first_use_page(session, user_id, PAGE_TEMPLATE)  # made on the first КП (Ф-35)
    await place_item(session, item)  # «Документы» takes it (kind kp; `_owners`)
    return Created(doc, item)


SOURCE_KINDS = frozenset({RecordKind.PDF, RecordKind.DOCX, RecordKind.XLSX, RecordKind.IMAGE,
                          RecordKind.SCREENSHOT, RecordKind.NOTE, RecordKind.VOICE,
                          RecordKind.EMAIL, RecordKind.TG_MESSAGE})  # fmt: skip
WAITING = frozenset({RecordStatus.PENDING, RecordStatus.PROCESSING})
REQUEST_MAX = 4000


async def request_record(session: AsyncSession, user_id: int, text: str, *,
                         voice: bool = False) -> Item:  # fmt: skip
    """The ТЗ said or typed as a phrase («сделай КП для ТОО Ромашка: 20 светильников, монтаж»):
    a record in the person's words, like any note (Ф-50), so the КП has a source to point to."""
    from assistant.records import detect_lang, enqueue_ingest

    body = normalize_text(text)[:REQUEST_MAX]
    if not body:
        raise KpError(422, "kp_source_empty")
    item = Item(user_id=user_id, client_id=uuid.uuid4(), kind=RecordKind.NOTE,
                source=RecordSource.MIC if voice else RecordSource.TYPED,
                status=RecordStatus.PENDING, title=None, text=body, text_lang=detect_lang(body),
                content_hash=content_hash(body), source_meta={"kp_request": True},
                ai_generated=False)  # fmt: skip
    session.add(item)
    await session.flush()
    item.occurred_at = item.created_at
    await enqueue_ingest(session, item)
    await place_item(session, item)
    return item


async def start(session: AsyncSession, user_id: int, *, sources: list[Item], wishes: str | None,
                client_id: uuid.UUID | None, now: datetime, per_day: int) -> Created:  # fmt: skip
    """A new КП from its ТЗ records (the screen, «Сделать КП из этого», the line): the checks of
    `POST /v1/documents/kp`, then the record + document; the caller queues the job. Raises
    KpError: `item_kind`, `kp_source_not_ready` (a file still being read), `kp_source_empty`,
    `kp_daily_limit`. Consent is the caller's (the line already needs `ai_cross_border`)."""
    if not sources or any(i.kind not in SOURCE_KINDS for i in sources):
        raise KpError(422, "item_kind")
    # a record still being read waits; the ТЗ just said as a phrase (`request_record`) is its text
    if any(i.status in WAITING and not (i.source_meta or {}).get("kp_request") for i in sources):
        raise KpError(409, "kp_source_not_ready", {"retry_after": 2})
    if not any((i.text or i.raw_text or "").strip() for i in sources):
        raise KpError(422, "kp_source_empty")
    tz = await user_tz(session, user_id)
    day_start = now.astimezone(tz).replace(hour=0, minute=0, second=0, microsecond=0)
    today = await session.scalar(select(func.count()).select_from(Document).where(
        Document.user_id == user_id, Document.kind == DocKind.KP, Document.ai_generated,
        Document.created_at >= day_start.astimezone(ZoneInfo("UTC")))) or 0  # fmt: skip
    if today >= per_day:
        raise KpError(429, "kp_daily_limit")
    return await create(session, user_id, sources=sources, wishes=wishes, client_id=client_id,
                        now=now)  # fmt: skip


@dataclass
class Saved:
    version: DocumentVersion
    totals: calc.Totals
    before: dict[str, Any] | None = None  # the previous totals (for «1 240 000 → 1 178 000 ₸»)
    pages: set[int] = field(default_factory=set)


async def save_version(session: AsyncSession, doc: Document, data: dict[str, Any], *, author: str,
                       now: datetime, settings: Any, patch: list | None = None,
                       changed_paths: list[str] | None = None,
                       request_text: str | None = None) -> Saved:  # fmt: skip
    """A new version (n + 1) with code's totals. Updates the document, its record and the price
    history. Raises KpError(422) when the data does not compute (calc.CalcError)."""
    try:
        totals, rate = compute(data, rates=settings.kp_vat_rates, rounding=settings.kp_vat_rounding)
    except calc.CalcError as exc:
        raise KpError(422, exc.code, {"line": exc.line}) from exc
    except vat.VatConfigError as exc:
        raise KpError(422, "kp_vat_invalid") from exc
    before = None
    if doc.current_version_n:
        prev = await version(session, doc)
        before = prev.totals
    n = (doc.current_version_n or 0) + 1
    if before is not None and before.get("total") != calc.fmt(totals.total):
        changed_paths = [*(changed_paths or []), "/totals/total"]
    tpl = await system_template(session)
    v = DocumentVersion(document_id=doc.id, user_id=doc.user_id, n=n, data=data,
                        totals=totals.as_json(), calc_version=calc.CALC_VERSION, vat_rate=rate,
                        vat_mode=totals.vat_mode, template_id=tpl.id if tpl else None,
                        patch=list(patch or []), changed_paths=list(changed_paths or []),
                        author=author, request_text=request_text,
                        ai_generated=doc.ai_generated)  # fmt: skip
    session.add(v)
    doc.current_version_n = n
    doc.client = {k: v_ for k, v_ in (data.get("client") or {}).items() if k != "review"}
    doc.title = title_of(doc, data)
    if doc.status in (DocStatus.EXTRACTING, DocStatus.READY, DocStatus.FAILED):
        doc.status = DocStatus.DRAFT
    doc.version += 1
    doc.updated_at = now
    item = await session.get(Item, doc.item_id, with_for_update=True)
    assert item is not None
    item.title = doc.title
    item.text = record_text(data, totals.total)
    item.content_hash = content_hash(item.text)
    item.updated_at = now
    await session.flush()
    await prices.record_history(session, doc, n, data.get("items") or [],
                                data.get("currency") or "KZT")  # fmt: skip
    await session.flush()
    return Saved(v, totals, before)


async def copy_version(session: AsyncSession, doc: Document, src: DocumentVersion, *, author: str,
                       now: datetime) -> DocumentVersion:  # fmt: skip
    """«Вернуть версию n» / «Отменить» of an edit: a new version equal to `src` (its data, totals,
    rate and calc version as they were: the numbers the person saw come back exactly)."""
    n = (doc.current_version_n or 0) + 1
    cur = await version(session, doc) if doc.current_version_n else None
    changed = _diff_paths(cur.data if cur else {}, src.data)
    if cur is not None and cur.totals.get("total") != src.totals.get("total"):
        changed.append("/totals/total")
    v = DocumentVersion(document_id=doc.id, user_id=doc.user_id, n=n, data=src.data,
                        totals=src.totals, calc_version=src.calc_version, vat_rate=src.vat_rate,
                        vat_mode=src.vat_mode, template_id=src.template_id,
                        patch=[{"op": "revert", "from": src.n}], changed_paths=changed,
                        author=author, ai_generated=src.ai_generated)  # fmt: skip
    session.add(v)
    doc.current_version_n = n
    doc.client = {k: x for k, x in (src.data.get("client") or {}).items() if k != "review"}
    doc.title = title_of(doc, src.data)
    doc.version += 1
    doc.updated_at = now
    item = await session.get(Item, doc.item_id, with_for_update=True)
    if item is not None:
        item.title = doc.title
        item.text = record_text(src.data, Decimal(src.totals["total"]))
        item.content_hash = content_hash(item.text)
        item.updated_at = now
    await session.flush()
    await prices.record_history(session, doc, n, src.data.get("items") or [],
                                src.data.get("currency") or "KZT")  # fmt: skip
    return v


def _diff_paths(a: dict[str, Any], b: dict[str, Any]) -> list[str]:
    out = []
    for key in ("number", "date", "discount_total_pct", "subject"):
        if a.get(key) != b.get(key):
            out.append(f"/{key}")
    for group in ("client", "vat", "terms", "text_blocks", "outgoing"):
        ga, gb = a.get(group) or {}, b.get(group) or {}
        out += [f"/{group}/{k}" for k in sorted(set(ga) | set(gb))
                if k != "review" and ga.get(k) != gb.get(k)]  # fmt: skip
    ia = {str(i["id"]): i for i in a.get("items") or []}
    ib = {str(i["id"]): i for i in b.get("items") or []}
    for lid in dict.fromkeys([*ia, *ib]):
        x, y = ia.get(lid), ib.get(lid)
        if x is None or y is None:
            out.append(f"/items/{lid}")
            continue
        out += [f"/items/{lid}/{k}" for k in ("name", "unit", "qty", "unit_price", "discount_pct",
                                              "volume") if x.get(k) != y.get(k)]  # fmt: skip
    return out


def missing_required(data: dict[str, Any], totals: dict[str, Any], profile: dict[str, Any],
                     required: list[str]) -> list[str]:  # fmt: skip
    """Ф-17 (configurable): the required fields still empty. `signature_stamp` never blocks.
    Week 15 keys (the founder's father's real КП): `outgoing` («Исх. № … от …»), `items` (the
    table has a line), `signer` (name and position); `seller.bank` = ИИК, БИК and Кбе."""
    client = data.get("client") or {}
    terms = data.get("terms") or {}
    bank = profile.get("bank") or {}
    out_no = data.get("outgoing") or {}
    signer = profile.get("signer") or {}
    checks = {
        "outgoing": bool(out_no.get("number") and out_no.get("date")),
        "items": bool(data.get("items")),
        "signer": bool(signer.get("name") and signer.get("title")),
        "license": bool((profile.get("license") or {}).get("number")),
        "subject": bool(data.get("subject")),
        "number": bool(data.get("number")), "date": bool(data.get("date")),
        "validity": bool(terms.get("validity_days")),
        "seller.name": bool(profile.get("name")), "seller.bin_iin": bool(profile.get("bin_iin")),
        "seller.address": bool(profile.get("address")),
        "seller.bank": bool(bank.get("iban") and bank.get("bik") and bank.get("kbe")),
        "buyer.name": bool(client.get("name")), "buyer.bin": bool(client.get("bin")),
        "items.unit": all(it.get("unit") or it.get("kind") == "lump"
                          for it in data.get("items") or []),
        "total": bool(totals.get("complete")), "vat": bool(totals.get("vat_mode")),
        "amount_words": bool(totals.get("complete")), "signature_stamp": True,
    }  # fmt: skip
    return [k for k in required if not checks.get(k, True)]


def valid_until(data: dict[str, Any]) -> str | None:
    days = (data.get("terms") or {}).get("validity_days")
    if not days or not data.get("date"):
        return None
    return (date.fromisoformat(data["date"]) + timedelta(days=int(days))).isoformat()


async def items_dicts(session: AsyncSession, user_id: int, items: list[dict[str, Any]],
                      totals: dict[str, Any], tz: ZoneInfo) -> list[dict[str, Any]]:  # fmt: skip
    by_id = {t["id"]: t for t in totals.get("lines") or []}
    labels = await prices.labels(session, user_id, {str(it.get("price_source") or "missing")
                                                    for it in items}, tz)  # fmt: skip
    out = []
    for it in items:
        src = str(it.get("price_source") or "missing")
        t = by_id.get(str(it["id"]), {})
        label = labels.get(src, "")
        if it.get("price_review") and it.get("matched_name"):
            label = f"{label}: «{it['matched_name']}» — та ли позиция?"
        out.append({**{k: it.get(k) for k in ("id", "name", "unit", "qty", "unit_price",
                                              "discount_pct", "price_source", "price_review",
                                              "matched_name", "source_ref", "volume")},
                    "kind": it.get("kind") or "qty",
                    "review_fields": list(it.get("review") or []),
                    "price_label": label, "amount": t.get("amount"), "gross": t.get("gross"),
                    "discount": t.get("discount")})  # fmt: skip
    return out


def price_summary(items: list[dict[str, Any]]) -> dict[str, int]:
    """S16 «ЦЕНЫ: 9 — из прайса · 1 — из КП · 2 — нет цены»."""
    out = {"price_list": 0, "past_kp": 0, "manual": 0, "missing": 0}
    for it in items:
        kind = str(it.get("price_source") or "missing").split(":", 1)[0]
        out[kind] = out.get(kind, 0) + 1
    return out


async def version_dict(session: AsyncSession, doc: Document, v: DocumentVersion, *,
                       tz: ZoneInfo, profile: dict[str, Any] | None,
                       required: list[str] | None) -> dict[str, Any]:  # fmt: skip
    data = v.data or {}
    files = await version_files(session, doc, [v])
    render = files[v.n]["pdf"]
    out = {
        "n": v.n, "author": v.author, "created_at": v.created_at, "calc_version": v.calc_version,
        "vat_rate": f"{v.vat_rate:.2f}" if v.vat_rate is not None else None,
        "vat_mode": v.vat_mode, "changed_paths": list(v.changed_paths or []),
        "patch": list(v.patch or []), "request_text": v.request_text,
        "data": {k: data.get(k) for k in ("number", "date", "currency", "vat",
                                          "discount_total_pct", "terms", "text_blocks",
                                          "subject", "outgoing")},
        "client": data.get("client") or {},
        "items": await items_dicts(session, doc.user_id, data.get("items") or [], v.totals, tz),
        "totals": v.totals, "valid_until": valid_until(data),
        "price_summary": price_summary(data.get("items") or []),
        "sent_at": v.sent_at, "sent_channel": v.sent_channel, "render": render,
        "ai_generated": v.ai_generated, "files": files[v.n], "frozen": v.sent_at is not None,
    }  # fmt: skip
    if profile is not None and required is not None:
        out["missing_required"] = missing_required(data, v.totals, profile, required)
    return out


def file_dict(doc: Document, f: File, n: int | None = None) -> dict[str, Any]:
    out = {"id": f.public_id, "mime": f.mime, "bytes": f.bytes, "sha256": f.sha256,
           "url": f"/v1/documents/{doc.public_id}/files/{f.public_id}"}  # fmt: skip
    if n is not None:
        out["name"] = filename(doc, n, "docx" if f.mime == DOCX_MIME else "pdf")
    return out


DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def filename(doc: Document, n: int, ext: str = "pdf") -> str:
    """«КП_ТОО_Арман_v3.pdf»."""
    who = ((doc.client or {}).get("name") or "").replace("«", "").replace("»", "")
    base = "_".join(["КП", *who.split()])[:80] or "КП"
    return f"{base}_v{n}.{ext}"


async def version_files(session: AsyncSession, doc: Document, vers: list[DocumentVersion],
                        ) -> dict[int, dict[str, Any]]:  # fmt: skip
    """n → {pdf, docx}: the files made of each version (null when none or purged)."""
    ids = {i for v in vers for i in (v.render_file_id, v.docx_file_id) if i}
    rows = {f.id: f for f in await session.scalars(select(File).where(
        File.id.in_(ids), File.purged_at.is_(None)))} if ids else {}  # fmt: skip
    out = {}
    for v in vers:
        pdf, docx = rows.get(v.render_file_id or 0), rows.get(v.docx_file_id or 0)
        out[v.n] = {"pdf": file_dict(doc, pdf, v.n) if pdf else None,
                    "docx": file_dict(doc, docx, v.n) if docx else None}
    return out


AUTHOR_TEXT = {"initial": "Первая версия", "tap_edit": "Правка вручную"}


def author_text(v: DocumentVersion) -> str:
    if v.author == "agent_request":
        phrase = " ".join((v.request_text or "").split())
        return f"Правка: «{phrase[:80]}»" if phrase else "Правка"
    if v.author == "revert":
        src = next((p.get("from") for p in v.patch or [] if p.get("op") == "revert"), None)
        return f"Вернул версию {src}" if src else "Вернул версию"
    return AUTHOR_TEXT.get(v.author, "Правка")


async def versions_rows(session: AsyncSession, doc: Document,
                        limit: int = 50) -> list[dict[str, Any]]:  # fmt: skip
    """The versions sheet, newest first."""
    vers = list(await session.scalars(select(DocumentVersion).where(
        DocumentVersion.document_id == doc.id).order_by(DocumentVersion.n.desc()).limit(limit)))
    files = await version_files(session, doc, vers)
    return [{"n": v.n, "author": v.author, "author_text": author_text(v),
             "request_text": v.request_text, "created_at": v.created_at,
             "total": v.totals.get("total"), "missing_prices": v.totals.get("missing", 0),
             "changed_paths": list(v.changed_paths or []), "current": v.n == doc.current_version_n,
             "sent_at": v.sent_at, "sent_channel": v.sent_channel, "frozen": v.sent_at is not None,
             "files": files[v.n]} for v in vers]  # fmt: skip


async def rows_dicts(session: AsyncSession, docs: list[Document]) -> list[dict[str, Any]]:
    """The card file's row of each document (sync, pages, list): no lines, no requisites."""
    if not docs:
        return []
    items = dict((await session.execute(select(Item.id, Item.public_id).where(
        Item.id.in_({d.item_id for d in docs})))).tuples().all())  # fmt: skip
    want = [(d.id, d.current_version_n) for d in docs if d.current_version_n]
    vers = {(v.document_id, v.n): v for v in await session.scalars(select(DocumentVersion).where(
        tuple_(DocumentVersion.document_id, DocumentVersion.n).in_(want)))} if want else {}
    out = []
    for d in docs:
        v = vers.get((d.id, d.current_version_n or 0))
        t = v.totals if v else {}
        data = v.data if v else {}
        out.append({
            "id": d.public_id, "client_id": d.client_id, "item_id": items.get(d.item_id),
            "kind": d.kind, "title": d.title, "number": d.number, "date": data.get("date"),
            "client": {"name": (d.client or {}).get("name")}, "currency": data.get("currency"),
            "total": t.get("total"), "vat_mode": t.get("vat_mode"), "missing_prices":
            t.get("missing", 0), "lines": len(data.get("items") or []), "status": d.status,
            "deal_status": d.deal_status, "deal_status_text": DEAL_TEXT[d.deal_status],
            "current_version_n": d.current_version_n, "sent_version_n": d.sent_version_n,
            "sent_at": d.sent_at, "progress": d.progress or {}, "error": d.error,
            "ai_generated": d.ai_generated,
            "version": d.version, "seq": d.seq, "created_at": d.created_at,
            "updated_at": d.updated_at, "deleted_at": d.deleted_at,
        })  # fmt: skip
    return out


def field_values(row: dict[str, Any]) -> dict[str, Any]:
    """«Документы» page fields of a КП (the template's `document.*` sources)."""
    values = {"doc_type": "kp", "client": (row.get("client") or {}).get("name"),
              "amount": row.get("total"), "kp_status": row.get("deal_status")}  # fmt: skip
    return {k: v for k, v in values.items() if v is not None}


DOC_TYPES = {"receipt": "receipt", "contract": "contract", "kp_request": "other",
             "price_list": "other", "id_document": "other", "document": "other"}  # fmt: skip


def other_field_values(item: Item) -> dict[str, Any]:
    """A document that is not a КП (a contract, a receipt, a PDF): its type from the envelope."""
    env = item.envelope or {}
    kind = DOC_TYPES.get(str(env.get("type") or ""), "other")
    out: dict[str, Any] = {"doc_type": kind}
    people = (env.get("entities") or {}).get("people") if isinstance(env.get("entities"),
                                                                       dict) else None
    if isinstance(people, list) and people and isinstance(people[0], str):
        out["client"] = people[0][:120]
    return out


def same_name(a: str | None, b: str | None) -> bool:
    return name_norm(a) == name_norm(b)


__all__ = ["DEAL_TEXT", "DOCX_MIME", "JOB_EXTRACT", "KpError", "PAGE_TEMPLATE", "Saved",
           "author_text", "compute", "create", "field_values", "file_dict", "filename", "get",
           "version_files", "versions_rows", "missing_required", "next_number",
           "other_field_values", "price_summary", "rows_dicts", "same_name", "save_version",
           "system_template", "user_tz", "valid_until", "version", "version_dict"]  # fmt: skip
