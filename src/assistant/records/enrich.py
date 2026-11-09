"""Enrichment job `ai:enrich` (spec 5.2, 5.6, 6.2): record text -> title, summary, envelope.

    ingest done -> enqueue_enrich -> run_enrich -> Router (consent, budget, masking, fallback)
                                  `-> AIBatchRequest when nobody waits (records/batching.py)

Enrichment never holds a record back: `status` stays what ingest decided, so the person has the
record and its text at once and in "Без ИИ" mode; `enrich_state` tells how far this step got.

The model is not trusted with anything code can check. Every number and date it returns must be
found in the record's text or it is dropped; amounts become Decimal here; nothing proposed is
executed; a title or summary with an unfound number is thrown away. The person's own title and
any «Верно» or «Исправить» are never overwritten: what the person entered needs no source. No
transaction is open during a provider call.
"""

import copy
import hashlib
import logging
import re
from datetime import UTC, datetime, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, field_validator
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from assistant.ai import (
    AIConsentRequired,
    AIUnavailable,
    BatchMode,
    BudgetExceeded,
    LLMTask,
    Router,
    StrongReason,
    StrongRequest,
    TaskInputs,
    UntrustedPart,
    next_month_start,
    period_starts,
)
from assistant.db import queue
from assistant.db.models import Item, Job
from assistant.db.models_ai import AIBatchRequest
from assistant.db.models_v2 import EnrichState, HiddenReason, RecordKind, RecordSource, RecordStatus
from assistant.memory import enqueue_embed
from assistant.pages import place_item
from assistant.records import store

log = logging.getLogger(__name__)

JOB_ENRICH = "ai:enrich"
ENVELOPE_VERSION = 1
PROMPT_VERSION = "enrich.v1"
SYSTEM_PROMPT = (Path(__file__).parent / "prompts" / "enrich.v1.md").read_text(encoding="utf-8")
INSTRUCTION = "Return the envelope of this record."

MIN_LETTERS = 3  # "да", "ok": nothing to enrich
SUMMARY_MIN_CHARS = 80  # shorter text is its own summary
# Head and tail of long documents: well below Haiku's 100,000-token price step.
MAX_INPUT_CHARS = 30_000
HEAD_CHARS = 24_000
ESCALATE_BELOW_REVIEW = 0.7  # storage.keep_while_unsure: "the rest" gets «Проверьте» below this
GIVE_UP_AFTER = timedelta(hours=72)
RETRY_AFTER_OUTAGE = timedelta(hours=1)

# Nobody is watching these arrive one by one.
BULK_SOURCES = frozenset({RecordSource.IMPORT_TELEGRAM, RecordSource.BOT_FORWARD,
                          RecordSource.SYSTEM})  # fmt: skip
BACKLOG_AFTER = timedelta(minutes=10)  # older than this when the job runs: not a live capture
# Spec 5.6 rule 6: phone, amount, ИИН/БИН, IBAN, document number: always, from photo and voice.
RECOGNISED_KINDS = frozenset({RecordKind.IMAGE, RecordKind.SCREENSHOT, RecordKind.VOICE})


# --- the envelope (strict schema: no numeric/length keywords, limits are applied after parsing)


class Entities(BaseModel):
    people: list[str]
    orgs: list[str]
    phones: list[str]
    amounts: list[str]
    dates: list[str]
    places: list[str]


class ProposedReminder(BaseModel):
    text: str
    when_text: str


class ProposedTask(BaseModel):
    title: str


class Proposed(BaseModel):
    reminders: list[ProposedReminder]
    tasks: list[ProposedTask]
    kp: bool


class VerifyField(BaseModel):
    kind: str
    value: str


