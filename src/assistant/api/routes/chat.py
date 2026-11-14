"""/v1/chat/* and /v1/feedback: the assistant line, «Переписка», «Сообщить о проблеме».

Contract: docs/api/chat.md. The answer itself is written by assistant.chat.ChatService in the
background; these handlers only start it, stream its events and read saved messages.
"""

import json
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Header, Query, Response
from fastapi.responses import StreamingResponse
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from assistant.ai import ai_consent_providers
from assistant.api.consent_gate import ConsentRequired, require_ai_consent, require_base_consent
from assistant.api.deps import Ctx, CurrentUser, Db
from assistant.api.errors import ApiError
from assistant.api.schemas import (
    ActionOut,
    ChatMessageIn,
    ChatMessageOut,
    ChatMessagesOut,
    DeliveryIn,
    FeedbackIn,
    FeedbackOut,
    HistoryEntryOut,
    HistoryOut,
    PendingBannerOut,
)
from assistant.chat import ChatRequest, ChatService, RateLimited, store
from assistant.db.models import Item
from assistant.db.models_chat import (
    Conversation,
    ConversationMessage,
    Delivery,
    Feedback,
    FeedbackTarget,
    MessageRole,
    MessageState,
)

router = APIRouter(prefix="/chat", tags=["chat"])
feedback_router = APIRouter(prefix="/feedback", tags=["chat"])
history_router = APIRouter(prefix="/history", tags=["chat"])
AiUser = Annotated[CurrentUser, Depends(require_ai_consent)]
BaseUser = Annotated[CurrentUser, Depends(require_base_consent)]

SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
_DELIVERY_RANK = {None: 0, Delivery.STREAMED: 0, Delivery.BANNER_PENDING: 0,
                  Delivery.BANNER_SHOWN: 1, Delivery.OPENED: 2, Delivery.DISMISSED: 2}  # fmt: skip


def _service(ctx: Ctx) -> ChatService:
    if ctx.chat is None:
        raise ApiError(503, "internal")
    return ctx.chat


async def _frames(events: AsyncIterator[Any]) -> AsyncIterator[str]:
    async for ev in events:
        if ev is None:
            yield ": ping\n\n"
            continue
        i, name, data = ev
        yield f"id: {i}\nevent: {name}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _stream(events: AsyncIterator[Any]) -> StreamingResponse:
    return StreamingResponse(_frames(events), media_type="text/event-stream",
                             headers=SSE_HEADERS)  # fmt: skip


@router.post("/messages", response_class=StreamingResponse, status_code=200)
async def post_message(body: ChatMessageIn, user: AiUser, db: Db, ctx: Ctx) -> StreamingResponse:
    service = _service(ctx)
    chain = service.chat_providers()
    allowed = await ai_consent_providers(
        db, user.id, legacy_providers=tuple(ctx.settings.ai_legacy_consent_providers))
    if chain and not (set(allowed or ()) & set(chain)):
        raise ConsentRequired(["ai_cross_border"])
    await db.commit()  # nothing of this request's session stays open while the answer runs
    req = ChatRequest(
        client_id=body.client_id, text=body.text, page_id=body.page_id,
        visible_item_ids=body.visible_item_ids, view_version=body.view_version,
        selected_item_id=body.selected_item_id, lang=body.lang, input_kind=body.input_kind,
        choice=body.choice.model_dump() if body.choice else None,
    )  # fmt: skip
    try:
        reply_id, run = await service.start(user.id, user.locale, req)
    except RateLimited as exc:  # week 18: per-person limit, friendly 429 + Retry-After
        raise ApiError(429, exc.code, retry_after=exc.retry_after) from exc
    if run is not None:
        return _stream(run.follow(0))
    return _stream(service.resume(user.id, reply_id, 0))


async def _own_message(db: Db, user: CurrentUser, message_id: uuid.UUID,
                       *, assistant: bool = False) -> ConversationMessage:  # fmt: skip
    msg = await store.by_public_id(db, user.id, message_id)
    if msg is None or (assistant and msg.role != MessageRole.ASSISTANT):
        raise ApiError(404, "not_found")
    return msg


