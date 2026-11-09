"""Tool screens of «Заметки», «Дела», «Покупки» become the default (week 11а; proposal
template-screens §2.1, §2.3, §2.4, §4, §6).

No new columns: colours, «приколоть», piles, the rows/board switch, group order and the planner
all live in what weeks 9–11 already made (`screen_items.appearance`, `pinned`, `group_key`,
`screens.view_state`, `tasks`, `reminders`). This migration only adds catalogue versions whose
default layout is the template's own tool:

- notes v4: `builtin:notes_board` (sticker wall; «Ряды» by default, `view_state.board` = «Доска»);
- tasks v3: `builtin:planner` (the day planner);
- shopping v3: `builtin:shopping` (the fridge list with «Я в магазине»).

The old layouts (`stacks`, `builtin:tasks`, `checklist`) stay allowed, and `list` («Простой
список», Ф-30) stays on all three. Pages follow the new versions. A page whose layout is the old
default and was not set by the person (`view_state.set_by.layout` is not `user`) takes the new
default; a layout the person chose by hand stays theirs (R-54, proposal 2.8).

Frozen SQL, no create_all.

Revision ID: 0017
Revises: 0016
"""

import json

from alembic import op

revision = "0017"
down_revision = "0016"
branch_labels = None
depends_on = None

# key -> (version now, old default layout, new default layout, layouts of the new version)
BUMPS = {
    "notes": (3, "stacks", "builtin:notes_board", ["builtin:notes_board", "list", "stacks"]),
    "tasks": (2, "builtin:tasks", "builtin:planner", ["builtin:planner", "builtin:tasks", "list"]),
    "shopping": (2, "checklist", "builtin:shopping", ["builtin:shopping", "checklist", "list"]),
}

_NOT_BY_USER = "coalesce(view_state -> 'set_by' ->> 'layout', '') <> 'user'"


def _up(key: str, old: int, old_default: str, new_default: str, layouts: list[str]) -> list[str]:
    new = old + 1
    return [
        f"""
INSERT INTO screen_templates (key, version, owner, status, catalog_visible, catalog_order, title,
    description, default_title, icon, preview_ref, singleton, facet, fields, layouts,
    default_layout, default_view, aggregates, auto_rule, ai_hints_ref, min_app_version,
    migrate_from)
SELECT key, {new}, owner, status, catalog_visible, catalog_order, title, description,
    default_title, icon, preview_ref, singleton, facet, fields, CAST('{json.dumps(layouts)}' AS JSONB),
    '{new_default}', default_view, aggregates, auto_rule, ai_hints_ref, min_app_version, {old}
FROM screen_templates WHERE key = '{key}' AND version = {old}
""",
        f"UPDATE screens SET layout = '{new_default}' "
        f"WHERE template_key = '{key}' AND template_version = {old} "
        f"AND layout = '{old_default}' AND {_NOT_BY_USER}",
        f"UPDATE screens SET template_version = {new} "
        f"WHERE template_key = '{key}' AND template_version = {old}",
    ]


def _down(key: str, old: int, old_default: str, new_default: str) -> list[str]:
    new = old + 1
    return [
        f"UPDATE screens SET layout = '{old_default}' "
        f"WHERE template_key = '{key}' AND template_version = {new} "
        f"AND layout = '{new_default}' AND {_NOT_BY_USER}",
        f"UPDATE screens SET template_version = {old} "
        f"WHERE template_key = '{key}' AND template_version = {new}",
        f"DELETE FROM screen_templates WHERE key = '{key}' AND version = {new}",
    ]


def upgrade() -> None:
    for key, (old, old_default, new_default, layouts) in BUMPS.items():
        for stmt in _up(key, old, old_default, new_default, layouts):
            op.execute(stmt)


def downgrade() -> None:
    for key, (old, old_default, new_default, _layouts) in BUMPS.items():
        for stmt in _down(key, old, old_default, new_default):
            op.execute(stmt)
