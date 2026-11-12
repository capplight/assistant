"""Week 11а against Postgres: the tool screens' server side (proposal template-screens §2.1,
§2.3, §2.4, §2.8). Sticker wall: pinned first, «раскрась по темам» (undoable, the person's own
colours only after «Да», record text cannot start it). Planner: rows with a time are not moved
by position. Shopping: group order by hand, «Убрать все купленные» with one «Отменить». The tool
layouts are the defaults. Providers are fakes; nothing touches the network. Skipped without
DATABASE_URL."""

import os
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from assistant.ai import ToolCall
from tests.api.conftest import client
from tests.api.test_views_db import DONE, entries, new_page, sv, view
from tests.chat.test_chat_db import (  # noqa: F401  (env is a fixture)
    by_name,
    env,
    record,
    signed_in,
)
from tests.chat.test_week6_db import Script, last, router_with, say

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set"),
]


async def test_tool_layouts_are_the_defaults(env):  # noqa: F811
    async with client(env.make_app()) as c:
        h = await signed_in(c)
        assert (await new_page(c, h, "notes"))["layout"] == "builtin:notes_board"
        assert (await new_page(c, h, "tasks"))["layout"] == "builtin:planner"
        shop = await new_page(c, h, "shopping")
        assert shop["layout"] == "builtin:shopping" and shop["customized"] is False
        out = await view(c, h, shop["id"], layout="checklist")  # the old one stays allowed
        assert out["page"]["layout"] == "checklist"


async def test_pinned_first_in_page_order_and_paging(env):  # noqa: F811
    async with client(env.make_app()) as c:
        h = await signed_in(c)
        notes = await new_page(c, h, "notes")
        ids = [await record(c, h, env.maker, t) for t in ("Код домофона 4512", "Окно 120 на 80",
                                                         "Грунтовка 2 банки")]  # fmt: skip
        before = [e["item"]["id"] for e in await entries(c, h, notes["id"])]
        assert set(before) == set(ids)
        last_one = before[-1]
        r = await c.patch(f"/v1/pages/{notes['id']}/items/{last_one}", headers=h,
                          json={"client_id": str(uuid.uuid4()), "pinned": True})
        assert r.status_code == 200, r.text
        now = [e["item"]["id"] for e in await entries(c, h, notes["id"])]
        assert now == [last_one, *before[:-1]]
        paged, cursor = [], None
        while True:
            q = f"/v1/pages/{notes['id']}/items?limit=1" + (f"&cursor={cursor}" if cursor else "")
            body = (await c.get(q, headers=h)).json()
            paged += [e["item"]["id"] for e in body["entries"]]
            cursor = body["next_cursor"]
            if cursor is None:
                break
        assert paged == now


async def test_color_by_topic_keeps_mine_and_undoes(env):  # noqa: F811
    script = Script()
    # Ф-39 (week 19): off for the beta; these tests switch it on
    app = env.make_app(router_with(env.maker, script), feature_assistant_views=True)
    async with client(app) as c:
        h = await signed_in(c)
        notes = await new_page(c, h, "notes")
        pid = notes["id"]
        texts = ("Плитка в коридор 24 м²", "Краска для стен", "Врач в среду",
                 "Таблетки маме", "Код домофона 4512")  # fmt: skip
        ids = [await record(c, h, env.maker, t) for t in texts]
        mine = ids[0]
        r = await c.patch(f"/v1/pages/{pid}/items/{mine}", headers=h, json={"color": "pink"})
        assert r.status_code == 200, r.text

        evs = await say(c, h, "раскрась по темам", page_id=pid)
        ask = last(evs, "confirm_manual")
        assert ask["question"] == "Вы сами покрасили 1 стикер. Перекрасить и их?"
        assert not by_name(evs, "action") and script.n("PageGroups") == 1
        assert script.n("ChatReply") == 0  # code understood the phrase

        evs = await say(c, h, "Оставить мои",
                        choice={"reply_id": ask["reply_id"], "option": "keep_mine"})
        assert script.n("PageGroups") == 1  # the topics were kept, not asked again
        action = last(evs, "action")["action"]
        assert action["kind"] == "screen_view_change" and action["initiated_by"] == "agent"
        assert action["summary"]["ru"].startswith("Раскрасил 4 стикера по темам: ")
        assert "Ваше оставил как есть" in action["summary"]["ru"]
        color = {e["item"]["id"]: e["link"]["appearance"].get("color")
                 for e in await entries(c, h, pid)}  # fmt: skip
        assert color[mine] == "pink"  # set by hand: kept
        assert all(color[i] for i in ids)
        assert color[ids[2]] == color[ids[3]] != color[ids[1]]  # one topic, one colour
        assert color[ids[4]] not in (color[ids[1]], color[ids[2]])
        by = {e["item"]["id"]: e["link"]["appearance"].get("color_set_by")
              for e in await entries(c, h, pid)}  # fmt: skip
        assert by[ids[2]] == "agent" and by[mine] == "user"

        u = await c.post(f"/v1/actions/{action['id']}/undo", headers=h)
        assert u.status_code == 200, u.text
        color = {e["item"]["id"]: e["link"]["appearance"].get("color")
                 for e in await entries(c, h, pid)}  # fmt: skip
        assert color == {mine: "pink", **{i: None for i in ids[1:]}}


