"""Context assembler of one chat step (spec 5.10, R-56): layers with hard budgets.

| layer | what | budget (tokens, estimated) |
|---|---|---|
| 1 | system prompt + tool descriptions (cached) | ~3 000 |
| 2 | profile (cached with the system prompt) | ≤400 |
| 3 | page index, counted by code (`screen_summaries`) | ≤30 per page, ≤600 |
| 4 | current page + visible records (≤40) | ≤1 500 |
| 5 | conversation summary (no `untrusted_data`) | ≤600 |
| 6 | last messages, with page labels | 6-10 messages, ≤2 500 |
| 7 | found across all pages (`<untrusted_data>`, masked) | ≤8 fragments, ≤2 500 |

The whole input is capped at `chat_max_input_tokens` (12 000): layer 7 is cut first, then 6;
layers 1-4 never. Stable first, changing last (prompt cache): no time stamp in the system part.
Tokens are estimated as chars / 3 (Cyrillic runs about 2.5-3.5 chars per token) [estimate].
Record text (titles, fragments) is data: it goes only into `untrusted` parts. Reads are short
sessions; nothing stays open while the embedder or the model works.
"""

import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from zoneinfo import ZoneInfo

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from assistant.ai import TaskInputs, UntrustedPart
from assistant.ai.types import Message
from assistant.chat.sources import PageInfo, Source, SourceBook
from assistant.chat.tools import READ_TOOLS, ToolEnv, run_search
from assistant.chat.verify import Facts, facts_of, short_date
from assistant.embeddings import ChunkEmbedder

PROMPT_VERSION = "chat.v2"
SYSTEM_PROMPT = (Path(__file__).parent / "prompts" / "chat.v2.md").read_text(encoding="utf-8")

BUDGET_PROFILE = 400
BUDGET_PAGE_LINE = 30
BUDGET_INDEX = 600
BUDGET_PAGE = 1500
BUDGET_SUMMARY = 600
BUDGET_HISTORY = 2500
BUDGET_FOUND = 2500
MAX_VISIBLE = 40
MAX_FOUND = 8
MAX_HISTORY = 10
VISIBLE_ITEM_CHARS = 100

_WEEKDAYS = ("понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье")
_MONTHS_GEN = ("января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа",
               "сентября", "октября", "ноября", "декабря")  # fmt: skip
_SMALL_TALK = re.compile(
    r"^\s*(привет\w*|здравств\w*|салем\w*|сәлем\w*|спасибо\w*|рахмет\w*|ок|окей|хорошо|"
    r"понятно|ясно|пока|до свидания|да|нет)\s*[.!)]*\s*$", re.IGNORECASE)  # fmt: skip


def est_tokens(value: str) -> int:
    return (len(value) + 2) // 3


def _cut(value: str, tokens: int) -> str:
    limit = tokens * 3
    return value if len(value) <= limit else value[:max(0, limit - 1)].rstrip() + "…"


def looks_like_data_question(phrase: str) -> bool:
    """Layer 7 is filled only when the phrase is about the person's data (spec 5.10). Code, no
    model: small talk («спасибо», «привет») gets no search."""
    return bool(phrase.strip()) and not _SMALL_TALK.match(phrase)


def now_line(now: datetime, tz: str) -> str:
    local = now.astimezone(ZoneInfo(tz))
    return (f"Сейчас: {_WEEKDAYS[local.weekday()]}, {local.day} {_MONTHS_GEN[local.month - 1]} "
            f"{local.year}, {local:%H:%M} ({tz}).")  # fmt: skip


@dataclass
class TurnInput:
    user_id: int
    conversation_id: int
    message_id: int  # the person's message of this turn (left out of the history)
    text: str
    lang: str
    page_pk: int | None
    visible_pks: list[int]
    selected_pk: int | None = None  # «это»: the record open or selected on the phone
    input_kind: str = "typed"
    # The record was tapped in the answer to «Какую?» of a delete: that tap is the «Да».
    picked: bool = False


@dataclass
class Assembled:
    inputs: TaskInputs
    book: SourceBook
    extra: Facts  # numbers / dates the answer may state without a source
    tokens: dict[str, int]
    page: PageInfo | None
    prefetched: list[Source] = field(default_factory=list)
    tz: str = "Asia/Almaty"

    @property
    def total_tokens(self) -> int:
        return sum(self.tokens.values())


