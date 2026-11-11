"""The `kp:extract` job (spec 6.7 steps 1–3): the ТЗ → parts through KP_EXTRACT → prices by code
(the model only picks a candidate) → version 1 with code's totals → one action `create_kp` with
«Отменить». Run by `python -m assistant.kp`; tests call `run_extract` directly.

No transaction stays open across a model call. Each part read is saved in `documents.draft`, so a
retry (provider down: the queue's backoff) goes on from the next part, and `documents.progress`
says «Обработал 120 из 240». The first part starts the КП: if the budget refuses it, the КП fails
with «продолжу завтра»; later parts and the price pick run with `continuing=True` (never cut off,
R-18). After the last retry a КП with some parts read is still made, marked `partial`. A КП put
in the trash while it is read is still finished, so its «Отменить» brings back a whole one.
"""

import logging
import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from assistant.actions import record
from assistant.ai import AIConsentRequired, AIError, BudgetExceeded
from assistant.db import queue
from assistant.db.models import Item, Job
from assistant.db.models_actions import ActionKind, Initiator
from assistant.db.models_kp import DocStatus, Document
from assistant.kp import extract, prices, profile, service, vat
from assistant.kp.calc import format_money
from assistant.logs import error_text
from assistant.pages import lock_user

log = logging.getLogger(__name__)

TEXT_BUDGET = "На сегодня достаточно — продолжу завтра. Сохранение, напоминания и поиск работают."
TEXT_CONSENT = "Чтобы сделать КП, нужно согласие на работу помощника."
TEXT_EMPTY = "Не нашёл в файле позиций для КП. Пришлите ТЗ ещё раз или добавьте позиции вручную."
TEXT_FAILED = "Не получилось прочитать ТЗ. Попробуйте ещё раз чуть позже."


def _now() -> datetime:
    return datetime.now(UTC)


async def enqueue(session: AsyncSession, doc: Document) -> None:
    await queue.enqueue(session, service.JOB_EXTRACT,
                        {"document_id": doc.id, "user_id": doc.user_id},
                        idempotency_key=f"document:{doc.id}:kp_extract")  # fmt: skip


def progress_text(done: int, total: int) -> str:
    return f"Обработал {done} из {total}" if total else "Читаю ТЗ…"


async def _fail(maker: async_sessionmaker[AsyncSession], doc_id: int, code: str,
                text: str) -> None:  # fmt: skip
    async with maker() as s:
        doc = await s.get(Document, doc_id, with_for_update=True)
        if doc is not None and doc.status == DocStatus.EXTRACTING:
            doc.status, doc.error = DocStatus.FAILED, code
            doc.progress = {**(doc.progress or {}), "state": "failed", "message": text}
            doc.version += 1
        await s.commit()


async def _sources(s: AsyncSession, doc: Document) -> str:
    rows = list(await s.scalars(select(Item).where(Item.id.in_(doc.source_item_ids or []))))
    rows.sort(key=lambda i: (doc.source_item_ids or []).index(i.id))
    return "\n\n".join(i.text or i.raw_text or "" for i in rows if (i.text or i.raw_text)).strip()