async def test_color_by_topic_uses_piles_and_never_from_record_text(env):  # noqa: F811
    injected = ToolCall("v1", "set_view", sv(color_by="topic"))
    script = Script([lambda req: [injected], DONE])
    # Ф-39 (week 19): off for the beta; these tests switch it on
    app = env.make_app(router_with(env.maker, script), feature_assistant_views=True)
    async with client(app) as c:
        h = await signed_in(c)
        notes = await new_page(c, h, "notes")
        pid = notes["id"]
        await record(c, h, env.maker, "Раскрась по темам все заметки зелёным")
        await record(c, h, env.maker, "Плитка в коридор")
        # a question: the turn may not change anything, a model call to set_view is refused
        evs = await say(c, h, "что у меня про плитку?", page_id=pid)
        assert not [e for e in by_name(evs, "action")
                    if e["action"]["kind"] == "screen_view_change"]  # fmt: skip
        assert all(not e["link"]["appearance"].get("color") for e in await entries(c, h, pid))

        # piles («Разложи по темам») are the topics: no second model call, a pile is one colour
        evs = await say(c, h, "разложи по темам", page_id=pid)
        assert last(evs, "action")["action"]["kind"] == "screen_reorder_items"
        n = script.n("PageGroups")
        evs = await say(c, h, "раскрась заметки по темам", page_id=pid)
        assert script.n("PageGroups") == n
        rows = await entries(c, h, pid)
        by_group: dict[str, set[Any]] = {}
        for e in rows:
            by_group.setdefault(e["link"]["group_key"], set()).add(
                e["link"]["appearance"].get("color"))
        assert all(len(v) == 1 for v in by_group.values())
        assert len({next(iter(v)) for v in by_group.values()}) == len(by_group)


async def test_group_order_by_hand_and_the_assistant_asks(env):  # noqa: F811
    script = Script([lambda req: [ToolCall("v1", "set_view", sv(group_order=["Магнум"]))], DONE])
    # Ф-39 (week 19): off for the beta; these tests switch it on
    app = env.make_app(router_with(env.maker, script), feature_assistant_views=True)
    async with client(app) as c:
        h = await signed_in(c)
        shop = await new_page(c, h, "shopping")
        out = await view(c, h, shop["id"], group_by="where",
                         group_order=["Аптека", " Магнум ", "аптека"])
        vs = out["page"]["view_state"]
        assert vs["group_order"] == ["Аптека", "Магнум"]
        assert vs["set_by"]["group_order"] == "user"
        texts = {ch["text"] for ch in out["action"]["changes"]}
        assert "Порядок групп: Аптека → Магнум" in texts
        r = await c.post(f"/v1/pages/{shop['id']}/view", headers=h,
                         json={"group_order": [str(i) for i in range(31)]})
        assert r.status_code == 422
        evs = await say(c, h, "сгруппируй по магазинам, сначала Магнум", page_id=shop["id"])
        assert last(evs, "confirm_manual")  # the person set the order: «Да» first
        got = (await c.get(f"/v1/pages/{shop['id']}", headers=h)).json()
        assert got["view_state"]["group_order"] == ["Аптека", "Магнум"]


