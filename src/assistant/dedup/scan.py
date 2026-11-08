"""Groups of similar records (spec 6.3 p. 2): candidates by code, borderline pairs to DUP_JUDGE,
union-find, `duplicate_groups(kind=near, status=suggested)`. Nothing is merged here: the person
says «Да» per group (`dedup.auto_merge_near=false`).

One scan covers a person's visible records. Three short steps, no transaction across the model:
read the corpus and what is already known; compute pairs and ask the judge; write candidates and
groups. A group the person dismissed («Это разные») or whose merge they undid is never suggested
again for the same records; neither is a pair the judge called different or a newer version.
"""

import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime

from sqlalchemy import delete, func, select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from assistant.ai import AIConsentRequired, AIUnavailable, BudgetExceeded, Router
from assistant.config import get_settings
from assistant.db.models import Item
from assistant.db.models_dedup import (
    DupKind,
    DuplicateCandidate,
    DuplicateGroup,
    DuplicateGroupMember,
    DupOrigin,
    DupStatus,
)
from assistant.db.models_tasks import Task
from assistant.db.models_v2 import RecordKind
from assistant.dedup import similarity as sim
from assistant.dedup.judge import judge

log = logging.getLogger(__name__)

MAX_RECORDS = 20_000  # per scan; the newest ones
EMBED_NEIGHBOURS = 5


@dataclass
class Rec:
    id: int
    text: str
    content_hash: str | None
    unmerged: bool
    when: datetime
    import_id: int | None
    doc: sim.Doc


@dataclass
class ScanResult:
    records: int = 0
    pairs_checked: int = 0
    sure: int = 0
    judged: int = 0
    judge_cost_usd: float = 0.0
    judge_skipped: int = 0  # borderline pairs left for later (no consent, budget, outage, cap)
    groups: int = 0
    group_ids: list[int] = field(default_factory=list)


async def load_corpus(s: AsyncSession, user_id: int) -> list[Rec]:
    body = func.coalesce(Item.text, Item.raw_text)
    rows = await s.execute(
        select(Item.id, body.label("body"), Item.title, Item.simhash, Item.content_hash,
               Item.source_meta, func.coalesce(Item.occurred_at, Item.created_at).label("when"))
        .where(Item.user_id == user_id, Item.deleted_at.is_(None), Item.hidden_reason.is_(None),
               body.is_not(None), Item.kind != RecordKind.KP, Item.ai_generated.is_(False),
               ~select(Task.id).where(Task.item_id == Item.id).exists())
        .order_by(Item.id.desc()).limit(MAX_RECORDS)
    )  # fmt: skip
    out = []
    for r in rows:
        meta = r.source_meta or {}
        textv = r.body if not r.title or r.body.startswith(r.title) else f"{r.title}\n{r.body}"
        imp = meta.get("import_id")
        out.append(Rec(r.id, textv, r.content_hash, bool(meta.get("unmerged")), r.when,
                       int(imp) if isinstance(imp, int) else None,
                       sim.make_doc(r.id, textv, r.simhash)))  # fmt: skip
    return out


async def _refused_pairs(s: AsyncSession, user_id: int) -> set[tuple[int, int]]:
    """Pairs inside a group the person dismissed or undid."""
    rows = await s.execute(
        select(DuplicateGroupMember.group_id, DuplicateGroupMember.item_id)
        .join(DuplicateGroup, DuplicateGroup.id == DuplicateGroupMember.group_id)
        .where(DuplicateGroup.user_id == user_id,
               DuplicateGroup.status.in_((DupStatus.DISMISSED, DupStatus.UNDONE)))
    )  # fmt: skip
    groups: dict[int, list[int]] = {}
    for gid, iid in rows:
        groups.setdefault(gid, []).append(iid)
    out: set[tuple[int, int]] = set()
    for members in groups.values():
        members.sort()
        out.update((a, b) for i, a in enumerate(members) for b in members[i + 1:])
    return out


async def _verdicts(s: AsyncSession, user_id: int) -> dict[tuple[int, int], tuple[str, dict]]:
    rows = await s.execute(
        select(DuplicateCandidate.item_a, DuplicateCandidate.item_b, DuplicateCandidate.verdict,
               DuplicateCandidate.signals)
        .where(DuplicateCandidate.user_id == user_id, DuplicateCandidate.verdict.is_not(None))
    )  # fmt: skip
    return {(a, b): (v, sig or {}) for a, b, v, sig in rows}


