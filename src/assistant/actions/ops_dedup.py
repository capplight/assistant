"""Engine ops for repeats and stacks (week 10; spec 3.7, 6.3, 6.4). Registered in `engine`.

- `hide_item` {item, canonical}: the record is hidden as a repeat of `canonical`
  (`hidden_reason=duplicate_merged`); the paragraphs it has and `canonical` lacks go into
  `canonical.merged_fragments` («Было в повторах»), the text of `canonical` stays. Undo:
  `unhide_item`.
- `unhide_item` {item, exact?}: visible again, its fragment leaves the canonical. `exact=true`
  (an automatic exact merge taken back) also marks it «never auto-merge again», like /unmerge,
  and brings its original file back from the trash.
- `relink` {item, keep, back, reminders?, collections?, pages?}: `back=false` moves what pointed to
  the repeat to the record kept: its reminders, its stacks, and its pages (the kept record is shown
  where the repeat was). The undo (`back=true`) moves exactly those back.
- `set_status` {entity: duplicate_groups, id, value, undo_value?, expect?}: a group's status.
- `add_collection_item` / `remove_collection_item` {collection, item, by_user?}: stack members.
  Removing with `by_user` keeps the row as «убрано» (rules do not add it again).
- `restore_collection` {id, state: {title, icon, hidden_at, deleted_at}, expect?}: a stack's
  name, icon, and whether it is hidden or removed.
"""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from assistant.actions.engine import Outcome, _items, _uuid
from assistant.db.models import Item, Reminder
from assistant.db.models_dedup import Collection, CollectionItem, DuplicateGroup
from assistant.db.models_pages import AddedBy, Screen, ScreenItem, ScreenKind
from assistant.db.models_v2 import FileState, HiddenReason
from assistant.pages import add_link

GROUP_STATUSES = frozenset({"auto_merged", "suggested", "merged", "dismissed", "undone"})


def fragment_of(item: Item, keep: Item, now: datetime) -> dict[str, Any]:
    from assistant.dedup.similarity import paragraphs_missing  # dedup imports actions

    occurred = item.occurred_at or item.created_at or now
    extra = paragraphs_missing(keep.text, item.text)
    frag: dict[str, Any] = {"item_id": str(item.public_id), "kind": str(item.kind),
                            "source": str(item.source), "occurred_at": occurred.isoformat(),
                            "merged_at": now.isoformat()}  # fmt: skip
    if item.title and item.title != keep.title:
        frag["title"] = item.title
    if extra:
        frag["paragraphs"] = extra[:20]
    return frag


async def _hide(session: AsyncSession, user_id: int, op: dict, out: Outcome, *,
                by: str, check: bool, now: datetime) -> None:  # fmt: skip
    rid, cid = str(op["item"]), str(op["canonical"])
    items = await _items(session, user_id, [rid, cid])
    item, keep = items.get(rid), items.get(cid)
    if item is None or keep is None or item.id == keep.id:
        out.skipped += 1
        return
    if item.hidden_reason == HiddenReason.DUPLICATE_MERGED and item.canonical_item_id == keep.id:
        return
    if item.hidden_reason is not None or item.deleted_at is not None \
            or keep.hidden_reason is not None or keep.deleted_at is not None:  # fmt: skip
        out.skipped += 1  # gone or hidden meanwhile: nothing to merge
        return
    item.hidden_reason = HiddenReason.DUPLICATE_MERGED
    item.canonical_item_id = keep.id
    if check:  # an undo of an unmerge: the person's flag goes with it
        meta = dict(item.source_meta or {})
        meta.pop("unmerged", None)
        item.source_meta = meta
    keep.merged_fragments = [*[f for f in keep.merged_fragments or []
                               if f.get("item_id") != rid], fragment_of(item, keep, now)]
    out.inverse.append({"op": "unhide_item", "item": rid, "exact": bool(op.get("exact"))})
    out.items |= {rid, cid}


async def _unhide(session: AsyncSession, user_id: int, op: dict, out: Outcome, *,
                  by: str, check: bool, now: datetime) -> None:  # fmt: skip
    from assistant.memory import enqueue_embed
    from assistant.records import enqueue_ingest, original_file

    rid = str(op["item"])
    item = (await _items(session, user_id, [rid])).get(rid)
    if item is None:
        out.skipped += 1
        return
    if item.hidden_reason != HiddenReason.DUPLICATE_MERGED or item.canonical_item_id is None:
        if item.hidden_reason is not None:
            out.skipped += 1
        return
    keep = await session.get(Item, item.canonical_item_id, with_for_update=True)
    item.hidden_reason = None
    item.canonical_item_id = None
    if keep is not None:
        keep.merged_fragments = [f for f in keep.merged_fragments or []
                                 if f.get("item_id") != rid]  # fmt: skip
        out.items.add(str(keep.public_id))
        out.inverse.append({"op": "hide_item", "item": rid, "canonical": str(keep.public_id),
                            "exact": bool(op.get("exact"))})  # fmt: skip
    if op.get("exact"):
        item.source_meta = {**(item.source_meta or {}), "unmerged": True}
        file = await original_file(session, item.id, lock=True)
        if file is not None and file.state == FileState.TRASH:
            file.state, file.trash_until = FileState.ACTIVE, None
        if item.text is None and file is not None:
            await enqueue_ingest(session, item, suffix=f":unmerge:{uuid.uuid4().hex[:12]}")
    if item.text is not None:
        await enqueue_embed(session, item)
    out.items.add(rid)


