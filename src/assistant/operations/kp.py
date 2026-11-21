"""Operation of a КП (Ф-97, chat-full-control.md phase 2): `kp.edit` — a tap edit or a phrase
edit («цену светильников 4 500», «убери доставку») applied as one new version with code's totals,
one `edit_kp` action whose «Отменить» reverts to the version before. `POST
/v1/documents/{id}/patch`, `/edit` and the assistant line run it.

The ops are the tap-edit white list (`kp.patch`); a phrase's ops were checked by
`kp.edit.check_ops` first (numbers only from the phrase). Sending a КП is not an operation: only
the screen sends, after «Да» (Ф-95 (4)).
"""

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.actions import record
from assistant.db.models import Item
from assistant.db.models_actions import ActionKind
from assistant.operations.registry import Operation, OpError, OpResult, register


class KpEdit(BaseModel):
    model_config = ConfigDict(extra="forbid")
    document_id: uuid.UUID
    ops: list[dict[str, Any]] = Field(min_length=1, max_length=100)
    base_version: int | None = None  # the version the editor saw (409 when it moved on)
    author: str = "agent_request"
    request_text: str | None = None


def change_text(before: dict[str, Any] | None, after_total: str, currency: str) -> str:
    from assistant.kp.calc import format_money

    if before and before.get("total") != after_total:
        old = format_money(before["total"], currency).removesuffix(" ₸")
        return f"Итого: {old} → {format_money(after_total, currency)}"
    return "Изменил КП"


async def _edit(session: AsyncSession, user_id: int, args: KpEdit, *, by: str, now: datetime,
                client_id: uuid.UUID | None = None, message_pk: int | None = None,
                settings: Any = None, **_: Any) -> OpResult:  # fmt: skip
    """`data`: doc, before (data), after (data), text. Raises OpError with the KpError /
    PatchError code (`details`: the path)."""
    from assistant.config import get_settings
    from assistant.db.models_kp import Document
    from assistant.kp import patch, service

    doc = await session.scalar(select(Document).where(
        Document.user_id == user_id, Document.public_id == args.document_id).with_for_update())
    if doc is None:
        raise OpError("not_found", 404)
    if doc.deleted_at is not None:
        raise OpError("item_deleted", 409)
    if not doc.current_version_n:
        raise OpError("kp_not_ready", 409)
    if args.base_version is not None and args.base_version != doc.current_version_n:
        raise OpError("conflict", 409)
    cur = await service.version(session, doc)
    try:
        data, changed, applied = patch.apply_patch(cur.data, args.ops)
        saved = await service.save_version(session, doc, data, author=args.author, now=now,
                                           settings=settings or get_settings(), patch=applied,
                                           changed_paths=changed,
                                           request_text=args.request_text)  # fmt: skip
    except patch.PatchError as exc:
        raise OpError(exc.code, 422, {"path": exc.path} if exc.path else None) from exc
    except service.KpError as exc:
        raise OpError(exc.code, exc.status, exc.details) from exc
    item = await session.get(Item, doc.item_id)
    assert item is not None
    inverse = [{"op": "revert_document", "id": str(doc.public_id), "n": cur.n,
                "expect_n": saved.version.n, "item": str(item.public_id)}]
    text = change_text(saved.before, saved.version.totals["total"], data.get("currency") or "KZT")
    action = await record(
        session, user_id=user_id, kind=ActionKind.EDIT_KP, initiated_by=by,
        summary={"ru": text, "kk": None},
        changes=[{"item_id": str(item.public_id), "document_id": str(doc.public_id),
                  "title": doc.title, "kind": "edit", "page_id": None, "text": text,
                  "changed_paths": changed}],
        inverse=inverse, now=now, source_item_ids=[item.id], client_id=client_id,
        message_id=message_pk,
        extra={**({"request_text": args.request_text} if args.request_text else {}),
               "op": "kp.edit", "touched": ["records"]},
    )  # fmt: skip
    return OpResult(action=action, actions=[action], inverse=inverse, items={str(item.public_id)},
                    sentence=text, touched=("records",),
                    data={"doc": doc, "before": cur.data, "after": data, "text": text,
                          "inverse": inverse})  # fmt: skip


register(Operation("kp.edit", "kp", "safe", KpEdit, execute=_edit,
                   description="change a КП (prices, quantities, lines, terms): a new version"))
