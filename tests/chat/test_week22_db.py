"""Steps 3-4 of vision-2026-11-review §5.4 against Postgres: undo by phrase for any action
(Ф-67, Ф-73), the «изменил помощник» mark (Ф-73), the notice (Ф-65), «разберу позже» (Ф-69).

Providers are fakes (no network). Skipped without DATABASE_URL.
"""

import os
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select, text

from assistant.ai import AIUnavailable
from assistant.chat import jobs, parse_later
from assistant.chat.intent import IntentReply
from assistant.db.models import Item, Job
from assistant.tasks.parse import TaskLine, TasksReply
from tests.api.conftest import client
from tests.chat.test_chat_db import _Stub, env, signed_in  # noqa: F401  (env is a fixture)
from tests.chat.test_week6_db import Script, last, router_with, say

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set"),
]


async def _item(c, h, item_id: str) -> dict:  # type: ignore[no-untyped-def]
    r = await c.get(f"/v1/items/{item_id}", headers=h)
    assert r.status_code == 200, r.text
    return r.json()


async def test_save_marks_the_record_and_undo_by_phrase_takes_it_back(env):  # noqa: F811
    async with client(env.make_app(router_with(env.maker, Script()))) as c:
        h = await signed_in(c)
        evs = await say(c, h, "запиши купить краску для забора")
        action = last(evs, "action")["action"]
        item_id = action["changed_item_ids"][0]
        assert action["notice"]["ms"] == 3000 and action["notice"]["text_ru"]
        assert action["notice"]["target"]["id"] == item_id
        item = await _item(c, h, item_id)
        assert item["assistant_changed_at"] is not None
        assert item["assistant_action_id"] == action["id"]
        # «верни как было»: the same undo as «Отменить», by code
        evs = await say(c, h, "верни как было")
        assert last(evs, "done")["answer_kind"] == "action"
        got = last(evs, "action")
        assert got["action"]["kind"] == "save_item" and got["undone"]["id"] == action["id"]
        assert got["undone"]["undone_at"] is not None
        assert got["action"]["notice"]["text_ru"] == "Вернул как было"
        msg = (await c.get(f"/v1/chat/messages/{got['reply_id']}", headers=h)).json()
        assert msg["text"].startswith("Вернул как было")
        item = await _item(c, h, item_id)
        assert item["deleted_at"] is not None and item["assistant_changed_at"] is None
        # nothing fresh left of the assistant's: an honest answer, nothing changed
        evs = await say(c, h, "отмени")
        assert last(evs, "done")["answer_kind"] == "text"
        assert "Не нашёл, что отменить" in last(evs, "banner")["text"]


async def test_undo_by_words_finds_the_right_action(env):  # noqa: F811
    async with client(env.make_app(router_with(env.maker, Script()))) as c:
        h = await signed_in(c)
        first = last(await say(c, h, "запиши купить краску для забора"), "action")["action"]
        second = last(await say(c, h, "запиши позвонить мастеру Ерлану"), "action")["action"]
        evs = await say(c, h, "верни запись про краску")
        got = last(evs, "action")
        assert got["undone"]["id"] == first["id"]
        assert (await _item(c, h, first["changed_item_ids"][0]))["deleted_at"] is not None
        assert (await _item(c, h, second["changed_item_ids"][0]))["deleted_at"] is None
        evs = await say(c, h, "отмени то, что ты сделал с плиткой")
        assert "«плиткой»" in last(evs, "banner")["text"]
        # the same answer run again (resume after a restart) never undoes twice
        r = await c.get(f"/v1/actions/{first['id']}", headers=h)
        assert r.json()["undoable"] is False


async def test_persons_edit_clears_the_mark(env):  # noqa: F811
    async with client(env.make_app(router_with(env.maker, Script()))) as c:
        h = await signed_in(c)
        action = last(await say(c, h, "запиши купить краску для забора"), "action")["action"]
        item_id = action["changed_item_ids"][0]
        seq = (await _item(c, h, item_id))["seq"]
        r = await c.patch(f"/v1/items/{item_id}", json={"title": "Краска"}, headers=h)
        assert r.status_code == 200 and r.json()["assistant_changed_at"] is None
        assert r.json()["seq"] > seq
        # the mark of another, older action is shown only for 24 h
        async with env.maker() as s:
            await s.execute(text("UPDATE items SET assistant_changed_at = :t, "
                                 "assistant_action_id = :a WHERE public_id = :p"),
                            {"t": datetime.now(UTC) - timedelta(hours=25),
                             "a": uuid.UUID(action["id"]), "p": uuid.UUID(item_id)})
            await s.commit()
        assert (await _item(c, h, item_id))["assistant_changed_at"] is None


