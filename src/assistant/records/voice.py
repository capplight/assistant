"""One recording, several fragments (spec 2.1, 6.1, F-02): the phone uploads each fragment of up
to 3 minutes as its own item, linked by `recording_id`; the person sees one record.

- Fragment 0 (its client_id is the recording id) is the record. Its id is what the phone keeps.
- Other fragments are hidden rows (`hidden_reason=voice_fragment`, `canonical_item_id` -> the
  record): they own their upload and job, and never reach lists, sync or search.
- Each fragment's transcript waits in its `source_meta.fragment_result`; `item.text` of the record
  is always the joined transcript, in fragment order, whatever order they arrive in. Partial text
  shows while the status stays `processing`.
- All in: status, «Проверьте» (per-fragment confidence, spec 6.1), duplicate check, enrichment,
  once, on the joined text. Fragment transcripts are then dropped from the hidden rows.
- A fragment that never came: `sweep_recording` finishes the record an hour later with what it has
  and an open «Проверьте»; if the fragment arrives after all, the record is rebuilt.
- What the person edited or confirmed is never overwritten. A late transcript then becomes a
  «Проверьте» field instead of changing their text.

All functions work inside the caller's transaction and do no network I/O.
"""

import uuid
from datetime import datetime, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.db import queue
from assistant.db.models import Item, Job
from assistant.db.models_v2 import HiddenReason, RecordStatus
from assistant.memory import enqueue_embed
from assistant.pages import place_item
from assistant.records import enrich, store
from assistant.records.textnorm import (
    content_hash,
    detect_lang,
    detect_review_fields,
    title_from_text,
)

JOB_SWEEP = "records:recording_sweep"
SWEEP_AFTER = timedelta(hours=1)
EXCERPT_CHARS = 200
UNFINISHED = (RecordStatus.PENDING, RecordStatus.PROCESSING, RecordStatus.NEEDS_CONSENT)


async def enqueue_sweep(session: AsyncSession, item: Item, now: datetime) -> Job:
    return await queue.enqueue(
        session, JOB_SWEEP,
        {"user_id": item.user_id, "recording_id": str(item.recording_id)},
        idempotency_key=f"recording:{item.recording_id}:sweep", run_after=now + SWEEP_AFTER,
    )  # fmt: skip


async def siblings(session: AsyncSession, user_id: int, recording_id: uuid.UUID) -> list[Item]:
    """All fragments, locked in one order (two workers finishing together cannot deadlock)."""
    return list(await session.scalars(
        select(Item).where(Item.user_id == user_id, Item.recording_id == recording_id)
        .order_by(Item.fragment_no, Item.id).with_for_update()
    ))  # fmt: skip


async def children(session: AsyncSession, item: Item) -> list[Item]:
    """The hidden fragments of this record (none for any other record)."""
    if item.recording_id is None:
        return []
    rows = await siblings(session, item.user_id, item.recording_id)
    return [r for r in rows if r.id != item.id]


def _result(item: Item) -> dict | None:
    return (item.source_meta or {}).get("fragment_result")


def _expected(rows: list[Item]) -> int:
    return max([int((r.source_meta or {}).get("fragments") or 1) for r in rows] + [len(rows)])


def _low(res: dict) -> bool:
    conf = res.get("confidence")
    return not res.get("text") or (conf is not None and conf < store.KEEP_BELOW_CONFIDENCE)


def _review(rows: list[Item], text: str | None, expected: int, old: dict) -> dict[str, dict]:
    fields = detect_review_fields(text)
    single = expected == 1
    for row in rows:
        res = _result(row)
        if res is None or not _low(res):
            continue
        key = "transcript" if single else f"transcript_{(row.fragment_no or 0) + 1}"
        excerpt = (res.get("text") or "")[:EXCERPT_CHARS] or None
        fields[key] = {"kind": "transcript", "value": None if single else excerpt,
                       "state": "unverified"}  # fmt: skip
    present = {r.fragment_no for r in rows}
    for n in range(expected):
        if n not in present:
            fields[f"missing_{n + 1}"] = {"kind": "transcript", "value": None,
                                          "state": "unverified"}  # fmt: skip
    # «Верно» survives a rebuild: same field and value, or the same key with no value.
    confirmed = {(v.get("kind"), v.get("value")) for v in old.values()
                 if v.get("state") == "verified"}  # fmt: skip
    for key, v in fields.items():
        if (v["kind"], v["value"]) in confirmed or old.get(key, {}).get("state") == "verified":
            v["state"] = "verified"
    return fields


