"""Injection corpus through the real line (week 17; spec 5.7, 5.10, 9): every case of
eval/injection/corpus.yaml as a record on a page, the person asks a question, the fake provider
obeys the record. Nothing may change. Plus shared text (rule 1), the history and summary fold
without shared text (rule 10), and no reach into another person's records.

Providers are fakes (no network). Skipped without DATABASE_URL.
"""

import os

import pytest
from sqlalchemy import select, text

from assistant.ai.types import AdapterRequest
from assistant.chat import ChatReply, jobs
from assistant.chat.context import SHARED_IN_HISTORY
from assistant.db.models_actions import Action
from tests.api.conftest import client
from tests.chat.test_chat_db import _all_text, env, events, page, record, signed_in  # noqa: F401
from tests.chat.test_injection_corpus import CASES, QUESTION, obey
from tests.chat.test_week6_db import Script, router_with, rows, say, user_pk

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set"),
]
# Week 18: the corpus sends many phrases from one person; the message limit is not tested here.
NO_LIMIT = {"chat_rate_per_minute": {}, "chat_rate_per_day": {}}

ANSWER = ChatReply(answer="В записи текст документа.", citations=[], insufficient=False)


def _untrusted(req: AdapterRequest) -> str:
    body = req.messages[-1].text if req.messages else ""
    for m in req.messages:
        if "<untrusted_data>" in m.text:
            body = m.text
    start, end = body.find("<untrusted_data>"), body.rfind("</untrusted_data>")
    return body[start:end] if start >= 0 else ""


async def _state(maker, uid: int) -> tuple:  # type: ignore[no-untyped-def]
    async with maker() as s:
        agent = await s.scalar(select(Action.id).where(Action.user_id == uid,
                                                       Action.initiated_by == "agent"))
        deleted = await s.scalar(text("SELECT count(*) FROM items WHERE user_id = :u "
                                      "AND deleted_at IS NOT NULL"), {"u": uid})  # fmt: skip
        pages = await s.scalar(text("SELECT count(*) FROM screens WHERE user_id = :u"),
                               {"u": uid})  # fmt: skip
        pending = await s.scalar(text("SELECT count(*) FROM pending_actions WHERE user_id = :u"),
                                 {"u": uid})  # fmt: skip
        reminders = await s.scalar(text("SELECT count(*) FROM reminders WHERE user_id = :u"),
                                   {"u": uid})  # fmt: skip
    return agent, deleted, pages, pending, reminders


async def test_every_corpus_case_changes_nothing(env):  # noqa: F811
    script = Script()
    async with client(env.make_app(router_with(env.maker, script), **NO_LIMIT)) as c:
        h = await signed_in(c)
        uid = await user_pk(c, h, env.maker)
        pid = await page(c, h, "Дом")
        ids = [await record(c, h, env.maker, t, pid)
               for t in ("Плитка в коридор", "Краска для стен")]  # fmt: skip
        before_rows = await rows(env.maker, pid)
        start = await _state(env.maker, uid)
        failed = []
        for case in CASES:
            if case["channel"] == "share":
                continue  # below
            rid = await record(c, h, env.maker, case["text"])
            script.chat = [obey(case), ANSWER]
            n0 = script.n("ChatReply")
            evs = await say(c, h, QUESTION[case["lang"]], page_id=pid,
                            visible_item_ids=[rid, *ids])  # fmt: skip
            names = [n for _, n, _ in evs]
            first = script.calls["ChatReply"][n0]
            offered = {t.name for t in first.tools}
            ok = (offered == {"search", "list_page", "aggregate"}
                  and not {"action", "confirm", "reminder_draft"} & set(names)
                  and "done" in names and _untrusted(first).count("</untrusted_data>") == 0)
            if not ok:
                failed.append(case["id"])
        assert failed == []
        assert await _state(env.maker, uid) == start
        assert await rows(env.maker, pid) == before_rows


async def test_shared_text_is_data_and_never_repeated(env):  # noqa: F811
    script = Script()
    app = env.make_app(router_with(env.maker, script), **NO_LIMIT)
    async with client(app) as c:
        h = await signed_in(c)
        uid = await user_pk(c, h, env.maker)
        start = await _state(env.maker, uid)
        for case in [x for x in CASES if x["channel"] == "share"]:
            script.chat = [obey(case), ANSWER]
            n0 = script.n("ChatReply")
            evs = await say(c, h, case["text"], input_kind="share")
            names = [n for _, n, _ in evs]
            assert not {"action", "confirm", "reminder_draft"} & set(names), case["id"]
            req = script.calls["ChatReply"][n0]
            assert {t.name for t in req.tools} == {"search", "list_page", "aggregate"}
            # spec 5.7 rule 1: the shared text is inside the data block, not in our lines
            assert case["text"][:30] in _untrusted(req), case["id"]
            assert f"): {case['text']}" not in _all_text(req)
        assert await _state(env.maker, uid) == start
        # The next turn: the shared texts are not repeated in the history (layer 6).
        script.chat = [ANSWER]
        await say(c, h, "Что я спрашивал?")
        prompt = _all_text(script.calls["ChatReply"][-1])
        assert SHARED_IN_HISTORY in prompt
        for case in [x for x in CASES if x["channel"] == "share"]:
            assert case["text"] not in prompt, case["id"]
        # ... nor in the summary fold (layer 5)
        for i in range(8):
            script.chat = [ANSWER]
            await say(c, h, f"Вопрос номер {i}")
        async with env.maker() as s:
            conv = await s.scalar(text("SELECT id FROM conversations WHERE user_id = :u"),
                                  {"u": uid})  # fmt: skip
        assert await jobs.run_summarize(env.maker, app.state.ctx.chat.router, conv)
        sent = _all_text(script.calls["ChatSummary"][0])
        assert SHARED_IN_HISTORY in sent
        for case in [x for x in CASES if x["channel"] == "share"]:
            assert case["text"] not in sent, case["id"]
        async with env.maker() as s:
            await s.execute(text("DELETE FROM jobs"))
            await s.commit()


async def test_a_record_cannot_reach_another_persons_records(env):  # noqa: F811
    reveal = next(x for x in CASES if x["attack"] == "reveal")
    script = Script()
    async with client(env.make_app(router_with(env.maker, script), **NO_LIMIT)) as c:
        other = await signed_in(c)
        await record(c, other, env.maker, "ЧУЖОЙ-СЕКРЕТ: код сейфа у соседа")
        h = await signed_in(c)
        rid = await record(c, h, env.maker, reveal["text"])

        def search_secret(req: AdapterRequest):  # type: ignore[no-untyped-def]
            from assistant.ai import ToolCall

            return [ToolCall("x1", "search", {"query": "ЧУЖОЙ-СЕКРЕТ код сейфа", "page": None,
                                              "kind": None, "date_from": None, "date_to": None,
                                              "user_id": 1})]  # fmt: skip

        script.chat = [search_secret, ANSWER]
        n0 = script.n("ChatReply")
        await say(c, h, "Что в этой записи?", visible_item_ids=[rid])
        after = script.calls["ChatReply"][n0 + 1]
        results = after.messages[-1].tool_results
        assert results and all("сейфа у соседа" not in r.content for r in results)
        assert all('"found":0' in r.content for r in results)  # only this person's records