async def run_extract(maker: async_sessionmaker[AsyncSession], router: Any, settings: Any,
                      payload: dict[str, Any], job_id: int | None = None) -> str:  # fmt: skip
    """Returns the outcome (`done`, `failed:<code>`, `skipped`). Raises to retry."""
    doc_id = int(payload["document_id"])
    async with maker() as s:
        doc = await s.get(Document, doc_id)
        if doc is None or doc.status != DocStatus.EXTRACTING:
            return "skipped"
        user_id, wishes = doc.user_id, doc.request_text
        text = await _sources(s, doc)
        parts_done = list((doc.draft or {}).get("parts") or [])
    if not text:
        await _fail(maker, doc_id, "kp_source_empty", TEXT_EMPTY)
        return "failed:kp_source_empty"
    chunks = extract.split(text, single_rows=settings.kp_single_pass_positions,
                           single_chars=settings.kp_single_pass_chars,
                           chunk_rows=settings.kp_chunk_positions)  # fmt: skip
    total_rows = sum(c.rows for c in chunks)
    async with maker() as s:
        doc = await s.get(Document, doc_id, with_for_update=True)
        assert doc is not None
        doc.progress = {**(doc.progress or {}), "state": "reading", "total": total_rows,
                        "parts_total": len(chunks), "parts_done": len(parts_done),
                        "done": sum(p.get("rows", 0) for p in parts_done),
                        "message": progress_text(sum(p.get("rows", 0) for p in parts_done),
                                                 total_rows)}  # fmt: skip
        await s.commit()

    if router is None:
        await _fail(maker, doc_id, "kp_consent", TEXT_CONSENT)
        return "failed:kp_consent"
    try:
        for chunk in chunks[len(parts_done):]:
            reply, _cost = await extract.read_part(router, user_id, chunk, len(chunks), wishes,
                                                   continuing=chunk.n > 0)  # fmt: skip
            start = sum(len(p.get("lines") or []) for p in parts_done)
            part = {"n": chunk.n, "rows": chunk.rows,
                    "lines": extract.check_lines(chunk, reply, start),
                    "client": extract.check_client(text, reply) if chunk.n == 0 else {},
                    "terms": extract.check_terms(chunk.text, wishes, reply)}  # fmt: skip
            parts_done.append(part)
            done = sum(p.get("rows", 0) for p in parts_done)
            async with maker() as s:
                doc = await s.get(Document, doc_id, with_for_update=True)
                if doc is None or doc.status != DocStatus.EXTRACTING:
                    await s.commit()
                    return "skipped"
                doc.draft = {**(doc.draft or {}), "parts": parts_done}
                doc.progress = {**(doc.progress or {}), "parts_done": len(parts_done),
                                "done": done, "message": progress_text(done, total_rows)}
                await s.commit()
    except BudgetExceeded:
        if not parts_done:
            await _fail(maker, doc_id, "kp_budget", TEXT_BUDGET)
            return "failed:kp_budget"
        raise  # a started КП is never cut off: should not happen (continuing), retry
    except AIConsentRequired:
        await _fail(maker, doc_id, "kp_consent", TEXT_CONSENT)
        return "failed:kp_consent"
    except AIError as exc:
        if parts_done and await _last_try(maker, job_id):
            log.warning("kp %s: finishing with %s of %s parts (%s)", doc_id, len(parts_done),
                        len(chunks), error_text(exc))  # fmt: skip
            return await _finish(maker, router, settings, doc_id, parts_done, partial=True)
        if await _last_try(maker, job_id):
            await _fail(maker, doc_id, "kp_unavailable", TEXT_FAILED)
            return "failed:kp_unavailable"
        raise
    return await _finish(maker, router, settings, doc_id, parts_done, partial=False)


async def _last_try(maker: async_sessionmaker[AsyncSession], job_id: int | None) -> bool:
    if job_id is None:
        return True
    async with maker() as s:
        job = await s.get(Job, job_id)
        return job is None or job.attempts >= job.max_attempts


