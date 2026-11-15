"""A line phrase that reached the server as a plain record (QA 1, 2026-11-15; Ф-47).

Offline, in «Без ИИ» or while the answering service is down, the phone saves what was said in the
line as a record (`POST /v1/items`, no page, `source_meta.from_line: true`). Code reads it the
way the line would: a spend
(«потратил 2000 на мороженое») becomes an expense on «Расходы» with that record as its record, a
to-do («купить хлеб на завтра») a task on «Дела». Code only (no model), the same readers as the
line (`expenses.parse.rules_parse`, `tasks.parse.rules_parse`). One action with «Отменить», like
the line. Anything else stays a note, placed by the page rules. A reminder is never set here: it
needs the person's «Сохранить».
"""

import logging
from datetime import datetime
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.actions import engine, record
from assistant.db.models import Item, User
from assistant.db.models_actions import ActionKind, Initiator
from assistant.db.models_v2 import RecordKind, RecordSource
from assistant.expenses import parse as expenses_parse
from assistant.expenses import service as expenses
from assistant.tasks import parse as tasks_parse
from assistant.tasks import service as tasks

log = logging.getLogger(__name__)

MAX_CHARS = 300  # a line phrase, not a long note


def _is_phrase(item: Item) -> bool:
    text = (item.text or "").strip()
    meta = item.source_meta or {}
    return (bool(meta.get("from_line")) and item.kind == RecordKind.NOTE
            and item.source in (RecordSource.TYPED, RecordSource.MIC)
            and 0 < len(text) <= MAX_CHARS and not meta.get("url") and not meta.get("caption")
            and not item.title and not item.fragment_no)  # fmt: skip


async def file_line_phrase(db: AsyncSession, user_id: int, item: Item, now: datetime) -> bool:
    """True when the record became an expense or task(s). The caller places it afterwards."""
    if not _is_phrase(item):
        return False
    text = item.text or ""
    tz = await db.scalar(select(User.tz).where(User.id == user_id)) or "Asia/Almaty"
    today = now.astimezone(ZoneInfo(tz)).date()
    if expenses_parse.mentions_expense(text):
        draft = expenses_parse.rules_parse(text, today)
        if draft is not None:
            cat = await expenses.category_by_key(db, user_id, draft.category_key)
            spec = expenses.NewExpense(
                amount=draft.amount, currency=draft.currency, spent_on=draft.spent_on,
                category=cat, note=draft.note, payee=draft.payee, method=draft.method,
                direction=draft.direction, parse_source=draft.source,
                source="voice" if item.source == RecordSource.MIC else "typed",
                phrase=text, item=item)  # fmt: skip
            created = await expenses.create(db, user_id, spec, by=Initiator.USER, now=now,
                                            today=today)  # fmt: skip
            meta = dict(item.source_meta or {})
            meta["expense"] = True
            item.source_meta = meta
            await record(db, user_id=user_id, kind=ActionKind.CREATE_EXPENSE,
                         initiated_by=Initiator.USER,
                         summary={"ru": created.sentence, "kk": None}, changes=created.changes,
                         inverse=created.inverse, now=now,
                         screen_id=created.page.id if created.page else None,
                         source_item_ids=[item.id])  # fmt: skip
            return True
    if not tasks_parse.mentions_list(text):
        return False
    reading = tasks_parse.rules_parse(text, today, None)
    if reading is None or not reading.specs:
        return False
    if len(reading.specs) == 1:
        added = await tasks.attach(db, user_id, item, reading.specs[0], by=Initiator.USER,
                                   now=now)  # fmt: skip
        inverse = added.inverse
    else:  # «купить хлеб, молоко и сыр»: one task each; the phrase itself goes to the trash
        added = await tasks.add(db, user_id, reading.specs, by=Initiator.USER, now=now)
        res = await engine.apply(db, user_id, [{"op": "delete_entity_soft", "entity": "items",
                                                "id": str(item.public_id)}],
                                 by=Initiator.USER, check=False, now=now)  # fmt: skip
        inverse = [*res.inverse, *added.inverse]
    await record(db, user_id=user_id, kind=ActionKind.SAVE_ITEM, initiated_by=Initiator.USER,
                 summary={"ru": added.sentence, "kk": None}, changes=added.changes,
                 inverse=inverse, now=now, screen_id=added.page.id if added.page else None,
                 source_item_ids=added.item_pks)  # fmt: skip
    return True