async def test_model_down_note_waits_then_is_read(env):  # noqa: F811
    """Ф-69: the model is down → «Сохранил как заметку, разберу позже»; the chat worker reads it
    once the model is back: a to-do → a task on «Дела», the note leaves «Заметки»."""
    async with client(env.make_app(_Stub(AIUnavailable("down")))) as c:
        h = await signed_in(c)
        evs = await say(c, h, "свет в гараже починить в субботу")
        action = last(evs, "action")["action"]
        assert action["notice"]["text_ru"] == "Сохранил как заметку, разберу позже"
        item_id = action["changed_item_ids"][0]
        item = await _item(c, h, item_id)
        assert item["parse_later"]["state"] == "waiting"
        async with env.maker() as s:
            pk = await s.scalar(select(Item.id).where(Item.public_id == uuid.UUID(item_id)))
            job = await s.scalar(select(Job).where(Job.idempotency_key == parse_later.job_key(pk)))
            assert job is not None and job.kind == jobs.JOB_PARSE
        # still down: the job waits (Retry), nothing moved
        with pytest.raises(parse_later.Retry):
            await parse_later.run_parse(env.maker, _Stub(AIUnavailable("down")), pk,
                                        datetime.now(UTC))  # fmt: skip
        assert (await _item(c, h, item_id))["parse_later"]["state"] == "waiting"

        class Back(Script):
            def __call__(self, req):  # type: ignore[no-untyped-def]
                if req.schema_name == "IntentReply":
                    return IntentReply(intent="note", confidence=0.9)
                if req.schema_name == "TasksReply":
                    return TasksReply(list="todo", items=[TaskLine(title="Починить свет в гараже",
                                                                   qty=None)],
                                      day="sat")  # fmt: skip
                return super().__call__(req)

        back = router_with(env.maker, Back())
        assert await parse_later.run_parse(env.maker, back, pk, datetime.now(UTC)) == "tasks"
        item = await _item(c, h, item_id)
        assert item["parse_later"]["state"] == "done" and item["parse_later"]["to"] == "tasks"
        assert item["parse_later"]["text_ru"].startswith("Разобрал: перенёс в «")
        assert item["assistant_changed_at"] is not None
        acts = (await c.get("/v1/actions", headers=h)).json()["actions"]
        moved = acts[0]
        assert moved["parsed_later"] is True and moved["initiated_by"] == "agent"
        assert moved["notice"]["text_ru"].startswith("Разобрал: перенёс в «")
        tasks = (await c.get("/v1/tasks", headers=h)).json()["tasks"]
        assert [t["title"] for t in tasks] == ["Починить свет в гараже"]
        assert tasks[0]["assistant_action_id"] == moved["id"]
        # a second run finds nothing to do
        assert await parse_later.run_parse(env.maker, back, pk, datetime.now(UTC)) == "gone"
        # «Отменить» on it: the task goes, the note is back where it was
        r = await c.post(f"/v1/actions/{moved['id']}/undo", headers=h)
        assert r.status_code == 200, r.text


async def test_phone_line_phrase_waits_when_code_cannot_read_it(env):  # noqa: F811
    async with client(env.make_app(router_with(env.maker, Script()))) as c:
        h = await signed_in(c)
        r = await c.post("/v1/items", json={"client_id": str(uuid.uuid4()),
                                            "text": "идея для подарка маме — шарф",
                                            "source_meta": {"from_line": True}}, headers=h)
        assert r.status_code == 201, r.text
        assert r.json()["item"]["parse_later"]["state"] == "waiting"
        async with env.maker() as s:
            pk = await s.scalar(select(Item.id).where(
                Item.public_id == uuid.UUID(r.json()["item"]["id"])))  # fmt: skip
        # the model reads it as a plain note: it stays a note, honestly said
        assert await parse_later.run_parse(env.maker, router_with(env.maker, Script()), pk,
                                           datetime.now(UTC)) == "note"  # fmt: skip
        item = await _item(c, h, r.json()["item"]["id"])
        assert item["parse_later"] == {"state": "done", "text_ru": "Разобрал: оставил заметкой",
                                       "text_kk": None, "to": "note", "action_id": None}