async def _finish(maker: async_sessionmaker[AsyncSession], router: Any, settings: Any,
                  doc_id: int, parts: list[dict[str, Any]], *, partial: bool) -> str:  # fmt: skip
    lines = [ln for p in parts for ln in p.get("lines") or []][:settings.kp_max_positions]
    if not lines:
        await _fail(maker, doc_id, "kp_no_positions", TEXT_EMPTY)
        return "failed:kp_no_positions"
    for i, ln in enumerate(lines, start=1):
        ln["id"] = f"i{i}"
    client = next((p["client"] for p in parts if p.get("client")), {})
    terms: dict[str, Any] = {}
    for p in parts:
        for k, v in (p.get("terms") or {}).items():
            terms.setdefault(k, v)
    # prices: code first (price list, then past КП), candidates for the model to pick from
    ask: dict[str, list[prices.Candidate]] = {}
    async with maker() as s:
        doc = await s.get(Document, doc_id)
        if doc is None or doc.status != DocStatus.EXTRACTING:
            return "skipped"
        user_id = doc.user_id
        key = prices.client_key(client)
        for ln in lines:
            cands = await prices.from_price_list(s, user_id, ln["name"], ln.get("unit"),
                                                 settings.kp_match_candidates)  # fmt: skip
            exact = next((c for c in cands if c.exact), None)
            if exact is None:
                hist = await prices.from_history(s, user_id, ln["name"], ln.get("unit"), key)
                if hist is not None:
                    exact = hist
            if exact is not None:
                _take(ln, exact, review=False)
            elif cands:
                ask[ln["id"]] = cands
        await s.commit()
    if ask and router is not None:
        want = [ln for ln in lines if ln["id"] in ask]
        for i in range(0, len(want), 40):
            batch = want[i:i + 40]
            try:
                picked, _ = await extract.pick(router, user_id, batch,
                                               {ln["id"]: ask[ln["id"]] for ln in batch})
            except AIError as exc:  # no pick: these lines ask the person for a price
                log.info("kp %s: price pick unavailable: %s", doc_id, error_text(exc))
                break
            for ln in batch:
                if ln["id"] in picked:
                    _take(ln, picked[ln["id"]], review=True)
    now = _now()
    async with maker() as s:
        await lock_user(s, user_id)
        doc = await s.get(Document, doc_id, with_for_update=True)
        if doc is None or doc.status != DocStatus.EXTRACTING:
            await s.commit()
            return "skipped"
        tz = await service.user_tz(s, user_id)
        today = now.astimezone(tz).date()
        prof = await profile.get(s, user_id)
        defaults = dict(prof.default_terms or {}) if prof else {}
        seq_no, number = await service.next_number(s, user_id, today.year,
                                                   settings.kp_number_prefix)  # fmt: skip
        outgoing = profile.take_outgoing(prof, today, seq_no)  # «Исх. № 2026-118-1»
        doc.year, doc.seq_no, doc.number = today.year, seq_no, number
        data = {
            "number": number, "date": today.isoformat(), "currency": "KZT",
            "outgoing": {"number": outgoing, "date": today.isoformat()}, "subject": None,
            "seller_ref": f"company_profile:{prof.public_id}" if prof else None,
            "client": client,
            "vat": {"mode": vat.default_mode(prof.vat_payer if prof else None,
                                             settings.kp_vat_default_mode)},
            "items": lines, "discount_total_pct": "0",
            "terms": {"payment": terms.get("payment") or defaults.get("payment"),
                      "delivery": terms.get("delivery") or defaults.get("delivery"),
                      "warranty": defaults.get("warranty"),
                      "validity_days": defaults.get("validity_days") or settings.kp_validity_days,
                      "conditions": list(defaults.get("conditions") or []) or None},
            "text_blocks": {"intro": None, "outro": None},
        }  # fmt: skip
        saved = await service.save_version(s, doc, data, author="initial", now=now,
                                           settings=settings)  # fmt: skip
        item = await s.get(Item, doc.item_id)
        assert item is not None
        doc.progress = {**(doc.progress or {}), "state": "done", "partial": partial,
                        "message": (f"Прочитал {sum(p.get('rows', 0) for p in parts)} из "
                                    f"{doc.progress.get('total', 0)} — остальное добавьте вручную"
                                    if partial else None)}  # fmt: skip
        who = client.get("name")
        missing = saved.totals.missing
        text = (f"Сделал КП{' ' + who if who else ''}: {len(lines)} поз., итого "
                f"{format_money(saved.totals.total)}"
                + (f", без цены — {missing}" if missing else ""))  # fmt: skip
        await record(
            s, user_id=user_id, kind=ActionKind.CREATE_KP, initiated_by=Initiator.AGENT,
            summary={"ru": text, "kk": None},
            changes=[{"item_id": str(item.public_id), "document_id": str(doc.public_id),
                      "title": doc.title, "kind": "create", "page_id": None, "text": text}],
            inverse=[{"op": "delete_entity_soft", "entity": "documents",
                      "id": str(doc.public_id), "item": str(item.public_id)}],
            now=now, source_item_ids=[item.id, *(doc.source_item_ids or [])],
            client_id=uuid.uuid5(doc.public_id, "create_kp"),
        )  # fmt: skip
        await s.commit()
    return "done"


def _take(line: dict[str, Any], c: prices.Candidate, *, review: bool) -> None:
    line["unit_price"] = f"{c.price:.2f}"
    line["price_source"] = c.ref
    line["price_review"] = review
    line["matched_name"] = c.name if review and not service.same_name(c.name, line["name"]) \
        else None
    if not line.get("unit") and c.unit:
        line["unit"] = c.unit


__all__ = ["enqueue", "progress_text", "run_extract"]
