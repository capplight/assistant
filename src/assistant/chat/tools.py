"""Read tools of the chat step (spec 5.10): `search` and `list_page`. Week 6 adds the mutating
ones (create, update, move, reorder, create_page_from_template) behind the intent rule; they plug
in here as more `ChatTool`s with `mutating=True` and never reach a step without that intent.

The model returns a call; code validates the arguments against the same schema, runs a short
read-only DB session (closed before the next model call) and writes the result as JSON. Results
carry refs (`s3`, `p2`) issued by the turn's SourceBook, never database ids.
"""

import json
import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from typing import Literal

from pydantic import BaseModel, ValidationError
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from assistant.ai import ToolCall, ToolSpec
from assistant.ai.adapters import strict_json_schema
from assistant.chat.sources import SourceBook
from assistant.embeddings import ChunkEmbedder
from assistant.memory import embed_query, search_records

log = logging.getLogger(__name__)

RESULT_MAX_CHARS = 6000  # one tool result, about 2 000 tokens
FRAGMENT_CHARS = 700
LIST_ITEM_CHARS = 160

RecordKindArg = Literal["note", "voice", "image", "screenshot", "pdf", "docx", "xlsx", "link",
                        "email", "tg_message", "kp", "file_other"]  # fmt: skip


class SearchArgs(BaseModel):
    query: str
    page: str | None
    kind: RecordKindArg | None
    date_from: str | None
    date_to: str | None


class ListPageArgs(BaseModel):
    page: str
    order: Literal["newest", "oldest"] | None
    contains: str | None
    limit: int | None


SEARCH = ToolSpec(
    name="search",
    description=(
        "Search all of the person's records (every page) by words and by meaning. Use it when "
        "the records already shown do not answer the question. query: the words to look for, in "
        "the person's language. page: a page ref like p2 to search only that page, else null. "
        "kind: a record type, else null. date_from / date_to: YYYY-MM-DD bounds on the record's "
        "date, else null. Returns up to 8 records with refs (s1, s2, ...) you can cite."
    ),
    parameters=strict_json_schema(SearchArgs),
)
LIST_PAGE = ToolSpec(
    name="list_page",
    description=(
        "List the records on one page (a page ref like p2 from the page index). order: newest "
        "(default) or oldest. contains: a word the record must contain, else null. limit: 1-50, "
        "default 20. Returns the records with refs you can cite and the page's total count."
    ),
    parameters=strict_json_schema(ListPageArgs),
)
READ_TOOLS: tuple[ToolSpec, ...] = (SEARCH, LIST_PAGE)


@dataclass
class ToolEnv:
    sessionmaker: async_sessionmaker[AsyncSession]
    embedder: ChunkEmbedder
    user_id: int
    book: SourceBook
    embed_timeout_s: float
    min_similarity: float
    counts: set[int]  # numbers our code reported (totals): allowed in the answer


@dataclass
class ToolOutcome:
    content: str
    is_error: bool
    activity: str  # what the line shows, Russian
    page: str | None = None  # page public id for tool_activity


def _json(obj: object) -> str:
    out = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    return out if len(out) <= RESULT_MAX_CHARS else out[:RESULT_MAX_CHARS]


def _error(message: str, activity: str = "Смотрю записи…") -> ToolOutcome:
    return ToolOutcome(_json({"error": message}), True, activity)


def _day(value: str | None) -> date | None:
    if not value:
        return None
    try:
        return date.fromisoformat(value.strip()[:10])
    except ValueError:
        return None


