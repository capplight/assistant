"""Manual order against Postgres (week 7; US-27, US-28; spec 6.12, 9 «Ручная перестановка и
офлайн-конфликты»): moves by hand with «Отменить», «Убрать с этой страницы», moves between pages
and what they teach, tab order, and two phones offline (property-style: random moves, random
interleavings and retries, one result). Skipped unless DATABASE_URL is set."""

import os
import random
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from sqlalchemy import select, text

from assistant.db.models import Item
from assistant.db.models_habits import UserHabit
from assistant.pages import lexorank, order, place_item, rebalance_page
from tests.api.conftest import client
from tests.api.test_pages_db import (
    _add_page,
    _cid,
    _ids_on,
    _item,
    _link,
    _note,
    _page_row,
    _signed_in,
    _sync_all,
)

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set"),
]

T0 = datetime.now(UTC) - timedelta(hours=1)


async def _custom_page(c, h, title: str, n: int) -> tuple[dict, list[str]]:
    page = await _add_page(c, h, "custom", title=title)
    ids = []
    for k in range(n):
        item = await _note(c, h, f"{title} {k}")
        r = await c.post(f"/v1/pages/{page['id']}/items", json={"item_id": item}, headers=h)
        assert r.status_code == 201, r.text
        ids.append(item)
    return page, ids


async def _entries(c, h, page_id: str) -> list[dict]:
    r = await c.get(f"/v1/pages/{page_id}/items?limit=200", headers=h)
    assert r.status_code == 200, r.text
    return r.json()["entries"]


async def _move(c, h, page_id: str, **body: Any) -> dict:
    body.setdefault("client_id", _cid())
    r = await c.post(f"/v1/pages/{page_id}/items/move", json=body, headers=h)
    assert r.status_code == 200, r.text
    return r.json()


async def _set_envelope(s, item_id: str, kind: str) -> Item:
    item = await _item(s, item_id)
    item.envelope = {"type": kind, "title": "", "summary": ""}
    await s.commit()
    return item


# --- a row within a page ---


async def test_move_by_neighbours_marks_manual_and_undo_brings_it_back(db_app):
    app, _, s = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        page, ids = await _custom_page(c, h, "Дом", 4)
        before = await _ids_on(c, h, page["id"])
        x, top = before[-1], before[0]
        out = await _move(c, h, page["id"], item_id=x, before_item_id=top)
        assert out["moved"] is True and out["reason"] is None and out["repeated"] is False
        assert out["link"]["manual_order"] is True and out["link"]["updated_by"] == "user"
        assert await _ids_on(c, h, page["id"]) == [x, *before[:-1]]
        action = out["action"]
        assert action["kind"] == "screen_reorder_items" and action["initiated_by"] == "user"
        assert action["summary"]["ru"] == "Переставил «Дом 0»"  # the oldest was at the bottom
        assert action["undoable"] and action["changes"][0]["kind"] == "order"
        assert out["page_patch"]["page_id"] == page["id"]
        assert [r["item_id"] for r in out["page_patch"]["rows"]] == [x]
        assert (await c.get(f"/v1/pages/{page['id']}", headers=h)).json()["view_version"] == 2

        r = await c.post(f"/v1/actions/{action['id']}/undo", json={}, headers=h)
        assert r.status_code == 200 and r.json()["partial"] is False
        assert await _ids_on(c, h, page["id"]) == before
        link = await _link(s, page["id"], x)
        assert link.manual_order is False and link.manual_at is None


async def test_repeat_with_the_same_client_id_changes_nothing(db_app):
    app, _, _ = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        page, ids = await _custom_page(c, h, "Дом", 3)
        order_ = await _ids_on(c, h, page["id"])
        body = {"client_id": _cid(), "item_id": order_[2], "before_item_id": order_[0]}
        first = await _move(c, h, page["id"], **body)
        # The person moves it again, then the outbox retries the first call.
        await _move(c, h, page["id"], item_id=order_[2], after_item_id=order_[1])
        moved_again = await _ids_on(c, h, page["id"])
        again = await _move(c, h, page["id"], **body)
        assert again["repeated"] is True and again["action"]["id"] == first["action"]["id"]
        assert await _ids_on(c, h, page["id"]) == moved_again
        listed = (await c.get("/v1/actions", headers=h)).json()["actions"]
        assert len([a for a in listed if a["kind"] == "screen_reorder_items"]) == 2


async def test_undo_after_the_person_moved_it_again_is_partial(db_app):
    app, _, _ = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        page, _ = await _custom_page(c, h, "Дом", 3)
        a, b, cc = await _ids_on(c, h, page["id"])
        first = await _move(c, h, page["id"], item_id=cc, before_item_id=a)
        await _move(c, h, page["id"], item_id=cc, after_item_id=a)
        now = await _ids_on(c, h, page["id"])
        r = (await c.post(f"/v1/actions/{first['action']['id']}/undo", headers=h)).json()
        assert r["partial"] is True
        assert r["message_ru"] == "Часть уже изменена вами — вернул остальное."
        assert await _ids_on(c, h, page["id"]) == now  # the person's last move stands


