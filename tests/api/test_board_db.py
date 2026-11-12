"""The free board against Postgres (weeks 16а–16б, Ф-28; contract docs/api/views.md «Доска»):
turning it on gives places in rows order and never loses either layout, `items/place` with
«Отменить», repeats, a later place wins on two phones (property-style: random places, random
interleavings and retries, one result), sync. Skipped unless DATABASE_URL is set."""

import os
import random
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from sqlalchemy import text

from assistant.pages import board, order
from tests.api.conftest import client
from tests.api.test_pages_db import _add_page, _cid, _note, _page_row, _signed_in, _sync_all

pytestmark = [
    pytest.mark.db,
    pytest.mark.skipif(not os.environ.get("DATABASE_URL"), reason="DATABASE_URL not set"),
]

T0 = datetime.now(UTC) - timedelta(hours=1)
X = [c / 360 for c in board.COLUMNS]


async def _notes(c, h, n: int) -> tuple[dict, list[str]]:  # type: ignore[no-untyped-def]
    page = await _add_page(c, h, "notes")
    ids = []
    for k in range(n):
        item = await _note(c, h, f"Заметка {k}")
        r = await c.post(f"/v1/pages/{page['id']}/items", json={"item_id": item}, headers=h)
        assert r.status_code in (200, 201), r.text
        ids.append(item)
    return page, ids


async def _links(c, h, pid: str) -> dict[str, dict]:  # type: ignore[no-untyped-def]
    r = await c.get(f"/v1/pages/{pid}/items?limit=200", headers=h)
    assert r.status_code == 200, r.text
    return {e["item"]["id"]: e["link"] for e in r.json()["entries"]}


async def _order(c, h, pid: str) -> list[str]:  # type: ignore[no-untyped-def]
    r = await c.get(f"/v1/pages/{pid}/items?limit=200", headers=h)
    return [e["item"]["id"] for e in r.json()["entries"]]


async def _view(c, h, pid: str, **body: Any) -> dict:  # type: ignore[no-untyped-def]
    r = await c.post(f"/v1/pages/{pid}/view", json={"client_id": _cid(), **body}, headers=h)
    assert r.status_code == 200, r.text
    return r.json()


async def _place(c, h, pid: str, expect: int = 200, **body: Any) -> dict:  # type: ignore[no-untyped-def]
    body.setdefault("client_id", _cid())
    r = await c.post(f"/v1/pages/{pid}/items/place", json=body, headers=h)
    assert r.status_code == expect, r.text
    return r.json()


def _at(link: dict) -> tuple[int, int]:
    return board.x_pt(link["board_x"]), int(link["board_y"])


async def test_board_on_lays_out_in_rows_order_and_both_layouts_stay(db_app):
    app, _, s = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        page, _ = await _notes(c, h, 5)
        pid = page["id"]
        rows_order = await _order(c, h, pid)
        assert all(link["board_x"] is None for link in (await _links(c, h, pid)).values())

        out = await _view(c, h, pid, board=True)
        assert out["action"]["summary"]["ru"] == "Стикеры: Ряды → Доска."
        patched = {r["item_id"]: r for r in out["page_patch"]["rows"]}
        assert set(patched) == set(rows_order)  # the auto places travel in the patch
        links = await _links(c, h, pid)
        want = [(24, 16), (196, 16), (24, 172), (196, 172), (24, 328)]
        assert [_at(links[i]) for i in rows_order] == want
        assert not any(link["board_manual"] for link in links.values())

        # the person puts one sticker somewhere; back to rows: the order is as it was
        first = rows_order[0]
        await _place(c, h, pid, item_id=first, x=0.3, y=500)
        await _view(c, h, pid, board=False)
        assert await _order(c, h, pid) == rows_order
        # a note made while in rows gets no place; the board on again keeps every place
        late = await _note(c, h, "Поздняя")
        await c.post(f"/v1/pages/{pid}/items", json={"item_id": late}, headers=h)
        assert (await _links(c, h, pid))[late]["board_x"] is None
        await _view(c, h, pid, board=True)
        links = await _links(c, h, pid)
        assert _at(links[first]) == (108, 500) and links[first]["board_manual"] is True
        assert _at(links[late]) == (24, 16)  # the first free slot (the first sticker left it)
        # a new note while the board is on lies in the first free slot
        new = await _note(c, h, "Новая")
        await c.post(f"/v1/pages/{pid}/items", json={"item_id": new}, headers=h)
        assert _at((await _links(c, h, pid))[new]) == (196, 328)

        # «Вернуть как было» turns the board off and keeps the places
        r = await c.post(f"/v1/pages/{pid}/reset", json={}, headers=h)
        assert r.status_code == 200 and not r.json()["page"]["view_state"].get("board")
        assert _at((await _links(c, h, pid))[first]) == (108, 500)
        # undo of the reset brings the board back
        u = await c.post(f"/v1/actions/{r.json()['action']['id']}/undo", headers=h)
        assert u.status_code == 200, u.text
        assert (await c.get(f"/v1/pages/{pid}", headers=h)).json()["view_state"]["board"] is True
        assert (await _page_row(s, pid)).template_key == "notes"


