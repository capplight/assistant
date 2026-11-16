"""«Сохранил как заметку, разберу позже» (Ф-69; vision-2026-11-review §5.4 step 4).

Without the network or the answering service the phrase is not lost: it is a note marked
`source_meta.parse_later = true` (by the line when the model is down: `service._save_note`; by
`POST /v1/items` for a phone line phrase that code could not read, `source_meta.from_line`).
A `chat:parse_later` job (chat worker, `python -m assistant.chat`) reads it once the model is
back: code rules first (`expenses.parse.rules_parse`, `tasks.parse.rules_parse`), then the model
(a light INTENT probe — while it fails the job waits with the queue's backoff — then the same
readers as the line). A spend becomes an expense on «Расходы», a to-do a task on «Дела»; the
note leaves the pages it was on. One agent action with «Отменить», `payload.parsed_later`, so
its notice says «Разобрал: перенёс в «Расходы»» and the record gets «изменил помощник».
Anything else stays a note («Разобрал: оставил заметкой»). A question or a reminder phrase stays
a note too: nothing is answered or set up behind the person's back.

`source_meta` after the job: `parse_later` removed, `parsed_later = {"to": "expense" | "tasks" |
"note", "text_ru", "action_id", "at"}` (ItemOut `parse_later` shows it).
"""

import logging
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from assistant.actions import engine, record
from assistant.ai import (
    AIConsentRequired,
    AIUnavailable,
    BudgetExceeded,
    LLMTask,
    StreamInterrupted,
    TaskInputs,
)
from assistant.chat.jobs import JOB_PARSE
from assistant.db import queue
from assistant.db.models import Item, JobStatus, User
from assistant.db.models_actions import ActionKind, Initiator
from assistant.db.models_pages import Screen, ScreenItem
from assistant.db.models_v2 import RecordSource
from assistant.expenses import parse as expenses_parse
from assistant.expenses import service as expenses
from assistant.pages import lock_user
from assistant.tasks import parse as tasks_parse
from assistant.tasks import service as tasks

log = logging.getLogger(__name__)


FIRST_TRY_S = 30
REQUEUE_DAYS = 7  # a note still waiting after the queue gave up is tried again this long
MAX_CHARS = 300
TEXT_WAITING = {"ru": "Сохранил как заметку, разберу позже",
                "kk": "Сохранил как заметку, разберу позже"}  # fmt: skip  # kk: R-39
TEXT_KEPT = "Разобрал: оставил заметкой"


class Retry(Exception):
    """The model is not back yet: the queue runs the job again later."""


def job_key(item_pk: int) -> str:
    return f"{JOB_PARSE}:{item_pk}"


async def mark(session: AsyncSession, item: Item, now: datetime) -> None:
    """The note waits for the model (call in the transaction that saved it)."""
    item.source_meta = {**(item.source_meta or {}), "parse_later": True}
    await queue.enqueue(session, JOB_PARSE, {"item_id": item.id},
                        run_after=now + timedelta(seconds=FIRST_TRY_S),
                        idempotency_key=job_key(item.id))  # fmt: skip


def status_of(meta: dict[str, Any] | None) -> dict[str, Any] | None:
    """ItemOut `parse_later`: «сохранил как заметку · разберу позже» or what the job did."""
    meta = meta or {}
    if meta.get("parse_later"):
        return {"state": "waiting", "text_ru": TEXT_WAITING["ru"], "text_kk": None,
                "to": None, "action_id": None}  # fmt: skip
    done = meta.get("parsed_later")
    if isinstance(done, dict):
        return {"state": "done", "text_ru": done.get("text_ru") or TEXT_KEPT, "text_kk": None,
                "to": done.get("to"), "action_id": done.get("action_id")}  # fmt: skip
    return None


async def _finish(session: AsyncSession, item: Item, now: datetime, to: str, text_ru: str,
                  action_id: str | None = None) -> None:  # fmt: skip
    meta = {k: v for k, v in (item.source_meta or {}).items() if k != "parse_later"}
    meta["parsed_later"] = {"to": to, "text_ru": text_ru, "action_id": action_id,
                            "at": now.isoformat()}  # fmt: skip
    item.source_meta = meta


async def _probe(router: Any, phrase: str, user_id: int) -> str | None:
    """Is the model back? Its reading of the phrase, None: never ask it (no consent)."""
    from assistant.chat.intent import IntentReply
    from assistant.chat.service import INTENT_SYSTEM

    inputs = TaskInputs(system=INTENT_SYSTEM, instruction="Classify the phrase.",
                        context=[f"Фраза человека: {phrase}"],
                        prompt_version="intent.v1")  # fmt: skip
    try:
        result = await router.run(LLMTask.INTENT, IntentReply, inputs, user_id=user_id)
    except AIConsentRequired:
        return None
    except (AIUnavailable, StreamInterrupted, BudgetExceeded) as exc:
        raise Retry(type(exc).__name__) from exc
    return str(result.data.intent)


async def _old_links(session: AsyncSession, item_pk: int) -> list[str]:
    return [str(p) for p in await session.scalars(
        select(Screen.public_id).join(ScreenItem, ScreenItem.screen_id == Screen.id)
        .where(ScreenItem.item_id == item_pk, ScreenItem.removed_by_user_at.is_(None),
               Screen.deleted_at.is_(None)))]  # fmt: skip


