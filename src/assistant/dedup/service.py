"""Repeats the person decides on (spec 6.3 p. 1-4, 4.6): the record of an automatic exact merge,
«Объединить?» per group, «Это разные», the cleanup plan «37 → 1» behind one «Да».

Merging is code: the repeats are hidden behind the record kept, their extra paragraphs go into
its «Было в повторах», their reminders, stacks and pages move to it. Nothing is deleted; one
«Отменить» brings all of it back. Every function works in the caller's transaction.
"""

import hashlib
import secrets
import uuid
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import and_, delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from assistant.actions import engine, record
from assistant.db.models import Item
from assistant.db.models_actions import Action, ActionKind, Initiator
from assistant.db.models_dedup import (
    DupKind,
    DuplicateGroup,
    DuplicateGroupMember,
    DupOrigin,
    DupStatus,
)
from assistant.db.models_tasks import PendingAction, PendingStatus, Task
from assistant.db.models_v2 import HiddenReason, RecordKind
from assistant.dedup import similarity as sim
from assistant.dedup import texts
from assistant.pages import lock_user

PENDING_HOURS = 24
PREVIEW_CHARS = 300
CLEANUP_MAX_GROUPS = 2000


class DedupError(Exception):
    def __init__(self, status: int, code: str) -> None:
        super().__init__(code)
        self.status, self.code = status, code


# --- on save: the automatic exact merge gets its group and its action ---


async def record_exact_merge(s: AsyncSession, item: Item, canonical: Item,
                             now: datetime) -> Action:  # fmt: skip
    """`item` was just hidden as an exact repeat of `canonical` (records.merge_into). Writes
    `duplicate_groups(exact, auto_merged, on_save)` and the `auto_merge_exact` action whose
    «Отменить» is the same as POST /items/{id}/unmerge."""
    group = DuplicateGroup(user_id=item.user_id, kind=DupKind.EXACT, status=DupStatus.AUTO_MERGED,
                           keep_item_id=canonical.id, member_count=2, origin=DupOrigin.ON_SAVE,
                           decided_at=now)  # fmt: skip
    s.add(group)
    await s.flush()
    s.add_all([DuplicateGroupMember(group_id=group.id, item_id=canonical.id, role="keep"),
               DuplicateGroupMember(group_id=group.id, item_id=item.id, role="merge", score=1.0)])
    when = canonical.occurred_at or canonical.created_at or now
    sentence = f"Уже было — добавил к записи от {when:%d.%m}"
    action = await record(
        s, user_id=item.user_id, kind=ActionKind.AUTO_MERGE_EXACT, initiated_by=Initiator.AGENT,
        summary={"ru": sentence, "kk": None},
        changes=[{"item_id": str(item.public_id), "title": item.title or canonical.title or "",
                  "kind": "merge", "page_id": None,
                  "text": f"{texts.quote(item.title or canonical.title)} → уже было"}],
        inverse=[{"op": "unhide_item", "item": str(item.public_id), "exact": True},
                 {"op": "set_status", "entity": "duplicate_groups", "id": str(group.public_id),
                  "value": DupStatus.UNDONE, "expect": DupStatus.AUTO_MERGED}],
        now=now, source_item_ids=[item.id, canonical.id],
    )  # fmt: skip
    group.action_id = action.id
    return action


async def on_unmerged(s: AsyncSession, item: Item, now: datetime) -> None:
    """POST /items/{id}/unmerge took an automatic merge back: its group and action follow."""
    groups = list(await s.scalars(
        select(DuplicateGroup).join(DuplicateGroupMember,
                                    DuplicateGroupMember.group_id == DuplicateGroup.id)
        .where(DuplicateGroupMember.item_id == item.id, DuplicateGroupMember.role == "merge",
               DuplicateGroup.status == DupStatus.AUTO_MERGED).with_for_update()))  # fmt: skip
    for g in groups:
        g.status, g.decided_at = DupStatus.UNDONE, now
        if g.action_id is not None:
            a = await s.get(Action, g.action_id, with_for_update=True)
            if a is not None and a.undone_at is None:
                a.undone_at = now


async def exact_merge_action_id(s: AsyncSession, item: Item) -> uuid.UUID | None:
    return await s.scalar(
        select(Action.public_id).join(DuplicateGroup, DuplicateGroup.action_id == Action.id)
        .join(DuplicateGroupMember, DuplicateGroupMember.group_id == DuplicateGroup.id)
        .where(DuplicateGroupMember.item_id == item.id, DuplicateGroupMember.role == "merge",
               DuplicateGroup.kind == DupKind.EXACT)
        .order_by(DuplicateGroup.id.desc()).limit(1))  # fmt: skip