async def test_place_undo_repeat_and_the_rows_order_untouched(db_app):
    app, _, _ = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        page, ids = await _notes(c, h, 3)
        pid = page["id"]
        await _view(c, h, pid, board=True)
        rows_order = await _order(c, h, pid)
        a = rows_order[1]
        before = (await _links(c, h, pid))[a]
        cid = _cid()
        ts = (T0 + timedelta(minutes=1)).isoformat()
        out = await _place(c, h, pid, client_id=cid, client_ts=ts, item_id=a, x=0.41, y=33.6,
                           base_view_version=1)
        assert out["placed"] is True and out["rebased"] is True and out["repeated"] is False
        link = out["links"][0]
        assert _at(link) == (148, 34) and link["board_manual"] is True
        assert link["board_z"] == board.z_of(datetime.fromisoformat(ts))
        assert out["action"]["kind"] == "screen_reorder_items"
        assert out["action"]["summary"]["ru"].startswith("Переставил «") and \
            out["action"]["summary"]["ru"].endswith("» на доске")  # fmt: skip
        assert out["action"]["changes"][0]["kind"] == "place"
        assert link["position"] == before["position"]
        assert await _order(c, h, pid) == rows_order  # rows do not move with the board

        rep = await _place(c, h, pid, client_id=cid, client_ts=ts, item_id=a, x=0.9, y=0)
        assert rep["repeated"] is True and rep["action"]["id"] == out["action"]["id"]
        assert _at(rep["links"][0]) == (148, 34)

        u = await c.post(f"/v1/actions/{out['action']['id']}/undo", headers=h)
        assert u.status_code == 200, u.text
        back = (await _links(c, h, pid))[a]
        assert (back["board_x"], back["board_y"], back["board_z"], back["board_manual"]) == \
            (before["board_x"], before["board_y"], None, False)  # fmt: skip
        # the clock did not go back: an older place from the other phone still loses
        old = await _place(c, h, pid, client_ts=T0.isoformat(), item_id=a, x=0, y=900)
        assert old["placed"] is False and old["reason"] == "newer_move"
        assert old["kept_item_ids"] == [a] and old["action"] is None

        # moved again since: «Отменить» leaves the newer place (partial)
        p1 = await _place(c, h, pid, client_ts=(T0 + timedelta(minutes=2)).isoformat(),
                          item_id=a, x=0, y=600)
        await _place(c, h, pid, client_ts=(T0 + timedelta(minutes=3)).isoformat(), item_id=a,
                     x=0, y=700)
        u = await c.post(f"/v1/actions/{p1['action']['id']}/undo", headers=h)
        assert u.status_code == 200 and u.json()["partial"] is True, u.text
        assert _at((await _links(c, h, pid))[a]) == (0, 700)

        # «Наверх доски»: the same place, on top
        b = rows_order[2]
        cur = (await _links(c, h, pid))[b]
        top = await _place(c, h, pid, client_ts=(T0 + timedelta(minutes=4)).isoformat(),
                           item_id=b, x=cur["board_x"], y=cur["board_y"])
        assert top["action"]["summary"]["ru"].startswith("Положил «")
        assert top["links"][0]["board_z"] > (await _links(c, h, pid))[a]["board_z"]

        # a row moved in «Ряды» keeps its board place
        r = await c.post(f"/v1/pages/{pid}/items/move", headers=h,
                         json={"client_id": _cid(), "item_id": a,
                               "before_item_id": rows_order[0]})  # fmt: skip
        assert r.status_code == 200 and r.json()["moved"] is True
        assert _at((await _links(c, h, pid))[a]) == (0, 700)
        assert ids