@router.get("/messages/{reply_id}/events", response_class=StreamingResponse)
async def resume_events(
    reply_id: uuid.UUID, user: AiUser, db: Db, ctx: Ctx,
    after: Annotated[int | None, Query(ge=0)] = None,
    last_event_id: Annotated[str | None, Header(alias="Last-Event-ID")] = None,
) -> StreamingResponse:  # fmt: skip
    service = _service(ctx)
    await _own_message(db, user, reply_id, assistant=True)
    await db.commit()
    start = after
    if start is None and last_event_id and last_event_id.strip().isdigit():
        start = int(last_event_id.strip())
    return _stream(service.resume(user.id, reply_id, start or 0))


async def _out(db: Db, ctx: Ctx, rows: list[ConversationMessage]) -> list[ChatMessageOut]:
    dicts = await store.messages_dicts(db, rows, ctx.settings.label_ai_generated)
    return [ChatMessageOut.model_validate(d) for d in dicts]


@router.get("/messages", response_model=ChatMessagesOut)
async def list_messages(
    user: BaseUser, db: Db, ctx: Ctx, before: uuid.UUID | None = None,
    around: uuid.UUID | None = None, limit: Annotated[int, Query(ge=1, le=50)] = 30,
) -> ChatMessagesOut:  # fmt: skip
    conv_id = await db.scalar(select(Conversation.id).where(Conversation.user_id == user.id,
                                                            Conversation.kind == "main"))
    if conv_id is None:
        if before or around:
            raise ApiError(404, "not_found")
        return ChatMessagesOut(messages=[], has_more_before=False, has_more_after=False)
    base = select(ConversationMessage).where(
        ConversationMessage.conversation_id == conv_id, ConversationMessage.deleted_at.is_(None),
        ConversationMessage.role.in_([MessageRole.USER, MessageRole.ASSISTANT]))

    async def older(pk: int | None, n: int) -> tuple[list[ConversationMessage], bool]:
        q = base if pk is None else base.where(ConversationMessage.id < pk)
        rows = list(await db.scalars(q.order_by(ConversationMessage.id.desc()).limit(n + 1)))
        return list(reversed(rows[:n])), len(rows) > n

    if around is not None:
        anchor = await _own_message(db, user, around)
        rows_before, more_before = await older(anchor.id, limit // 2)
        after_rows = list(await db.scalars(base.where(ConversationMessage.id >= anchor.id)
                                           .order_by(ConversationMessage.id)
                                           .limit(limit - len(rows_before) + 1)))  # fmt: skip
        n_after = limit - len(rows_before)
        rows, more_after = rows_before + after_rows[:n_after], len(after_rows) > n_after
    else:
        pk = (await _own_message(db, user, before)).id if before is not None else None
        rows, more_before = await older(pk, limit)
        more_after = False
        if pk is not None:
            more_after = bool(await db.scalar(
                select(ConversationMessage.id).where(ConversationMessage.conversation_id == conv_id,
                                                     ConversationMessage.id >= pk).limit(1)))
    return ChatMessagesOut(messages=await _out(db, ctx, rows), has_more_before=more_before,
                           has_more_after=more_after)  # fmt: skip


@router.get("/messages/{message_id}", response_model=ChatMessageOut)
async def get_message(message_id: uuid.UUID, user: BaseUser, db: Db, ctx: Ctx) -> ChatMessageOut:
    return (await _out(db, ctx, [await _own_message(db, user, message_id)]))[0]


@router.get("/pending-banner", response_model=PendingBannerOut)
async def pending_banner(user: BaseUser, db: Db, ctx: Ctx) -> PendingBannerOut:
    msg = await db.scalar(
        select(ConversationMessage)
        .where(ConversationMessage.user_id == user.id,
               ConversationMessage.delivery == Delivery.BANNER_PENDING,
               ConversationMessage.role == MessageRole.ASSISTANT,
               ConversationMessage.state.in_([MessageState.DONE, MessageState.DEFERRED,
                                              MessageState.FAILED]),
               ConversationMessage.deleted_at.is_(None))
        .order_by(ConversationMessage.id.desc()).limit(1)
    )  # fmt: skip
    return PendingBannerOut(message=(await _out(db, ctx, [msg]))[0] if msg else None)


@router.post("/messages/{message_id}/delivery", response_model=ChatMessageOut)
async def mark_delivery(message_id: uuid.UUID, body: DeliveryIn, user: BaseUser, db: Db,
                        ctx: Ctx) -> ChatMessageOut:  # fmt: skip
    msg = await _own_message(db, user, message_id, assistant=True)
    if _DELIVERY_RANK[Delivery(body.delivery)] > _DELIVERY_RANK.get(msg.delivery, 0):
        msg.delivery = body.delivery
        await db.flush()
    return (await _out(db, ctx, [msg]))[0]


@router.delete("/history", status_code=204)
async def clear_history(user: BaseUser, db: Db) -> Response:
    await store.clear_history(db, user.id)
    return Response(status_code=204)


@feedback_router.post("", response_model=FeedbackOut, status_code=201)
async def post_feedback(body: FeedbackIn, user: BaseUser, db: Db,
                        response: Response) -> FeedbackOut:
    if body.client_id is not None:
        old = await db.scalar(select(Feedback).where(Feedback.user_id == user.id,
                                                     Feedback.client_id == body.client_id))
        if old is not None:
            response.status_code = 200
            return FeedbackOut(id=old.public_id, created_at=old.created_at)
    if body.target == FeedbackTarget.ANSWER:
        await _own_message(db, user, body.target_ref, assistant=True)
    elif body.target == FeedbackTarget.ITEM:
        found = await db.scalar(select(Item.id).where(Item.user_id == user.id,
                                                      Item.public_id == body.target_ref))
        if found is None:
            raise ApiError(404, "not_found")
    row = Feedback(user_id=user.id, client_id=body.client_id, target=body.target,
                   target_ref=body.target_ref, reason=body.reason,
                   comment=(body.comment or "").strip() or None,
                   allow_anonymized_example=body.allow_anonymized_example)  # fmt: skip
    db.add(row)
    try:
        await db.flush()
    except IntegrityError as exc:  # the same client_id raced in
        raise ApiError(409, "conflict") from exc
    await db.refresh(row)
    return FeedbackOut(id=row.public_id, created_at=row.created_at)


# --- «История» (Ф-50): «Переписка» + «Что я сделал» in one feed ---

# A turn = a phrase the person sent (its answer and the action it caused come along); an action
# entry = a change made without a phrase (a tick, a move by hand, «Отменить», a form) or whose
# phrase is gone («Очистить переписку»). One keyset over both, newest first.
_HISTORY_SQL = """
SELECT kind, id, at FROM (
    SELECT 'turn' AS kind, m.id, m.created_at AS at FROM conversation_messages m
    WHERE m.user_id = :u AND m.role = 'user' AND m.deleted_at IS NULL {turn_filter}
    UNION ALL
    SELECT 'action' AS kind, a.id, a.created_at AS at FROM actions a
    WHERE a.user_id = :u {action_filter} AND NOT EXISTS (
        SELECT 1 FROM conversation_messages r
        WHERE r.id = a.message_id AND r.deleted_at IS NULL
          AND (r.role = 'user' OR r.reply_to_id IS NOT NULL))
) e
{before}
ORDER BY at DESC, kind DESC, id DESC
LIMIT :n
"""
_REPLY = ("SELECT 1 FROM conversation_messages r WHERE r.reply_to_id = m.id "
          "AND r.role = 'assistant' AND r.deleted_at IS NULL")
_FILTERS = {
    "all": ("", ""),
    "changes": (f"AND EXISTS ({_REPLY} AND cardinality(r.action_ids) > 0)", ""),
    "questions": (f"AND NOT EXISTS ({_REPLY} AND (cardinality(r.action_ids) > 0 "
                  "OR jsonb_typeof(r.proposal) = 'object'))", "AND false"),
    "waiting": (f"AND EXISTS ({_REPLY} AND r.proposal ->> 'state' = 'open' "
                "AND CAST(r.proposal ->> 'expires_at' AS timestamptz) > now())", "AND false"),
}


def _status(action: dict | None, answer: dict | None) -> str:
    if action is not None:
        return "undone" if action.get("undone_at") else "done"
    if answer is None:
        return "pending"
    if (answer.get("proposal") or {}).get("state") == "open":
        return "waiting"
    state = answer.get("state")
    return {"pending": "pending", "deferred": "deferred", "failed": "failed"}.get(
        state or "", "answered")


@history_router.get("", response_model=HistoryOut)
async def history(
    user: BaseUser, db: Db, ctx: Ctx, before: uuid.UUID | None = None,
    only: Literal["all", "changes", "questions", "waiting"] = "all",
    limit: Annotated[int, Query(ge=1, le=50)] = 30,
) -> HistoryOut:  # fmt: skip
    """«Всё · Изменения · Вопросы · Ждут»: newest first; `before` = the `id` of the last entry
    shown (a phrase or an action of this person, else 404)."""
    from assistant.actions import actions_dicts
    from assistant.db.models_actions import Action

    params: dict[str, Any] = {"u": user.id, "n": limit + 1}
    cursor = ""
    if before is not None:
        msg = await store.by_public_id(db, user.id, before)
        if msg is not None and msg.role == MessageRole.USER:
            params.update(bk="turn", bid=msg.id, bat=msg.created_at)
        else:
            act = await db.scalar(select(Action).where(Action.user_id == user.id,
                                                       Action.public_id == before))
            if act is None:
                raise ApiError(404, "not_found")
            params.update(bk="action", bid=act.id, bat=act.created_at)
        cursor = "WHERE (at, kind, id) < (:bat, :bk, :bid)"
    turn_filter, action_filter = _FILTERS[only]
    rows = (await db.execute(text(_HISTORY_SQL.format(
        turn_filter=turn_filter, action_filter=action_filter, before=cursor)), params)).all()
    more, rows = len(rows) > limit, rows[:limit]
    turn_pks = [r.id for r in rows if r.kind == "turn"]
    said: dict[int, ConversationMessage] = {}
    if turn_pks:
        said = {m.id: m for m in await db.scalars(
            select(ConversationMessage).where(ConversationMessage.id.in_(turn_pks)))}
    replies: dict[int, ConversationMessage] = {}
    if turn_pks:
        for r in await db.scalars(
                select(ConversationMessage)
                .where(ConversationMessage.reply_to_id.in_(turn_pks),
                       ConversationMessage.role == MessageRole.ASSISTANT,
                       ConversationMessage.deleted_at.is_(None))
                .order_by(ConversationMessage.id.desc())):  # fmt: skip
            replies[r.reply_to_id] = r  # type: ignore[index]  # the first answer wins
    msgs = [*said.values(), *replies.values()]
    out_msgs = {m.id: d for m, d in zip(msgs, await store.messages_dicts(
        db, msgs, ctx.settings.label_ai_generated), strict=True)}  # fmt: skip
    action_pks = [r.id for r in rows if r.kind == "action"]
    acts: list[Action] = []
    if action_pks:
        acts = list(await db.scalars(select(Action).where(Action.id.in_(action_pks))))
    out_acts = {a.id: d for a, d in zip(acts, await actions_dicts(db, acts, datetime.now(UTC)),
                                        strict=True)}  # fmt: skip
    entries: list[HistoryEntryOut] = []
    for r in rows:
        if r.kind == "turn":
            m = said[r.id]
            reply = replies.get(m.id)
            answer = out_msgs.get(reply.id) if reply is not None else None
            action = (answer or {}).get("action")
            entries.append(HistoryEntryOut(
                id=m.public_id, kind="turn", status=_status(action, answer), at=m.created_at,
                said=ChatMessageOut.model_validate(out_msgs[m.id]),
                answer=ChatMessageOut.model_validate(answer) if answer else None,
                action=ActionOut.model_validate(action) if action else None))  # fmt: skip
        else:
            d = out_acts[r.id]
            entries.append(HistoryEntryOut(
                id=uuid.UUID(d["id"]), kind="action", status=_status(d, None), at=r.at,
                said=None, answer=None, action=ActionOut.model_validate(d)))  # fmt: skip
    return HistoryOut(entries=entries, has_more=more)
