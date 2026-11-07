"""«Что я сделал» and «Отменить» (spec 3.7, R-31, R-33).

Public surface:
- `engine.apply(session, user_id, ops, by=, check=, now=)`: run white-listed ops, get their undo.
- `record`, `extend`: write an action / add to the turn's action; `undo`: run its inverse (whole
  or for some items), idempotent; `actions_dicts`: the JSON of docs/api/actions.md.
- `manual`: the person's own moves (week 7): `move_row`, `move_to_page`, `remove_row`,
  `move_tab`, `turn_off_rule`; offline conflicts by last-writer-wins on the row.
Week 6 writes the kinds the assistant line needs; week 9 adds the rest on the same engine.
"""

from assistant.actions import engine, manual
from assistant.actions.service import (
    TEXT_PARTIAL,
    ActionNotFound,
    UndoExpired,
    UndoResult,
    actions_dicts,
    extend,
    is_undoable,
    record,
    undo,
)

__all__ = ["TEXT_PARTIAL", "ActionNotFound", "UndoExpired", "UndoResult", "actions_dicts",
           "engine", "extend", "is_undoable", "manual", "record", "undo"]  # fmt: skip