async def test_phone_key_is_used_and_a_stale_one_after_rekey_is_not(db_app):
    app, _, s = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        page, _ = await _custom_page(c, h, "Дом", 4)
        entries = await _entries(c, h, page["id"])
        keys = [e["link"]["position"] for e in entries]
        ids = [e["item"]["id"] for e in entries]
        base = (await _sync_all(c, h))["next_since"]
        mine = lexorank.between(keys[0], keys[1])
        out = await _move(c, h, page["id"], item_id=ids[3], after_item_id=ids[0],
                          before_item_id=ids[1], position=mine, base_seq=base)
        assert out["link"]["position"] == mine  # the phone's own key, as it is

        # The page is re-keyed after the phone's base: its key is not trusted, neighbours are.
        await rebalance_page(s, (await _page_row(s, page["id"])).id)
        await s.commit()
        cur = await _ids_on(c, h, page["id"])
        stale = lexorank.between(None, keys[0])  # meant "to the top" in the old key space
        out = await _move(c, h, page["id"], item_id=cur[2], after_item_id=cur[3],
                          position=stale, base_seq=base)
        assert out["link"]["position"] != stale
        assert await _ids_on(c, h, page["id"]) == [cur[0], cur[1], cur[3], cur[2]]
        # Without position the server places it by the neighbours.
        out = await _move(c, h, page["id"], item_id=cur[0], after_item_id=cur[2])
        assert await _ids_on(c, h, page["id"]) == [cur[1], cur[3], cur[2], cur[0]]


async def test_equal_neighbour_keys_rekey_then_place(db_app):
    app, _, s = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        page, _ = await _custom_page(c, h, "Дом", 4)
        entries = await _entries(c, h, page["id"])
        ids = [e["item"]["id"] for e in entries]
        base = (await _sync_all(c, h))["next_since"]
        k = lexorank.between(entries[0]["link"]["position"], entries[1]["link"]["position"])
        # Two phones put two rows in one gap: the same key, ordered by the page tie-break.
        await _move(c, h, page["id"], item_id=ids[2], after_item_id=ids[0], position=k,
                    base_seq=base)
        await _move(c, h, page["id"], item_id=ids[3], after_item_id=ids[0], position=k,
                    base_seq=base)
        shared = await _entries(c, h, page["id"])
        assert shared[1]["link"]["position"] == shared[2]["link"]["position"] == k
        middle = [e["item"]["id"] for e in shared]
        # Now a row between the two: the phone can't compute one, the server re-keys first.
        out = await _move(c, h, page["id"], item_id=middle[3], after_item_id=middle[1],
                          before_item_id=middle[2])
        assert await _ids_on(c, h, page["id"]) == [middle[0], middle[1], middle[3], middle[2]]
        assert len(out["page_patch"]["rows"]) == 4  # every row got a new key
        assert (await _page_row(s, page["id"])).rekeyed_seq is not None


async def test_group_key_set_kept_and_cleared(db_app):
    app, _, _ = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        page, _ = await _custom_page(c, h, "Дом", 3)
        a, b, cc = await _ids_on(c, h, page["id"])
        out = await _move(c, h, page["id"], item_id=cc, after_item_id=a, group_key="Ремонт")
        assert out["link"]["group_key"] == "Ремонт"
        out = await _move(c, h, page["id"], item_id=cc, before_item_id=a)
        assert out["link"]["group_key"] == "Ремонт"  # left out = kept
        out = await _move(c, h, page["id"], item_id=cc, after_item_id=b, group_key=None)
        assert out["link"]["group_key"] is None


async def test_move_errors_and_never_a_conflict(db_app):
    app, _, _ = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        page, _ = await _custom_page(c, h, "Дом", 2)
        a, b = await _ids_on(c, h, page["id"])
        today = (await c.get("/v1/pages", headers=h)).json()["pages"][0]
        url = f"/v1/pages/{page['id']}/items/move"
        r = await c.post(f"/v1/pages/{today['id']}/items/move",
                         json={"client_id": _cid(), "item_id": a, "after_item_id": b}, headers=h)
        assert r.status_code == 403 and r.json()["code"] == "page_system"
        r = await c.post(url, json={"client_id": _cid(), "item_id": a}, headers=h)
        assert r.status_code == 422
        r = await c.post(url, json={"client_id": _cid(), "item_id": _cid(), "after_item_id": b},
                         headers=h)  # fmt: skip
        assert r.status_code == 404
        # A stale view never blocks the person's move.
        out = await _move(c, h, page["id"], item_id=a, after_item_id=b, base_view_version=-5)
        assert out["moved"] is True and out["rebased"] is True
        # Both neighbours purged meanwhile and no key of its own: nothing to anchor to.
        gone = await _note(c, h, "чужая")
        out = await _move(c, h, page["id"], item_id=a, after_item_id=gone)
        assert out["moved"] is False and out["reason"] == "anchor_gone" and out["action"] is None


async def test_placement_and_page_rules_never_move_rows_placed_by_hand(db_app):
    app, _, s = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        notes = await _add_page(c, h, "notes")
        ids = [await _note(c, h, f"запись {k}") for k in range(4)]
        order_ = await _ids_on(c, h, notes["id"])
        await _move(c, h, notes["id"], item_id=order_[3], before_item_id=order_[0])
        mine = (await _link(s, notes["id"], order_[3])).position
        for k in range(3):  # new records, and placing an old one again
            await _note(c, h, f"новая {k}")
        await place_item(s, await _item(s, ids[0]))
        await s.commit()
        assert (await _link(s, notes["id"], order_[3])).position == mine
        assert (await _ids_on(c, h, notes["id"]))[0] == order_[3]  # still on top


