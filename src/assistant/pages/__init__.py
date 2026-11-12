"""Pages: template catalogue, placement by `auto_rule`, LexoRank order (spec 3.10).

Public surface for other modules:
- `place_item(session, item)`: call after anything new is known about an item (created, text ready,
  envelope written). Adds it to the pages whose rule matches; never moves an existing row.
- `rescue_moved(session, page)`: call when a page is removed: records moved onto it by hand go
  back to where they came from.
- `timed_items(session, page)`: rows of «Дела» that have a time (ordered by it, not moved).
- `board_on(page)`, `fill_board(session, page)`: the free board of «Заметки» (weeks 16а–16б):
  stickers without a place get the first free grid slot (`board` holds the pure rules).
- `lexorank`, `rules`, `order`, `board`: pure code, no DB. `habits`: learned placement
  (`placement_rule`).
The API is in `assistant.api.routes.pages`.
"""

from assistant.pages import board, habits, lexorank, order, rules
from assistant.pages.service import (
    add_link,
    board_on,
    create_page,
    fill_board,
    fill_page,
    latest_template,
    latest_templates,
    lock_user,
    mark_rekeyed,
    place_item,
    rebalance_page,
    rescue_moved,
    timed_items,
)

__all__ = ["add_link", "board", "board_on", "create_page", "fill_board", "fill_page", "habits",
           "latest_template", "latest_templates", "lexorank", "lock_user", "mark_rekeyed", "order",
           "place_item", "rebalance_page", "rescue_moved", "rules", "timed_items"]  # fmt: skip
