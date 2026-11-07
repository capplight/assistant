"""Conversation storage: one `main` conversation per person, its messages, their JSON shape.

Short transactions only; the caller commits. Contract of the JSON: docs/api/chat.md
(ChatMessage).
"""

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select, text, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.db.models_chat import (
    Conversation,
    ConversationMessage,
    MessageRole,
    MessageState,
)
from assistant.db.models_pages import Screen


async def main_conversation(session: AsyncSession, user_id: int) -> Conversation:
    await session.execute(
        insert(Conversation).values(user_id=user_id, kind="main")
        .on_conflict_do_nothing(index_elements=["user_id", "kind"])
    )  # fmt: skip
    conv = await session.scalar(
        select(Conversation).where(Conversation.user_id == user_id, Conversation.kind == "main")
    )  # fmt: skip
    assert conv is not None
    return conv


async def find_by_client_id(session: AsyncSession, conversation_id: int,
                            client_id: uuid.UUID) -> ConversationMessage | None:  # fmt: skip
    return await session.scalar(select(ConversationMessage).where(
        ConversationMessage.conversation_id == conversation_id,
        ConversationMessage.client_id == client_id))  # fmt: skip


async def reply_of(session: AsyncSession, message_id: int) -> ConversationMessage | None:
    return await session.scalar(
        select(ConversationMessage)
        .where(ConversationMessage.reply_to_id == message_id,
               ConversationMessage.role == MessageRole.ASSISTANT)
        .order_by(ConversationMessage.id).limit(1)
    )  # fmt: skip


async def by_public_id(session: AsyncSession, user_id: int,
                       public_id: uuid.UUID) -> ConversationMessage | None:  # fmt: skip
    return await session.scalar(select(ConversationMessage).where(
        ConversationMessage.user_id == user_id, ConversationMessage.public_id == public_id,
        ConversationMessage.deleted_at.is_(None)))  # fmt: skip


async def bump_count(session: AsyncSession, conversation_id: int, n: int) -> None:
    await session.execute(update(Conversation).where(Conversation.id == conversation_id)
                          .values(msg_count=Conversation.msg_count + n, updated_at=func.now()))


async def mark_stale_failed(session: AsyncSession, message_id: int, older_than: datetime) -> bool:
    """A pending answer nobody is writing any more (the server restarted): failed."""
    res = await session.execute(
        update(ConversationMessage)
        .where(ConversationMessage.id == message_id,
               ConversationMessage.state == MessageState.PENDING,
               ConversationMessage.updated_at < older_than)
        .values(state=MessageState.FAILED, error_code="stale", updated_at=func.now())
    )  # fmt: skip
    return bool(res.rowcount)  # type: ignore[attr-defined]


async def clear_history(session: AsyncSession, user_id: int) -> None:
    await session.execute(text("DELETE FROM conversation_messages WHERE user_id = :u"),
                          {"u": user_id})  # fmt: skip
    await session.execute(
        update(Conversation).where(Conversation.user_id == user_id)
        .values(summary=None, summary_upto_msg_id=None, summary_version=None, msg_count=0,
                updated_at=func.now())
    )  # fmt: skip


async def pages_of(session: AsyncSession, screen_ids: set[int]) -> dict[int, dict[str, Any]]:
    if not screen_ids:
        return {}
    rows = await session.execute(
        select(Screen.id, Screen.public_id, Screen.title, Screen.icon)
        .where(Screen.id.in_(screen_ids), Screen.deleted_at.is_(None))
    )  # fmt: skip
    return {pk: {"id": str(pid), "title": title, "icon": icon} for pk, pid, title, icon in rows}


async def public_ids(session: AsyncSession, ids: set[int]) -> dict[int, uuid.UUID]:
    if not ids:
        return {}
    rows = await session.execute(select(ConversationMessage.id, ConversationMessage.public_id)
                                 .where(ConversationMessage.id.in_(ids)))  # fmt: skip
    return {pk: pid for pk, pid in rows}


def _iso(value: datetime) -> str:
    return (value if value.tzinfo else value.replace(tzinfo=UTC)).isoformat()


def proposal_out(prop: dict[str, Any] | None, now: datetime) -> dict[str, Any] | None:
    """A proposal as the phone sees it: never the plan our code keeps."""
    if not prop:
        return None
    out = {k: v for k, v in prop.items() if k != "plan"}
    if out.get("state") == "open" and datetime.fromisoformat(out["expires_at"]) <= now:
        out["state"] = "expired"
    return out


def message_dict(m: ConversationMessage, *, page: dict[str, Any] | None,
                 reply_to: uuid.UUID | None, ai_label: str,
                 action: dict[str, Any] | None = None,
                 now: datetime | None = None) -> dict[str, Any]:  # fmt: skip
    assistant = m.role == MessageRole.ASSISTANT
    citations = [{k: v for k, v in c.items() if k != "_pk"} for c in (m.citations or [])]
    return {
        "id": str(m.public_id), "client_id": str(m.client_id) if m.client_id else None,
        "role": m.role, "reply_to": str(reply_to) if reply_to else None, "page": page,
        "input_kind": m.input_kind, "text": m.content, "answer_kind": m.answer_kind,
        "state": m.state, "citations": citations if assistant else [],
        "checked": m.checked if assistant else None,
        "delivery": m.delivery if assistant else None,
        "ai_label": ai_label if assistant and m.ai_generated else None,
        "action": action if assistant else None,
        "proposal": proposal_out(m.proposal, now or datetime.now(UTC)) if assistant else None,
        "choice": m.choice if not assistant else None,
        "error_code": m.error_code if assistant else None,
        "seq": m.seq,
        "created_at": _iso(m.created_at),
    }  # fmt: skip


async def messages_dicts(session: AsyncSession, rows: list[ConversationMessage],
                         ai_label: str) -> list[dict[str, Any]]:  # fmt: skip
    from assistant.actions import actions_dicts
    from assistant.db.models_actions import Action

    now = datetime.now(UTC)
    pages = await pages_of(session, {m.screen_id for m in rows if m.screen_id})
    replies = await public_ids(session, {m.reply_to_id for m in rows if m.reply_to_id})
    action_pks = {m.action_ids[0] for m in rows if m.action_ids}
    actions: dict[int, dict[str, Any]] = {}
    if action_pks:
        found = list(await session.scalars(select(Action).where(Action.id.in_(action_pks))))
        actions = {a.id: d for a, d in zip(found, await actions_dicts(session, found, now),
                                           strict=True)}  # fmt: skip
    return [message_dict(m, page=pages.get(m.screen_id) if m.screen_id else None,
                         reply_to=replies.get(m.reply_to_id) if m.reply_to_id else None,
                         ai_label=ai_label,
                         action=actions.get(m.action_ids[0]) if m.action_ids else None,
                         now=now) for m in rows]  # fmt: skip
