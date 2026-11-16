"""AI-chat export import (step 7) on a real database: records on no page (Ф-77), word search,
the summary, re-import brings nothing, «удалить импорт» = undo, Gemini Takeout, bad files.
Invented content only; nothing touches the network. Skipped without DATABASE_URL."""

import json
import os
import uuid

import pytest
from sqlalchemy import select

from assistant.db.models import Item, Job
from assistant.db.models_dedup import Import
from assistant.db.models_v2 import ConsentKind, File
from assistant.imports import JOB_AI_IMPORT, handlers, run_ai_import
from tests.api.conftest import client
from tests.api.test_week10_db import _upload, env, note, notes_page, uid_of  # noqa: F401
from tests.chat.test_chat_db import signed_in
from tests.imports.aichat_fixtures import chatgpt_simple, chatgpt_zip, claude_zip, gemini_zip

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set"),
]
BASE = (ConsentKind.PD_PROCESSING, ConsentKind.TERMS)


async def _start(env, c, h, uid: int, data: bytes, mime: str = "application/zip") -> dict:  # noqa: F811
    up = await _upload(env, uid, data, mime)
    r = await c.post("/v1/imports/ai-chats/file",
                     json={"client_id": str(uuid.uuid4()), "upload_id": up}, headers=h)
    assert r.status_code == 202, r.text
    return r.json()["import"]


async def _run(env, c, h, imp: dict) -> dict:  # noqa: F811
    async with env.maker() as s:
        pk = await s.scalar(select(Import.id).where(Import.public_id == uuid.UUID(imp["id"])))
    await run_ai_import(env.maker, env.storage, pk)
    return (await c.get(f"/v1/imports/{imp['id']}", headers=h)).json()["import"]


async def test_chatgpt_import_search_reimport_and_undo(env):  # noqa: F811
    async with client(env.make_app()) as c:
        h = await signed_in(c, kinds=BASE)  # base consents are enough: the file is the person's
        page = await notes_page(c, h)
        old = await note(c, h, "Я: Как варить плов?\n\nChatGPT: Рис, морковь, зира.")  # repeat
        uid = await uid_of(env, old["item"]["id"])
        imp = await _start(env, c, h, uid, chatgpt_zip())
        assert imp["source"] == "ai_chat_export_file" and imp["status"] == "created"
        async with env.maker() as s:
            assert JOB_AI_IMPORT in set(await s.scalars(select(Job.kind)))
        got = await _run(env, c, h, imp)
        assert got["status"] == "done" and got["provider"] == "chatgpt", got
        assert got["total"] == 2 and got["processed"] == 2
        assert got["created"] == 1 and got["conversations"] == 1 and got["skipped_dups"] == 1
        assert got["skipped_media"] == {"image": 1} and got["failed"] == 1
        assert got["summary_ru"] == ("Принёс 1 разговор из ChatGPT. Повторов не взял: 1. "
                                     "Картинки (1) не перенёс — только текст. Не прочитал: 1.")
        rows = (await c.get(f"/v1/pages/{page}/items", headers=h)).json()["entries"]
        assert not [e for e in rows if e["item"]["source"] == "import_ai_chat"]  # Ф-77: no page
        listed = (await c.get("/v1/items?limit=200", headers=h)).json()["items"]
        brought = [i for i in listed if i["source"] == "import_ai_chat"]
        assert len(brought) == 1
        it = brought[0]
        assert it["kind"] == "ai_chat" and it["title"] == "Кафе в Стамбуле"
        assert it["source_meta"]["tag"] == "из ChatGPT"
        assert it["source_meta"]["ai_chat"]["provider"] == "chatgpt"
        assert it["enrich_state"] == "skipped" and it["ai_generated"] is False
        found = (await c.get("/v1/search?q=Босфор", headers=h)).json()
        assert it["id"] in json.dumps(found, ensure_ascii=False)
        async with env.maker() as s:
            f = await s.scalar(select(File).join(Import, Import.file_id == File.id)
                               .where(Import.public_id == uuid.UUID(imp["id"])))
            assert f.state == "trash"  # the export is not kept
        # the same export again: nothing new
        again = await _run(env, c, h, await _start(env, c, h, uid, chatgpt_zip()))
        assert again["created"] == 0 and again["seen_before"] == 2 and again["action_id"] is None
        # a conversation continued since: comes as a new record
        grown = json.dumps([chatgpt_simple("c-2", "Рецепт плова", "Как варить плов?",
                                           "Рис, морковь, зира. И баранина.", 1.76e9)]).encode()
        more = await _run(env, c, h, await _start(env, c, h, uid, grown, "application/json"))
        assert more["created"] == 1
        # «удалить импорт»: the import's action undo moves what it brought to the trash
        u = await c.post(f"/v1/actions/{got['action_id']}/undo", headers=h)
        assert u.status_code == 200, u.text
        trash = (await c.get("/v1/items/trash", headers=h)).json()["items"]
        assert [t["id"] for t in trash] == [it["id"]]


async def test_claude_and_gemini_and_bad_files(env):  # noqa: F811
    async with client(env.make_app()) as c:
        h = await signed_in(c, kinds=BASE)
        first = await note(c, h, "первая заметка")
        uid = await uid_of(env, first["item"]["id"])
        cl = await _run(env, c, h, await _start(env, c, h, uid, claude_zip()))
        assert cl["provider"] == "claude" and cl["conversations"] == 2 and cl["created"] == 2
        assert cl["summary_ru"].startswith("Принёс 2 разговора из Claude.")
        ge = await _run(env, c, h, await _start(env, c, h, uid, gemini_zip()))
        assert ge["provider"] == "gemini" and ge["conversations"] == 2, ge
        async with env.maker() as s:
            tags = set(await s.scalars(select(Item.source_meta["tag"].astext).where(
                Item.user_id == uid, Item.source == "import_ai_chat")))
        assert tags == {"из Claude", "из Gemini"}
        bad = await _run(env, c, h, await _start(env, c, h, uid, b"<p>hello</p>", "text/html"))
        assert bad["status"] == "failed" and bad["error"] == "import_unknown_format"
        r = await c.post("/v1/imports/ai-chats/file", json={"client_id": str(uuid.uuid4()),
                         "upload_id": await _upload(env, uid, b"x", "image/png")}, headers=h)
        assert r.status_code == 422 and r.json()["code"] == "import_not_chats_file", r.text
        assert set(handlers(env.maker, env.storage)) >= {JOB_AI_IMPORT}