class Envelope(BaseModel):
    type: Literal["note", "task", "reminder_request", "shopping_list", "document", "receipt",
                  "contract", "id_document", "contact", "kp_request", "price_list", "idea",
                  "event", "other"]  # fmt: skip
    title: str
    summary: str
    lang: Literal["ru", "kk", "en", "other"]
    entities: Entities
    proposed: Proposed
    topics: list[str]
    critical_numbers: list[str]
    sensitivity: list[Literal["id_number", "health", "finance", "other"]]
    verify_fields: list[VerifyField]
    confidence: float

    @field_validator("confidence")
    @classmethod
    def _clamp(cls, v: float) -> float:
        return max(0.0, min(1.0, v))

    @field_validator("title")
    @classmethod
    def _title(cls, v: str) -> str:
        return v.strip()[:200]

    @field_validator("summary")
    @classmethod
    def _summary(cls, v: str) -> str:
        return v.strip()[:1000]


# --- input


def text_fingerprint(text: str | None) -> str:
    return hashlib.sha256((text or "").encode()).hexdigest()


def clip_input(text: str) -> tuple[str, bool]:
    if len(text) <= MAX_INPUT_CHARS:
        return text, False
    tail = MAX_INPUT_CHARS - HEAD_CHARS
    return f"{text[:HEAD_CHARS]}\n[…]\n{text[-tail:]}", True


def build_inputs(item: Item) -> TaskInputs:
    """Same record -> same prompt, so a batch answer can be unmasked later (router.finish_batch).
    Volatile values (today, ids) stay out of the system prompt: it is the cached prefix."""
    meta = item.source_meta or {}
    text, _ = clip_input(item.text or "")
    parts = [UntrustedPart("record", text)]
    if meta.get("caption"):
        parts.append(UntrustedPart("note from the person", str(meta["caption"])))
    if meta.get("file_name"):
        parts.append(UntrustedPart("file name", str(meta["file_name"])))
    return TaskInputs(system=SYSTEM_PROMPT, instruction=INSTRUCTION,
                      context=[f"Record kind: {item.kind}"], untrusted=parts,
                      prompt_version=PROMPT_VERSION)  # fmt: skip


def enrichable(item: Item) -> bool:
    if item.deleted_at is not None or item.hidden_reason is not None:
        return False
    if (item.source_meta or {}).get("statement_row"):
        return False  # a bank statement row (week 13): its fields came from the bank's table
    return sum(c.isalpha() for c in item.text or "") >= MIN_LETTERS


# --- checks: nothing the code can verify is taken on the model's word

_NUM = re.compile(r"\d(?:[\d\s  .,\-()]*\d)?")
_SCALED = re.compile(r"(\d+(?:[.,]\d+)?)\s*(тыс|млн|млрд)", re.IGNORECASE)
_SCALE = {"тыс": 1_000, "млн": 1_000_000, "млрд": 1_000_000_000}
_CURRENCY = {"₸": "KZT", "тг": "KZT", "тенге": "KZT", "kzt": "KZT", "сом": "KGS", "kgs": "KGS",
             "руб": "RUB", "₽": "RUB", "usd": "USD", "$": "USD", "eur": "EUR",
             "€": "EUR"}  # fmt: skip


def _digits(s: str) -> str:
    return re.sub(r"\D", "", s)


def source_numbers(text: str) -> set[str]:
    """Every way a number in the text can be cited: "125 000" -> 125000, 125, 000."""
    found: set[str] = set()
    for m in _NUM.finditer(text):
        found.add(_digits(m.group(0)))
        found.update(_digits(tok) for tok in re.split(r"[\s  ]+", m.group(0)))
        if len(_digits(m.group(0))) >= 10:  # phones: +7 / 8 prefix
            found.add(_digits(m.group(0))[-10:])
    for m in _SCALED.finditer(text):
        try:
            found.add(str(int(Decimal(m.group(1).replace(",", ".")) * _SCALE[m.group(2).lower()])))
        except InvalidOperation:
            continue
    found.discard("")
    return found


