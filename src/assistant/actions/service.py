"""«Что я сделал»: write an action, add to it within one chat turn, undo it (spec 3.7, R-31).

Short transactions only; the caller commits. Contract of the JSON: docs/api/actions.md.
"""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.actions import engine
from assistant.db.models_actions import UNDO_DAYS, Action, Initiator
from assistant.db.models_chat import ConversationMessage
from assistant.db.models_pages import Screen
from assistant.records import clear_marks, set_marks

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
    await _marks(session, action, changes, now)
    return action


def _marked_ids(changes: list[dict[str, Any]]) -> list[str]:
    """Records an action names (a record put in the trash is not shown: no mark)."""
    return [str(c["item_id"]) for c in changes[:MAX_CHANGES]
            if c.get("item_id") and c.get("kind") != "trash"]  # fmt: skip


async def _marks(session: AsyncSession, action: Action, changes: list[dict[str, Any]],
                 now: datetime) -> None:  # fmt: skip
    """Ф-73 «изменил помощник»: the assistant's change marks its records for 24 h; the person's
    change clears the mark (an undo clears only the marks of the action it undid)."""
    ids = [str(c["item_id"]) for c in changes[:MAX_CHANGES] if c.get("item_id")]
    if not ids:
        return
    if action.initiated_by == Initiator.AGENT:
        await set_marks(session, action.user_id, _marked_ids(changes), action.public_id, now)
        return
    undone = None
    if action.undo_of_action_id is not None:
        undone = await session.scalar(select(Action.public_id)
                                      .where(Action.id == action.undo_of_action_id))
    await clear_marks(session, action.user_id, ids, action_id=undone)


async def extend(session: AsyncSession, action_id: int, *, summary: dict[str, Any],
                 changes: list[dict[str, Any]], inverse: list[dict[str, Any]],
                 source_item_ids: list[int] | None = None,
                 now: datetime | None = None) -> Action:  # fmt: skip
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
    await _marks(session, action, changes, now or datetime.now(UTC))
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


async def saved_to(session: AsyncSession,
                   rows: list[Action]) -> dict[int, list[dict[str, Any]]]:  # fmt: skip
    """Ф-50 «Сохранил в «…» · Переложить»: per action, the live pages its new records (rows with
    `kind: "create"`) are on now, in tab order, with those records. Read live, so after
    «Переложить» or «Отменить» it says where they are (or nothing)."""
    from assistant.db.models import Item
    from assistant.db.models_pages import ScreenItem, ScreenKind

    want: dict[int, list[str]] = {}
    for a in rows:
        ids = [str(c["item_id"]) for c in (a.payload or {}).get("changes", [])
               if c.get("kind") == "create" and c.get("item_id")]
        if ids:
            want[a.id] = list(dict.fromkeys(ids))
    pids = {uuid.UUID(i) for ids in want.values() for i in ids}
    if not pids:
        return {}
    found = (await session.execute(
        select(Item.public_id, Screen.public_id, Screen.title, Screen.icon, Screen.template_key)
        .join(ScreenItem, ScreenItem.item_id == Item.id)
        .join(Screen, Screen.id == ScreenItem.screen_id)
        .where(Item.public_id.in_(pids), Item.deleted_at.is_(None),
               ScreenItem.removed_by_user_at.is_(None), Screen.deleted_at.is_(None),
               Screen.kind == ScreenKind.PAGE)
        .order_by(Screen.position, Screen.public_id))).all()  # fmt: skip
    out: dict[int, list[dict[str, Any]]] = {}
    for aid, ids in want.items():
        pages: dict[str, dict[str, Any]] = {}
        for item_pid, page_pid, title, icon, key in found:
            if str(item_pid) not in ids:
                continue
            row = pages.setdefault(str(page_pid), {"page_id": str(page_pid), "title": title,
                                                   "icon": icon, "template_key": key,
                                                   "item_ids": []})  # fmt: skip
            row["item_ids"].append(str(item_pid))
        out[aid] = list(pages.values())
    return out


