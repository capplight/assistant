"""Step 5 against Postgres: the compact memory (Ф-59…Ф-61, Ф-70) and search over the whole
conversation. Providers and the embedder are fakes (no network). Skipped without DATABASE_URL.
"""

import os
import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy import select, text

from assistant.ai import ToolCall
from assistant.ai.types import AdapterRequest
from assistant.chat import ChatReply, memory, recall
from assistant.chat.memory import FactOut, MemoryReply
from assistant.chat.sources import SourceBook
from assistant.chat.tools import ToolEnv, execute
from assistant.db.models_memory import MemoryFact
from assistant.embeddings import FakeEmbedder
from tests.api.conftest import client
from tests.chat.test_chat_db import _all_text, env, signed_in  # noqa: F401  (env is a fixture)
from tests.chat.test_week6_db import Script, last, router_with, say, user_pk

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set"),
]


def _banner(evs) -> str:  # type: ignore[no-untyped-def]
    return last(evs, "banner")["text"]


async def _facts(maker, uid: int) -> list[MemoryFact]:  # type: ignore[no-untyped-def]
    async with maker() as s:
        return list(await s.scalars(select(MemoryFact).where(MemoryFact.user_id == uid)
                                    .order_by(MemoryFact.id)))


async def test_remember_list_and_forget_by_phrase(env):  # noqa: F811
    async with client(env.make_app(router_with(env.maker, Script()))) as c:
        h = await signed_in(c)
        uid = await user_pk(c, h, env.maker)
        evs = await say(c, h, "запомни: мой брат Ерлан, день рождения 3 мая")
        assert _banner(evs) == "Запомнил: Мой брат Ерлан, день рождения 3 мая."
        assert _banner(await say(c, h, "Запомни, что я не ем свинину")).startswith("Запомнил")
        evs = await say(c, h, "запомни: у сына аллергия на орехи")
        assert _banner(evs) == memory.TEXT_WONT_KEEP
        facts = await _facts(env.maker, uid)
        assert [(f.kind, f.source) for f in facts] == [("person", "said"), ("preference", "said")]
        evs = await say(c, h, "Что ты обо мне помнишь?")
        said = _banner(evs)
        assert "Люди: Мой брат Ерлан" in said and "Предпочтения: Я не ем свинину" in said
        assert _banner(await say(c, h, "забудь про Ерлана")).startswith("Забыл: «Мой брат Ерлан")
        assert len(await _facts(env.maker, uid)) == 1
        assert _banner(await say(c, h, "забудь про плитку")) == memory.TEXT_NOT_IN_MEMORY
        # «забудь всё» cannot be undone: one compact «Да»
        evs = await say(c, h, "забудь всё")
        ask = last(evs, "confirm")
        assert ask["question"] == "Забыть всё, что я о вас помню (1)?"
        assert len(await _facts(env.maker, uid)) == 1
        evs = await say(c, h, "Забыть", choice={"reply_id": ask["reply_id"], "option": "yes"})
        assert _banner(evs) == memory.TEXT_FORGOT_ALL
        assert await _facts(env.maker, uid) == []


class _Reader(Script):
    def __init__(self, facts: list[FactOut]) -> None:
        super().__init__()
        self.facts = facts

    def __call__(self, req: AdapterRequest):  # type: ignore[no-untyped-def]
        if req.schema_name == "MemoryReply":
            self.calls.setdefault(req.schema_name, []).append(req)
            return MemoryReply(facts=self.facts)
        return super().__call__(req)


def _f(text_: str, *, kind: str = "other", source: str = "said", material: str | None = None,
       until: str | None = None, op: str = "add", ref: str | None = None) -> FactOut:  # fmt: skip
    return FactOut(op=op, ref=ref, kind=kind, text=text_, source=source, material=material,  # type: ignore[arg-type]
                   until=until)