INSTRUCTION = ("Answer the person's question (the «Вопрос» line above) following your rules. "
               "Use the tools if what you were shown is not enough.")  # fmt: skip


async def _profile(session: AsyncSession, user_id: int) -> tuple[str, str, str]:
    row = (await session.execute(text(
        "SELECT coalesce(display_name, first_name) AS name, locale, tz FROM users WHERE id = :u"
    ), {"u": user_id})).one()  # fmt: skip
    return row.name or "", row.locale or "ru", row.tz or "Asia/Almaty"


async def _pages(session: AsyncSession, user_id: int, book: SourceBook) -> list[PageInfo]:
    rows = await session.execute(text("""
        SELECT s.id, s.public_id, s.title, s.icon, s.template_key,
               coalesce(ss.item_count, 0) AS n, ss.last_titles[1] AS last_title
        FROM screens s LEFT JOIN screen_summaries ss ON ss.screen_id = s.id
        WHERE s.user_id = :u AND s.deleted_at IS NULL AND s.hidden_at IS NULL
        ORDER BY s.position, s.id
    """), {"u": user_id})  # fmt: skip
    return [book.add_page(r.id, r.public_id, r.title, r.icon, r.template_key, int(r.n),
                          r.last_title) for r in rows]  # fmt: skip


async def _visible(session: AsyncSession, turn: TurnInput, book: SourceBook,
                   page: PageInfo | None) -> list[Source]:  # fmt: skip
    if page is None or not turn.visible_pks:
        return []
    rows = (await session.execute(text("""
        SELECT i.id, i.public_id, i.title, i.kind, i.occurred_at, i.created_at,
               left(coalesce(i.text, i.raw_text, i.summary, ''), 600) AS body
        FROM screen_items si JOIN items i ON i.id = si.item_id
        WHERE si.screen_id = :screen AND si.removed_by_user_at IS NULL AND i.user_id = :u
          AND i.deleted_at IS NULL AND i.hidden_reason IS NULL AND i.id = ANY(:ids)
    """), {"screen": page.pk, "u": turn.user_id,
           "ids": turn.visible_pks[:MAX_VISIBLE]})).all()  # fmt: skip
    by_pk = {r.id: r for r in rows}
    out = []
    for pk in turn.visible_pks[:MAX_VISIBLE]:  # in the order the phone shows them
        r = by_pk.get(pk)
        if r is None:
            continue
        body = " ".join((r.body or "").split())[:VISIBLE_ITEM_CHARS]
        out.append(book.add(pk=r.id, item_id=r.public_id, title=r.title, body=body, kind=r.kind,
                            occurred_at=r.occurred_at, created_at=r.created_at,
                            page_pks=[page.pk]))  # fmt: skip
    return out


async def _history(session: AsyncSession, turn: TurnInput, book: SourceBook,
                   tz: ZoneInfo) -> tuple[str | None, list[tuple[str, str]]]:  # fmt: skip
    conv = (await session.execute(text(
        "SELECT summary, summary_upto_msg_id FROM conversations WHERE id = :c"),
        {"c": turn.conversation_id})).one()  # fmt: skip
    summary = conv.summary
    # What the summary folded in is not repeated word for word (layer 5 vs 6).
    rows = (await session.execute(text("""
        SELECT role, content, screen_id, created_at FROM conversation_messages
        WHERE conversation_id = :c AND id <> :m AND deleted_at IS NULL AND id > :upto
          AND role IN ('user', 'assistant') AND state = 'done' AND content <> ''
        ORDER BY id DESC LIMIT :n
    """), {"c": turn.conversation_id, "m": turn.message_id, "n": MAX_HISTORY,
           "upto": conv.summary_upto_msg_id or 0})).all()  # fmt: skip
    out = []
    for r in reversed(rows):
        line = r.content
        if r.role == "user":
            page = book.page_by_pk(r.screen_id) if r.screen_id else None
            when = r.created_at.astimezone(tz)
            where = f"на странице «{page.title}», " if page else ""
            line = f"[{where}{short_date(when)} {when:%H:%M}] {r.content}"
        out.append((r.role, line))
    return summary, out