NOTICE_MS = 3000  # Ф-67 / Ф-75: every notice, «Удалено · Восстановить» too
NOTICE_CHARS = 80
_RU_RECORDS = ("запись", "записи", "записей")
_RU_SPENDS = ("трату", "траты", "трат")


def _plural(n: int, forms: tuple[str, str, str]) -> str:
    n100, n10 = n % 100, n % 10
    if n10 == 1 and n100 != 11:
        return forms[0]
    if 2 <= n10 <= 4 and not 12 <= n100 <= 14:
        return forms[1]
    return forms[2]


def _short(text_: str, limit: int = NOTICE_CHARS) -> str:
    text_ = " ".join(text_.split()).rstrip(".")
    return text_ if len(text_) <= limit else text_[:limit - 1].rstrip() + "…"


def _target(c: dict[str, Any] | None, page_id: str | None) -> dict[str, Any] | None:
    """Where a tap on the notice goes: the expense / task / record, else the page."""
    if c is None:
        return {"kind": "page", "id": page_id, "page_id": page_id} if page_id else None
    page_id = page_id or c.get("page_id")
    for key, kind in (("expense_id", "expense"), ("task_id", "task"),
                      ("document_id", "document"), ("reminder_id", "reminder")):  # fmt: skip
        if c.get(key):
            return {"kind": kind, "id": str(c[key]), "page_id": page_id}
    if c.get("item_id"):
        return {"kind": "item", "id": str(c["item_id"]), "page_id": page_id}
    if page_id:
        return {"kind": "page", "id": page_id, "page_id": page_id}
    return None


def notice(a: Action, where: list[dict[str, Any]], *, undoable: bool,
           page_id: str | None) -> dict[str, Any]:  # fmt: skip
    """The 3-second notice (Ф-65…Ф-67, design-system §10.2): one short line, where a tap goes,
    and the label of its button (`Восстановить` after a trash, `Вернуть` after an undo)."""
    changes = list((a.payload or {}).get("changes") or [])
    rows = [c for c in changes if c.get("kind") != "create_page"]
    kinds = {c.get("kind") for c in rows}
    summary = (a.summary or {}).get("ru") or ""
    first = rows[0] if rows else None
    label = "Отменить"
    if a.undo_of_action_id is not None:
        text_, label = "Вернул как было", "Вернуть"
    elif kinds == {"trash"}:
        n = len(rows)
        text_ = (f"Удалил «{_short(str(first.get('title') or ''), 50)}»" if n == 1  # type: ignore[union-attr]
                 else f"Удалил {n} {_plural(n, _RU_RECORDS)}")  # fmt: skip
        label = "Восстановить"
        first = {**first, "page_id": None} if first else None  # it is in the trash now
        page_id = None
    elif kinds == {"create"} and where:
        made = [c for c in rows if c.get("kind") == "create"]
        page, n = where[0], len(made)
        forms = _RU_SPENDS if a.kind in ("create_expense", "bulk_create_expenses") else _RU_RECORDS
        what = ("трату " if forms is _RU_SPENDS else "") if n == 1 else f"{n} {_plural(n, forms)} "
        text_ = f"Записал {what}в «{page['title']}»"
        if (a.payload or {}).get("parsed_later"):  # Ф-69: a note read once the model was back
            text_ = f"Разобрал: перенёс в «{page['title']}»"
        elif (a.payload or {}).get("parse_later"):  # Ф-69: saved while the model was down
            text_ = "Сохранил как заметку, разберу позже"
        first = next((c for c in made if str(c.get("item_id")) in page["item_ids"]), first)
        page_id = page["page_id"]
    elif a.kind == "edit_expense":
        text_ = "Обновил трату"
    else:
        text_ = _short(summary) or "Готово"
    return {"text_ru": text_, "text_kk": None, "target": _target(first, page_id),
            "undo_label_ru": label if undoable else None, "undo_label_kk": None,
            "ms": NOTICE_MS}  # fmt: skip


_RU_DEEDS = ("дело", "дела", "дел")


