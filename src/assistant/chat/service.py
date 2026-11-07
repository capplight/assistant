"""One chat turn (spec 5.10, 6.11): context -> model steps with read tools -> checked answer.

Flow of `start`:
1. One short transaction: the person's message and a `pending` answer row, committed.
2. The answer is written by a background task that does not depend on the connection: the phone
   may leave, the answer still gets saved (`delivery = banner_pending` if nobody was listening).
3. Events go to an in-memory log per answer (`ReplyRun`); the SSE stream and a resume after a
   dropped connection read it from any position (`Last-Event-ID`). A finished answer, or one
   written by another server process, is served from the database as a `snapshot`.

Rules held here: no DB transaction is open during a model call or the embedder (every read is
its own short session); the final answer is committed before `citations` / `checked` /
`banner` / `done` are sent; tokens are whole sentences that passed the number/date check;
citations are only refs this turn issued; the provider is pinned after the first step.
"""

import asyncio
import logging
import re
import uuid
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

from pydantic import BaseModel
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from assistant.ai import (
    AIConsentRequired,
    AIUnavailable,
    BudgetExceeded,
    LLMTask,
    Masker,
    StreamInterrupted,
)
from assistant.ai.prompting import ToolRound
from assistant.ai.router import Router
from assistant.ai.types import ToolResult
from assistant.chat import store
from assistant.chat.context import PROMPT_VERSION, Assembled, TurnInput, assemble, est_tokens
from assistant.chat.sources import Source, SourceBook
from assistant.chat.stream import FieldStream
from assistant.chat.tools import READ_TOOLS, TOOLS, ToolEnv, call_key, execute
from assistant.chat.verify import Facts, check_sentence, split_sentences
from assistant.config import Settings
from assistant.db.models_chat import (
    AnswerKind,
    ConversationMessage,
    Delivery,
    InputKind,
    MessageRole,
    MessageState,
)
from assistant.embeddings import ChunkEmbedder, NullChunkEmbedder
from assistant.logs import error_text

log = logging.getLogger(__name__)

MAX_CALLS_PER_STEP = 4
ANSWER_MAX_CHARS = 4000
PREVIEW_CHARS = 140
RUN_KEEP_S = 600.0  # a finished answer's events stay in memory this long (resume from memory)
_REF_RE = re.compile(r"\s*\[(?:s\d+(?:,\s*)?)+\]")

TEXT_NOT_FOUND = {"ru": "Не нашёл в записях.", "kk": "Жазбалардан таппадым."}
TEXT_REMOVED = {"ru": "Часть чисел не нашёл в записях — не стал их писать.",
                "kk": "Кейбір сандарды жазбалардан таппадым — оларды жазбадым."}  # fmt: skip
TEXT_LIMITED = {"ru": "На сегодня достаточно — продолжу завтра. Сохранение, напоминания и поиск "
                      "работают.",
                "kk": "Бүгінге жетеді — ертең жалғастырамын. Сақтау, еске салу және іздеу "
                      "жұмыс істейді."}  # fmt: skip
TEXT_LIMITED_FOUND = {"ru": " Вот что нашёл в записях.", "kk": " Жазбалардан тапқаным осы."}
TEXT_DEFERRED = {"ru": "Сейчас не получается ответить. Попробуйте чуть позже.",
                 "kk": "Қазір жауап бере алмаймын. Сәл кейін көріңіз."}  # fmt: skip
STATUS = {
    "thinking": {"ru": "Смотрю записи…", "kk": "Жазбаларды қарап жатырмын…"},
    "searching": {"ru": "Ищу в записях…", "kk": "Жазбалардан іздеп жатырмын…"},
    "writing": {"ru": "Пишу ответ…", "kk": "Жауап жазып жатырмын…"},
}
ERRORS = {
    "stream_interrupted": ("Не получилось ответить. Попробуйте ещё раз.",
                           "Жауап бере алмадым. Қайталап көріңіз."),
    "consent_required": ("Чтобы отвечать, нужно ваше согласие на экране «Согласия».",
                         "Жауап беру үшін «Келісімдер» экранында келісіміңіз керек."),
    "internal": ("Что-то пошло не так. Попробуйте ещё раз.", "Бірдеңе дұрыс болмады. Қайталаңыз."),
    "stale": ("Не получилось ответить. Попробуйте ещё раз.",
              "Жауап бере алмадым. Қайталап көріңіз."),
}  # fmt: skip


