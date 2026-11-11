"""Lump-sum lines never reach «Мой прайс» (founder 2026-11-11)."""

from assistant.api.routes.documents import _offers


async def test_lump_line_is_never_offered_to_price_list() -> None:
    old = {"items": [{"id": "i1", "kind": "lump", "unit_price": None}]}
    new = {"items": [{"id": "i1", "kind": "lump", "name": "Монтаж систем",
                      "unit_price": "30100000.00", "price_source": "manual"}]}  # fmt: skip
    # No DB needed: a lump line is skipped before any price-list lookup.
    assert await _offers(None, 1, old, new) == []  # type: ignore[arg-type]