def numbers_found(value: str, known: set[str]) -> bool:
    """All numbers in `value` occur in the source."""
    for m in _NUM.finditer(value):
        d = _digits(m.group(0))
        if d in known or (len(d) >= 10 and d[-10:] in known):
            continue
        tokens = [_digits(t) for t in re.split(r"[\s  .,\-()]+", m.group(0))]
        if not all(t in known for t in tokens if t):
            return False
    return True


def present(value: str, source_lower: str, known: set[str]) -> bool:
    """A cited detail: its numbers are in the text; without numbers, its words are."""
    value = value.strip()
    if not value or "⟨" in value:
        return False
    if _NUM.search(value):
        return numbers_found(value, known)
    return value.lower() in source_lower


def parse_amount(text: str) -> dict | None:
    """Amount as a string -> Decimal by code: {"text", "value", "currency"}."""
    m = _NUM.search(text)
    if m is None:
        return None
    raw = re.sub(r"[\s  ]", "", m.group(0)).replace("-", "")
    if re.search(r"[.,]\d{1,2}$", raw):
        whole, frac = re.split(r"[.,](?=\d{1,2}$)", raw)
        raw = f"{_digits(whole)}.{frac}"
    else:
        raw = _digits(raw)
    try:
        value = Decimal(raw)
    except InvalidOperation:
        return None
    lower = text.lower()
    currency = next((code for mark, code in _CURRENCY.items() if mark in lower), None)
    return {"text": text.strip(), "value": str(value), "currency": currency}


def checked_envelope(env: Envelope, source: str) -> tuple[dict, dict]:
    """(envelope to store, what was thrown away)."""
    known = source_numbers(source)
    lower = source.lower()
    rejected: dict[str, list[str]] = {}

    def keep(name: str, values: list[str]) -> list[str]:
        ok = [v for v in values if present(v, lower, known)]
        bad = [v for v in values if v not in ok]
        if bad:
            rejected[name] = bad[:20]
        return ok[:50]

    data = env.model_dump(mode="json")
    ent = data["entities"]
    for name in ("phones", "dates", "places", "people", "orgs"):
        ent[name] = keep(name, ent[name])
    amounts = keep("amounts", ent["amounts"])
    ent["amounts"] = [a for a in (parse_amount(v) for v in amounts) if a]
    data["critical_numbers"] = keep("critical_numbers", data["critical_numbers"])
    data["verify_fields"] = [v for v in data["verify_fields"]
                             if present(v["value"], lower, known)][:20]  # fmt: skip
    data["topics"] = [t.strip() for t in data["topics"] if t.strip()][:5]
    # Reminders and tasks are suggestions in the person's words; their dates stay text.
    prop = data["proposed"]
    prop["reminders"] = [
        r for r in prop["reminders"] if numbers_found(f"{r['when_text']} {r['text']}", known)
    ][:10]
    prop["tasks"] = [t for t in prop["tasks"] if numbers_found(t["title"], known)][:10]
    for field in ("title", "summary"):
        if data[field] and ("⟨" in data[field] or not numbers_found(data[field], known)):
            rejected[field] = [data[field]]
            data[field] = ""
    return data, rejected


# --- applying


def _mark(value: object) -> str:
    """What makes two spellings the same value: the digits, or the words if it has none."""
    text = str(value or "")
    return _digits(text) or " ".join(text.lower().split())