# --- «Убрать с этой страницы» ---


async def test_remove_from_page_stays_removed_and_undo_returns_it(db_app):
    app, _, s = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        notes = await _add_page(c, h, "notes")
        docs = await _add_page(c, h, "custom", title="Документы")
        x = await _note(c, h, "Договор аренды")
        await c.post(f"/v1/pages/{docs['id']}/items", json={"item_id": x}, headers=h)
        cid = _cid()
        r = await c.delete(f"/v1/pages/{notes['id']}/items/{x}?client_id={cid}", headers=h)
        assert r.status_code == 200, r.text
        out = r.json()
        assert out["removed"] is True and out["link"]["removed_at"] is not None
        assert [p["title"] for p in out["still_on"]] == ["Документы"]
        assert out["action"]["kind"] == "screen_remove_item"
        assert out["action"]["summary"]["ru"] == "Убрал «Договор аренды» со страницы «Заметки»"
        assert out["page_patch"]["removed_item_ids"] == [] and out["page_patch"]["rows"]
        assert x not in await _ids_on(c, h, notes["id"])
        # A repeat, and a second tap: nothing more happens.
        again = (await c.delete(f"/v1/pages/{notes['id']}/items/{x}?client_id={cid}",
                                headers=h)).json()  # fmt: skip
        assert again["repeated"] is True and again["action"]["id"] == out["action"]["id"]
        other = (await c.delete(f"/v1/pages/{notes['id']}/items/{x}", headers=h)).json()
        assert other["removed"] is False and other["action"] is None
        # The rules never bring it back: placing again, restoring the page.
        await place_item(s, await _item(s, x))
        await s.commit()
        await c.delete(f"/v1/pages/{notes['id']}", headers=h)
        await c.post(f"/v1/pages/{notes['id']}/restore", headers=h)
        assert x not in await _ids_on(c, h, notes["id"])
        # «Отменить»: back on the page.
        r = await c.post(f"/v1/actions/{out['action']['id']}/undo", headers=h)
        assert r.status_code == 200 and r.json()["partial"] is False
        assert x in await _ids_on(c, h, notes["id"])
        today = (await c.get("/v1/pages", headers=h)).json()["pages"][0]
        r = await c.delete(f"/v1/pages/{today['id']}/items/{x}", headers=h)
        assert r.status_code == 403


# --- a record to other pages ---


async def test_move_to_page_and_also_show_with_undo(db_app):
    app, _, _ = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        notes = await _add_page(c, h, "notes")
        home = await _add_page(c, h, "custom", title="Ремонт")
        money = await _add_page(c, h, "custom", title="Траты")
        x = await _note(c, h, "Плитка 12 000")
        r = await c.post(f"/v1/items/{x}/move-to-page",
                         json={"client_id": _cid(), "mode": "move", "from_page_id": notes["id"],
                               "to_page_ids": [home["id"]]}, headers=h)  # fmt: skip
        assert r.status_code == 200, r.text
        out = r.json()
        assert out["moved"] is True and out["learned_ru"] is None  # a plain note teaches nothing
        assert out["action"]["summary"]["ru"] == "Перенёс «Плитка 12 000» в «Ремонт»"
        assert out["action"]["changes"][0]["kind"] == "move"
        by_page = {lk["page_id"]: lk for lk in out["links"]}
        assert by_page[notes["id"]]["removed_at"] is not None
        assert by_page[home["id"]]["added_by"] == "user"
        assert {p["page_id"] for p in out["page_patches"]} == {notes["id"], home["id"]}
        assert x not in await _ids_on(c, h, notes["id"]) and x in await _ids_on(c, h, home["id"])

        r = await c.post(f"/v1/items/{x}/move-to-page",
                         json={"client_id": _cid(), "mode": "also_show",
                               "to_page_ids": [money["id"], notes["id"]]}, headers=h)  # fmt: skip
        show = r.json()
        assert show["action"]["summary"]["ru"] == "Показал «Плитка 12 000» ещё на 2 страницах"
        assert x in await _ids_on(c, h, money["id"]) and x in await _ids_on(c, h, notes["id"])
        # Undo both, newest first: back to Notes only.
        await c.post(f"/v1/actions/{show['action']['id']}/undo", headers=h)
        await c.post(f"/v1/actions/{out['action']['id']}/undo", headers=h)
        assert x in await _ids_on(c, h, notes["id"])
        assert x not in await _ids_on(c, h, home["id"])
        assert x not in await _ids_on(c, h, money["id"])
        # Already there: nothing to do.
        again = (await c.post(f"/v1/items/{x}/move-to-page",
                              json={"client_id": _cid(), "mode": "also_show",
                                    "to_page_ids": [notes["id"]]}, headers=h)).json()  # fmt: skip
        assert again["moved"] is False and again["reason"] == "nothing_to_do"
        today = (await c.get("/v1/pages", headers=h)).json()["pages"][0]
        r = await c.post(f"/v1/items/{x}/move-to-page",
                         json={"client_id": _cid(), "mode": "also_show",
                               "to_page_ids": [today["id"]]}, headers=h)  # fmt: skip
        assert r.status_code == 403