async def _neighbours(s: AsyncSession, user_id: int) -> dict[tuple[int, int], float]:
    """Cosine of each record's first chunk with its nearest ones (bge-m3), ≥ the border."""
    model = get_settings().chunk_embedding_model
    rows = await s.execute(text("""
        SELECT a.item_id AS x, b.item_id AS y, 1 - (a.embedding <=> b.embedding) AS cos
        FROM chunks a
        CROSS JOIN LATERAL (
            SELECT c.item_id, c.embedding FROM chunks c
            WHERE c.user_id = a.user_id AND c.embedding_model = a.embedding_model AND c.ord = 0
              AND c.item_id <> a.item_id
            ORDER BY c.embedding <=> a.embedding LIMIT :k) b
        WHERE a.user_id = :u AND a.embedding_model = :m AND a.ord = 0
    """), {"u": user_id, "m": model, "k": EMBED_NEIGHBOURS})  # fmt: skip
    out: dict[tuple[int, int], float] = {}
    for x, y, cos in rows:
        if cos is not None and cos >= sim.COSINE_BORDER:
            key = (min(x, y), max(x, y))
            out[key] = max(out.get(key, 0.0), float(cos))
    return out


def _sha_pair(a: Rec, b: Rec) -> list[str | None]:
    return [a.content_hash, b.content_hash]


async def scan_user(maker: async_sessionmaker[AsyncSession], router: Router | None, user_id: int,
                    *, origin: str = DupOrigin.ON_SAVE, import_id: int | None = None,
                    judge_cap: int | None = None,
                    job_id: int | None = None) -> ScanResult:  # fmt: skip
    cap = get_settings().dedup_judge_per_scan if judge_cap is None else judge_cap
    res = ScanResult()
    # 1. read
    async with maker() as s:
        corpus = await load_corpus(s, user_id)
        refused = await _refused_pairs(s, user_id)
        cached = await _verdicts(s, user_id)
        cosines = await _neighbours(s, user_id)
        await s.commit()
    res.records = len(corpus)
    by_id = {r.id: r for r in corpus}
    docs = [r.doc for r in corpus]
    pairs = sim.prefix_pairs(docs) | sim.simhash_pairs(docs)
    pairs |= {p for p in cosines if p[0] in by_id and p[1] in by_id}

    # 2. decide
    accepted: dict[tuple[int, int], tuple[float, str, dict, str | None]] = {}
    to_judge: list[tuple[tuple[int, int], sim.PairSignals, str]] = []
    for p in sorted(pairs):
        a, b = by_id[p[0]], by_id[p[1]]
        if p in refused:
            continue
        if a.content_hash is not None and a.content_hash == b.content_hash:
            continue  # an exact repeat: the cleanup plan's job, or one the person kept apart
        res.pairs_checked += 1
        sig = sim.signals(a.doc, b.doc, cosines.get(p))
        what, method = sim.decide(sig)
        if what == sim.NO:
            continue
        old = cached.get(p)
        if old is not None and old[1].get("sha") == _sha_pair(a, b):
            if old[0] == "same":
                accepted[p] = (sim.score(sig), "llm_judge", sig.as_json(), "same")
            continue  # different / newer_version: never again for these texts
        if what == sim.SURE:
            res.sure += 1
            accepted[p] = (sim.score(sig), method, sig.as_json(), None)
        else:
            to_judge.append((p, sig, method))
    verdicts: dict[tuple[int, int], tuple[str, dict]] = {}
    for p, sig, _method in to_judge:
        if router is None or res.judged >= cap:
            res.judge_skipped += 1
            continue
        a, b = by_id[p[0]], by_id[p[1]]
        try:
            verdict, _model, cost = await judge(router, user_id, a.text, b.text, job_id=job_id)
        except (AIConsentRequired, BudgetExceeded, AIUnavailable) as exc:
            log.info("dup_judge for user %s stopped: %s", user_id, type(exc).__name__)
            res.judge_skipped += len(to_judge) - res.judged
            break
        res.judged += 1
        res.judge_cost_usd += cost
        verdicts[p] = (verdict, {**sig.as_json(), "sha": _sha_pair(a, b)})
        if verdict == "same":
            accepted[p] = (sim.score(sig), "llm_judge", sig.as_json(), "same")

    # 3. write
    async with maker() as s:
        await s.execute(text("SELECT sync_lock_user(:u)"), {"u": user_id})
        for p, (score, method, sig_json, verdict) in accepted.items():
            a, b = by_id[p[0]], by_id[p[1]]
            await _upsert_candidate(s, user_id, p, score, method,
                                    {**sig_json, "sha": _sha_pair(a, b)}, verdict)  # fmt: skip
        for p, (verdict, sig_json) in verdicts.items():
            if verdict != "same":
                await _upsert_candidate(s, user_id, p, 0.0, "llm_judge", sig_json, verdict)
        comps = sim.components(accepted)
        scores = {}
        for (x, y), (sc, *_rest) in accepted.items():
            scores[x] = max(scores.get(x, 0.0), sc)
            scores[y] = max(scores.get(y, 0.0), sc)
        ids = await write_groups(s, user_id, comps, by_id, scores, origin=origin,
                                 import_id=import_id)  # fmt: skip
        await s.commit()
    res.groups, res.group_ids = len(ids), ids
    return res