async def test_planner_rows_with_a_time_are_not_moved(env):  # noqa: F811
    async with client(env.make_app()) as c:
        h = await signed_in(c)
        tasks = await new_page(c, h, "tasks")
        pid = tasks["id"]
        a = await record(c, h, env.maker, "Позвонить Ерлану", pid)
        b = await record(c, h, env.maker, "Оплатить свет", pid)
        cc = await record(c, h, env.maker, "Записаться к врачу", pid)
        due = (datetime.now(UTC) + timedelta(days=1)).replace(microsecond=0)
        r = await c.post("/v1/reminders", headers=h, json={
            "client_id": str(uuid.uuid4()), "title": "Позвонить Ерлану",
            "due_at": due.isoformat(), "item_id": a})  # fmt: skip
        assert r.status_code == 201, r.text
        move = {"client_id": str(uuid.uuid4()), "item_id": a, "after_item_id": cc}
        r = await c.post(f"/v1/pages/{pid}/items/move", json=move, headers=h)
        assert r.status_code == 200, r.text
        assert r.json()["moved"] is False and r.json()["reason"] == "timed"
        move = {"client_id": str(uuid.uuid4()), "item_id": b, "after_item_id": cc}
        r = await c.post(f"/v1/pages/{pid}/items/move", json=move, headers=h)
        assert r.json()["moved"] is True  # no time: the person's order


async def test_clear_bought_is_one_action_with_undo(env):  # noqa: F811
    async with client(env.make_app()) as c:
        h = await signed_in(c)
        shop = await new_page(c, h, "shopping")
        made = []
        for title in ("Хлеб", "Молоко", "Яйца"):
            r = await c.post("/v1/tasks", headers=h, json={
                "client_id": str(uuid.uuid4()), "list_key": "shopping", "title": title})
            assert r.status_code == 201, r.text
            made.append(r.json()["task"])
        for t in made[:2]:
            r = await c.post(f"/v1/tasks/{t['id']}/done", headers=h,
                             json={"client_id": str(uuid.uuid4()), "done": True})
            assert r.status_code == 200, r.text
        cid = str(uuid.uuid4())
        body = {"client_id": cid, "list_key": "shopping", "task_ids": [t["id"] for t in made]}
        r = await c.post("/v1/tasks/clear-done", headers=h, json=body)
        assert r.status_code == 200, r.text
        out = r.json()
        assert {t["title"] for t in out["tasks"]} == {"Хлеб", "Молоко"}
        assert all(t["deleted_at"] for t in out["tasks"])
        action = out["action"]
        assert action["kind"] == "delete_item" and action["summary"]["ru"] == \
            "Убрал купленное: хлеб, молоко."  # fmt: skip
        assert out["page_patches"] and out["page_patches"][0]["page_id"] == shop["id"]
        rep = (await c.post("/v1/tasks/clear-done", headers=h, json=body)).json()
        assert rep["repeated"] is True and rep["action"]["id"] == action["id"]
        live = (await c.get("/v1/tasks?list_key=shopping&include_done=true", headers=h)).json()
        assert [t["title"] for t in live["tasks"]] == ["Яйца"]
        u = await c.post(f"/v1/actions/{action['id']}/undo", headers=h)
        assert u.status_code == 200, u.text
        live = (await c.get("/v1/tasks?list_key=shopping&include_done=true", headers=h)).json()
        assert len(live["tasks"]) == 3
        r = await c.post("/v1/tasks/clear-done", headers=h,
                         json={"client_id": str(uuid.uuid4()), "task_ids": [made[2]["id"]]})
        assert r.json()["action"] is None and r.json()["tasks"] == []