async def _groups(session: AsyncSession, mids: set[int],
                  now: datetime) -> dict[int, list[Action]]:  # fmt: skip
    """Step 6: the actions of one phrase (same `message_id`), oldest first."""
    if not mids:
        return {}
    rows = await session.scalars(select(Action).where(
        Action.message_id.in_(mids), Action.undo_of_action_id.is_(None)).order_by(Action.id))
    out: dict[int, list[Action]] = {}
    for a in rows:
        out.setdefault(a.message_id, []).append(a)  # type: ignore[arg-type]
    return out


def group_id_of(a: Action) -> str | None:
    """Step 8: the group of one tap («Сделать делами»), kept in the payload."""
    gid = (a.payload or {}).get("group_id")
    return str(gid) if gid else None


async def _tap_groups(session: AsyncSession, rows: list[Action]) -> dict[str, list[Action]]:
    """Step 8: the actions of one tap group (`payload.group_id`), oldest first."""
    gids = {g for a in rows if (g := group_id_of(a))}
    if not gids:
        return {}
    users = {a.user_id for a in rows}
    found = await session.scalars(select(Action).where(
        Action.user_id.in_(users), Action.payload["group_id"].astext.in_(gids),
        Action.undo_of_action_id.is_(None)).order_by(Action.id))  # fmt: skip
    out: dict[str, list[Action]] = {}
    for a in found:
        out.setdefault(group_id_of(a) or "", []).append(a)
    return out


def _tap_group_of(members: list[Action] | None, gid: str, a: Action,
                  now: datetime) -> dict[str, Any] | None:  # fmt: skip
    """A tap group is shown whatever its size: the phone undoes it by its id."""
    if not members:
        return None
    ids = [m.id for m in members]
    return {"id": gid, "size": len(members), "index": ids.index(a.id) if a.id in ids else None,
            "action_ids": [str(m.public_id) for m in members],
            "notice": group_notice(members, now)}  # fmt: skip


_RU_TASKS = ("дело", "дела", "дел")
_RU_REMINDERS = ("напоминание", "напоминания", "напоминаний")


def counts_text(counts: dict[str, Any]) -> str:
    """«5 дел и 2 напоминания» (a plan made into tasks, plans.md)."""
    parts = []
    for key, forms in (("tasks", _RU_TASKS), ("reminders", _RU_REMINDERS)):
        n = int(counts.get(key) or 0)
        if n:
            parts.append(f"{n} {_plural(n, forms)}")
    return " и ".join(parts)


def group_notice(members: list[Action], now: datetime) -> dict[str, Any]:
    """«Сделал 3 дела · Отменить всё» (one notice for one phrase, design-system §10.1). A group
    made by one tap (step 8 «Сделать делами») says what it made: «Сделал 5 дел и 2 напоминания»."""
    n = len(members)
    live = [a for a in members if a.undone_at is None]
    counts = next(((a.payload or {}).get("group_counts") for a in members
                   if (a.payload or {}).get("group_counts")), None)  # fmt: skip
    what = (counts_text(counts) if counts else "") or f"{n} {_plural(n, _RU_DEEDS)}"
    text_ = f"Сделал {what}" if live else f"Отменено: {what}"
    any_undo = any(is_undoable(a, now) for a in members)
    return {"text_ru": text_, "text_kk": None, "target": None,
            "undo_label_ru": "Отменить всё" if any_undo else None, "undo_label_kk": None,
            "ms": NOTICE_MS}  # fmt: skip


def _group_of(members: list[Action] | None, message_id: uuid.UUID | None,
              a: Action, now: datetime) -> dict[str, Any] | None:  # fmt: skip
    """Null unless the phrase made more than one action."""
    if not members or len(members) < 2 or message_id is None:
        return None
    ids = [m.id for m in members]
    return {"id": str(message_id), "size": len(members),
            "index": ids.index(a.id) if a.id in ids else None,
            "action_ids": [str(m.public_id) for m in members],
            "notice": group_notice(members, now)}  # fmt: skip