# --- groups as JSON (docs/api/duplicates.md) ---


def _visible(item: Item) -> bool:
    return item.deleted_at is None and item.hidden_reason is None


async def groups_dicts(s: AsyncSession, groups: list[DuplicateGroup]) -> list[dict[str, Any]]:
    if not groups:
        return []
    gids = [g.id for g in groups]
    rows = list(await s.execute(
        select(DuplicateGroupMember.group_id, DuplicateGroupMember.role,
               DuplicateGroupMember.score, Item)
        .join(Item, Item.id == DuplicateGroupMember.item_id)
        .where(DuplicateGroupMember.group_id.in_(gids))))  # fmt: skip
    actions = dict((await s.execute(select(Action.id, Action.public_id).where(
        Action.id.in_([g.action_id for g in groups if g.action_id])))).all())  # type: ignore[arg-type]
    by_group: dict[int, list[dict[str, Any]]] = {}
    keep_pub: dict[int, uuid.UUID] = {}
    for gid, role, score, it in rows:
        body = it.text if it.text is not None else it.raw_text
        if role == "keep":
            keep_pub[gid] = it.public_id
        by_group.setdefault(gid, []).append({
            "item_id": str(it.public_id), "role": role,
            "score": None if score is None else round(float(score), 3),
            "title": it.title, "preview": (body or "")[:PREVIEW_CHARS], "kind": str(it.kind),
            "source": str(it.source),
            "occurred_at": (it.occurred_at or it.created_at).isoformat(),
            "words": sim.completeness(body), "visible": _visible(it),
        })  # fmt: skip
    out = []
    for g in groups:
        members = sorted(by_group.get(g.id, []),
                         key=lambda m: (m["role"] != "keep", m["occurred_at"]), reverse=False)
        out.append({
            "id": str(g.public_id), "kind": g.kind, "status": g.status, "origin": g.origin,
            "keep_item_id": str(keep_pub[g.id]) if g.id in keep_pub else None,
            "keep_rule": g.keep_rule, "member_count": g.member_count, "members": members,
            "action_id": str(actions[g.action_id]) if g.action_id in actions else None,
            "seq": g.seq, "created_at": g.created_at.isoformat(),
            "decided_at": g.decided_at.isoformat() if g.decided_at else None,
        })  # fmt: skip
    return out


async def get_group(s: AsyncSession, user_id: int, gid: uuid.UUID, *,
                    lock: bool = False) -> DuplicateGroup:  # fmt: skip
    q = select(DuplicateGroup).where(DuplicateGroup.user_id == user_id,
                                     DuplicateGroup.public_id == gid)
    g = await s.scalar(q.with_for_update() if lock else q)
    if g is None:
        raise DedupError(404, "not_found")
    return g


# --- «Объединить?» → «Да» ---


def merge_ops(keep: Item, others: list[Item], *, exact: bool = False) -> list[dict[str, Any]]:
    ops: list[dict[str, Any]] = []
    for it in others:
        ops.append({"op": "relink", "item": str(it.public_id), "keep": str(keep.public_id),
                    "back": False})  # fmt: skip
        ops.append({"op": "hide_item", "item": str(it.public_id),
                    "canonical": str(keep.public_id), "exact": exact})  # fmt: skip
    return ops


async def _members(s: AsyncSession, group: DuplicateGroup) -> list[Item]:
    return list(await s.scalars(
        select(Item).join(DuplicateGroupMember, DuplicateGroupMember.item_id == Item.id)
        .where(DuplicateGroupMember.group_id == group.id).order_by(Item.id)
        .with_for_update(of=Item)))  # fmt: skip


async def _plan(s: AsyncSession, group: DuplicateGroup, keep_id: uuid.UUID | None,
                now: datetime) -> tuple[Item, list[Item], list[Item]]:  # fmt: skip
    """(keep, others, members) of an open group. A group with fewer than two visible records left
    closes (`group_stale`)."""
    if group.status != DupStatus.SUGGESTED:
        raise DedupError(409, "group_closed")
    members = await _members(s, group)
    alive = [m for m in members if _visible(m)]
    if keep_id is not None:
        keep = next((m for m in alive if m.public_id == keep_id), None)
        if keep is None:
            raise DedupError(422, "keep_not_in_group")
    else:
        keep = next((m for m in alive if m.id == group.keep_item_id), None) or (
            max(alive, key=lambda m: (sim.completeness(m.text or m.raw_text),
                                      m.occurred_at or m.created_at, m.id)) if alive else None)
    others = [m for m in alive if keep is not None and m.id != keep.id]
    if keep is None or not others:
        group.status, group.decided_at = DupStatus.DISMISSED, now
        raise DedupError(409, "group_stale")
    return keep, others, members