async def test_pile_swap_and_errors(db_app):
    app, _, _ = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        page, _ = await _notes(c, h, 3)
        pid = page["id"]
        await _view(c, h, pid, board=True)
        a, b, k = await _order(c, h, pid)
        la, lb = (await _links(c, h, pid))[a], (await _links(c, h, pid))[b]
        out = await _place(c, h, pid, places=[
            {"item_id": a, "x": lb["board_x"], "y": lb["board_y"]},
            {"item_id": b, "x": la["board_x"], "y": la["board_y"]}])  # «Выше / Ниже» at 150%
        assert out["action"]["summary"]["ru"] == "Переставил 2 стикера на доске"
        assert len(out["action"]["changes"]) == 2
        now = await _links(c, h, pid)
        assert _at(now[a]) == _at(lb) and _at(now[b]) == _at(la)
        u = await c.post(f"/v1/actions/{out['action']['id']}/undo", headers=h,
                         json={"item_ids": [a]})  # «Вернуть» one sticker
        assert u.status_code == 200, u.text
        now = await _links(c, h, pid)
        assert _at(now[a]) == _at(la) and _at(now[b]) == _at(la)

        other = await _add_page(c, h, "custom", title="Дом")
        r = await c.post(f"/v1/pages/{other['id']}/items", json={"item_id": a}, headers=h)
        assert r.status_code == 201
        bad = await _place(c, h, other["id"], 422, item_id=a, x=0, y=0)
        assert bad["code"] == "validation_error"
        await _place(c, h, pid, 404, item_id=str(uuid.uuid4()), x=0, y=0)
        await _place(c, h, str(uuid.uuid4()), 404, item_id=a, x=0, y=0)
        await _place(c, h, pid, 422, places=[{"item_id": a, "x": 0, "y": 0},
                                             {"item_id": a, "x": 1, "y": 0}])
        await _place(c, h, pid, 422, item_id=a, x=0)
        r = await c.post(f"/v1/pages/{pid}/items/place", headers=h,
                         content=f'{{"client_id": "{_cid()}", "item_id": "{k}", "x": NaN, "y": 0}}')
        assert r.status_code == 422
        today = next(p for p in (await c.get("/v1/pages", headers=h)).json()["pages"]
                     if p["kind"] == "system_today")
        await _place(c, h, today["id"], 403, item_id=a, x=0, y=0)


async def test_sync_carries_the_board(db_app):
    app, _, _ = db_app
    async with client(app) as c:
        h = await _signed_in(c)
        page, _ = await _notes(c, h, 2)
        pid = page["id"]
        await _view(c, h, pid, board=True)
        a = (await _order(c, h, pid))[0]
        base = (await _sync_all(c, h))["next_since"]
        await _place(c, h, pid, item_id=a, x=0.5, y=40)
        rows = [r for r in (await _sync_all(c, h, base))["screen_items"] if r["item_id"] == a]
        assert len(rows) == 1 and _at(rows[0]) == (180, 40) and rows[0]["board_manual"] is True


# --- two phones offline ---


@dataclass
class Phone:
    rng: random.Random
    clock: datetime
    stickers: list[str]
    outbox: list[dict] = field(default_factory=list)

    def act(self) -> None:
        self.clock += timedelta(milliseconds=self.rng.randint(0, 900))  # 0: equal times happen
        k = self.rng.randint(1, 3)
        chosen = self.rng.sample(self.stickers, k)
        places = [{"item_id": i, "x": self.rng.randint(0, 230) / 360,
                   "y": self.rng.choice([0, 16, 172, self.rng.randint(0, 2000)])}
                  for i in chosen]  # fmt: skip
        self.outbox.append({"client_id": _cid(), "client_ts": self.clock.isoformat(),
                            "places": places})  # fmt: skip