@dataclass
class GroupUndo:
    results: list[UndoResult]
    failed: list[Action]
    partial: bool
    pages: set[int]
    items: set[str]


TEXT_GROUP_FAILED = "Вернул {done} из {n}: остальное уже нельзя отменить."


async def undo_group(session: AsyncSession, user_id: int, group_id: uuid.UUID, *,
                     now: datetime, client_id: uuid.UUID | None = None) -> GroupUndo:
    """«Отменить всё» of one phrase (step 6): every action of the phrase, newest first, in one
    transaction; each in a savepoint, so one that cannot be undone any more (30 days, nothing
    left) is reported and the others still go back. Idempotent like `undo`."""
    msg = await session.scalar(select(ConversationMessage.id).where(
        ConversationMessage.user_id == user_id, ConversationMessage.public_id == group_id))
    if msg is not None:
        members = list(await session.scalars(select(Action).where(
            Action.user_id == user_id, Action.message_id == msg,
            Action.undo_of_action_id.is_(None)).order_by(Action.id.desc())))  # fmt: skip
    else:  # step 8: a group made by one tap (no chat answer), `payload.group_id`
        members = list(await session.scalars(select(Action).where(
            Action.user_id == user_id, Action.payload["group_id"].astext == str(group_id),
            Action.undo_of_action_id.is_(None)).order_by(Action.id.desc())))  # fmt: skip
    if not members:
        raise ActionNotFound(str(group_id))
    out = GroupUndo([], [], False, set(), set())
    for a in members:
        cid = uuid.uuid5(client_id, str(a.public_id)) if client_id else None
        try:
            async with session.begin_nested():
                res = await undo(session, user_id, a.public_id, now=now, client_id=cid)
        except (ActionNotFound, UndoExpired):
            out.failed.append(a)
            continue
        out.results.append(res)
        out.partial |= res.partial
        out.pages |= res.pages
        out.items |= res.items
    return out


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
    where = await saved_to(session, rows)
    groups = await _groups(session, mids, now)
    taps = await _tap_groups(session, rows)
    out = []
    for a in rows:
        reverted = set(a.payload.get("reverted") or [])
        changes = [{**c, "reverted": row_id(c) in reverted}
                   for c in a.payload.get("changes", [])]  # fmt: skip
        undoable = is_undoable(a, now)
        page = pages.get(a.screen_id) if a.screen_id else None
        out.append({
            "id": str(a.public_id), "kind": a.kind, "scope": a.scope,
            "initiated_by": a.initiated_by,
            "summary": {"ru": (a.summary or {}).get("ru") or "",
                        "kk": (a.summary or {}).get("kk")},
            "page": page,
            "changes": changes,
            "changed_item_ids": list(dict.fromkeys(c["item_id"] for c in changes
                                                   if c.get("item_id"))),
            "created_page_id": a.payload.get("created_page_id"),
            "saved_to": where.get(a.id, []),
            "parsed_later": bool(a.payload.get("parsed_later")),
            "notice": notice(a, where.get(a.id, []), undoable=undoable,
                             page_id=a.payload.get("created_page_id")
                             or (page["id"] if page else None)),
            "undoable": undoable,
            "undoable_until": a.undoable_until.isoformat() if a.undoable_until else None,
            "undone_at": a.undone_at.isoformat() if a.undone_at else None,
            "undo_of": str(undo_of[a.undo_of_action_id]) if a.undo_of_action_id in undo_of
            else None,
            "message_id": str(msgs[a.message_id]) if a.message_id in msgs else None,
            "group": (_tap_group_of(taps.get(gid), gid, a, now) if (gid := group_id_of(a))
                      else _group_of(groups.get(a.message_id or 0), msgs.get(a.message_id or 0),
                                     a, now)),
            # step 8: the «План» card of a plan this action made or changed (plans.md)
            "plan": {**a.payload["plan_card"], "action_id": str(a.public_id)}
            if a.payload.get("plan_card") else None,
            "seq": a.seq,
            "created_at": a.created_at.isoformat(),
        })  # fmt: skip
    return out