async def _upsert_candidate(s: AsyncSession, user_id: int, p: tuple[int, int], score: float,
                            method: str, signals: dict, verdict: str | None) -> None:  # fmt: skip
    stmt = insert(DuplicateCandidate).values(
        user_id=user_id, item_a=p[0], item_b=p[1], kind=DupKind.NEAR, score=score, method=method,
        signals=signals, verdict=verdict)
    await s.execute(stmt.on_conflict_do_update(
        constraint="uq_duplicate_candidates_pair",
        set_={"score": score, "method": method, "signals": signals, "verdict": verdict}))


def pick_keep(members: list[int], by_id: dict[int, Rec]) -> int:
    """keep_rule=most_complete: more words wins; equal: the newer one (spec 3.3)."""
    return max(members, key=lambda i: (sim.completeness(by_id[i].text), by_id[i].when, i))


async def write_groups(s: AsyncSession, user_id: int, comps: list[list[int]],
                       by_id: dict[int, Rec], scores: dict[int, float], *, origin: str,
                       import_id: int | None) -> list[int]:  # fmt: skip
    """Match new components to the open (suggested) near groups by overlap, so a group keeps its
    id while it grows; open groups that match nothing any more go away."""
    open_groups = list(await s.scalars(
        select(DuplicateGroup).where(DuplicateGroup.user_id == user_id,
                                     DuplicateGroup.kind == DupKind.NEAR,
                                     DuplicateGroup.status == DupStatus.SUGGESTED)
        .with_for_update()))  # fmt: skip
    members: dict[int, set[int]] = {g.id: set() for g in open_groups}
    if open_groups:
        for gid, iid in await s.execute(select(DuplicateGroupMember.group_id,
                                               DuplicateGroupMember.item_id)
                                        .where(DuplicateGroupMember.group_id.in_(members))):
            members[gid].add(iid)
    used: set[int] = set()
    out: list[int] = []
    for comp in comps:
        cs = set(comp)
        best = max((g for g in open_groups if g.id not in used and members[g.id] & cs),
                   key=lambda g: len(members[g.id] & cs), default=None)  # fmt: skip
        keep = pick_keep(comp, by_id)
        if best is None:
            from_import = import_id is not None and any(by_id[i].import_id == import_id
                                                        for i in comp)
            best = DuplicateGroup(user_id=user_id, kind=DupKind.NEAR, status=DupStatus.SUGGESTED,
                                  origin=DupOrigin.IMPORT if from_import else origin,
                                  import_id=import_id if from_import else None)  # fmt: skip
            s.add(best)
            await s.flush()
            members[best.id] = set()
        elif members[best.id] == cs and best.keep_item_id == keep:
            used.add(best.id)
            out.append(best.id)
            continue
        used.add(best.id)
        await s.execute(delete(DuplicateGroupMember)
                        .where(DuplicateGroupMember.group_id == best.id))
        for iid in comp:
            s.add(DuplicateGroupMember(group_id=best.id, item_id=iid,
                                       role="keep" if iid == keep else "merge",
                                       score=None if iid == keep else scores.get(iid)))
        best.keep_item_id = keep
        best.member_count = len(comp)
        best.updated_at = datetime.now(UTC)
        out.append(best.id)
    stale = [g.id for g in open_groups if g.id not in used]
    if stale:
        await s.execute(delete(DuplicateGroup).where(DuplicateGroup.id.in_(stale)))
    await s.flush()
    return out