async def _relink(session: AsyncSession, user_id: int, op: dict, out: Outcome, *,
                  by: str, check: bool, now: datetime) -> None:  # fmt: skip
    rid, kid = str(op["item"]), str(op["keep"])
    items = await _items(session, user_id, [rid, kid])
    item, keep = items.get(rid), items.get(kid)
    if item is None or keep is None:
        out.skipped += 1
        return
    back = bool(op.get("back"))
    src, dst = (keep, item) if back else (item, keep)
    # reminders
    q = select(Reminder).where(Reminder.user_id == user_id, Reminder.item_id == src.id)
    if back:
        ids = [_uuid(x) for x in op.get("reminders") or []]
        q = q.where(Reminder.public_id.in_(ids)) if ids else q.where(False)
    rems = list(await session.scalars(q.with_for_update()))
    for r in rems:
        r.item_id = dst.id
    # stacks: the kept record joins the repeat's stacks (and leaves them again on undo)
    added_cols: list[str] = []
    if back:
        cols = [_uuid(x) for x in op.get("collections") or []]
        if cols:
            pks = list(await session.scalars(select(Collection.id).where(
                Collection.user_id == user_id, Collection.public_id.in_(cols))))  # fmt: skip
            await session.execute(delete(CollectionItem).where(
                CollectionItem.collection_id.in_(pks), CollectionItem.item_id == keep.id))
    else:
        other = aliased(CollectionItem)
        rows = await session.execute(
            select(Collection.id, Collection.public_id)
            .join(CollectionItem, CollectionItem.collection_id == Collection.id)
            .where(CollectionItem.item_id == item.id, CollectionItem.removed_by_user_at.is_(None),
                   Collection.deleted_at.is_(None),
                   ~select(other.item_id).where(other.collection_id == Collection.id,
                                                other.item_id == keep.id).exists())
        )  # fmt: skip
        for pk, pid in rows:
            session.add(CollectionItem(collection_id=pk, item_id=keep.id, added_by="agent"))
            added_cols.append(str(pid))
    # pages: the kept record is shown where the repeat was
    added_pages: list[str] = []
    if back:
        pids = [_uuid(x) for x in op.get("pages") or []]
        if pids:
            pks = list(await session.scalars(select(Screen.id).where(
                Screen.user_id == user_id, Screen.public_id.in_(pids))))  # fmt: skip
            gone = delete(ScreenItem).where(ScreenItem.screen_id.in_(pks),
                                            ScreenItem.item_id == keep.id)
            if check:  # a row the person moved by hand since stays
                gone = gone.where(~((ScreenItem.updated_by == "user")
                                    & ScreenItem.manual_order.is_(True)))  # fmt: skip
            await session.execute(gone)
            out.pages |= set(pks)
    else:
        pages = list(await session.scalars(
            select(Screen).join(ScreenItem, ScreenItem.screen_id == Screen.id)
            .where(ScreenItem.item_id == item.id, ScreenItem.removed_by_user_at.is_(None),
                   Screen.deleted_at.is_(None), Screen.kind != ScreenKind.SYSTEM_TODAY)
        ))  # fmt: skip
        for page in pages:
            if await add_link(session, page, keep.id, keep.occurred_at or keep.created_at,
                              AddedBy.AGENT):  # fmt: skip
                added_pages.append(str(page.public_id))
                out.pages.add(page.id)
    out.inverse.append({"op": "relink", "item": rid, "keep": kid, "back": not back,
                        "reminders": [str(r.public_id) for r in rems],
                        "collections": added_cols, "pages": added_pages})  # fmt: skip
    out.items |= {rid, kid}