async def run_parse(maker: async_sessionmaker[AsyncSession], router: Any, item_pk: int,
                    now: datetime) -> str:  # fmt: skip
    """Read one waiting note. Returns `gone` | `expense` | `tasks` | `note`; raises Retry while
    the model is down. No transaction is open during a model call."""
    from assistant.chat.service import is_reminder_phrase

    async with maker() as s:
        item = await s.get(Item, item_pk)
        if item is None or item.deleted_at is not None \
                or not (item.source_meta or {}).get("parse_later"):  # fmt: skip
            await s.commit()
            return "gone"
        user_id, phrase = item.user_id, (item.text or "").strip()
        tz = await s.scalar(select(User.tz).where(User.id == user_id)) or "Asia/Almaty"
        cats = await expenses.reader_categories(s, user_id)
        await s.commit()
    today = now.astimezone(ZoneInfo(tz)).date()
    draft = None
    reading = None
    readable = 0 < len(phrase) <= MAX_CHARS and not is_reminder_phrase(phrase)
    if readable and expenses_parse.mentions_expense(phrase):  # code first
        draft = expenses_parse.rules_parse(phrase, today)
    if readable and draft is None and tasks_parse.mentions_list(phrase):
        reading = tasks_parse.rules_parse(phrase, today, None)
    by_code = draft is not None or bool(reading and reading.specs)
    if readable and not by_code and router is not None:
        intent = await _probe(router, phrase, user_id)
        if intent in ("note", "change"):
            if expenses_parse.mentions_expense(phrase):
                draft = await expenses_parse.read_phrase(
                    phrase, today=today, rules_first=False, router=router, user_id=user_id,
                    categories=cats)  # fmt: skip
            if draft is None:
                reading = await tasks_parse.read_phrase(phrase, today=today, rules_first=False,
                                                        router=router, user_id=user_id)
    async with maker() as s:
        await lock_user(s, user_id)
        item = await s.get(Item, item_pk, with_for_update=True)
        if item is None or item.deleted_at is not None \
                or not (item.source_meta or {}).get("parse_later"):  # fmt: skip
            await s.commit()
            return "gone"
        if (item.text or "").strip() != phrase:  # the person changed it meanwhile: theirs
            draft = reading = None
        out = await _apply(s, item, draft, reading, now=now, today=today)
        await s.commit()
    return out


async def _apply(s: AsyncSession, item: Item, draft: Any, reading: Any, *, now: datetime,
                 today: Any) -> str:  # fmt: skip
    user_id = item.user_id
    before = await _old_links(s, item.id)
    if draft is not None:
        cat = await expenses.category_by_key(s, user_id, draft.category_key)
        spec = expenses.NewExpense(
            amount=draft.amount, currency=draft.currency, spent_on=draft.spent_on, category=cat,
            note=draft.note, payee=draft.payee, method=draft.method, direction=draft.direction,
            parse_source=draft.source, phrase=item.text or "", item=item,
            source="voice" if item.source == RecordSource.MIC else "typed")  # fmt: skip
        made = await expenses.create(s, user_id, spec, by=Initiator.AGENT, now=now, today=today)
        item.source_meta = {**(item.source_meta or {}), "expense": True}
        kind, to = ActionKind.CREATE_EXPENSE, "expense"
        inverse, changes, page = made.inverse, made.changes, made.page
        pages = set(made.pages)
    elif reading is not None and reading.specs:
        if len(reading.specs) == 1:
            added = await tasks.attach(s, user_id, item, reading.specs[0], by=Initiator.AGENT,
                                       now=now)  # fmt: skip
            inverse = added.inverse
        else:  # one task each; the phrase itself goes to the trash
            added = await tasks.add(s, user_id, reading.specs, by=Initiator.AGENT, now=now)
            res = await engine.apply(s, user_id, [{"op": "delete_entity_soft", "entity": "items",
                                                   "id": str(item.public_id)}],
                                     by=Initiator.AGENT, check=False, now=now)  # fmt: skip
            inverse = [*res.inverse, *added.inverse]
            before = []
        kind, to = ActionKind.SAVE_ITEM, "tasks"
        changes, page, pages = added.changes, added.page, set(added.pages)
    else:
        await _finish(s, item, now, "note", TEXT_KEPT)
        return "note"
    target = str(page.public_id) if page is not None else None
    leave = [p for p in before if p != target]
    if leave:  # the note leaves «Заметки»: it lives on «Расходы» / «Дела» now
        res = await engine.apply(s, user_id, [{"op": "remove_screen_item", "page": p,
                                               "item": str(item.public_id), "exclude": False}
                                              for p in leave],
                                 by=Initiator.AGENT, check=False, now=now)  # fmt: skip
        inverse = [*res.inverse, *inverse]
        pages |= res.pages
    where = page.title if page is not None else ("Расходы" if to == "expense" else "Дела")
    said = f"Разобрал: перенёс в «{where}»"
    action = await record(s, user_id=user_id, kind=kind, initiated_by=Initiator.AGENT,
                          summary={"ru": said + ".", "kk": None}, changes=changes,
                          inverse=inverse, now=now, screen_id=page.id if page else None,
                          source_item_ids=[item.id], extra={"parsed_later": True})  # fmt: skip
    await _finish(s, item, now, to, said, str(action.public_id))
    return to


async def requeue_waiting(maker: async_sessionmaker[AsyncSession]) -> int:
    """Notes still waiting whose job gave up (the model was down for hours): try again."""
    async with maker() as s:
        rows = (await s.execute(text("""
            SELECT i.id FROM items i JOIN jobs j ON j.idempotency_key = :p || i.id::text
            WHERE i.source_meta ? 'parse_later' AND i.deleted_at IS NULL
              AND i.created_at > now() - make_interval(days => :d) AND j.status = 'failed'
            LIMIT 100
        """), {"p": JOB_PARSE + ":", "d": REQUEUE_DAYS})).scalars().all()  # fmt: skip
        for pk in rows:
            await queue.enqueue_again(s, JOB_PARSE, {"item_id": pk}, job_key(pk),
                                      again_if=(JobStatus.FAILED,))  # fmt: skip
        await s.commit()
    return len(rows)