async def _settle(s: AsyncSession, group: DuplicateGroup, keep: Item, others: list[Item],
                  members: list[Item], action: Action, now: datetime) -> None:  # fmt: skip
    group.keep_item_id, group.action_id, group.decided_at = keep.id, action.id, now
    gone = [m.id for m in members if m.id != keep.id and m not in others]
    if gone:
        await s.execute(delete(DuplicateGroupMember).where(
            DuplicateGroupMember.group_id == group.id, DuplicateGroupMember.item_id.in_(gone)))
    for m in [keep, *others]:
        await s.execute(
            DuplicateGroupMember.__table__.update()
            .where(DuplicateGroupMember.group_id == group.id, DuplicateGroupMember.item_id == m.id)
            .values(role="keep" if m.id == keep.id else "merge"))  # fmt: skip
    group.member_count = len(others) + 1


async def _repeat(s: AsyncSession, user_id: int, client_id: uuid.UUID | None
                  ) -> tuple[list[DuplicateGroup], Action] | None:  # fmt: skip
    if client_id is None:
        return None
    done = await s.scalar(select(Action).where(Action.user_id == user_id,
                                               Action.client_id == client_id))
    if done is None:
        return None
    groups = list(await s.scalars(select(DuplicateGroup).where(
        DuplicateGroup.action_id == done.id).order_by(DuplicateGroup.id)))
    return (groups, done) if groups else None


Pick = tuple[uuid.UUID, uuid.UUID | None]


async def merge_groups(s: AsyncSession, user_id: int, picks: list[Pick], *, now: datetime,
                       client_id: uuid.UUID | None = None,
                       ) -> tuple[list[DuplicateGroup], Action | None, bool,
                                  list[str]]:  # fmt: skip
    """«Да» on one group, or «Объединить все отмеченные (N)»: every picked group in one
    `merge_group` action, one «Отменить». `picks` = (group id, keep item id or None).
    Returns (groups merged, action, repeated, ids of groups skipped as closed meanwhile)."""
    again = await _repeat(s, user_id, client_id)
    if again is not None:
        return again[0], again[1], True, []
    await lock_user(s, user_id)
    plans = []
    skipped: list[str] = []
    for gid, keep_id in picks:
        group = await get_group(s, user_id, gid, lock=True)
        if group.status == DupStatus.MERGED and group.action_id is not None and len(picks) == 1:
            a = await s.get(Action, group.action_id)
            assert a is not None
            return [group], a, True, []
        try:
            plans.append((group, *await _plan(s, group, keep_id, now)))
        except DedupError as e:
            if len(picks) == 1 or e.code == "keep_not_in_group":
                raise
            skipped.append(str(gid))
    if not plans:
        return [], None, False, skipped
    ops: list[dict[str, Any]] = []
    changes: list[dict[str, Any]] = []
    pks: list[int] = []
    for group, keep, others, _all in plans:
        ops += merge_ops(keep, others)
        ops.append({"op": "set_status", "entity": "duplicate_groups", "id": str(group.public_id),
                    "value": DupStatus.MERGED, "undo_value": DupStatus.UNDONE})  # fmt: skip
        changes += [{"item_id": str(m.public_id), "title": m.title or "", "kind": "merge",
                     "page_id": None,
                     "text": f"{texts.quote(m.title)} → в {texts.quote(keep.title)}"}
                    for m in others]  # fmt: skip
        pks += [keep.id, *(m.id for m in others)]
    out = await engine.apply(s, user_id, ops, by=Initiator.USER, check=False, now=now)
    if len(plans) == 1:
        sentence = texts.merged_sentence(len(plans[0][2]) + 1)
    else:
        sentence = texts.merged_groups_sentence(len(plans), sum(len(p[2]) for p in plans))
    action = await record(
        s, user_id=user_id, kind=ActionKind.MERGE_GROUP, initiated_by=Initiator.USER,
        summary={"ru": sentence, "kk": None}, changes=changes, inverse=out.inverse, now=now,
        source_item_ids=pks[:5000], client_id=client_id,
        extra={"keep_item_ids": [str(p[1].public_id) for p in plans]},
    )  # fmt: skip
    for group, keep, others, members in plans:
        await _settle(s, group, keep, others, members, action, now)
    await s.flush()
    return [p[0] for p in plans], action, False, skipped