async def _set_status(session: AsyncSession, user_id: int, op: dict, out: Outcome, *,
                      by: str, check: bool, now: datetime) -> None:  # fmt: skip
    if op.get("entity") != "duplicate_groups" or op.get("value") not in GROUP_STATUSES:
        raise ValueError("set_status: entity/value not allowed")
    g = await session.scalar(select(DuplicateGroup).where(
        DuplicateGroup.user_id == user_id, DuplicateGroup.public_id == _uuid(op["id"]))
        .with_for_update())  # fmt: skip
    if g is None:
        out.skipped += 1
        return
    if check and op.get("expect") and g.status != op["expect"]:
        out.skipped += 1
        return
    if g.status == op["value"]:
        return
    back = op.get("undo_value") or g.status
    out.inverse.append({"op": "set_status", "entity": "duplicate_groups", "id": str(g.public_id),
                        "value": back, "expect": op["value"]})  # fmt: skip
    g.status = op["value"]
    g.decided_at = now


async def _collection(session: AsyncSession, user_id: int, cid: Any) -> Collection | None:
    return await session.scalar(select(Collection).where(
        Collection.user_id == user_id, Collection.public_id == _uuid(cid)).with_for_update())


async def _add_member(session: AsyncSession, user_id: int, op: dict, out: Outcome, *,
                      by: str, check: bool, now: datetime) -> None:  # fmt: skip
    col = await _collection(session, user_id, op["collection"])
    rid = str(op["item"])
    item = (await _items(session, user_id, [rid])).get(rid)
    if col is None or item is None:
        out.skipped += 1
        return
    row = await session.get(CollectionItem, (col.id, item.id), with_for_update=True)
    if row is not None and row.removed_by_user_at is None:
        return
    if row is None:
        session.add(CollectionItem(collection_id=col.id, item_id=item.id,
                                   added_by="user" if by == "user" else "agent"))  # fmt: skip
        out.inverse.append({"op": "remove_collection_item", "collection": str(col.public_id),
                            "item": rid, "by_user": False})  # fmt: skip
    else:
        row.removed_by_user_at = None
        out.inverse.append({"op": "remove_collection_item", "collection": str(col.public_id),
                            "item": rid, "by_user": True})  # fmt: skip
    col.updated_at = now
    out.items.add(rid)


async def _remove_member(session: AsyncSession, user_id: int, op: dict, out: Outcome, *,
                         by: str, check: bool, now: datetime) -> None:  # fmt: skip
    col = await _collection(session, user_id, op["collection"])
    rid = str(op["item"])
    item = (await _items(session, user_id, [rid])).get(rid)
    if col is None or item is None:
        out.skipped += 1
        return
    row = await session.get(CollectionItem, (col.id, item.id), with_for_update=True)
    if row is None or row.removed_by_user_at is not None:
        return
    out.inverse.append({"op": "add_collection_item", "collection": str(col.public_id),
                        "item": rid})  # fmt: skip
    if op.get("by_user"):
        row.removed_by_user_at = now
    else:
        await session.delete(row)
    col.updated_at = now
    out.items.add(rid)


COLLECTION_FIELDS = ("title", "icon", "hidden_at", "deleted_at")


def collection_state(col: Collection) -> dict[str, Any]:
    return {"title": col.title, "icon": col.icon,
            "hidden_at": col.hidden_at.isoformat() if col.hidden_at else None,
            "deleted_at": col.deleted_at.isoformat() if col.deleted_at else None}  # fmt: skip


async def _restore_collection(session: AsyncSession, user_id: int, op: dict, out: Outcome, *,
                              by: str, check: bool, now: datetime) -> None:  # fmt: skip
    col = await _collection(session, user_id, op["id"])
    if col is None:
        out.skipped += 1
        return
    cur = collection_state(col)
    if check and op.get("expect") and op["expect"] != cur:
        out.skipped += 1
        return
    new = {k: v for k, v in (op.get("state") or {}).items() if k in COLLECTION_FIELDS}
    if all(cur[k] == v for k, v in new.items()):
        return
    out.inverse.append({"op": "restore_collection", "id": str(col.public_id),
                        "state": {k: cur[k] for k in new}, "expect": {**cur, **new}})
    old_title = col.title
    for k, v in new.items():
        if k in ("hidden_at", "deleted_at"):
            setattr(col, k, datetime.fromisoformat(v) if v else None)
        else:
            setattr(col, k, v)
    col.updated_at = now
    if col.screen_id is not None and col.title != old_title:  # the group on the page follows
        await session.execute(update(ScreenItem).where(
            ScreenItem.screen_id == col.screen_id, ScreenItem.group_key == old_title)
            .values(group_key=col.title).execution_options(synchronize_session=False))
        page = await session.get(Screen, col.screen_id, with_for_update=True)
        if page is not None:
            view = dict(page.view_state or {})
            view["groups"] = [col.title if g == old_title else g for g in view.get("groups", [])]
            page.view_state = view
            out.pages.add(page.id)


HANDLERS = {
    "hide_item": _hide,
    "unhide_item": _unhide,
    "relink": _relink,
    "set_status": _set_status,
    "add_collection_item": _add_member,
    "remove_collection_item": _remove_member,
    "restore_collection": _restore_collection,
}
