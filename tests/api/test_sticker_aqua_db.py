"""The 8th sticker colour «aqua» (бирюза, migration 0032) against Postgres: picked by hand on
«Заметки», kept by the CHECK, the 7 old keys still valid, an unknown key refused. Skipped without
DATABASE_URL."""

import os

import pytest
from sqlalchemy import text

from tests.api.conftest import client
from tests.api.test_views_db import new_page
from tests.chat.test_chat_db import env, record, signed_in  # noqa: F401  (env is a fixture)

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set"),
]


async def test_aqua_is_picked_by_hand_and_old_keys_stay(env):  # noqa: F811
    async with client(env.make_app()) as c:
        h = await signed_in(c)
        notes = await new_page(c, h, "notes")
        rid = await record(c, h, env.maker, "Бирюзовая заметка")
        url = f"/v1/pages/{notes['id']}/items/{rid}"
        r = await c.patch(url, headers=h, json={"color": "aqua"})
        assert r.status_code == 200, r.text
        assert r.json()["link"]["appearance"]["color"] == "aqua"
        for old in ("yellow", "pink", "green", "blue", "peach", "white", "lilac"):
            r = await c.patch(url, headers=h, json={"color": old})
            assert r.status_code == 200, (old, r.text)
        for unknown in ("teal", "lemon", "mist"):  # the phone's names are not stored keys
            r = await c.patch(url, headers=h, json={"color": unknown})
            assert r.status_code == 422, unknown
        r = await c.post(f"/v1/pages/{notes['id']}/view", headers=h,
                         json={"colors": [{"item_id": rid, "color": "aqua"}]})
        assert r.status_code == 200, r.text
        sync = (await c.get("/v1/sync?since=0&limit=500", headers=h)).json()
        mine = [x for x in sync["screen_items"] if x["item_id"] == rid]
        assert mine[-1]["appearance"]["color"] == "aqua"


async def test_check_constraint_takes_aqua_and_refuses_others(env):  # noqa: F811
    async with env.maker() as s:
        found = await s.scalar(text(
            "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
            "WHERE conname = 'ck_screen_items_appearance'"))
        await s.rollback()
    assert found is not None and "'aqua'" in found and "'lilac'" in found and "'teal'" not in found
