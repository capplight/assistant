"""Pages: template catalogue, placement by `auto_rule`, LexoRank order (spec 3.10).

Public surface for other modules:
- `place_item(session, item)`: call after anything new is known about an item (created, text ready,
  envelope written). Adds it to the pages whose rule matches; never moves an existing row.
- `lexorank`, `rules`: pure code, no DB.
The API is in `assistant.api.routes.pages`.
"""

from assistant.pages import lexorank, rules
from assistant.pages.service import (
    add_link,
    create_page,
    fill_page,
    latest_template,
    latest_templates,
    lock_user,
    place_item,
    rebalance_page,
)

__all__ = ["add_link", "create_page", "fill_page", "latest_template", "latest_templates",
           "lexorank", "lock_user", "place_item", "rebalance_page", "rules"]  # fmt: skip
