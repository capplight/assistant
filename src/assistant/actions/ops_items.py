"""Engine op of a record's content (step 8 «Составь план», Ф-73 inline edit):

- `set_item_content` {entity: items, id, values: {title?, text?, plan?}, expect?: {same keys}}:
  sets the record's title, text and/or plan structure (`source_meta.plan`, docs/api/plans.md).
  A new text is re-indexed like the person's own edit in `PATCH /v1/items` (hash, language,
  simhash, a new summary and embedding on their way). Its reverse sets the old values back with
  `expect` = what it left: if the person changed the record since, an undo skips it («Часть уже
  изменена вами»).
"""

from datetime import datetime
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from assistant.actions.engine import Outcome, _items

CONTENT_FIELDS = frozenset({"title", "text", "plan"})


def content_of(item: Any) -> dict[str, Any]:
    return {"title": item.title, "text": item.text,
            "plan": (item.source_meta or {}).get("plan")}  # fmt: skip


async def _set_item_content(session: AsyncSession, user_id: int, op: dict, out: Outcome, *,
                            by: str, check: bool, now: datetime) -> None:  # fmt: skip
    values = op.get("values")
    if not isinstance(values, dict) or not values or set(values) - CONTENT_FIELDS:
        raise ValueError("set_item_content: fields not allowed")
    rid = str(op["id"])
    item = (await _items(session, user_id, [rid])).get(rid)
    if item is None or item.deleted_at is not None:
        out.skipped += 1
        return
    cur = content_of(item)
    expect = op.get("expect")
    if check and isinstance(expect, dict) and any(cur.get(k) != v for k, v in expect.items()):
        out.skipped += 1
        return
    if all(cur.get(k) == v for k, v in values.items()):
        return
    out.inverse.append({"op": "set_item_content", "entity": "items", "id": rid,
                        "values": {k: cur.get(k) for k in values},
                        "expect": dict(values)})  # fmt: skip
    if "title" in values:
        item.title = values["title"]
    if "plan" in values:
        meta = dict(item.source_meta or {})
        if values["plan"] is None:
            meta.pop("plan", None)
        else:
            meta["plan"] = values["plan"]
        item.source_meta = meta
    if "text" in values and values["text"] != cur["text"]:
        from assistant.dedup.similarity import simhash
        from assistant.records import content_hash, detect_lang

        item.text = values["text"]
        item.text_lang = detect_lang(item.text) if item.text else None
        item.content_hash = content_hash(item.text) if item.text else None
        item.simhash = simhash(item.text) if item.text else None
        item.summary = None
        item.ai_fields = [f for f in (item.ai_fields or []) if f != "summary"]
    if ("title" in values or "text" in values) and item.hidden_reason is None:
        from assistant.memory import enqueue_embed

        await enqueue_embed(session, item)
    out.items.add(rid)


HANDLERS = {"set_item_content": _set_item_content}