def _index_lines(pages: list[PageInfo], current: PageInfo | None) -> list[str]:
    lines = []
    for p in pages:
        # Only what the person named and code counted: record titles are data, not context
        # (they would sit outside <untrusted_data> here), so `last_titles` stays out.
        line = f"{p.ref} · {p.title[:40]} ({p.template_key}) · записей: {p.item_count}"
        if current is not None and p.pk == current.pk:
            line += " · ТЕКУЩАЯ"
        lines.append(_cut(line, BUDGET_PAGE_LINE))
    out, used = [], 0
    for line in lines:
        used += est_tokens(line)
        if used > BUDGET_INDEX:
            out.append(f"… ещё страниц: {len(lines) - len(out)}")
            break
        out.append(line)
    return out


def _source_line(book: SourceBook, src: Source, *, with_pages: bool) -> str:
    head = f"{src.ref} · {book.date_text(src)}"
    if with_pages and src.pages:
        head += " · [" + ", ".join(p.title for p in src.pages) + "]"
    return f"{head} · {src.title}\n{src.shown[-1]}" if src.shown[-1] else f"{head} · {src.title}"


async def _selected(session: AsyncSession, turn: TurnInput, book: SourceBook) -> Source | None:
    if turn.selected_pk is None:
        return None
    r = (await session.execute(text("""
        SELECT i.id, i.public_id, i.title, i.kind, i.occurred_at, i.created_at,
               left(coalesce(i.text, i.raw_text, i.summary, ''), 600) AS body
        FROM items i WHERE i.id = :i AND i.user_id = :u AND i.deleted_at IS NULL
    """), {"i": turn.selected_pk, "u": turn.user_id})).first()  # fmt: skip
    if r is None:
        return None
    links = (await session.execute(text("""
        SELECT si.screen_id FROM screen_items si JOIN screens s ON s.id = si.screen_id
        WHERE si.item_id = :i AND si.removed_by_user_at IS NULL AND s.deleted_at IS NULL
    """), {"i": r.id})).scalars().all()  # fmt: skip
    body = " ".join((r.body or "").split())[:300]
    return book.add(pk=r.id, item_id=r.public_id, title=r.title, body=body, kind=r.kind,
                    occurred_at=r.occurred_at, created_at=r.created_at, page_pks=list(links))


async def book_for(sessionmaker: async_sessionmaker[AsyncSession], user_id: int,
                   page_pk: int | None) -> SourceBook:  # fmt: skip
    """A book with just the pages (a tap on «Да» needs no context for a model)."""
    async with sessionmaker() as session:
        _, _, tz = await _profile(session, user_id)
        book = SourceBook(tz)
        await _pages(session, user_id, book)
        book.current = book.page_by_pk(page_pk) if page_pk is not None else None
    return book