async def test_two_moves_of_one_kind_teach_placement_and_undo_unteaches(db_app):
    app, _, s = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        notes = await _add_page(c, h, "notes")
        home = await _add_page(c, h, "custom", title="Ремонт")
        receipts = [await _note(c, h, f"Чек Леруа {k}") for k in range(3)]
        for r_ in receipts:
            await _set_envelope(s, r_, "receipt")

        async def move(item: str) -> dict:
            r = await c.post(f"/v1/items/{item}/move-to-page",
                             json={"client_id": _cid(), "mode": "move",
                                   "from_page_id": notes["id"], "to_page_ids": [home["id"]]},
                             headers=h)  # fmt: skip
            assert r.status_code == 200, r.text
            return r.json()

        assert (await move(receipts[0]))["learned_ru"] is None  # once is not a habit
        second = await move(receipts[1])
        assert second["learned_ru"] == "Похожие положу туда же"
        habit = await s.scalar(select(UserHabit).execution_options(populate_existing=True))
        assert habit is not None and habit.status == "active" and habit.evidence_count == 2
        assert habit.source == "learned_edit" and habit.kind == "placement_rule"
        listed = [x for x in (await c.get("/v1/habits", headers=h)).json()["habits"]
                  if x["kind"] == "placement_rule"]  # week 9 adds the screen exclusions
        assert [x["text_ru"] for x in listed] == ["Чеки кладу на страницу «Ремонт»"]

        # A new receipt goes where the person put the others too (once its type is known); a
        # plain note does not.
        new = await _note(c, h, "Чек Леруа 3")
        assert new not in await _ids_on(c, h, home["id"])
        item = await _set_envelope(s, new, "receipt")
        await place_item(s, item)
        await s.commit()
        assert new in await _ids_on(c, h, home["id"])
        plain = await _note(c, h, "Просто заметка")
        assert plain in await _ids_on(c, h, notes["id"]) and plain not in await _ids_on(
            c, h, home["id"])  # fmt: skip

        # «Отменить» of the move that switched it on takes the learning back.
        r = await c.post(f"/v1/actions/{second['action']['id']}/undo", headers=h)
        assert r.status_code == 200 and r.json()["partial"] is False
        await s.refresh(habit)
        assert habit.status == "candidate" and habit.evidence_count == 1
        assert [x for x in (await c.get("/v1/habits", headers=h)).json()["habits"]
                if x["kind"] == "placement_rule"] == []
        late = await _note(c, h, "Чек Леруа 4")
        await place_item(s, await _set_envelope(s, late, "receipt"))
        await s.commit()
        assert late not in await _ids_on(c, h, home["id"])
        # Turned off by the person: learning never switches it on again.
        habit.status = "disabled"
        await s.commit()
        assert (await move(receipts[2]))["learned_ru"] is None
        await s.refresh(habit)
        assert habit.status == "disabled"


async def test_move_to_a_page_removed_on_the_other_phone_never_loses_the_record(db_app):
    """Spec 9: a move offline + removing that page on the second phone → the record stays on
    «Заметки», whatever order the two calls arrive in."""
    app, _, _ = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        notes = await _add_page(c, h, "notes")
        for first in ("move", "remove"):
            target = await _add_page(c, h, "custom", title=f"Ремонт {first}")
            x = await _note(c, h, f"Плитка {first}")
            body = {"client_id": _cid(), "mode": "move", "from_page_id": notes["id"],
                    "to_page_ids": [target["id"]]}
            if first == "move":
                r = await c.post(f"/v1/items/{x}/move-to-page", json=body, headers=h)
                assert r.json()["moved"] is True
                assert x not in await _ids_on(c, h, notes["id"])
                await c.delete(f"/v1/pages/{target['id']}", headers=h)
            else:
                await c.delete(f"/v1/pages/{target['id']}", headers=h)
                r = await c.post(f"/v1/items/{x}/move-to-page", json=body, headers=h)
                assert r.json()["moved"] is False and r.json()["reason"] == "page_removed"
            assert x in await _ids_on(c, h, notes["id"]), first


# --- tab order ---


async def test_tabs_by_hand_today_stays_first_undo_and_last_writer_wins(db_app):
    app, _, _ = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        a = await _add_page(c, h, "custom", title="А")
        b = await _add_page(c, h, "custom", title="Б")
        cc = await _add_page(c, h, "custom", title="В")
        tabs = lambda: c.get("/v1/pages", headers=h)  # noqa: E731
        today = (await tabs()).json()["pages"][0]
        r = await c.post("/v1/pages/reorder", json={"client_id": _cid(), "page_id": cc["id"],
                                                    "after_page_id": today["id"]}, headers=h)
        assert r.status_code == 200, r.text
        out = r.json()
        assert out["moved"] is True and out["action"]["kind"] == "reorder_screens"
        assert out["action"]["summary"]["ru"] == "Переставил страницу «В»"
        assert [p["title"] for p in (await tabs()).json()["pages"]] == ["Сегодня", "В", "А", "Б"]
        r = await c.post(f"/v1/actions/{out['action']['id']}/undo", headers=h)
        assert r.status_code == 200
        assert [p["title"] for p in (await tabs()).json()["pages"]] == ["Сегодня", "А", "Б", "В"]
        # «Сегодня» itself cannot move.
        r = await c.post("/v1/pages/reorder", json={"client_id": _cid(), "page_id": today["id"],
                                                    "after_page_id": a["id"]}, headers=h)
        assert r.status_code == 403
        # Two phones move «А» offline: the later one wins in either order.
        late = {"client_id": _cid(), "page_id": a["id"], "after_page_id": cc["id"],
                "client_ts": (T0 + timedelta(minutes=2)).isoformat()}
        early = {"client_id": _cid(), "page_id": a["id"], "before_page_id": b["id"],
                 "after_page_id": today["id"], "client_ts": (T0 + timedelta(minutes=1)).isoformat()}
        assert (await c.post("/v1/pages/reorder", json=late, headers=h)).json()["moved"] is True
        lost = (await c.post("/v1/pages/reorder", json=early, headers=h)).json()
        assert lost["moved"] is False and lost["reason"] == "newer_move"
        assert [p["title"] for p in (await tabs()).json()["pages"]] == ["Сегодня", "Б", "В", "А"]