def _window(body: str, snippet: str, size: int) -> str:
    """The part of the record around the found words, about `size` chars."""
    flat = " ".join(body.split())
    if len(flat) <= size:
        return flat
    probe = snippet.strip("… ")[:40]
    at = flat.find(probe) if probe else -1
    start = max(0, at - size // 3) if at >= 0 else 0
    piece = flat[start:start + size]
    return ("…" if start else "") + piece + ("…" if start + size < len(flat) else "")


async def _bodies(session: AsyncSession, pks: list[int]) -> dict[int, str]:
    rows = await session.execute(text("""
        SELECT id, left(coalesce(text, raw_text, summary, ''), 20000) AS body,
               source_meta->>'caption' AS caption
        FROM items WHERE id = ANY(:ids)
    """), {"ids": pks})  # fmt: skip
    return {r.id: "\n".join(p for p in (r.caption, r.body) if p) for r in rows}


async def _page_links(session: AsyncSession, pks: list[int]) -> dict[int, list[int]]:
    rows = await session.execute(text("""
        SELECT si.item_id, si.screen_id FROM screen_items si JOIN screens s ON s.id = si.screen_id
        WHERE si.item_id = ANY(:ids) AND si.removed_by_user_at IS NULL
          AND s.deleted_at IS NULL AND s.hidden_at IS NULL
        ORDER BY s.position, s.id
    """), {"ids": pks})  # fmt: skip
    out: dict[int, list[int]] = {}
    for item_id, screen_id in rows:
        out.setdefault(item_id, []).append(screen_id)
    return out


async def run_search(env: ToolEnv, query: str, *, page_pk: int | None = None,
                     kind: str | None = None, start: datetime | None = None,
                     end: datetime | None = None, limit: int = 8,
                     boost_page_pk: int | None = None) -> list:  # fmt: skip
    """Hybrid search (spec 6.9) + the shown fragment of each hit, registered in the book.
    Returns the Source objects, best first. No transaction stays open across the embedder."""
    vector = await embed_query(env.embedder, query, env.embed_timeout_s)
    async with env.sessionmaker() as session:
        result = await search_records(
            session, env.user_id, query, query_vector=vector, model=env.embedder.model,
            min_similarity=env.min_similarity, screen_id=page_pk, kind=kind, start=start,
            end=end, limit=max(limit, 15),
        )  # fmt: skip
        if not result.hits:
            return []
        rows = await session.execute(
            text("SELECT id, public_id FROM items WHERE public_id = ANY(:ids) AND user_id = :u"),
            {"ids": [h.item_id for h in result.hits], "u": env.user_id},
        )
        pk_of = {public_id: pk for pk, public_id in rows}
        hits = [h for h in result.hits if h.item_id in pk_of]
        pks = [pk_of[h.item_id] for h in hits]
        bodies = await _bodies(session, pks)
        links = await _page_links(session, pks)
    order = list(range(len(hits)))
    if boost_page_pk is not None:  # the current page first among equals (spec 5.10, layer 7)
        order.sort(key=lambda i: i - (2 if boost_page_pk in links.get(pks[i], []) else 0))
    out = []
    for i in order[:limit]:
        h, pk = hits[i], pks[i]
        body = _window(bodies.get(pk, ""), h.snippet, FRAGMENT_CHARS) or h.snippet
        out.append(env.book.add(pk=pk, item_id=h.item_id, title=h.title, body=body, kind=h.kind,
                                occurred_at=h.occurred_at, created_at=h.created_at,
                                page_pks=links.get(pk, [])))  # fmt: skip
    return out


def fragment_json(env: ToolEnv, src) -> dict:  # type: ignore[no-untyped-def]
    return {"ref": src.ref, "title": src.title, "date": env.book.date_text(src),
            "pages": [p.title for p in src.pages], "text": src.shown[-1]}  # fmt: skip


async def _search(env: ToolEnv, args: SearchArgs) -> ToolOutcome:
    query = " ".join(args.query.split())[:200]
    if not query:
        return _error("query is empty")
    page = env.book.page(args.page) if args.page else None
    if args.page and page is None:
        return _error(f"unknown page {args.page}")
    tz = env.book.tz
    d_from, d_to = _day(args.date_from), _day(args.date_to)
    start = datetime.combine(d_from, time.min, tz) if d_from else None
    end = datetime.combine(d_to + timedelta(days=1), time.min, tz) if d_to else None
    found = await run_search(env, query, page_pk=page.pk if page else None, kind=args.kind,
                             start=start, end=end)  # fmt: skip
    activity = f"Ищу в «{page.title}»…" if page else "Ищу в записях…"
    return ToolOutcome(_json({"found": len(found),
                              "results": [fragment_json(env, s) for s in found]}),
                       False, activity, str(page.id) if page else None)  # fmt: skip


async def _list_page(env: ToolEnv, args: ListPageArgs) -> ToolOutcome:
    page = env.book.page(args.page)
    if page is None:
        return _error(f"unknown page {args.page}")
    limit = min(max(args.limit or 20, 1), 50)
    order = "ASC" if args.order == "oldest" else "DESC"
    contains = " ".join((args.contains or "").split())[:100]
    where = """si.screen_id = :screen AND si.removed_by_user_at IS NULL AND i.user_id = :u
               AND i.deleted_at IS NULL AND i.hidden_reason IS NULL"""
    params: dict = {"screen": page.pk, "u": env.user_id, "limit": limit}
    if contains:
        where += (" AND (i.title ILIKE :pat OR coalesce(i.text, i.raw_text, '') ILIKE :pat)")
        params["pat"] = "%" + contains.replace("\\", "\\\\").replace("%", "\\%").replace(
            "_", "\\_") + "%"
    async with env.sessionmaker() as session:
        total = await session.scalar(text(
            f"SELECT count(*) FROM screen_items si JOIN items i ON i.id = si.item_id "
            f"WHERE {where}"), params)  # fmt: skip
        rows = (await session.execute(text(f"""
            SELECT i.id, i.public_id, i.title, i.kind, i.occurred_at, i.created_at,
                   left(coalesce(i.text, i.raw_text, i.summary, ''), 2000) AS body
            FROM screen_items si JOIN items i ON i.id = si.item_id
            WHERE {where}
            ORDER BY coalesce(i.occurred_at, i.created_at) {order}, i.id {order}
            LIMIT :limit
        """), params)).all()  # fmt: skip
        links = await _page_links(session, [r.id for r in rows])
    env.counts.add(int(total or 0))
    items = []
    for r in rows:
        src = env.book.add(pk=r.id, item_id=r.public_id, title=r.title,
                           body=_window(r.body or "", "", LIST_ITEM_CHARS), kind=r.kind,
                           occurred_at=r.occurred_at, created_at=r.created_at,
                           page_pks=links.get(r.id, [page.pk]))  # fmt: skip
        items.append(fragment_json(env, src))
    return ToolOutcome(_json({"page": page.title, "total": int(total or 0), "shown": len(items),
                              "records": items}),
                       False, f"Смотрю «{page.title}»…", str(page.id))  # fmt: skip


@dataclass(frozen=True)
class ChatTool:
    spec: ToolSpec
    args: type[BaseModel]
    run: Callable[[ToolEnv, BaseModel], Awaitable[ToolOutcome]]
    mutating: bool = False


TOOLS: dict[str, ChatTool] = {
    "search": ChatTool(SEARCH, SearchArgs, _search),  # type: ignore[arg-type]
    "list_page": ChatTool(LIST_PAGE, ListPageArgs, _list_page),  # type: ignore[arg-type]
}


def call_key(call: ToolCall) -> str:
    return call.name + ":" + json.dumps(call.arguments, sort_keys=True, ensure_ascii=False)


async def execute(env: ToolEnv, call: ToolCall, *, allowed: set[str]) -> ToolOutcome:
    """Run one call. Unknown / not allowed tools and bad arguments come back as an error the
    model can read; nothing outside the white list ever runs."""
    tool = TOOLS.get(call.name)
    if tool is None or call.name not in allowed:
        return _error(f"tool {call.name} is not available")
    try:
        args = tool.args.model_validate(call.arguments)
    except ValidationError:
        return _error("arguments do not match the schema")
    try:
        return await tool.run(env, args)
    except Exception:  # a broken read must not end the answer
        log.exception("chat tool %s failed", call.name)
        return _error("the tool failed, answer from what you have")