def _interleave(rng: random.Random, a: list, b: list) -> list:
    """A random arrival order keeping each phone's FIFO outbox, with some calls retried later."""
    out, i, j = [], 0, 0
    while i < len(a) or j < len(b):
        if j >= len(b) or (i < len(a) and rng.random() < 0.5):
            out.append(a[i])
            i += 1
        else:
            out.append(b[j])
            j += 1
    for op in list(out):
        if rng.random() < 0.3:
            out.insert(rng.randint(out.index(op) + 1, len(out)), op)
    return out


async def _state(s, page_pk: int) -> dict[str, tuple]:  # type: ignore[no-untyped-def]
    rows = await s.execute(text("""
        SELECT i.public_id, si.board_x, si.board_y, si.board_z, si.board_manual, si.position
        FROM screen_items si JOIN items i ON i.id = si.item_id WHERE si.screen_id = :p
    """), {"p": page_pk})  # fmt: skip
    return {str(r[0]): tuple(r[1:]) for r in rows}


async def _reset(s, page_pk: int, user_pk: int, snap: dict[str, tuple]) -> None:  # type: ignore[no-untyped-def]
    for item, (x, y, z, manual, _) in snap.items():
        await s.execute(text("""
            UPDATE screen_items SET board_x = :x, board_y = :y, board_z = :z, board_manual = :m,
                   board_ts = NULL, board_client_id = NULL
            WHERE screen_id = :p AND item_id = (SELECT id FROM items WHERE public_id = :i)
        """), {"x": x, "y": y, "z": z, "m": manual, "p": page_pk, "i": uuid.UUID(item)})
    await s.execute(text("DELETE FROM actions WHERE user_id = :u "
                         "AND kind = 'screen_reorder_items'"), {"u": user_pk})
    await s.commit()


def _expected(snap: dict[str, tuple], ops: list[dict]) -> dict[str, tuple]:
    """The oracle: per sticker, the place with the latest (client_ts, client_id) wins."""
    out = {}
    for item, row in snap.items():
        best = None
        for op in ops:
            for p in op["places"]:
                if p["item_id"] == item:
                    stamp = order.Stamp(datetime.fromisoformat(op["client_ts"]),
                                        str(op["client_id"]))
                    if best is None or stamp > best[0]:
                        best = (stamp, p)
        if best is None:
            out[item] = row
            continue
        x, y = board.normalize(best[1]["x"], best[1]["y"])
        out[item] = (x, y, board.z_of(best[0].ts), True, row[4])
    return out


@pytest.mark.parametrize("seed", [1, 2, 3, 4, 5])
async def test_two_phones_offline_converge_whatever_the_arrival_order(db_app, seed):
    app, _, s = db_app
    rng = random.Random(seed)
    async with client(app) as c:
        h = await _signed_in(c)
        page, _ = await _notes(c, h, 5)
        pid = page["id"]
        await _view(c, h, pid, board=True)
        row = await _page_row(s, pid)
        page_pk, user_pk = row.id, row.user_id
        stickers = await _order(c, h, pid)
        snap = await _state(s, page_pk)
        start = T0 + timedelta(milliseconds=rng.randint(0, 300))
        phones = [Phone(random.Random(seed * 10 + k), start, stickers) for k in range(2)]
        for _ in range(6):
            for p in phones:
                p.act()
        both = [{pl["item_id"] for op in p.outbox for pl in op["places"]} for p in phones]
        assert both[0] & both[1]  # a real conflict: some sticker placed on both phones
        ops = phones[0].outbox + phones[1].outbox
        expected = _expected(snap, ops)

        finals = []
        for _ in range(4):
            await _reset(s, page_pk, user_pk, snap)
            for op in _interleave(rng, phones[0].outbox, phones[1].outbox):
                r = await c.post(f"/v1/pages/{pid}/items/place", json=op, headers=h)
                assert r.status_code == 200, r.text
            state = await _state(s, page_pk)
            assert state == expected  # every sticker where its latest place put it
            finals.append(state)
        assert all(f == finals[0] for f in finals)
        # a phone applying sync lands on the same board
        sync = await _sync_all(c, h)
        local = {r["item_id"]: (r["board_x"], r["board_y"], r["board_z"], r["board_manual"])
                 for r in sync["screen_items"] if r["page_id"] == pid}  # fmt: skip
        assert local == {i: v[:4] for i, v in finals[0].items()}