# --- two phones offline: property-style ---


@dataclass
class Phone:
    """A phone offline: it moves rows in its own copy of the page and queues the calls."""

    name: str
    rows: list[tuple[str, str]]  # (item id, key) in its visible order
    base_seq: int
    rng: random.Random
    clock: datetime
    outbox: list[dict] = field(default_factory=list)

    def tick(self) -> str:
        self.clock += timedelta(milliseconds=self.rng.randint(1, 1500))
        return self.clock.isoformat()

    def act(self) -> None:
        if len(self.rows) >= 3 and self.rng.random() < 0.15:
            item, _ = self.rows.pop(self.rng.randrange(len(self.rows)))
            self.outbox.append({"kind": "remove", "item": item, "client_id": _cid()})
            return
        i = self.rng.randrange(len(self.rows))
        item, _ = self.rows.pop(i)
        j = self.rng.randrange(len(self.rows) + 1)
        above = self.rows[j - 1] if j > 0 else None
        below = self.rows[j] if j < len(self.rows) else None
        key = lexorank.between(above[1] if above else None, below[1] if below else None)
        self.rows.insert(j, (item, key))
        self.outbox.append({"kind": "move", "item": item, "client_id": _cid(),
                            "body": {"item_id": item,
                                     "after_item_id": above[0] if above else None,
                                     "before_item_id": below[0] if below else None,
                                     "position": key, "base_seq": self.base_seq,
                                     "client_ts": self.tick()}})  # fmt: skip


def _interleave(rng: random.Random, a: list, b: list) -> list:
    """A random arrival order that keeps each phone's own order (its outbox is FIFO), with some
    calls retried later (a lost response)."""
    out, i, j = [], 0, 0
    while i < len(a) or j < len(b):
        if j >= len(b) or (i < len(a) and rng.random() < 0.5):
            out.append(a[i])
            i += 1
        else:
            out.append(b[j])
            j += 1
    for op in list(out):
        if rng.random() < 0.25:
            at = out.index(op) + 1
            out.insert(rng.randint(at, len(out)), op)
    return out


async def _state(s, page_pk: int) -> dict[str, tuple]:
    rows = await s.execute(text("""
        SELECT i.public_id, si.position, si.manual_order, si.removed_by_user_at IS NOT NULL
        FROM screen_items si JOIN items i ON i.id = si.item_id WHERE si.screen_id = :p
    """), {"p": page_pk})  # fmt: skip
    return {str(pid): (pos, manual, removed) for pid, pos, manual, removed in rows}


async def _reset(s, page_pk: int, user_pk: int, snap: dict[str, tuple]) -> None:
    for item, (pos, _, _) in snap.items():
        await s.execute(text("""
            UPDATE screen_items SET position = :pos, manual_order = false, manual_at = NULL,
                   updated_by = 'user', removed_by_user_at = NULL, moved_ts = NULL,
                   moved_client_id = NULL
            WHERE screen_id = :p AND item_id = (SELECT id FROM items WHERE public_id = :i)
        """), {"pos": pos, "p": page_pk, "i": uuid.UUID(item)})  # fmt: skip
    await s.execute(text("DELETE FROM actions WHERE user_id = :u"), {"u": user_pk})
    await s.execute(text("UPDATE screens SET rekeyed_seq = NULL WHERE id = :p"), {"p": page_pk})
    await s.commit()


def _expected(snap: dict[str, tuple], ops: list[dict]) -> dict[str, tuple]:
    """The oracle: per row, the move with the latest (client_ts, client_id) wins; a removal from
    either phone stands."""
    out = {}
    for item, (pos, _, _) in snap.items():
        moves = [op for op in ops if op["kind"] == "move" and op["item"] == item]
        win = max(moves, default=None, key=lambda op: order.Stamp(
            datetime.fromisoformat(op["body"]["client_ts"]), str(op["client_id"])))  # fmt: skip
        removed = any(op["kind"] == "remove" and op["item"] == item for op in ops)
        out[item] = (win["body"]["position"] if win else pos, bool(win), removed)
    return out


