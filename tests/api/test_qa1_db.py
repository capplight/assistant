"""Phone QA 1 (2026-11-15) against a real database: server parts.

- spends, to-dos and «…, напомни …» phrases never end up as notes: the line reads them by code
  when the model is down, and a line phrase the phone saved offline (`POST /v1/items`, typed, no
  page) becomes an expense on «Расходы» / a task on «Дела», with «Отменить»;
- the AI label is never on the person's own record (only a made title is not AI content);
- a voice record never stays «Разбираю…»: no speech-to-text → failed at once, an outage → failed
  past the deadline, with a readable text.
Providers are fakes (no network). Skipped without DATABASE_URL."""

import os
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select, text

from assistant.ai import AIUnavailable
from assistant.db.models import Item
from assistant.records import IngestDeps, run_ingest
from assistant.records.adapters import (
    FakeTranscriber,
    TranscriberRejected,
    UnavailableTranscriber,
)
from assistant.records.store import fail_stuck_voice
from tests.api.conftest import client
from tests.api.test_items_db import _signed_in, _upload
from tests.api.test_week9_db import entries
from tests.api.test_week19_db import _first_launch, _pages, _say
from tests.chat.test_chat_db import env  # noqa: F401  (a fixture)
from tests.chat.test_week6_db import Script, last, router_with

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set"),
]


class Down(Script):
    """The answering service is down for the readers (the intent check still answers)."""

    def __call__(self, req):  # type: ignore[no-untyped-def]
        if req.schema_name in ("ExpenseReply", "TasksReply"):
            raise AIUnavailable("every provider failed")
        return super().__call__(req)


async def _ids(c, h, page_id: str) -> set[str]:  # type: ignore[no-untyped-def]
    return {e["item"]["id"] for e in await entries(c, h, page_id)}


# --- 1. the line with the model down ---


async def test_line_reads_spends_and_todos_by_code_when_the_model_is_down(env):  # noqa: F811
    async with client(env.make_app(router_with(env.maker, Down()))) as c:
        h = await _first_launch(c)
        pages = await _pages(c, h)
        ev = last(await _say(c, h, "Я потратил 2000 на мороженое"), "action")
        assert ev["action"]["kind"] == "create_expense"
        assert ev["expenses"][0]["amount"] == "2000.00"
        item = ev["expenses"][0]["item_id"]
        assert item in await _ids(c, h, pages["expenses"]["id"])
        assert item not in await _ids(c, h, pages["notes"]["id"])
        ev = last(await _say(c, h, "Я сегодня потратил 5000"), "action")
        assert ev["expenses"][0]["amount"] == "5000.00"

        ev = last(await _say(c, h, "купить хлеб на завтра, и напомни в 10 утра"), "action")
        task = ev["tasks"][0]
        assert (task["list_key"], task["title"]) == ("todo", "Купить хлеб")
        assert task["due_date"] is not None
        assert task["item_id"] in await _ids(c, h, pages["tasks"]["id"])
        assert task["item_id"] not in await _ids(c, h, pages["notes"]["id"])
        # the person's own words: no AI label
        rec = (await c.get(f"/v1/items/{task['item_id']}", headers=h)).json()
        assert rec["ai_generated"] is False and rec["ai_label"] is None


# --- 1. a line phrase saved on the phone offline ---


async def _offline(c, h, phrase: str, line: bool = True) -> dict:  # type: ignore[no-untyped-def]
    body = {"client_id": str(uuid.uuid4()), "text": phrase, "source": "typed"}
    if line:
        body["source_meta"] = {"from_line": True}
    r = await c.post("/v1/items", json=body, headers=h)
    assert r.status_code == 201, r.text
    return r.json()["item"]


async def _last_action(c, h) -> dict:  # type: ignore[no-untyped-def]
    return (await c.get("/v1/actions?limit=1", headers=h)).json()["actions"][0]


async def test_offline_phrases_become_expenses_and_tasks(env):  # noqa: F811
    async with client(env.make_app()) as c:
        h = await _first_launch(c)
        pages = await _pages(c, h)
        spend = await _offline(c, h, "Я потратил 2000 на мороженое")
        expenses = (await c.get("/v1/expenses", headers=h)).json()["expenses"]
        assert [(e["item_id"], e["amount"]) for e in expenses] == [(spend["id"], "2000.00")]
        assert spend["id"] in await _ids(c, h, pages["expenses"]["id"])
        assert spend["id"] not in await _ids(c, h, pages["notes"]["id"])
        a = await _last_action(c, h)
        assert a["kind"] == "create_expense" and a["saved_to"][0]["page_id"] == \
            pages["expenses"]["id"]  # fmt: skip
        # «Отменить»: the expense goes, the person's record stays
        r = await c.post(f"/v1/actions/{a['id']}/undo", headers=h)
        assert r.status_code == 200, r.text
        assert (await c.get("/v1/expenses", headers=h)).json()["expenses"] == []
        assert (await c.get(f"/v1/items/{spend['id']}", headers=h)).json()["deleted_at"] is None

        todo = await _offline(c, h, "купить хлеб на завтра, и напомни в 10 утра")
        tasks = (await c.get("/v1/tasks", headers=h)).json()["tasks"]
        assert [(t["item_id"], t["list_key"], t["title"]) for t in tasks] == [
            (todo["id"], "todo", "Купить хлеб")]
        assert tasks[0]["due_date"] is not None
        assert todo["id"] in await _ids(c, h, pages["tasks"]["id"])
        assert todo["id"] not in await _ids(c, h, pages["notes"]["id"])

        many = await _offline(c, h, "купить молоко, сыр и яйца")
        titles = {t["title"] for t in (await c.get("/v1/tasks", headers=h)).json()["tasks"]}
        assert {"Купить молоко", "Купить сыр", "Купить яйца"} <= titles
        assert (await c.get(f"/v1/items/{many['id']}", headers=h)).json()["deleted_at"]
        a = await _last_action(c, h)
        await c.post(f"/v1/actions/{a['id']}/undo", headers=h)  # the phrase comes back
        assert (await c.get(f"/v1/items/{many['id']}", headers=h)).json()["deleted_at"] is None

        idea = await _offline(c, h, "Идея: полка над столом")
        assert idea["id"] in await _ids(c, h, pages["notes"]["id"])  # a note stays a note
        # not from the line (a note typed on a page): kept as written
        typed = await _offline(c, h, "Потратил 700 на кофе", line=False)
        assert typed["id"] in await _ids(c, h, pages["notes"]["id"])
        assert len((await c.get("/v1/expenses", headers=h)).json()["expenses"]) == 0


