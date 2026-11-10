"""«Что я сделал»: write an action, add to it within one chat turn, undo it (spec 3.7, R-31).

Short transactions only; the caller commits. Contract of the JSON: docs/api/actions.md.
"""

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.actions import engine
from assistant.db.models_actions import UNDO_DAYS, Action, Initiator
from assistant.db.models_chat import ConversationMessage
from assistant.db.models_pages import Screen

TEXT_PARTIAL = "Часть уже изменена вами — вернул остальное."
MAX_CHANGES = 500  # «Что изменилось» rows kept per action


class ActionNotFound(LookupError):
    pass


class UndoExpired(Exception):
    pass


def row_id(change: dict[str, Any]) -> str | None:
    """What «Вернуть» on a «Что изменилось» row names: the record, or the view setting's key."""
    return change.get("item_id") or change.get("key")


def is_undoable(a: Action, now: datetime) -> bool:
    return (a.undone_at is None and bool(a.inverse) and a.undoable_until is not None
            and now < a.undoable_until)  # fmt: skip


async def record(session: AsyncSession, *, user_id: int, kind: str, initiated_by: str,
                 summary: dict[str, Any], changes: list[dict[str, Any]],
                 inverse: list[dict[str, Any]], now: datetime, screen_id: int | None = None,
                 message_id: int | None = None, source_item_ids: list[int] | None = None,
                 undo_of: int | None = None, client_id: uuid.UUID | None = None,
                 extra: dict[str, Any] | None = None) -> Action:  # fmt: skip
    engine.validate(inverse)
    action = Action(
        user_id=user_id, kind=kind, initiated_by=initiated_by, summary=summary,
        payload={"changes": changes[:MAX_CHANGES], "reverted": [], **(extra or {})},
        inverse=inverse, undoable_until=now + timedelta(days=UNDO_DAYS) if inverse else None,
        undo_of_action_id=undo_of, source_item_ids=list(source_item_ids or []),
        screen_id=screen_id, message_id=message_id, client_id=client_id,
    )  # fmt: skip
    session.add(action)
    await session.flush()
    return action


async def extend(session: AsyncSession, action_id: int, *, summary: dict[str, Any],
                 changes: list[dict[str, Any]], inverse: list[dict[str, Any]],
                 source_item_ids: list[int] | None = None) -> Action:  # fmt: skip
    """One chat turn = one action (spec 5.10 rule 3): a later change of the same turn joins it.
    Its undo runs first (newest first)."""
    engine.validate(inverse)
    action = await session.get(Action, action_id, with_for_update=True)
    assert action is not None
    action.summary = summary
    action.payload = {**action.payload,
                      "changes": [*action.payload.get("changes", []), *changes][:MAX_CHANGES]}
    action.inverse = [*inverse, *action.inverse]
    if inverse and action.undoable_until is None:
        action.undoable_until = action.created_at + timedelta(days=UNDO_DAYS)
    action.source_item_ids = list(dict.fromkeys([*action.source_item_ids,
                                                 *(source_item_ids or [])]))  # fmt: skip
    return action


@dataclass
class UndoResult:
    action: Action  # the action undone, as it is now
    undo: Action  # the new action that did it («Вернуть» undoes this one)
    partial: bool
    repeated: bool
    pages: set[int]
    items: set[str]