@pytest.mark.parametrize("seed", [1, 2, 3, 4])
async def test_two_phones_offline_converge_whatever_the_arrival_order(db_app, seed):
    app, _, s = db_app
    rng = random.Random(seed)
    async with client(app) as c:
        h = await _signed_in(c)
        page, _ = await _custom_page(c, h, "Дом", 6)
        page_pk = (await _page_row(s, page["id"])).id
        user_pk = (await _page_row(s, page["id"])).user_id
        entries = await _entries(c, h, page["id"])
        start = [(e["item"]["id"], e["link"]["position"]) for e in entries]
        base = (await _sync_all(c, h))["next_since"]
        snap = await _state(s, page_pk)
        # Both phones go offline from the same state; their clocks interleave.
        phones = [Phone(n, list(start), base, random.Random(seed * 10 + k),
                        T0 + timedelta(milliseconds=rng.randint(0, 500)))
                  for k, n in enumerate("AB")]  # fmt: skip
        for _ in range(7):
            for p in phones:
                p.act()
        ops = phones[0].outbox + phones[1].outbox
        both = [{o["item"] for o in p.outbox if o["kind"] == "move"} for p in phones]
        assert both[0] & both[1]  # some row is moved on both phones: a real conflict
        expected = _expected(snap, ops)

        finals = []
        for _ in range(5):
            await _reset(s, page_pk, user_pk, snap)
            for op in _interleave(rng, phones[0].outbox, phones[1].outbox):
                if op["kind"] == "move":
                    r = await c.post(f"/v1/pages/{page['id']}/items/move",
                                     json={"client_id": str(op["client_id"]), **op["body"]},
                                     headers=h)  # fmt: skip
                else:
                    r = await c.delete(f"/v1/pages/{page['id']}/items/{op['item']}"
                                       f"?client_id={op['client_id']}", headers=h)  # fmt: skip
                assert r.status_code == 200, r.text
            state = await _state(s, page_pk)
            assert state == expected  # every row as the oracle says: no loss, no duplicate
            finals.append((state, await _ids_on(c, h, page["id"])))
        assert all(f == finals[0] for f in finals)

        # Each phone syncs and lands on the server's order (pages.md page order).
        sync = await _sync_all(c, h, base)
        when = {i["id"]: i["occurred_at"] or i["created_at"]
                for i in (await _sync_all(c, h))["items"]}  # fmt: skip
        for _ in phones:
            local = {e["item"]["id"]: (e["link"]["position"], None) for e in entries}
            for link in sync["screen_items"]:
                if link["page_id"] == page["id"]:
                    local[link["item_id"]] = (link["position"], link["removed_at"])
            shown = [i for i, (_, removed) in local.items() if removed is None]
            shown.sort(key=lambda i: (local[i][0], -datetime.fromisoformat(when[i]).timestamp(), i))
            assert shown == finals[0][1]


async def test_one_row_on_two_phones_later_wins_without_duplicates(db_app):
    app, _, s = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        page, _ = await _custom_page(c, h, "Дом", 4)
        entries = await _entries(c, h, page["id"])
        ids = [e["item"]["id"] for e in entries]
        keys = [e["link"]["position"] for e in entries]
        base = (await _sync_all(c, h))["next_since"]
        to_top = {"client_id": _cid(), "item_id": ids[2], "before_item_id": ids[0],
                  "position": lexorank.between(None, keys[0]), "base_seq": base,
                  "client_ts": (T0 + timedelta(seconds=5)).isoformat()}
        to_bottom = {"client_id": _cid(), "item_id": ids[2], "after_item_id": ids[3],
                     "position": lexorank.between(keys[3], None), "base_seq": base,
                     "client_ts": (T0 + timedelta(seconds=9)).isoformat()}
        results = []
        for first, second in ((to_top, to_bottom), (to_bottom, to_top)):
            page_pk = (await _page_row(s, page["id"])).id
            await _reset(s, page_pk, (await _page_row(s, page["id"])).user_id,
                         {i: (k, False, False) for i, k in zip(ids, keys, strict=True)})
            a = await _move(c, h, page["id"], **first)
            b = await _move(c, h, page["id"], **second)
            assert a["moved"] is True
            if first is to_bottom:  # the earlier move arrives last: it loses, no dialog
                assert b["moved"] is False and b["reason"] == "newer_move" and not b["action"]
                assert b["link"]["position"] == to_bottom["position"]  # shown where it won
            else:
                assert b["moved"] is True
            results.append(await _ids_on(c, h, page["id"]))
        assert results[0] == results[1] == [ids[0], ids[1], ids[3], ids[2]]