def _review_from_envelope(item: Item, data: dict) -> dict[str, dict]:
    """«Проверьте» the model pointed to, once its value is confirmed to be in the text. Nothing the
    person settled comes back: not a value they confirmed, not one they replaced, whatever kind the
    model calls it."""
    if not _recognised(item):
        return {}
    fields = dict(item.review_fields or {})
    seen = {(v.get("kind"), _digits(str(v.get("value") or ""))) for v in fields.values()}
    settled = {_mark(v.get("value")) for v in fields.values() if v.get("state") == "verified"}
    settled.update(_mark(old) for v in fields.values() for old in v.get("was") or [])

    def add(kind: str, value: str) -> None:
        if _mark(value) in settled or ((kind, _digits(value)) in seen and _digits(value)):
            return
        seen.add((kind, _digits(value)))
        n = 1 + sum(1 for k in fields if k.startswith(f"{kind}_"))
        fields[f"{kind}_{n}"] = {"kind": kind, "value": value, "state": "unverified"}

    ent = data["entities"]
    for phone in ent["phones"]:
        add("phone", phone)
    for amount in ent["amounts"]:
        add("amount", amount["text"])
    for number in data["critical_numbers"]:
        add("doc_number", number)
    unsure = data["confidence"] < ESCALATE_BELOW_REVIEW or (
        item.confidence is not None and item.confidence < ESCALATE_BELOW_REVIEW)
    if unsure:
        for v in data["verify_fields"]:
            add(re.sub(r"\W", "", v["kind"].lower())[:20] or "other", v["value"])
    return fields


def _recognised(item: Item) -> bool:
    if item.kind in RECOGNISED_KINDS:
        return True
    pdf = (item.source_meta or {}).get("pdf") or {}
    return bool(pdf.get("ocr_pages"))


# --- «Исправить»: the person's value wins, and needs no source


_FIELD_LIST = {"phone": "phones", "date": "dates"}
_SPACE = r"[\s\u00a0\u202f]"


def _with_correction(text: str, old: str, new: str) -> str:
    """`text` with the first `old` replaced, however it is spaced. Only a whole value: "500 ₸" is
    not the tail of "1 500 ₸". Not found: `text` as it was."""
    compact = re.sub(r"\s", "", old)
    if not compact:
        return text
    before = rf"(?<!\d{_SPACE})(?<!\d[.,])" if compact[0].isdigit() else ""
    after = rf"(?!{_SPACE}?\d)(?![.,]\d)" if compact[-1].isdigit() else ""
    body = f"{_SPACE}*".join(re.escape(c) for c in compact)
    return re.sub(rf"(?<!\w){before}{body}{after}(?!\w)", lambda _: new, text, count=1)


def _correct_amount(old: dict, new: str) -> dict:
    parsed = parse_amount(new) or {"text": new, "value": None, "currency": None}
    return {**parsed, "currency": parsed["currency"] or old.get("currency")}


def carry_corrections(data: dict, fields: dict) -> None:
    """Put the person's values into an envelope, in place of the ones they replaced. Safe to repeat.
    Runs on every new envelope too: the model only sees the record's text."""
    ent = data.get("entities")
    if not isinstance(ent, dict):
        return
    for field in (fields or {}).values():
        gone = {_mark(old) for old in field.get("was") or []}
        if not gone:
            continue
        new, kind = str(field.get("value")), field.get("kind")

        def swap(values: list[str], new: str = new, gone: set[str] = gone) -> list[str]:
            return list(dict.fromkeys(new if _mark(v) in gone else v for v in values))

        for name in ("phones", "dates", "places", "people", "orgs"):
            ent[name] = swap(ent.get(name) or [])
        data["critical_numbers"] = swap(data.get("critical_numbers") or [])
        for v in data.get("verify_fields") or []:
            if _mark(v.get("value")) in gone:
                v["value"] = new
        amounts = [_correct_amount(a, new) if _mark(a.get("text")) in gone else a
                   for a in ent.get("amounts") or []]  # fmt: skip
        if kind == "amount" and not any(_mark(a.get("text")) == _mark(new) for a in amounts):
            amounts.append(_correct_amount({}, new))
        ent["amounts"] = amounts
        if kind == "amount":
            continue
        name = _FIELD_LIST.get(str(kind))
        target = ent[name] if name else data["critical_numbers"]
        if (name or kind in ("iban", "iin_bin", "doc_number")) and new not in target:
            target.append(new)