# --- 2. the AI label ---


async def test_ai_label_only_on_ai_content(env):  # noqa: F811
    async with client(env.make_app(router_with(env.maker, Script()))) as c:
        h = await _first_launch(c)
        ev = last(await _say(c, h, "Мастер Ерлан, плитка, позвонить в пятницу"), "action")
        rid = ev["action"]["saved_to"][0]["item_ids"][0]
        rec = (await c.get(f"/v1/items/{rid}", headers=h)).json()
        assert rec["ai_generated"] is False and rec["ai_label"] is None
        # a title the assistant made is not a reason for the label
        async with env.maker() as s:
            await s.execute(text("UPDATE items SET ai_fields = '[\"title\"]', title = 'Плитка' "
                                 "WHERE public_id = :p"), {"p": uuid.UUID(rid)})  # fmt: skip
            await s.commit()
        rec = (await c.get(f"/v1/items/{rid}", headers=h)).json()
        assert rec["ai_fields"] == ["title"] and rec["ai_label"] is None
        r = await c.get("/v1/search", params={"q": "плитка"}, headers=h)
        assert all(x["ai_label"] is None for x in r.json()["results"])


# --- 3. voice never «Разбираю…» forever ---


async def _voice(c, h) -> dict:  # type: ignore[no-untyped-def]
    up = await _upload(c, h, b"aac-audio-" + uuid.uuid4().bytes, "audio/aac")  # not a repeat
    r = await c.post("/v1/items", json={"client_id": str(uuid.uuid4()), "upload_id": up,
                                        "source": "mic"}, headers=h)  # fmt: skip
    assert r.status_code == 201, r.text
    return r.json()["item"]


async def _pk(maker, public_id: str) -> int:  # type: ignore[no-untyped-def]
    async with maker() as s:
        return int(await s.scalar(select(Item.id).where(Item.public_id == uuid.UUID(public_id))))


async def test_voice_without_stt_fails_at_once_and_stuck_ones_time_out(env):  # noqa: F811
    app = env.make_app()
    async with client(app) as c:
        h = await _signed_in(c)
        item = await _voice(c, h)
        deps = IngestDeps(storage=app.state.ctx.storage, transcriber=UnavailableTranscriber())
        status = await run_ingest(env.maker, await _pk(env.maker, item["id"]), deps)
        assert status == "failed"
        out = (await c.get(f"/v1/items/{item['id']}", headers=h)).json()
        assert out["status"] == "failed" and out["error"] == "stt_unavailable"
        assert out["error_ru"].startswith("Не получилось разобрать запись")

        # an outage (a provider that says unavailable): retried, then past the deadline failed
        stuck = await _voice(c, h)
        pk = await _pk(env.maker, stuck["id"])
        async with env.maker() as s:
            assert await fail_stuck_voice(s, datetime.now(UTC)) == 0  # still young
            await s.execute(text("UPDATE items SET status = 'processing', created_at = "
                                 "created_at - interval '1 hour' WHERE id = :i"), {"i": pk})
            n = await fail_stuck_voice(s, datetime.now(UTC) + timedelta(seconds=1))
            await s.commit()
            jobs = await s.scalar(text("SELECT count(*) FROM jobs WHERE status = 'queued' AND "
                                       "CAST(payload ->> 'item_id' AS BIGINT) = :i"), {"i": pk})
        assert n == 1 and jobs == 0
        out = (await c.get(f"/v1/items/{stuck['id']}", headers=h)).json()
        assert out["status"] == "failed" and out["error"] == "stt_timeout" and out["error_ru"]
        # a working provider still reads a new one
        ok = await _voice(c, h)
        deps = IngestDeps(storage=app.state.ctx.storage,
                          transcriber=FakeTranscriber("Купить хлеб", 0.95))  # fmt: skip
        assert await run_ingest(env.maker, await _pk(env.maker, ok["id"]), deps) == "ready"

        # the provider refuses this audio (broken file): failed at once, no retries
        class Rejecting(FakeTranscriber):
            async def transcribe(self, audio, *, mime, lang_hint):  # type: ignore[no-untyped-def]
                raise TranscriberRejected("http 400")

        bad = await _voice(c, h)
        deps = IngestDeps(storage=app.state.ctx.storage, transcriber=Rejecting())
        assert await run_ingest(env.maker, await _pk(env.maker, bad["id"]), deps) == "failed"
        out = (await c.get(f"/v1/items/{bad['id']}", headers=h)).json()
        assert out["error"] == "stt_unavailable"
