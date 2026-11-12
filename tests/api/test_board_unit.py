"""The free board's pure rules (weeks 16а–16б, `pages.board`; contract docs/api/views.md
«Доска»): board space, clamping, auto slots, reading order, the place call's body."""

import random
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from pydantic import ValidationError

from assistant.api.schemas import ItemPlaceIn
from assistant.pages import board, order


def test_normalize_keeps_whole_board_points_inside_the_board():
    assert board.normalize(0.0667, 172.4) == (24 / 360, 172.0)
    assert board.normalize(-1, -5) == (0.0, 0.0)
    assert board.normalize(0.99, 10**9) == (220 / 360, float(board.MAX_Y_PT))
    x, _ = board.normalize(196 / 360, 0)
    assert board.x_pt(x) == 196  # the share round-trips to the same board point
    for bad in (("a", 1), (float("nan"), 0), (0, float("inf")), (None, 1)):
        with pytest.raises(board.BadPlace):
            board.normalize(*bad)


def test_same_board_on_every_screen_width():
    x, y = board.normalize(196 / 360, 328)
    for width in (320, 360, 393, 430, 600):
        s = width / board.WIDTH
        left, top, side = x * width, y * s, board.STICKER * s
        assert left + side <= width + 1e-9  # never off the board
        assert (left / width, top / width) == pytest.approx((196 / 360, 328 / 360))


def test_free_slots_fill_from_the_top_and_skip_overlaps():
    assert board.free_slots([], 3) == [(24 / 360, 16.0), (196 / 360, 16.0), (24 / 360, 172.0)]
    # a sticker over the first slot (partly) and one between the right slots of rows 0 and 1
    placed = [board.Placed(100, 40), board.Placed(250, 100)]
    assert board.free_slots(placed, 2) == [(24 / 360, 328.0), (196 / 360, 328.0)]
    # touching edges is not an overlap
    assert board.free_slots([board.Placed(24 + 140, 16 + 140)], 1) == [(24 / 360, 16.0)]


def test_free_slots_match_a_brute_force_check():
    rng = random.Random(7)
    for _ in range(200):
        placed = [board.Placed(rng.randint(0, 220), rng.randint(0, 900)) for _ in range(6)]
        got = board.free_slots(placed, 4)
        for gx, gy in got:
            sx = board.x_pt(gx)
            assert sx in board.COLUMNS
            for p in placed:
                assert not (p.x_pt < sx + 140 and sx < p.x_pt + 140
                            and p.y_pt < gy + 140 and gy < p.y_pt + 140)
        assert len(set(got)) == 4


def test_reading_order_bands_then_left_to_right():
    rows = [("a", 196 / 360, 20.0), ("b", 24 / 360, 30.0), ("c", None, None),
            ("d", 100 / 360, 200.0), ("e", 0.0, 220.0), ("f", 24 / 360, 30.0)]
    assert board.reading_order(rows) == ["b", "f", "a", "d", "e", "c"]


def test_z_follows_the_winning_stamp_and_snap_is_the_grid():
    t = datetime(2026, 11, 12, 5, 0, tzinfo=UTC)
    assert board.z_of(t + timedelta(milliseconds=5)) - board.z_of(t) == 5
    assert board.z_of(t) < 2**53
    assert [board.snap(v) for v in (0, 3, 4, 70, 94, 166)] == [0, 0, 8, 72, 96, 168]


def test_place_body_one_or_many():
    one = ItemPlaceIn.model_validate({"client_id": str(uuid.uuid4()),
                                      "item_id": str(uuid.uuid4()), "x": 0.1, "y": 2})
    assert len(one.all_places()) == 1
    a, b = str(uuid.uuid4()), str(uuid.uuid4())
    many = ItemPlaceIn.model_validate({"client_id": str(uuid.uuid4()), "places": [
        {"item_id": a, "x": 0, "y": 0}, {"item_id": b, "x": 0.5, "y": 16}]})
    assert [str(p[0]) for p in many.all_places()] == [a, b]
    for bad in ({"item_id": a, "x": 0.1}, {"places": []},
                {"places": [{"item_id": a, "x": 0, "y": 0}], "item_id": a},
                {"places": [{"item_id": a, "x": 0, "y": 0}, {"item_id": a, "x": 1, "y": 1}]}):
        with pytest.raises(ValidationError):
            ItemPlaceIn.model_validate({"client_id": str(uuid.uuid4()), **bad})


def test_last_writer_wins_is_order_free_for_absolute_places():
    """The oracle the DB property test checks against: per sticker, max stamp wins."""
    rng = random.Random(3)
    t0 = datetime(2026, 11, 12, tzinfo=UTC)
    ops = [(rng.choice("ab"), order.Stamp(t0 + timedelta(milliseconds=rng.randint(0, 5)),
                                          str(uuid.uuid4())), rng.randint(0, 220))
           for _ in range(12)]  # fmt: skip
    results = set()
    for _ in range(20):
        rng.shuffle(ops)
        state: dict[str, tuple] = {}
        for key, stamp, x in ops:
            cur = state.get(key)
            if order.wins(stamp, cur[0] if cur else None):
                state[key] = (stamp, x)
        results.add(tuple(sorted(state.items())))
    assert len(results) == 1