async def test_background_read_keeps_only_safe_grounded_facts(env):  # noqa: F811
    reader = _Reader([
        _f("Поездка в Стамбул 10–15 декабря", kind="project", until="2026-12-15"),
        _f("У сына аллергия на орехи"),  # health: never
        _f("Любит дорогие отели", kind="preference"),  # not in the phrases: dropped
        _f("Бронь отеля Султанахмет", kind="project", source="material", material="d1"),
    ])
    async with client(env.make_app(router_with(env.maker, reader))) as c:
        h = await signed_in(c)
        uid = await user_pk(c, h, env.maker)
        r = await c.post("/v1/items", json={"client_id": str(uuid.uuid4()), "source": "share",
                                            "text": "Бронь отеля Султанахмет 10–15 декабря"},
                         headers=h)  # fmt: skip
        assert r.status_code == 201, r.text
        for phrase in ("Мы летим в Стамбул 10 декабря, обратно 15-го", "у сына аллергия",
                       "Мастер Серик придёт в среду", "Плитку берём серую"):
            await say(c, h, phrase)
        async with env.maker() as s:
            conv = await s.scalar(text("SELECT id FROM conversations WHERE user_id = :u"),
                                  {"u": uid})
            n = await s.scalar(text("SELECT count(*) FROM jobs WHERE kind = 'chat:memory'"))
        assert n >= 1  # enqueued after the 4th phrase
        router = router_with(env.maker, reader)
        emb = FakeEmbedder()
        out = await memory.run_memory(env.maker, router, emb, conv, datetime.now(UTC))
        assert out.added == ["Поездка в Стамбул 10–15 декабря", "Бронь отеля Султанахмет"]
        assert out.dropped == 2
        facts = await _facts(env.maker, uid)
        assert [(f.source, str(f.valid_until)) for f in facts] == [("said", "2026-12-15"),
                                                                    ("material", "None")]
        assert all(f.embedding is not None for f in facts)
        req = reader.calls["MemoryReply"][0]
        assert "Бронь отеля" in _all_text(req) and "<untrusted_data>" in _all_text(req)
        # nothing new: no model call
        again = await memory.run_memory(env.maker, router, emb, conv, datetime.now(UTC))
        assert again.skipped == "nothing_new" and len(reader.calls["MemoryReply"]) == 1
        # the memory goes into every answer, as data
        reader.chat = [ChatReply(answer="Хорошо.", citations=[], insufficient=False)]
        await say(c, h, "Какие у меня планы на декабрь?")
        chat_req = reader.calls["ChatReply"][-1]
        body = _all_text(chat_req)
        assert "Память о человеке" in body and "Поездка в Стамбул" in body
        assert "(из материала)" in body
        # «что ты обо мне помнишь?» marks the material's fact
        assert "Бронь отеля Султанахмет (из материала)" in _banner(
            await say(c, h, "что ты обо мне помнишь?"))


async def test_daily_cap_stops_reads(env):  # noqa: F811
    reader = _Reader([_f("Дача в Талгаре", kind="place")])
    async with client(env.make_app(router_with(env.maker, reader))) as c:
        h = await signed_in(c)
        uid = await user_pk(c, h, env.maker)
        await say(c, h, "у нас дача в Талгаре")
        async with env.maker() as s:
            conv = await s.scalar(text("SELECT id FROM conversations WHERE user_id = :u"),
                                  {"u": uid})
            await s.execute(text("""
                INSERT INTO usage_counters (user_id, period_start, counter, value)
                SELECT :u, :d, 'memory_runs', 6
            """), {"u": uid, "d": memory_day()})
            await s.commit()
        out = await memory.run_memory(env.maker, router_with(env.maker, reader), None, conv)
        assert out.skipped == "daily_cap" and "MemoryReply" not in reader.calls


def memory_day() -> datetime:
    from assistant.ai.store import period_starts
    from assistant.config import get_settings

    return period_starts(datetime.now(UTC), get_settings().budget_tz)[0]


async def test_whole_conversation_is_searchable_by_words_and_meaning(env):  # noqa: F811
    script = Script([ChatReply(answer="Записал.", citations=[], insufficient=False)] * 20)
    async with client(env.make_app(router_with(env.maker, script))) as c:
        h = await signed_in(c)
        uid = await user_pk(c, h, env.maker)
        await say(c, h, "Мастер Серик советовал плитку Керама Марацци для ванной")
        async with env.maker() as s:  # a long conversation since (no rate limit in the way)
            await s.execute(text("""
                INSERT INTO conversation_messages (conversation_id, user_id, role, content, state,
                                                   input_kind, public_id, created_at)
                SELECT c.id, c.user_id, 'user', 'Где мои ключи номер ' || g, 'done', 'typed',
                       gen_random_uuid(), now() - interval '1 hour'
                FROM conversations c, generate_series(1, 12) g WHERE c.user_id = :u
            """), {"u": uid})
            await s.commit()
        async with env.maker() as s:
            turns = await recall.search_history(s, uid, "какую плитку советовал мастер?")
        assert turns and "Керама" in turns[0].said
        # by meaning: «кафель» is «плитка» for the fake embedder
        emb = FakeEmbedder(same_meaning={"кафель": "плитку"})
        assert await recall.embed_pending(env.maker, emb) > 0
        vec = (await emb.embed(["кафель"], "query"))[0]
        async with env.maker() as s:
            turns = await recall.search_history(s, uid, "кафель", vector=vec,
                                                min_similarity=0.1)
        assert turns and "Керама" in turns[0].said
        # the read tool
        tool_env = ToolEnv(env.maker, emb, uid, SourceBook("Asia/Almaty"), 0.5, 0.1,
                           counts=set())  # fmt: skip
        res = await execute(tool_env, ToolCall("x", "search_chat", {"query": "плитка Серик"}),
                            allowed={"search_chat"})  # fmt: skip
        assert not res.is_error and "Керама" in res.content
        # a shared text is never a turn of the person's
        await say(c, h, "Серик плитка реклама", input_kind="share")
        async with env.maker() as s:
            turns = await recall.search_history(s, uid, "реклама")
        assert turns == []
