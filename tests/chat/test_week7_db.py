"""Week 7 with the assistant line (US-27, US-28; spec 6.12): rows the person placed with
`items/move` are not moved by «Разложи» without «Да»; a move the person makes while the assistant
is thinking wins; a record the person took off a page with «Убрать с этой страницы» is not put back
by the assistant. Providers are fakes (no network). Skipped without DATABASE_URL."""

import os
import re
import uuid
from typing import Any

import pytest

from assistant.ai import FakeAdapter, ToolCall
from assistant.ai.types import AdapterRequest
from assistant.chat import ChatReply
from tests.api.conftest import client
from tests.chat.test_chat_db import _all_text, env, fake_router, page, record, signed_in  # noqa: F401
from tests.chat.test_week6_db import (
    HOME,
    Script,
    group_by_words,
    home_page,
    last,
    router_with,
    rows,
    say,
)

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set"),
]


async def _order(c, h, pid: str) -> list[str]:  # type: ignore[no-untyped-def]
    r = await c.get(f"/v1/pages/{pid}/items?limit=200", headers=h)
    return [e["item"]["id"] for e in r.json()["entries"]]


async def _move(c, h, pid: str, **body: Any) -> dict:  # type: ignore[no-untyped-def]
    r = await c.post(f"/v1/pages/{pid}/items/move",
                     json={"client_id": str(uuid.uuid4()), **body}, headers=h)  # fmt: skip
    assert r.status_code == 200, r.text
    return r.json()


async def test_rows_moved_by_hand_need_yes(env):  # noqa: F811
    script = Script()
    async with client(env.make_app(router_with(env.maker, script))) as c:
        h = await signed_in(c)
        pid, _ = await home_page(c, h, env.maker)
        order = await _order(c, h, pid)
        mine = [order[-1], order[-2]]
        await _move(c, h, pid, item_id=mine[0], before_item_id=order[0])
        await _move(c, h, pid, item_id=mine[1], after_item_id=mine[0])
        before = {r["item"]: r for r in await rows(env.maker, pid)}

        evs = await say(c, h, "разложи по темам", page_id=pid)
        ask = last(evs, "confirm_manual")
        assert ask["question"] == "Вы сами расставили 2 записи. Переставить и их?"
        assert set(ask["item_ids"]) == set(mine)
        assert {r["item"]: r for r in await rows(env.maker, pid)} == before  # nothing moved yet

        evs = await say(c, h, "Оставить мои",
                        choice={"reply_id": ask["reply_id"], "option": "keep_mine"})
        assert last(evs, "action")["action"]["summary"]["ru"].endswith(
            "Ваши 2 записи оставил на местах.")  # fmt: skip
        now = {r["item"]: r for r in await rows(env.maker, pid)}
        for i in mine:  # manual_order_overridden = 0
            assert now[i] == before[i] and now[i]["manual_order"] is True
        assert (await _order(c, h, pid))[:2] == mine


async def test_the_persons_move_during_arranging_wins(env):  # noqa: F811
    holder: dict[str, Any] = {}
    script = Script()
    adapter = FakeAdapter("anthropic", [lambda req: group_by_words(req) if req.schema_name ==
                                        "PageGroups" else script(req)])  # fmt: skip
    app = env.make_app(fake_router(env.maker, adapter))
    async with client(app) as c:
        h = await signed_in(c)
        pid, _ = await home_page(c, h, env.maker, HOME[:6])
        order = await _order(c, h, pid)
        real = app.state.ctx.chat.router.run

        async def run_and_drag(task, *a, **kw):  # type: ignore[no-untyped-def]
            out = await real(task, *a, **kw)
            if str(task) == "page_group":  # the person drags a card meanwhile
                holder["move"] = await _move(c, h, pid, item_id=order[3], before_item_id=order[0])
            return out

        app.state.ctx.chat.router.run = run_and_drag  # type: ignore[method-assign]
        evs = await say(c, h, "разложи по темам", page_id=pid)
        assert "То, что вы двигали сами, не трогал." in last(evs, "action")["action"]["summary"][
            "ru"]  # fmt: skip
        assert holder["move"]["moved"] is True
        now = {r["item"]: r for r in await rows(env.maker, pid)}
        assert now[order[3]]["position"] == holder["move"]["link"]["position"]
        assert now[order[3]]["group_key"] is None and now[order[3]]["manual_order"] is True


async def test_a_record_taken_off_a_page_is_not_put_back_by_the_assistant(env):  # noqa: F811
    def move(req: AdapterRequest) -> list[ToolCall]:
        ref = re.search(r"(p\d+) · Документы", _all_text(req)).group(1)  # type: ignore[union-attr]
        return [ToolCall("c1", "move", {"records": ["s1"], "from_page": None, "to_page": ref,
                                        "mode": "also_show"})]

    script = Script([move, ChatReply(answer="Готово.", citations=[], insufficient=False)])
    async with client(env.make_app(router_with(env.maker, script))) as c:
        h = await signed_in(c)
        pid, ids = await home_page(c, h, env.maker, HOME[:2])
        docs = await page(c, h, "Документы")
        r = await c.post(f"/v1/pages/{docs}/items", json={"item_id": ids[0]}, headers=h)
        assert r.status_code == 201
        r = await c.delete(f"/v1/pages/{docs}/items/{ids[0]}", headers=h)
        assert r.json()["removed"] is True

        evs = await say(c, h, "Положи плитку ещё и на страницу Документы", page_id=pid,
                        visible_item_ids=[ids[0]])  # fmt: skip
        assert "action" not in [n for _, n, _ in evs]
        assert "не стал возвращать" in last(evs, "banner")["text"]
        there = {r_["item"]: r_ for r_ in await rows(env.maker, docs)}
        assert there[ids[0]]["removed_by_user_at"] is not None
        assert ids[0] not in await _order(c, h, docs)