class ChatReply(BaseModel):
    """The model's structured answer. `answer` first: it is what streams to the person."""

    answer: str
    citations: list[str]
    insufficient: bool


@dataclass
class ChatRequest:
    client_id: uuid.UUID
    text: str
    page_id: uuid.UUID | None = None
    visible_item_ids: list[uuid.UUID] = field(default_factory=list)
    view_version: int | None = None
    selected_item_id: uuid.UUID | None = None
    lang: str | None = None
    input_kind: str = InputKind.TYPED


Event = tuple[int, str, dict[str, Any]]


class ReplyRun:
    """The event log of one answer being written in this process."""

    def __init__(self, reply_pk: int, reply_id: uuid.UUID, user_id: int) -> None:
        self.reply_pk = reply_pk
        self.reply_id = reply_id
        self.user_id = user_id
        self.events: list[Event] = []
        self.finished = False
        self.subscribers = 0
        self._changed = asyncio.Event()

    def emit(self, name: str, data: dict[str, Any]) -> None:
        self.events.append((len(self.events) + 1, name, data))
        self._changed.set()

    def finish(self) -> None:
        self.finished = True
        self._changed.set()

    async def follow(self, after: int = 0, keepalive_s: float = 15.0
                     ) -> AsyncIterator[Event | None]:  # fmt: skip
        """Events after `after`, then live ones until the end. None = time for a keep-alive."""
        self.subscribers += 1
        try:
            i = max(0, after)
            while True:
                while i < len(self.events):
                    yield self.events[i]
                    i += 1
                if self.finished:
                    return
                self._changed.clear()
                if i < len(self.events):
                    continue
                try:
                    await asyncio.wait_for(self._changed.wait(), keepalive_s)
                except TimeoutError:
                    yield None
        finally:
            self.subscribers -= 1


class AnswerGate:
    """Turns streamed answer text into checked sentences. Every number and date of a sentence
    must be found in a source the model saw this turn, or in `extra` (the question, today,
    counts our code made); otherwise the sentence is not sent."""

    def __init__(self, book: SourceBook, extra: Facts, counts: set[int],
                 emit: Callable[[str, dict[str, Any]], None], lang: str = "ru") -> None:
        self.lang = lang
        self.book = book
        self.extra = extra
        self.counts = counts
        self.emit = emit
        self.fed = ""
        self.buffer = ""
        self.sent: list[str] = []
        self.removed = 0
        self.basis: list[str] = []  # refs that back a number of the answer

    @property
    def started(self) -> bool:
        return bool(self.fed)

    @property
    def text(self) -> str:
        return "".join(self.sent).strip()

    def _allowed(self) -> Facts:
        allowed = Facts()
        allowed.update(self.extra)
        allowed.numbers |= {Decimal(n) for n in self.counts}
        allowed.numbers.add(Decimal(len(self.book)))
        return allowed

    def _sentence(self, raw: str) -> None:
        sentence = _REF_RE.sub("", raw)
        if not sentence.strip():
            if self.sent and raw.strip() == "" and "\n" in raw:
                self.sent.append(raw)
            return
        if not self.sent:
            self.emit("status", {"stage": "writing", "text": STATUS["writing"][self.lang]})
        result = check_sentence(sentence, self.book.facts(), self._allowed())
        if not result.ok:
            self.removed += 1
            log.info("chat: sentence dropped, %d unverified values", len(result.missing))
            return
        for refs in result.supported_by.values():
            ref = sorted(refs, key=lambda r: int(r[1:]))[0]
            if ref not in self.basis:
                self.basis.append(ref)
        self.sent.append(sentence)
        self.emit("token", {"text": sentence})

    def feed(self, piece: str) -> None:
        self.fed += piece
        self.buffer += piece
        done, self.buffer = split_sentences(self.buffer)
        for s in done:
            self._sentence(s)

    def finish(self, final_text: str | None) -> None:
        if final_text is not None and final_text.startswith(self.fed):
            self.feed(final_text[len(self.fed):])
        if self.buffer.strip():
            rest, self.buffer = self.buffer, ""
            self._sentence(rest)