def apply_corrections(item: Item, corrections: dict[str, str]) -> bool:
    """«Исправить»: each review field takes the person's value and stops asking. The value also
    replaces the wrong one in the text and the title (search and answers read those) and in the
    envelope. It is never checked against the source. The caller has checked the keys and handles a
    changed text. True if a value changed."""
    fields = {key: dict(v) for key, v in (item.review_fields or {}).items()}
    changed = False
    for key, new in corrections.items():
        field = fields[key]
        old = str(field.get("value"))
        field["state"] = "verified"
        if new == old:
            continue
        changed = True
        field["value"] = new
        field["was"] = [*field.get("was", []), old]
        if item.text:
            item.text = _with_correction(item.text, old, new)
        if item.title and (item.source_meta or {}).get("title_source") != "user":
            item.title = _with_correction(item.title, old, new)[:500]
    item.review_fields = fields
    if changed and item.envelope:
        envelope = copy.deepcopy(item.envelope)
        carry_corrections(envelope, fields)
        item.envelope = envelope
    return changed


def apply_envelope(item: Item, env: Envelope, *, provider: str, model: str, escalated: bool,
                   now: datetime) -> None:  # fmt: skip
    fields = item.review_fields or {}
    entered = [str(v.get("value")) for v in fields.values() if v.get("was")]
    data, rejected = checked_envelope(env, "\n".join([item.text or "", *entered]))
    carry_corrections(data, fields)
    meta = dict(item.source_meta or {})
    ai_fields = [f for f in (item.ai_fields or []) if f not in ("title", "summary")]
    if data["title"] and meta.get("title_source") != "user":
        item.title = data["title"][:500]
        meta["title_source"] = "ai"
        ai_fields.append("title")
    elif "title" in (item.ai_fields or []) and meta.get("title_source") == "ai":
        ai_fields.append("title")
    summary = data["summary"] if len(item.text or "") >= SUMMARY_MIN_CHARS else ""
    item.summary = summary or None
    if summary:
        ai_fields.append("summary")
    item.ai_fields = ai_fields
    item.source_meta = meta
    if item.text_lang is None:
        item.text_lang = data["lang"]
    item.review_fields = _review_from_envelope(item, data) or item.review_fields
    if item.status == RecordStatus.READY and any(
        v.get("state") != "verified" for v in (item.review_fields or {}).values()
    ):
        item.status = RecordStatus.NEEDS_REVIEW
    _, clipped = clip_input(item.text or "")
    item.envelope = {**data, "text_sha": text_fingerprint(item.text), "input_clipped": clipped,
                     "rejected": rejected, "provider": provider, "model": model,
                     "escalated": escalated}  # fmt: skip
    item.envelope_version = ENVELOPE_VERSION
    item.enrich_state = EnrichState.DONE
    item.enriched_at = now


# --- queueing


async def enqueue_enrich(session: AsyncSession, item: Item, *, suffix: str = "",
                         live: bool = False,
                         run_after: datetime | None = None) -> Job | None:  # fmt: skip
    """Inside the caller's transaction. Sets enrich_state; adds a job unless consent is missing."""
    if not enrichable(item):
        if item.hidden_reason is None and item.deleted_at is None:
            item.enrich_state = EnrichState.SKIPPED
        return None
    if not await store.ai_consent_covers(session, item.user_id, None):
        item.enrich_state = EnrichState.NO_CONSENT
        return None
    item.enrich_state = EnrichState.PENDING
    key = f"item:{item.id}:enrich:v{ENVELOPE_VERSION}:{text_fingerprint(item.text)[:16]}{suffix}"
    return await queue.enqueue(session, JOB_ENRICH, {"item_id": item.id, "live": live},
                               idempotency_key=key, run_after=run_after)  # fmt: skip


async def requeue_after_consent(session: AsyncSession, user_id: int, grant_marker: str) -> int:
    rows = list(await session.scalars(
        select(Item).where(Item.user_id == user_id, Item.enrich_state == EnrichState.NO_CONSENT,
                           Item.deleted_at.is_(None)).with_for_update()
    ))  # fmt: skip
    for item in rows:
        await enqueue_enrich(session, item, suffix=f":consent:{grant_marker}")
    return len(rows)