async def merge_group(s: AsyncSession, user_id: int, gid: uuid.UUID, *, now: datetime,
                      keep_id: uuid.UUID | None = None, client_id: uuid.UUID | None = None,
                      ) -> tuple[DuplicateGroup, Action, bool]:  # fmt: skip
    """«Да» on one group. Returns (group, action, repeated)."""
    groups, action, repeated, _ = await merge_groups(s, user_id, [(gid, keep_id)], now=now,
                                                     client_id=client_id)  # fmt: skip
    assert action is not None
    return groups[0], action, repeated


async def dismiss_group(s: AsyncSession, user_id: int, gid: uuid.UUID, *, now: datetime,
                        client_id: uuid.UUID | None = None,
                        ) -> tuple[DuplicateGroup, Action | None, bool]:  # fmt: skip
    """«Это разные»: the group closes and these records are not suggested together again. One
    action (`dismiss_group`) with «Отменить»: the group is open again («Объединить?»)."""
    again = await _repeat(s, user_id, client_id)
    if again is not None:
        return again[0][0], again[1], True
    group = await get_group(s, user_id, gid, lock=True)
    if group.status == DupStatus.DISMISSED:
        a = await s.get(Action, group.action_id) if group.action_id else None
        return group, a, True
    if group.status != DupStatus.SUGGESTED:
        raise DedupError(409, "group_closed")
    op = {"op": "set_status", "entity": "duplicate_groups", "id": str(group.public_id),
          "value": DupStatus.DISMISSED}
    out = await engine.apply(s, user_id, [op], by=Initiator.USER, check=False, now=now)
    keep = await s.get(Item, group.keep_item_id) if group.keep_item_id else None
    changes = []
    if keep is not None:
        changes.append({"item_id": str(keep.public_id), "title": keep.title or "",
                        "kind": "keep_apart", "page_id": None,
                        "text": "Оставил записи отдельно"})  # fmt: skip
    action = await record(
        s, user_id=user_id, kind=ActionKind.DISMISS_GROUP, initiated_by=Initiator.USER,
        summary={"ru": texts.dismissed_sentence(group.member_count), "kk": None},
        changes=changes, inverse=out.inverse, now=now, client_id=client_id,
    )  # fmt: skip
    group.action_id = action.id
    return group, action, False


# --- the cleanup plan «37 → 1» ---


async def exact_clusters(s: AsyncSession, user_id: int) -> list[list[Item]]:
    """Visible records with the same normalised text (or the same file bytes, when there is no
    text), 2+ per cluster. A record the person un-merged before stays out."""
    key = func.coalesce(Item.content_hash, Item.original_sha256)
    live = and_(Item.user_id == user_id, Item.deleted_at.is_(None), Item.hidden_reason.is_(None),
                key.is_not(None), Item.kind != RecordKind.KP, Item.ai_generated.is_(False),
                Item.source_meta["unmerged"].as_boolean().is_not(True),
                ~select(Task.id).where(Task.item_id == Item.id).exists())  # fmt: skip
    dup_keys = (select(key.label("k")).where(live).group_by(key).having(func.count() > 1)
                .limit(CLEANUP_MAX_GROUPS).subquery())  # fmt: skip
    rows = list(await s.scalars(select(Item).where(live, key.in_(select(dup_keys.c.k)))
                                .order_by(Item.id)))  # fmt: skip
    clusters: dict[str, list[Item]] = {}
    for it in rows:
        clusters.setdefault(it.content_hash or it.original_sha256 or "", []).append(it)
    return [c for c in clusters.values() if len(c) > 1]


def keep_of(cluster: list[Item]) -> Item:
    """The oldest copy stays (as on save: the first one), the others join it."""
    return min(cluster, key=lambda m: (m.occurred_at or m.created_at, m.id))