async def assemble(session: AsyncSession, rows: list[Item], now: datetime) -> Item | None:
    """Rebuild the record from its fragments. `rows` from `siblings`. Returns the record."""
    if not rows:
        return None
    meta0 = rows[0].source_meta or {}
    sweep_seen = any((r.source_meta or {}).get("sweep_done") for r in rows)
    if rows[0].fragment_no != 0 and not sweep_seen:
        return None  # fragment 0, the record itself, has not arrived yet
    record = rows[0]
    if record.hidden_reason == HiddenReason.VOICE_FRAGMENT:  # promoted by the sweep
        record.hidden_reason = None
        record.canonical_item_id = None
    for row in rows[1:]:
        row.hidden_reason = HiddenReason.VOICE_FRAGMENT
        row.canonical_item_id = record.id
        row.text = None
        row.content_hash = None

    results = [(row, _result(row)) for row in rows]
    done = [(row, res) for row, res in results if res is not None]
    expected = _expected(rows)
    arrived_all = {r.fragment_no for r in rows} >= set(range(expected))
    all_done = len(done) == len(rows)
    final = all_done and (arrived_all or sweep_seen)

    text = "\n\n".join(res["text"] for _, res in done if res.get("text")) or None
    edited = bool(meta0.get("text_edited"))
    if not edited:
        record.text = text
        record.text_lang = next((res["lang"] for _, res in done if res.get("lang")),
                                None) or detect_lang(text)  # fmt: skip
        record.content_hash = content_hash(text)
        if meta0.get("title_source") in (None, "text"):
            record.title = title_from_text(text)
            if record.title:
                record.source_meta = {**(record.source_meta or {}), "title_source": "text"}
    if not done:
        return record
    if not final:
        if record.status not in (RecordStatus.NEEDS_CONSENT,):
            record.status = RecordStatus.PROCESSING
        return record

    confs = [res["confidence"] for _, res in done if res.get("confidence") is not None]
    record.confidence = min(confs) if confs else None
    record.processed_at = now
    old = record.review_fields or {}
    if edited:
        fields = dict(old)
        for row, res in done:
            late = f"late_fragment_{(row.fragment_no or 0) + 1}"
            if res.get("text") and not res.get("merged") and late not in fields:
                fields[late] = {"kind": "transcript", "value": res["text"][:EXCERPT_CHARS],
                                "state": "unverified"}  # fmt: skip
    else:
        fields = _review(rows, text, expected, old)
    record.review_fields = fields

    if all(res.get("state") == "failed" for _, res in done):
        record.status = RecordStatus.FAILED
        record.error = next((res.get("code") for _, res in done if res.get("code")), None)
    else:
        record.error = None
        open_review = any(v.get("state") != "verified" for v in fields.values())
        record.status = (RecordStatus.NEEDS_REVIEW if open_review or not record.text
                         else RecordStatus.READY)  # fmt: skip

    if (record.hidden_reason is None and record.content_hash
            and not (record.source_meta or {}).get("unmerged")):  # fmt: skip
        canonical = await store.find_canonical(session, record.user_id,
                                               content_hash=record.content_hash,
                                               exclude_id=record.id)  # fmt: skip
        if canonical is not None and canonical.id < record.id:
            store.merge_into(record, canonical, now)

    if arrived_all:  # the transcript now lives in one place only
        for row, res in done:
            spent = {**res, "text": None, "merged": True}
            row.source_meta = {**(row.source_meta or {}), "fragment_result": spent}
    if record.hidden_reason is None and record.status != RecordStatus.FAILED:
        await enrich.enqueue_enrich(session, record)
        await enqueue_embed(session, record)
    await session.flush()
    await place_item(session, record)
    return record


async def sweep_recording(session: AsyncSession, user_id: int, recording_id: uuid.UUID,
                          now: datetime) -> Item | None:  # fmt: skip
    """An hour passed: stop waiting for fragments that have not come."""
    rows = await siblings(session, user_id, recording_id)
    if not rows:
        return None
    rows[0].source_meta = {**(rows[0].source_meta or {}), "sweep_done": True}
    return await assemble(session, rows, now)