async def promote_if_waiting(session: AsyncSession, item: Item) -> bool:
    """The person opened a record still waiting in a batch: do it now. A batch answer that
    arrives later is charged but ignored (state superseded)."""
    if item.enrich_state != EnrichState.QUEUED_BATCH:
        return False
    await session.execute(
        update(AIBatchRequest)
        .where(AIBatchRequest.item_id == item.id,
               AIBatchRequest.state.in_(("queued", "submitted")))
        .values(state="superseded", done_at=store.now_utc())
    )  # fmt: skip
    await enqueue_enrich(session, item, suffix=":live", live=True)
    return True


def is_bulk(item: Item, now: datetime) -> bool:
    if item.source in BULK_SOURCES:
        return True
    return now - (item.created_at or now) > BACKLOG_AFTER


def should_batch(mode: BatchMode, item: Item, now: datetime) -> bool:
    if mode is BatchMode.ALWAYS:
        return True
    return mode is BatchMode.BULK and is_bulk(item, now)


def next_budget_time(reason: str, now: datetime, tz: str) -> datetime | None:
    """When a user wallet has room again. None: a one-off wallet, it does not refill."""
    day, month = period_starts(now, tz)
    if reason == "daily_soft":
        return day + timedelta(days=1)
    if reason == "monthly_hard":
        return next_month_start(month, tz)
    return None


async def defer_for_budget(session: AsyncSession, item: Item, reason: str, now: datetime,
                           tz: str) -> None:  # fmt: skip
    """«Продолжу завтра»: the record stays as it is; the job comes back with the new period."""
    when = next_budget_time(reason, now, tz)
    if when is None:
        item.enrich_state = EnrichState.SKIPPED
        return
    await enqueue_enrich(session, item, suffix=f":budget:{when:%Y%m%d}", run_after=when)
    if item.enrich_state == EnrichState.PENDING:
        item.enrich_state = EnrichState.DEFERRED_BUDGET


# --- the job


async def run_enrich(maker: async_sessionmaker[AsyncSession], router: Router, item_id: int, *,
                     live: bool = False, job_id: int | None = None) -> str | None:  # fmt: skip
    """Returns the resulting enrich_state (None: nothing to do). Raises AIUnavailable when every
    provider failed, so the queue retries with backoff."""
    now = datetime.now(UTC)
    # 1. read, and park the record if nobody is waiting for it
    async with maker() as s:
        item = await s.get(Item, item_id, with_for_update=True)
        if item is None or not enrichable(item):
            await s.commit()
            return None
        sha = text_fingerprint(item.text)
        if (item.envelope or {}).get("text_sha") == sha and item.enrich_state == EnrichState.DONE:
            await s.commit()
            return EnrichState.DONE
        user_id, inputs = item.user_id, build_inputs(item)
        # Imported records draw on the one-off import wallet (spec 6.10, IMPORT_SUMMARIZE, $1).
        task = (LLMTask.IMPORT_SUMMARIZE if item.source == RecordSource.IMPORT_TELEGRAM
                else LLMTask.ENRICH)  # fmt: skip
        mode = router.routes.route(LLMTask.ENRICH).batch
        if not live and router.batching_available(LLMTask.ENRICH) and should_batch(mode, item, now):
            await _park(s, item)
            await s.commit()
            return EnrichState.QUEUED_BATCH
        await s.commit()

    # 2. provider calls, no transaction open
    try:
        result = await router.run(task, Envelope, inputs, user_id=user_id, job_id=job_id)
    except AIConsentRequired:
        return await _set_state(maker, item_id, EnrichState.NO_CONSENT)
    except BudgetExceeded as exc:
        return await _budget_stop(maker, router, item_id, exc.reason, now)
    assert result.data is not None
    env, provider, model, escalated = result.data, result.provider, result.model, False

    ask = StrongRequest(StrongReason.LOW_CONFIDENCE, confidence=env.confidence)
    if await router.escalation_denial(task, ask, inputs, user_id) is None:
        try:
            better = await router.run(task, Envelope, inputs, user_id=user_id,
                                      strong=ask, job_id=job_id)  # fmt: skip
        except (AIUnavailable, BudgetExceeded, AIConsentRequired):
            log.info("enrich item %s: strong attempt failed, keeping the light one", item_id)
        else:
            assert better.data is not None
            env, provider, model = better.data, better.provider, better.model
            escalated = not better.escalation_blocked

    # 3. store, unless the record changed meanwhile
    return await store_envelope(maker, item_id, sha, env, provider=provider, model=model,
                                escalated=escalated)  # fmt: skip