async def test_person_moved_offline_while_assistant_arranged_keeps_their_place(db_app):
    """The assistant's plan applies with `restore_positions`; a move the person made after it
    (arriving later from the outbox) still wins, and the assistant's undo leaves it alone."""
    from assistant.actions import engine, record
    from assistant.db.models_actions import Initiator

    app, _, s = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        page, _ = await _custom_page(c, h, "Дом", 3)
        entries = await _entries(c, h, page["id"])
        ids = [e["item"]["id"] for e in entries]
        keys = [e["link"]["position"] for e in entries]
        page_row = await _page_row(s, page["id"])
        now = datetime.now(UTC)
        out = await engine.apply(s, page_row.user_id, [{"op": "restore_positions",
                                                        "page": page["id"], "rows": [
            {"item": ids[0], "position": keys[2], "group_key": None, "manual_order": False},
            {"item": ids[2], "position": keys[0], "group_key": None, "manual_order": False},
        ]}], by=Initiator.AGENT, check=False, now=now)  # fmt: skip
        agent = await record(s, user_id=page_row.user_id, kind="screen_reorder_items",
                             initiated_by="agent", summary={"ru": "Переставил"}, changes=[],
                             inverse=out.inverse, now=now)  # fmt: skip
        await s.commit()
        mine = await _move(c, h, page["id"], item_id=ids[0], before_item_id=ids[2],
                           client_ts=(now - timedelta(seconds=30)).isoformat())
        assert mine["moved"] is True
        r = (await c.post(f"/v1/actions/{agent.public_id}/undo", headers=h)).json()
        assert r["partial"] is True
        assert (await _ids_on(c, h, page["id"]))[0] == ids[0]  # the person's place stands
        assert (await _link(s, page["id"], ids[0])).manual_order is True


async def test_sync_carries_manual_moves_and_actions(db_app):
    app, _, _ = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        page, _ = await _custom_page(c, h, "Дом", 2)
        a, b = await _ids_on(c, h, page["id"])
        base = (await _sync_all(c, h))["next_since"]
        out = await _move(c, h, page["id"], item_id=b, before_item_id=a)
        r = (await c.get(f"/v1/sync?since={base}", headers=h)).json()
        assert [lk["item_id"] for lk in r["screen_items"]] == [b]
        assert r["screen_items"][0]["manual_order"] is True
        assert [x["id"] for x in r["actions"]] == [out["action"]["id"]]
        assert [p["id"] for p in r["screens"]] == [page["id"]]  # view_version went up


async def test_undo_of_the_first_of_two_moves_takes_only_its_count_back(db_app):
    app, _, s = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        notes = await _add_page(c, h, "notes")
        home = await _add_page(c, h, "custom", title="Ремонт")
        ids = [await _note(c, h, f"Чек {k}") for k in range(2)]
        moved = []
        for i in ids:
            await _set_envelope(s, i, "receipt")
            r = await c.post(f"/v1/items/{i}/move-to-page",
                             json={"client_id": _cid(), "mode": "move",
                                   "from_page_id": notes["id"], "to_page_ids": [home["id"]]},
                             headers=h)  # fmt: skip
            moved.append(r.json())
        r = (await c.post(f"/v1/actions/{moved[0]['action']['id']}/undo", headers=h)).json()
        assert r["partial"] is False  # a later move of another record is no conflict
        habit = await s.scalar(select(UserHabit).execution_options(populate_existing=True))
        assert habit.status == "candidate" and habit.evidence_count == 1
        # «Вернуть» counts it again.
        await c.post(f"/v1/actions/{r['undo']['id']}/undo", headers=h)
        await s.refresh(habit)
        assert habit.status == "active" and habit.evidence_count == 2


async def test_turning_a_rule_off_stops_it_and_can_be_undone(db_app):
    app, _, s = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        notes = await _add_page(c, h, "notes")
        home = await _add_page(c, h, "custom", title="Ремонт")
        for k in range(2):
            i = await _note(c, h, f"Чек {k}")
            await _set_envelope(s, i, "receipt")
            await c.post(f"/v1/items/{i}/move-to-page",
                         json={"client_id": _cid(), "mode": "move", "from_page_id": notes["id"],
                               "to_page_ids": [home["id"]]}, headers=h)  # fmt: skip
        rule = (await c.get("/v1/habits", headers=h)).json()["habits"][0]
        off = (await c.delete(f"/v1/habits/{rule['id']}", headers=h)).json()
        assert off["removed"] is True and off["action"]["kind"] == "habit_change"
        assert [x for x in (await c.get("/v1/habits", headers=h)).json()["habits"]
                if x["kind"] == "placement_rule"] == []
        late = await _note(c, h, "Чек поздний")
        await place_item(s, await _set_envelope(s, late, "receipt"))
        await s.commit()
        assert late not in await _ids_on(c, h, home["id"])
        again = (await c.delete(f"/v1/habits/{rule['id']}", headers=h)).json()
        assert again["removed"] is False and again["action"] is None
        await c.post(f"/v1/actions/{off['action']['id']}/undo", headers=h)
        assert len([x for x in (await c.get("/v1/habits", headers=h)).json()["habits"]
                    if x["kind"] == "placement_rule"]) == 1
        assert (await c.delete(f"/v1/habits/{_cid()}", headers=h)).status_code == 404


async def test_a_repeat_of_a_move_that_changed_nothing_is_a_repeat(db_app):
    app, _, _ = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        page, _ = await _custom_page(c, h, "Дом", 3)
        entries = await _entries(c, h, page["id"])
        ids = [e["item"]["id"] for e in entries]
        key = lexorank.between(entries[0]["link"]["position"], entries[1]["link"]["position"])
        base = (await _sync_all(c, h))["next_since"]
        await _move(c, h, page["id"], item_id=ids[2], after_item_id=ids[0], position=key,
                    base_seq=base)
        body = {"client_id": _cid(), "item_id": ids[2], "after_item_id": ids[0], "position": key,
                "base_seq": base, "client_ts": datetime.now(UTC).isoformat()}
        first = await _move(c, h, page["id"], **body)
        assert first["moved"] is True and first["action"] is None
        again = await _move(c, h, page["id"], **body)
        assert again["moved"] is True and again["repeated"] is True


