"""Manual order, pure parts (week 7): last-writer-wins between two phones, where a moved row goes,
what a placement rule learns from, request validation. No DB."""

import random
import uuid
from datetime import UTC, datetime, timedelta, timezone

import pytest
from pydantic import ValidationError

from assistant.actions import engine
from assistant.api.schemas import ItemMoveIn, MoveToPageIn, PageReorderIn
from assistant.pages import habits, lexorank, order

T0 = datetime(2026, 11, 8, 10, 0, tzinfo=UTC)
NOW = T0 + timedelta(hours=1)


def _cid(n: int) -> uuid.UUID:
    return uuid.UUID(int=n)


def test_later_client_ts_wins_ties_by_client_id():
    early = order.Stamp.of(T0, _cid(9), NOW)
    late = order.Stamp.of(T0 + timedelta(seconds=1), _cid(1), NOW)
    assert order.wins(late, early) and not order.wins(early, late)
    a, b = order.Stamp.of(T0, _cid(1), NOW), order.Stamp.of(T0, _cid(2), NOW)
    assert order.wins(b, a) and not order.wins(a, b)
    assert not order.wins(a, a)  # a repeat is not newer than itself
    assert order.wins(a, None)


def test_time_zones_compare_as_instants_and_the_future_counts_as_now():
    almaty = datetime(2026, 11, 8, 15, 0, tzinfo=timezone(timedelta(hours=5)))
    assert order.Stamp.of(almaty, _cid(1), NOW) == order.Stamp.of(T0, _cid(1), NOW)
    ahead = order.Stamp.of(NOW + timedelta(days=365), _cid(1), NOW)
    assert ahead.ts == NOW  # a phone clock a year ahead does not win every later move


def test_winner_does_not_depend_on_arrival_order():
    rng = random.Random(7)
    for _ in range(200):
        stamps = [order.Stamp.of(T0 + timedelta(seconds=rng.randint(0, 5)), _cid(rng.randint(1, 4)),
                                 NOW) for _ in range(rng.randint(1, 8))]  # fmt: skip
        results = set()
        for _ in range(5):
            rng.shuffle(stamps)
            cur = None
            for s in stamps:
                if order.wins(s, cur):
                    cur = s
            results.add(cur)
        assert results == {max(stamps)}


def test_trusted_keys():
    assert order.trusted("V") and order.trusted("0V")
    assert not order.trusted(None) and not order.trusted("") and not order.trusted("V0")
    assert not order.trusted("V-") and not order.trusted("V" * 65) and order.trusted("V" * 64)


def test_slot_right_after_or_before_the_anchor():
    keys = ["1", "5", "9"]
    assert "5" < order.slot(keys, after="5", before=None) < "9"
    assert "1" < order.slot(keys, after=None, before="5") < "5"
    assert order.slot(keys, after="9", before=None) > "9"  # the bottom
    assert order.slot(keys, after=None, before="1") < "1"  # the top
    with pytest.raises(ValueError):
        order.slot(keys, after=None, before=None)


def test_slot_asks_for_a_rekey_on_shared_keys_and_long_keys():
    with pytest.raises(order.NeedRekey):
        order.slot(["1", "5", "5", "9"], after="5", before=None)
    with pytest.raises(order.NeedRekey):
        order.slot(["1", "5", "5", "9"], after=None, before="5")
    deep = "1" + "0" * 63 + "1"
    with pytest.raises(order.NeedRekey):
        order.slot(["1", deep], after="1", before=None)


def test_random_slots_keep_strict_order():
    rng = random.Random(3)
    keys = lexorank.sequence(5)
    for _ in range(300):
        i = rng.randrange(len(keys))
        try:
            k = order.slot(keys, after=keys[i], before=None)
        except order.NeedRekey:
            keys = lexorank.sequence(len(keys))
            continue
        assert keys[i] < k and (i + 1 == len(keys) or k < keys[i + 1])
        keys = sorted([*keys, k])


def test_what_a_placement_rule_learns_from():
    assert habits.kind_of({"type": "receipt"}) == "receipt"
    assert habits.kind_of({"type": "document"}) == "document"
    for plain in ({"type": "note"}, {"type": "idea"}, {"type": "other"}, {}, None, {"type": 3}):
        assert habits.kind_of(plain) is None


def test_engine_knows_the_new_ops_and_ties_habit_undo_to_the_record():
    engine.validate([{"op": "restore_page_position", "page": str(_cid(1)), "position": "V"},
                     {"op": "restore_habit", "id": str(_cid(2)),
                      "state": {"evidence_count": 0, "status": "candidate", "value": {}}}])
    op = {"op": "habit_evidence", "id": str(_cid(2)), "item": str(_cid(3)), "add": False}
    assert engine.op_items(op) == {str(_cid(3))}
    assert engine.select_ops([op], only={str(_cid(3))}, without=set()) == [op]


def test_move_requests_are_checked():
    item, other = _cid(1), _cid(2)
    with pytest.raises(ValidationError):
        ItemMoveIn(client_id=_cid(9), item_id=item)  # no neighbour
    with pytest.raises(ValidationError):
        ItemMoveIn(client_id=_cid(9), item_id=item, after_item_id=item)
    with pytest.raises(ValidationError):
        ItemMoveIn(client_id=_cid(9), item_id=item, after_item_id=other,
                   client_ts=datetime(2026, 11, 8, 10, 0))  # a time without an offset  # fmt: skip
    ok = ItemMoveIn(client_id=_cid(9), item_id=item, before_item_id=other)
    assert "group_key" not in ok.model_fields_set  # absent = keep the group
    assert "group_key" in ItemMoveIn(client_id=_cid(9), item_id=item, before_item_id=other,
                                     group_key=None).model_fields_set  # fmt: skip
    with pytest.raises(ValidationError):
        MoveToPageIn(client_id=_cid(9), mode="move", to_page_ids=[other])  # no from_page_id
    with pytest.raises(ValidationError):
        MoveToPageIn(client_id=_cid(9), mode="move", from_page_id=other, to_page_ids=[other])
    with pytest.raises(ValidationError):
        MoveToPageIn(client_id=_cid(9), mode="move", from_page_id=item,
                     to_page_ids=[other, _cid(3)])  # fmt: skip
    MoveToPageIn(client_id=_cid(9), mode="also_show", to_page_ids=[other, _cid(3)])
    with pytest.raises(ValidationError):
        PageReorderIn(client_id=_cid(9), page_id=item)