async def _park(session: AsyncSession, item: Item) -> None:
    exists = await session.scalar(
        select(AIBatchRequest.id).where(AIBatchRequest.item_id == item.id,
                                        AIBatchRequest.task == LLMTask.ENRICH.value,
                                        AIBatchRequest.state.in_(("queued", "submitted")))
    )  # fmt: skip
    if exists is None:
        session.add(AIBatchRequest(task=LLMTask.ENRICH.value, item_id=item.id,
                                   user_id=item.user_id))  # fmt: skip
    item.enrich_state = EnrichState.QUEUED_BATCH


async def store_envelope(maker: async_sessionmaker[AsyncSession], item_id: int, sha: str,
                         env: Envelope, *, provider: str, model: str,
                         escalated: bool) -> str | None:  # fmt: skip
    async with maker() as s:
        item = await s.get(Item, item_id, with_for_update=True)
        if item is None or item.deleted_at is not None or text_fingerprint(item.text) != sha:
            await s.commit()  # edited or deleted meanwhile: the edit queued its own job
            return None
        if item.hidden_reason == HiddenReason.VOICE_FRAGMENT:
            await s.commit()
            return None
        apply_envelope(item, env, provider=provider, model=model, escalated=escalated,
                       now=store.now_utc())  # fmt: skip
        state = str(item.enrich_state)
        await s.flush()
        await place_item(s, item)  # rules that read the envelope can match now
        await enqueue_embed(s, item)  # chunks are embedded with the title, which may be new
        from assistant.stacks import schedule_rebuild  # stacks -> actions -> records

        await schedule_rebuild(s, item.user_id)  # its topics may make or grow a stack
        await s.commit()
    return state


async def _set_state(maker: async_sessionmaker[AsyncSession], item_id: int, state: str) -> str:
    async with maker() as s:
        item = await s.get(Item, item_id, with_for_update=True)
        if item is not None:
            item.enrich_state = state
        await s.commit()
    return state


async def _budget_stop(maker: async_sessionmaker[AsyncSession], router: Router, item_id: int,
                       reason: str, now: datetime) -> str | None:  # fmt: skip
    async with maker() as s:
        item = await s.get(Item, item_id, with_for_update=True)
        state = None
        if item is not None:
            await defer_for_budget(s, item, reason, now, router.s.budget_tz)
            state = str(item.enrich_state)
        await s.commit()
    return state


async def give_up(maker: async_sessionmaker[AsyncSession], item_id: int) -> None:
    """The queue gave up (provider outage longer than its backoff). Come back within 3 days;
    the record stays usable all along («Сохранил, разберу через несколько минут»)."""
    now = store.now_utc()
    async with maker() as s:
        item = await s.get(Item, item_id, with_for_update=True)
        if item is None:
            await s.commit()
            return
        if now - (item.created_at or now) < GIVE_UP_AFTER:
            when = now + RETRY_AFTER_OUTAGE
            await enqueue_enrich(s, item, suffix=f":retry:{when:%Y%m%d%H}", run_after=when)
        else:
            item.enrich_state = EnrichState.FAILED
        await s.commit()
