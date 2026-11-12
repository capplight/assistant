"""The assistant and the free board (weeks 16а–16б; views.md «Доска»): «Разложи» on a board asks
before touching stickers the person placed, and never moves a board place; the mode switch from
the line only gives places to stickers without one. Providers are fakes (no network). Skipped
without DATABASE_URL."""

import os
import uuid

import pytest

from tests.api.conftest import client
from tests.chat.test_chat_db import env, record, signed_in  # noqa: F401
from tests.chat.test_week6_db import Script, last, router_with, say

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set"),
]

TEXTS = ["Плитка для ванной, замер", "Купить хлеб и молоко", "Запись к врачу в среду",
         "Краска для стен, белая", "Купить корм коту", "Анализы сдать натощак"]  # fmt: skip


async def _links(c, h, pid: str) -> dict[str, dict]:  # type: ignore[no-untyped-def]
    r = await c.get(f"/v1/pages/{pid}/items?limit=200", headers=h)
    return {e["item"]["id"]: e["link"] for e in r.json()["entries"]}


async def test_arrange_on_the_board_asks_and_keeps_every_place(env):  # noqa: F811
    script = Script()
    async with client(env.make_app(router_with(env.maker, script))) as c:
        h = await signed_in(c)
        r = await c.post("/v1/pages", headers=h,
                         json={"client_id": str(uuid.uuid4()), "template_key": "notes"})
        pid = r.json()["page"]["id"]
        ids = [await record(c, h, env.maker, t, pid) for t in TEXTS]
        r = await c.post(f"/v1/pages/{pid}/view", headers=h,
                         json={"client_id": str(uuid.uuid4()), "board": True})
        assert r.status_code == 200, r.text
        mine = ids[:2]
        r = await c.post(f"/v1/pages/{pid}/items/place", headers=h, json={
            "client_id": str(uuid.uuid4()),
            "places": [{"item_id": mine[0], "x": 0.5, "y": 900},
                       {"item_id": mine[1], "x": 0.1, "y": 1100}]})
        assert r.status_code == 200, r.text
        before = await _links(c, h, pid)
        places = {i: (v["board_x"], v["board_y"], v["board_z"]) for i, v in before.items()}

        evs = await say(c, h, "разложи по темам", page_id=pid)
        ask = last(evs, "confirm_manual")
        assert ask["question"].startswith("Вы сами расставили 2 ")
        assert set(ask["item_ids"]) == set(mine)
        assert await _links(c, h, pid) == before  # nothing moved yet

        evs = await say(c, h, "Оставить мои",
                        choice={"reply_id": ask["reply_id"], "option": "keep_mine"})
        assert last(evs, "action")["action"]["summary"]["ru"].endswith("оставил на местах.")
        now = await _links(c, h, pid)
        assert {i: (v["board_x"], v["board_y"], v["board_z"]) for i, v in now.items()} == places
        for i in mine:
            assert now[i]["group_key"] == before[i]["group_key"]
            assert now[i]["board_manual"] is True