def _preview(value: str) -> str:
    flat = " ".join(value.split())
    if len(flat) <= PREVIEW_CHARS:
        return flat
    cut = flat[:PREVIEW_CHARS - 1]
    space = cut.rfind(" ")
    return (cut[:space] if space > PREVIEW_CHARS // 2 else cut).rstrip(" ,.;:—-") + "…"


def _lang(value: str | None) -> str:
    return value if value in ("ru", "kk") else "ru"


class ChatService:
    def __init__(self, settings: Settings, sessionmaker: async_sessionmaker[AsyncSession],
                 router: Router | None, embedder: ChunkEmbedder | None = None, *,
                 clock: Callable[[], datetime] = lambda: datetime.now(UTC)) -> None:  # fmt: skip
        self.s = settings
        self.sessionmaker = sessionmaker
        self.router = router
        self.embedder = embedder or NullChunkEmbedder()
        self.clock = clock
        self.runs: dict[uuid.UUID, ReplyRun] = {}
        self._tasks: set[asyncio.Task[None]] = set()

    @property
    def ai_label(self) -> str:
        return self.s.label_ai_generated

    def chat_providers(self) -> list[str]:
        if self.router is None:
            return []
        return list(self.router.routes.route(LLMTask.CHAT).chain)

    async def drain(self) -> None:
        """Wait for answers being written (tests, shutdown)."""
        while self._tasks:
            await asyncio.gather(*list(self._tasks), return_exceptions=True)

    # --- start a turn ---

    async def start(self, user_id: int, locale: str, req: ChatRequest
                    ) -> tuple[uuid.UUID, ReplyRun | None]:  # fmt: skip
        """Save the message and start the answer. Returns the answer id and its live run (None
        when this client_id was already answered: resume it instead)."""
        async with self.sessionmaker() as session:
            conv = await store.main_conversation(session, user_id)
            existing = await store.find_by_client_id(session, conv.id, req.client_id)
            if existing is not None:
                reply = await store.reply_of(session, existing.id)
                await session.commit()
                if reply is None:
                    raise LookupError("message without an answer")
                live = self.runs.get(reply.public_id)
                return reply.public_id, live if live and not live.finished else None
            page_pk = await self._page_pk(session, user_id, req.page_id)
            visible = await self._item_pks(session, user_id, req.visible_item_ids[:40])
            lang = _lang(req.lang or locale)
            msg = ConversationMessage(
                conversation_id=conv.id, user_id=user_id, client_id=req.client_id,
                role=MessageRole.USER, screen_id=page_pk, input_kind=req.input_kind,
                content=req.text, state=MessageState.DONE,
                tool_results_ref=[{"view_version": req.view_version,
                                   "selected_item_id": str(req.selected_item_id)
                                   if req.selected_item_id else None}],
            )  # fmt: skip
            session.add(msg)
            try:
                await session.flush()
            except IntegrityError:  # the same client_id raced in: answer the first one
                await session.rollback()
                return await self.start(user_id, locale, req)
            reply = ConversationMessage(
                conversation_id=conv.id, user_id=user_id, role=MessageRole.ASSISTANT,
                reply_to_id=msg.id, screen_id=page_pk, content="", answer_kind=AnswerKind.TEXT,
                state=MessageState.PENDING, prompt_version=PROMPT_VERSION,
            )  # fmt: skip
            session.add(reply)
            await session.flush()
            await store.bump_count(session, conv.id, 2)
            turn = TurnInput(user_id, conv.id, msg.id, req.text, lang, page_pk, visible)
            reply_pk, reply_id, msg_id, created = reply.id, reply.public_id, msg.public_id, \
                msg.created_at
            await session.commit()
        run = ReplyRun(reply_pk, reply_id, user_id)
        self.runs[reply_id] = run
        run.emit("accepted", {"message_id": str(msg_id), "reply_id": str(reply_id),
                              "created_at": created.isoformat()})  # fmt: skip
        task = asyncio.create_task(self._run(run, turn))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return reply_id, run

    async def _page_pk(self, session: AsyncSession, user_id: int,
                       page_id: uuid.UUID | None) -> int | None:  # fmt: skip
        if page_id is None:
            return None
        from assistant.db.models_pages import Screen

        return await session.scalar(select(Screen.id).where(
            Screen.user_id == user_id, Screen.public_id == page_id, Screen.deleted_at.is_(None)))

    async def _item_pks(self, session: AsyncSession, user_id: int,
                        ids: list[uuid.UUID]) -> list[int]:  # fmt: skip
        if not ids:
            return []
        from assistant.db.models import Item

        rows = await session.execute(select(Item.public_id, Item.id).where(
            Item.user_id == user_id, Item.public_id.in_(ids)))  # fmt: skip
        pk_of = {pid: pk for pid, pk in rows}
        return [pk_of[i] for i in dict.fromkeys(ids) if i in pk_of]

    # --- the background answer ---

    async def _run(self, run: ReplyRun, turn: TurnInput) -> None:
        lang = turn.lang
        try:
            run.emit("status", {"stage": "thinking", "text": STATUS["thinking"][lang]})
            ctx, env = await assemble(
                self.sessionmaker, self.embedder, turn, now=self.clock(),
                max_input_tokens=self.s.chat_max_input_tokens,
                embed_timeout_s=self.s.search_embed_timeout_seconds,
                min_similarity=self.s.search_vector_min_similarity,
            )  # fmt: skip
            self._announce(run, ctx.book, only={s.ref for s in ctx.prefetched})
            await self._steps(run, turn, ctx, env)
        except Exception as exc:  # never leave the answer pending
            log.exception("chat turn failed: %s", error_text(exc))
            await self._fail(run, "internal", text="")
        finally:
            run.finish()
            asyncio.get_running_loop().call_later(RUN_KEEP_S, self.runs.pop, run.reply_id, None)

    def _announce(self, run: ReplyRun, book: SourceBook, only: set[str] | None = None) -> None:
        new = [s for s in book.take_new() if only is None or s.ref in only]
        if new:
            run.emit("sources", {"sources": [book.source_out(s) for s in new]})

    async def _steps(self, run: ReplyRun, turn: TurnInput, ctx: Assembled, env: ToolEnv) -> None:
        lang = turn.lang
        book = ctx.book
        gate = AnswerGate(book, ctx.extra, env.counts, run.emit, lang)
        masker = Masker(mask_contacts=True)
        provider: str | None = None
        cost = Decimal(0)
        seen: set[str] = set()
        tool_log: list[dict[str, Any]] = []
        reply: ChatReply | None = None
        allowed = {t.name for t in READ_TOOLS}  # week 6: + mutating tools behind the intent rule
        round_tokens = 0
        if self.router is None:
            await self._deferred(run, lang)
            return
        try:
            for step in range(self.s.chat_max_tool_steps + 1):
                final = (step == self.s.chat_max_tool_steps
                         or ctx.total_tokens + round_tokens >= self.s.chat_max_input_tokens)
                fs = FieldStream()

                async def hook(delta: str, fs: FieldStream = fs) -> None:
                    piece = fs.feed(delta)
                    if piece:
                        gate.feed(piece)

                result = await self.router.run(
                    LLMTask.CHAT, ChatReply, ctx.inputs, user_id=turn.user_id, stream=hook,
                    tools=READ_TOOLS, masker=masker, pin_provider=provider,
                    tool_choice="none" if final else "auto",
                )  # fmt: skip
                provider = result.provider
                cost += result.cost_usd
                if result.tool_calls and not gate.started and not final:
                    run.emit("status", {"stage": "searching", "text": STATUS["searching"][lang]})
                    results = []
                    for i, call in enumerate(result.tool_calls):
                        key = call_key(call)
                        if i >= MAX_CALLS_PER_STEP:
                            content, is_error = '{"error":"too many calls in one step"}', True
                        elif key in seen:
                            content = ('{"error":"already called with these arguments; '
                                       'use the earlier result"}')  # fmt: skip
                            is_error = True
                        else:
                            seen.add(key)
                            tool = TOOLS.get(call.name)
                            outcome = await execute(env, call, allowed=allowed)
                            if tool is not None and not outcome.is_error:
                                run.emit("tool_activity", {"tool": call.name,
                                                           "text": outcome.activity,
                                                           "page_id": outcome.page})  # fmt: skip
                            content, is_error = outcome.content, outcome.is_error
                            tool_log.append({"name": call.name, "arguments": call.arguments,
                                             "error": is_error})  # fmt: skip
                        results.append(ToolResult(call.id, call.name, content, is_error))
                        round_tokens += est_tokens(content) + est_tokens(str(call.arguments))
                    self._announce(run, book)
                    ctx.inputs.tool_rounds.append(
                        ToolRound(tuple(result.tool_calls), tuple(results), result.raw))
                    continue
                reply = result.data
                break
        except BudgetExceeded:
            await self._limited(run, turn, ctx, cost, tool_log)
            return
        except AIConsentRequired:
            await self._fail(run, "consent_required", text=gate.text, retry=False, cost=cost)
            return
        except StreamInterrupted:
            await self._fail(run, "stream_interrupted", text=gate.text, cost=cost)
            return
        except AIUnavailable as exc:
            log.warning("chat: no provider answered: %s", exc)
            if gate.sent:
                await self._fail(run, "stream_interrupted", text=gate.text, cost=cost)
            else:
                await self._deferred(run, lang, cost=cost)
            return

        answer = reply.answer[:ANSWER_MAX_CHARS] if reply is not None else None
        gate.finish(answer if answer is not None else gate.fed)
        text = gate.text
        if gate.removed:
            text = (text + " " + TEXT_REMOVED[lang]).strip()
        if not text:
            text = TEXT_NOT_FOUND[lang]
        refs: list[str] = []
        for ref in ([*(reply.citations if reply else []), *gate.basis]):
            src = book.get(ref) if isinstance(ref, str) else None
            if src is not None and src.ref not in refs:
                refs.append(src.ref)
        citations = [book.citation_out(book.get(r)) for r in refs]  # type: ignore[arg-type]
        checked = {"ok": gate.removed == 0, "removed": gate.removed}
        delivery = await self._save(run, text=text, citations=citations, checked=checked,
                                    tools=tool_log, seen_refs=[s.ref for s in book.all()],
                                    cost=cost, ai_generated=True)  # fmt: skip
        if delivery is None:
            return
        run.emit("citations", {"citations": citations})
        run.emit("checked", checked)
        self._banner(run, text, citations, ai=True)
        run.emit("done", {"reply_id": str(run.reply_id), "state": MessageState.DONE,
                          "answer_kind": AnswerKind.TEXT, "delivery": delivery,
                          "limited": False})  # fmt: skip

    def _banner(self, run: ReplyRun, text: str, citations: list[dict[str, Any]], *,
                ai: bool) -> None:  # fmt: skip
        preview = _preview(text)
        run.emit("banner", {"reply_id": str(run.reply_id), "text": text, "preview": preview,
                            "short": preview == " ".join(text.split()),
                            "ai_label": self.ai_label if ai else None,
                            "citations": citations})  # fmt: skip

    async def _limited(self, run: ReplyRun, turn: TurnInput, ctx: Assembled, cost: Decimal,
                       tool_log: list[dict[str, Any]]) -> None:  # fmt: skip
        """Over the monthly limit: search results without a written answer (spec 5.4)."""
        lang = turn.lang
        found: list[Source] = ctx.prefetched
        text = TEXT_LIMITED[lang] + (TEXT_LIMITED_FOUND[lang] if found else "")
        citations = [ctx.book.citation_out(s) for s in found]
        delivery = await self._save(run, text=text, citations=citations, checked=None,
                                    tools=tool_log, seen_refs=[], cost=cost,
                                    ai_generated=False)  # fmt: skip
        if delivery is None:
            return
        run.emit("citations", {"citations": citations})
        run.emit("checked", {"ok": True, "removed": 0})
        self._banner(run, text, citations, ai=False)
        run.emit("done", {"reply_id": str(run.reply_id), "state": MessageState.DONE,
                          "answer_kind": AnswerKind.TEXT, "delivery": delivery,
                          "limited": True})  # fmt: skip

    async def _deferred(self, run: ReplyRun, lang: str, *, cost: Decimal = Decimal(0)) -> None:
        delivery = await self._save(run, text="", citations=[], checked=None, tools=[],
                                    seen_refs=[], cost=cost, ai_generated=False,
                                    state=MessageState.DEFERRED,
                                    answer_kind=AnswerKind.DEFERRED)  # fmt: skip
        if delivery is None:
            return
        run.emit("deferred", {"reply_id": str(run.reply_id), "state": MessageState.DEFERRED,
                              "reason": "unavailable", "text": TEXT_DEFERRED[lang]})  # fmt: skip

    async def _fail(self, run: ReplyRun, code: str, *, text: str, retry: bool = True,
                    cost: Decimal = Decimal(0)) -> None:  # fmt: skip
        try:
            saved = await self._save(run, text=text, citations=[], checked=None, tools=[],
                                     seen_refs=[], cost=cost, ai_generated=bool(text),
                                     state=MessageState.FAILED, error_code=code)  # fmt: skip
        except Exception:
            log.exception("chat: could not save a failed answer")
            saved = None
        if saved is None and run.events and run.events[-1][1] in ("done", "deferred", "error"):
            return
        ru, kk = ERRORS.get(code, ERRORS["internal"])
        run.emit("error", {"reply_id": str(run.reply_id), "code": code, "message_ru": ru,
                           "message_kk": kk, "retry": retry})  # fmt: skip

    async def _save(self, run: ReplyRun, *, text: str, citations: list[dict[str, Any]],
                    checked: dict[str, Any] | None, tools: list[dict[str, Any]],
                    seen_refs: list[str], cost: Decimal, ai_generated: bool,
                    state: str = MessageState.DONE, answer_kind: str = AnswerKind.TEXT,
                    error_code: str | None = None) -> str | None:  # fmt: skip
        """Commit the answer; returns its delivery, None when the row is gone (history was
        cleared meanwhile: nothing to send)."""
        delivery = Delivery.STREAMED if run.subscribers > 0 else Delivery.BANNER_PENDING
        async with self.sessionmaker() as session:
            res = await session.execute(
                update(ConversationMessage)
                .where(ConversationMessage.id == run.reply_pk,
                       ConversationMessage.state == MessageState.PENDING)
                .values(content=text, citations=citations, checked=checked, tool_calls=tools,
                        tool_results_ref=[{"refs": seen_refs}], cost_usd=cost,
                        ai_generated=ai_generated, state=state, answer_kind=answer_kind,
                        error_code=error_code, delivery=delivery, updated_at=func.now())
            )  # fmt: skip
            await session.commit()
        if not res.rowcount:  # type: ignore[attr-defined]
            run.emit("error", {"reply_id": str(run.reply_id), "code": "internal",
                               "message_ru": ERRORS["internal"][0],
                               "message_kk": ERRORS["internal"][1], "retry": True})  # fmt: skip
            return None
        return delivery

    # --- resume ---

    async def resume(self, user_id: int, reply_id: uuid.UUID, after: int
                     ) -> AsyncIterator[Event | None]:  # fmt: skip
        """Events of an answer from `after` on: live from memory while it is being written
        here; once finished (or written elsewhere) a snapshot from the DB."""
        run = self.runs.get(reply_id)
        if run is not None and run.user_id == user_id and not run.finished:
            async for ev in run.follow(after):
                yield ev
            return
        stale_s = self.s.chat_stale_pending_seconds
        while True:
            async with self.sessionmaker() as session:
                msg = await store.by_public_id(session, user_id, reply_id)
                if msg is None or msg.role != MessageRole.ASSISTANT:
                    raise LookupError("not found")
                if msg.state == MessageState.PENDING:
                    cutoff = self.clock() - timedelta(seconds=stale_s)
                    if await store.mark_stale_failed(session, msg.id, cutoff):
                        await session.commit()
                        continue
                    await session.commit()
                else:
                    snap = (await store.messages_dicts(session, [msg], self.ai_label))[0]
                    reply_to = snap["reply_to"]
                    break
            local = self.runs.get(reply_id)  # it may have started here meanwhile
            if local is not None and not local.finished:
                async for ev in local.follow(after):
                    yield ev
                return
            yield None
            await asyncio.sleep(1.0)
        yield (1, "accepted", {"message_id": reply_to, "reply_id": str(reply_id),
                               "created_at": snap["created_at"]})  # fmt: skip
        yield (2, "snapshot", {"message": snap})
        if snap["state"] == MessageState.DONE:
            yield (3, "done", {"reply_id": str(reply_id), "state": snap["state"],
                               "answer_kind": snap["answer_kind"], "delivery": snap["delivery"],
                               "limited": snap["ai_label"] is None})  # fmt: skip
        elif snap["state"] == MessageState.DEFERRED:
            yield (3, "deferred", {"reply_id": str(reply_id), "state": snap["state"],
                                   "reason": "unavailable", "text": TEXT_DEFERRED["ru"]})
        else:
            code = msg.error_code or "internal"
            ru, kk = ERRORS.get(code, ERRORS["internal"])
            yield (3, "error", {"reply_id": str(reply_id), "code": code, "message_ru": ru,
                                "message_kk": kk, "retry": code != "consent_required"})