async def test_a_retry_after_the_record_went_to_the_trash_returns_the_first_result(db_app):
    app, _, _ = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        notes = await _add_page(c, h, "notes")
        home = await _add_page(c, h, "custom", title="Ремонт")
        x = await _note(c, h, "Плитка")
        body = {"client_id": _cid(), "mode": "move", "from_page_id": notes["id"],
                "to_page_ids": [home["id"]]}
        first = (await c.post(f"/v1/items/{x}/move-to-page", json=body, headers=h)).json()
        assert (await c.delete(f"/v1/items/{x}", headers=h)).status_code == 200
        r = await c.post(f"/v1/items/{x}/move-to-page", json=body, headers=h)
        assert r.status_code == 200 and r.json()["repeated"] is True
        assert r.json()["action"]["id"] == first["action"]["id"]
        body["client_id"] = _cid()
        r = await c.post(f"/v1/items/{x}/move-to-page", json=body, headers=h)
        assert r.status_code == 409 and r.json()["code"] == "item_deleted"


async def test_a_phone_key_from_before_the_assistant_arranged_the_page_is_not_used(db_app):
    """Its neighbours stand elsewhere now: the row goes next to them, where the person saw it."""
    from assistant.actions import engine
    from assistant.db.models_actions import Initiator

    app, _, s = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        page, _ = await _custom_page(c, h, "Дом", 4)
        entries = await _entries(c, h, page["id"])
        ids = [e["item"]["id"] for e in entries]
        keys = [e["link"]["position"] for e in entries]
        base = (await _sync_all(c, h))["next_since"]
        row = await _page_row(s, page["id"])
        await engine.apply(s, row.user_id, [{"op": "restore_positions", "page": page["id"],
                                             "rows": [
            {"item": ids[0], "position": keys[3], "group_key": None, "manual_order": False},
            {"item": ids[3], "position": keys[0], "group_key": None, "manual_order": False},
        ]}], by=Initiator.AGENT, check=False, now=datetime.now(UTC))  # fmt: skip
        await s.commit()
        stale = lexorank.between(keys[0], keys[1])  # "right after ids[0]" before it was moved
        out = await _move(c, h, page["id"], item_id=ids[2], after_item_id=ids[0], position=stale,
                          base_seq=base)
        assert out["link"]["position"] != stale
        assert await _ids_on(c, h, page["id"]) == [ids[3], ids[1], ids[0], ids[2]]
        # A phone that synced after it: its key is used again.
        fresh = (await _sync_all(c, h))["next_since"]
        k = lexorank.between(None, keys[0])
        out = await _move(c, h, page["id"], item_id=ids[1], before_item_id=ids[3], position=k,
                          base_seq=fresh)
        assert out["link"]["position"] == k


async def test_parallel_moves_on_real_connections(tmp_path):
    """Not in one rolled-back transaction: retries of one call race, two phones race on a row."""
    import asyncio

    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from assistant.api.app import create_app
    from assistant.api.sms import FakeSmsSender
    from tests.api.conftest import make_settings, make_storage

    engine = create_async_engine(os.environ["DATABASE_URL"])
    maker = async_sessionmaker(engine, expire_on_commit=False)
    app = create_app(make_settings(), sessionmaker=maker, sms=FakeSmsSender(),
                     storage=make_storage(tmp_path))  # fmt: skip
    user_id = None
    try:
        async with client(app) as c:
            h = await _signed_in(c)
            page, _ = await _custom_page(c, h, "Дом", 4)
            async with maker() as s:
                user_id = (await _page_row(s, page["id"])).user_id
            a, b, cc, d = await _ids_on(c, h, page["id"])
            url = f"/v1/pages/{page['id']}/items/move"
            same = {"client_id": _cid(), "item_id": d, "before_item_id": a}
            rs = await asyncio.gather(*(c.post(url, json=same, headers=h) for _ in range(6)))
            assert {r.status_code for r in rs} == {200}
            assert sum(not r.json()["repeated"] for r in rs) == 1
            assert len({r.json()["action"]["id"] for r in rs}) == 1
            moves = [{"client_id": _cid(), "item_id": b, "after_item_id": cc,
                      "client_ts": (T0 + timedelta(seconds=k)).isoformat()} for k in range(8)]
            rs = await asyncio.gather(*(c.post(url, json=m, headers=h) for m in moves))
            assert {r.status_code for r in rs} == {200}
            assert await _ids_on(c, h, page["id"]) == [d, a, cc, b]
            async with maker() as s:
                link = await _link(s, page["id"], b)
                assert str(link.moved_client_id) == moves[-1]["client_id"]  # the latest won
    finally:
        if user_id is not None:
            async with maker() as s:
                await s.execute(text(
                    "DELETE FROM jobs WHERE (payload ->> 'item_id')::bigint IN "
                    "(SELECT id FROM items WHERE user_id = :u) "
                    "OR (payload ->> 'user_id')::bigint = :u"), {"u": user_id})  # fmt: skip
                await s.execute(text("DELETE FROM users WHERE id = :u"), {"u": user_id})
                await s.commit()
        await engine.dispose()