async def undo(session: AsyncSession, user_id: int, action_id: uuid.UUID, *, now: datetime,
               item_ids: list[uuid.UUID] | None = None, keys: list[str] | None = None,
               client_id: uuid.UUID | None = None) -> UndoResult:  # fmt: skip
    """Run the action's `inverse` (all of it, or the rows of some items: «Вернуть» in «Что
    изменилось»; a view setting is named by its row `key`, week 11).
    Idempotent: a repeat (same `client_id`, or an action already undone) returns
    the first result and changes nothing."""
    if client_id is not None:
        done = await session.scalar(select(Action).where(Action.user_id == user_id,
                                                         Action.client_id == client_id))
        if done is not None and done.undo_of_action_id is not None:
            target = await session.get(Action, done.undo_of_action_id)
            if target is not None and target.public_id == action_id:
                return UndoResult(target, done, False, True, set(), set())
    action = await session.scalar(
        select(Action).where(Action.user_id == user_id, Action.public_id == action_id)
        .with_for_update()
    )  # fmt: skip
    if action is None:
        raise ActionNotFound(str(action_id))
    if action.undone_at is not None:
        last = await session.scalar(select(Action).where(Action.undo_of_action_id == action.id)
                                    .order_by(Action.id.desc()).limit(1))  # fmt: skip
        if last is not None:
            return UndoResult(action, last, False, True, set(), set())
    if not is_undoable(action, now):
        raise UndoExpired(str(action_id))
    reverted = set(action.payload.get("reverted") or [])
    only = {str(i) for i in item_ids or []} | set(keys or []) if item_ids or keys else None
    ops = engine.select_ops(action.inverse, only=only, without=reverted)
    out = await engine.apply(session, user_id, ops, by=Initiator.USER, check=True, now=now)
    changes = [c for c in action.payload.get("changes", [])
               if only is None or row_id(c) in only]  # fmt: skip
    ru = (action.summary or {}).get("ru") or ""
    undo_action = await record(
        session, user_id=user_id, kind=action.kind, initiated_by=Initiator.USER,
        summary={"ru": "Отменено: " + ru[:1].lower() + ru[1:] if ru else "Отменено", "kk": None},
        changes=changes, inverse=out.inverse, now=now, screen_id=action.screen_id,
        undo_of=action.id, client_id=client_id,
    )  # fmt: skip
    all_items = {row_id(c) for c in action.payload.get("changes", []) if row_id(c)}
    if only is None:
        action.undone_at = now
    else:
        reverted |= only
        action.payload = {**action.payload, "reverted": sorted(reverted)}
        if all_items and all_items <= reverted:
            action.undone_at = now
    if action.undone_at is not None:
        # rows whose status is read from this action («undone»): a new `seq`, so /v1/sync
        # brings them again (week 13 statement plans and expense repeats, 0020)
        for table in ("statement_imports", "expense_duplicates"):
            await session.execute(text(f"UPDATE {table} SET user_id = user_id "
                                       "WHERE action_id = :a"), {"a": action.id})  # fmt: skip
    return UndoResult(action, undo_action, out.skipped > 0, False, out.pages, out.items)


async def actions_dicts(session: AsyncSession, rows: list[Action],
                        now: datetime) -> list[dict[str, Any]]:  # fmt: skip
    screens = {s for a in rows for s in (a.screen_id,) if s}
    pages: dict[int, dict[str, Any]] = {}
    if screens:
        for pk, pid, title, icon in await session.execute(
                select(Screen.id, Screen.public_id, Screen.title, Screen.icon)
                .where(Screen.id.in_(screens))):  # fmt: skip
            pages[pk] = {"id": str(pid), "title": title, "icon": icon}
    msgs: dict[int, uuid.UUID] = {}
    mids = {a.message_id for a in rows if a.message_id}
    if mids:
        msgs = dict((await session.execute(
            select(ConversationMessage.id, ConversationMessage.public_id)
            .where(ConversationMessage.id.in_(mids)))).all())  # type: ignore[arg-type]  # fmt: skip
    undo_of: dict[int, uuid.UUID] = {}
    oids = {a.undo_of_action_id for a in rows if a.undo_of_action_id}
    if oids:
        undo_of = dict((await session.execute(
            select(Action.id, Action.public_id).where(Action.id.in_(oids)))).all())  # type: ignore[arg-type]  # fmt: skip
    out = []
    for a in rows:
        reverted = set(a.payload.get("reverted") or [])
        changes = [{**c, "reverted": row_id(c) in reverted}
                   for c in a.payload.get("changes", [])]  # fmt: skip
        out.append({
            "id": str(a.public_id), "kind": a.kind, "scope": a.scope,
            "initiated_by": a.initiated_by,
            "summary": {"ru": (a.summary or {}).get("ru") or "",
                        "kk": (a.summary or {}).get("kk")},
            "page": pages.get(a.screen_id) if a.screen_id else None,
            "changes": changes,
            "changed_item_ids": list(dict.fromkeys(c["item_id"] for c in changes
                                                   if c.get("item_id"))),
            "created_page_id": a.payload.get("created_page_id"),
            "undoable": is_undoable(a, now),
            "undoable_until": a.undoable_until.isoformat() if a.undoable_until else None,
            "undone_at": a.undone_at.isoformat() if a.undone_at else None,
            "undo_of": str(undo_of[a.undo_of_action_id]) if a.undo_of_action_id in undo_of
            else None,
            "message_id": str(msgs[a.message_id]) if a.message_id in msgs else None,
            "seq": a.seq,
            "created_at": a.created_at.isoformat(),
        })  # fmt: skip
    return out