async def plan_cleanup(s: AsyncSession, user_id: int, *, now: datetime,
                       client_id: uuid.UUID | None = None,
                       ) -> tuple[PendingAction | None, list[DuplicateGroup]]:  # fmt: skip
    """The plan: one pending «Да» for every exact repeat (one action, one «Отменить»), plus the
    open groups of similar ones («Да» per group). No exact repeats: no pending action."""
    if client_id is not None:
        same = await s.scalar(select(PendingAction).where(PendingAction.user_id == user_id,
                                                          PendingAction.client_id == client_id))
        if same is not None:
            return same, await open_near_groups(s, user_id)
    await lock_user(s, user_id)
    # an older open plan is replaced by this one
    for old in await s.scalars(select(PendingAction).where(
            PendingAction.user_id == user_id, PendingAction.kind == "cleanup_batch",
            PendingAction.status == PendingStatus.PROPOSED).with_for_update()):
        old.status, old.decided_at = PendingStatus.EXPIRED, now
    await s.execute(delete(DuplicateGroup).where(
        DuplicateGroup.user_id == user_id, DuplicateGroup.kind == DupKind.EXACT,
        DuplicateGroup.status == DupStatus.SUGGESTED))
    clusters = await exact_clusters(s, user_id)
    pending = None
    if clusters:
        gids: list[str] = []
        for c in clusters:
            keep = keep_of(c)
            g = DuplicateGroup(user_id=user_id, kind=DupKind.EXACT, status=DupStatus.SUGGESTED,
                               keep_item_id=keep.id, member_count=len(c),
                               origin=DupOrigin.CLEANUP)  # fmt: skip
            s.add(g)
            await s.flush()
            s.add_all([DuplicateGroupMember(group_id=g.id, item_id=m.id,
                                            role="keep" if m.id == keep.id else "merge",
                                            score=None if m.id == keep.id else 1.0)
                       for m in c])  # fmt: skip
            gids.append(str(g.public_id))
        before = sum(len(c) for c in clusters)
        copies = before - len(clusters)
        token = secrets.token_urlsafe(24)
        pending = PendingAction(
            user_id=user_id, client_id=client_id, kind="cleanup_batch",
            preview=texts.cleanup_preview(copies, before, len(clusters), len(clusters)),
            payload={"groups": gids}, confirm_token_hash=hashlib.sha256(token.encode()).hexdigest(),
            expires_at=now + timedelta(hours=PENDING_HOURS),
        )  # fmt: skip
        s.add(pending)
        await s.flush()
    return pending, await open_near_groups(s, user_id)


async def open_near_groups(s: AsyncSession, user_id: int) -> list[DuplicateGroup]:
    return list(await s.scalars(
        select(DuplicateGroup).where(DuplicateGroup.user_id == user_id,
                                     DuplicateGroup.kind == DupKind.NEAR,
                                     DuplicateGroup.status == DupStatus.SUGGESTED)
        .order_by(DuplicateGroup.member_count.desc(), DuplicateGroup.id)))  # fmt: skip


async def run_cleanup(s: AsyncSession, user_id: int, pending: PendingAction,
                      now: datetime) -> Action | None:  # fmt: skip
    """The «Да» on a cleanup plan: every exact group, still exact, in one `cleanup_batch` action.
    Copies changed or removed since the plan are left alone."""
    await lock_user(s, user_id)
    gids = [uuid.UUID(x) for x in (pending.payload or {}).get("groups", [])]
    groups = list(await s.scalars(select(DuplicateGroup).where(
        DuplicateGroup.user_id == user_id, DuplicateGroup.public_id.in_(gids),
        DuplicateGroup.status == DupStatus.SUGGESTED).order_by(DuplicateGroup.id)
        .with_for_update()))  # fmt: skip
    ops: list[dict[str, Any]] = []
    changes: list[dict[str, Any]] = []
    pks: list[int] = []
    copies = 0
    for g in groups:
        members = [m for m in await _members(s, g) if _visible(m)]
        keep = next((m for m in members if m.id == g.keep_item_id), None)
        if keep is None:
            continue
        k = keep.content_hash or keep.original_sha256
        others = [m for m in members if m.id != keep.id
                  and (m.content_hash or m.original_sha256) == k]  # fmt: skip
        if not others:
            continue
        ops += merge_ops(keep, others)
        ops.append({"op": "set_status", "entity": "duplicate_groups", "id": str(g.public_id),
                    "value": DupStatus.MERGED, "undo_value": DupStatus.UNDONE})  # fmt: skip
        changes += [{"item_id": str(m.public_id), "title": m.title or "", "kind": "merge",
                     "page_id": None, "text": f"{texts.quote(m.title or keep.title)} — повтор"}
                    for m in others]  # fmt: skip
        pks += [keep.id, *(m.id for m in others)]
        copies += len(others)
    if not ops:
        return None
    out = await engine.apply(s, user_id, ops, by=Initiator.USER, check=False, now=now)
    action = await record(
        s, user_id=user_id, kind=ActionKind.CLEANUP_BATCH, initiated_by=Initiator.USER,
        summary={"ru": texts.cleanup_sentence(copies), "kk": None}, changes=changes,
        inverse=out.inverse, now=now, source_item_ids=pks[:5000],
    )  # fmt: skip
    for g in groups:
        if g.status == DupStatus.MERGED:
            g.action_id = action.id
    return action


def hidden_as_repeat(item: Item) -> bool:
    return item.hidden_reason == HiddenReason.DUPLICATE_MERGED