async def assemble(
    sessionmaker: async_sessionmaker[AsyncSession], embedder: ChunkEmbedder, turn: TurnInput, *,
    now: datetime | None = None, max_input_tokens: int = 12000, embed_timeout_s: float = 0.5,
    min_similarity: float = 0.45, tools: tuple = READ_TOOLS,
) -> tuple[Assembled, ToolEnv]:  # fmt: skip
    now = now or datetime.now(UTC)
    async with sessionmaker() as session:
        name, locale, tz = await _profile(session, turn.user_id)
        book = SourceBook(tz)
        pages = await _pages(session, turn.user_id, book)
        page = book.page_by_pk(turn.page_pk) if turn.page_pk is not None else None
        book.current = page
        visible = await _visible(session, turn, book, page)
        selected = await _selected(session, turn, book)
        summary, history = await _history(session, turn, book, ZoneInfo(tz))
        view_line = None
        if page is not None and tools is not READ_TOOLS:  # week 11: for set_view
            from assistant.pages.view import describe

            view_line = await describe(session, page.pk)
    env = ToolEnv(sessionmaker, embedder, turn.user_id, book, embed_timeout_s, min_similarity,
                  counts=set())  # fmt: skip

    before = {s.ref for s in book.all()}
    found: list[Source] = []
    if looks_like_data_question(turn.text):
        found = await run_search(env, turn.text, limit=MAX_FOUND,
                                 boost_page_pk=page.pk if page else None)  # fmt: skip

    # --- layers ---
    tools_text = "".join(t.name + t.description + str(t.parameters) for t in tools)
    profile = [_cut(f"Профиль: имя {name or 'не указано'}; язык интерфейса {locale}; "
                    f"часовой пояс {tz}.", BUDGET_PROFILE)]  # fmt: skip
    index = _index_lines(pages, page)
    current = (f"Текущая страница: {page.ref} «{page.title}» ({page.template_key})"
               if page else "Текущая страница: не указана")  # fmt: skip
    question = f"Вопрос (язык {turn.lang}): {turn.text}"
    context = [now_line(now, tz), "Страницы:", *index, current]
    if view_line:
        context.append(view_line)
    if selected is not None:
        context.append(f"Выбранная запись («это», «здесь»): {selected.ref}")
    if tools is not READ_TOOLS:
        context.append("Изменения: человек в этой фразе просит что-то изменить; инструменты "
                       "изменений доступны.")  # fmt: skip
    else:
        context.append("Изменения: в этой фразе человек ничего менять не просил; только ответ.")
    if summary:
        context.append("Свёртка прошлых сообщений: " + _cut(summary, BUDGET_SUMMARY))
    context.append(question)

    page_lines: list[str] = []
    used = 0
    for src in visible:
        line = _source_line(book, src, with_pages=False)
        used += est_tokens(line)
        if used > BUDGET_PAGE:
            break
        page_lines.append(line)

    def found_lines(items: list[Source]) -> list[str]:
        return [_source_line(book, s, with_pages=True) for s in items]

    keep: list[Source] = []
    used = 0
    for src in found:
        cost = est_tokens(_source_line(book, src, with_pages=True))
        if used + cost > BUDGET_FOUND:
            break
        used += cost
        keep.append(src)

    hist: list[tuple[str, str]] = []
    used = 0
    for role, line in reversed(history):
        cost = est_tokens(line)
        if used + cost > BUDGET_HISTORY:
            break
        used += cost
        hist.insert(0, (role, line))

    tokens = {
        "system": est_tokens(SYSTEM_PROMPT) + est_tokens(tools_text) + 120,
        "profile": est_tokens(profile[0]),
        "context": sum(est_tokens(c) for c in context) + est_tokens(INSTRUCTION),
        "page": sum(est_tokens(x) for x in page_lines),
        "history": sum(est_tokens(x) for _, x in hist),
        "found": sum(est_tokens(x) for x in found_lines(keep)),
    }
    while sum(tokens.values()) > max_input_tokens and keep:  # cut layer 7 first
        keep.pop()
        tokens["found"] = sum(est_tokens(x) for x in found_lines(keep))
    while sum(tokens.values()) > max_input_tokens and hist:  # then layer 6, oldest first
        hist.pop(0)
        tokens["history"] = sum(est_tokens(x) for _, x in hist)
    kept = {s.ref for s in keep}
    for src in found:  # a source the model will not see cannot back a number
        if src.ref not in kept and src.ref not in before:
            book.discard(src.ref)
    while hist and hist[0][0] != "user":  # a conversation starts with the person
        hist.pop(0)

    untrusted = []
    if selected is not None:
        untrusted.append(UntrustedPart("Выбранная запись",
                                       _source_line(book, selected, with_pages=True)))
    if page_lines:
        untrusted.append(UntrustedPart(f"Записи на текущей странице «{page.title}»"
                                       if page else "Записи", "\n".join(page_lines)))  # fmt: skip
    if keep:
        untrusted.append(UntrustedPart("Найдено по всем страницам", "\n\n".join(found_lines(keep))))
    inputs = TaskInputs(
        system=SYSTEM_PROMPT, instruction=INSTRUCTION, context=context, untrusted=untrusted,
        prompt_version=PROMPT_VERSION, system_context=profile,
        history=[Message(role, line) for role, line in hist],
    )  # fmt: skip
    extra = facts_of(turn.text)
    today = Facts()
    today.add_date(now.astimezone(ZoneInfo(tz)))
    extra.update(today)
    for p in pages:
        extra.numbers.add(Decimal(p.item_count))
    return Assembled(inputs, book, extra, tokens, page, prefetched=keep, tz=tz), env
