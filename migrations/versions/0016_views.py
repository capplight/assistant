"""Page views (week 11, proposal template-screens §2.8, §4; R-51 extended, Ф-28, Ф-30, Ф-31).

- `screen_items.appearance jsonb` ({color, color_set_by, pinned_set_by}): a sticker's colour on
  this page and who set it (R-54: what the person set is theirs). Colours are the six names of the
  `color.note.*` tokens.
- `screen_items.board_x / board_y / board_z / board_manual`: the sticker's place on the free board
  (Ф-28). The board UI is weeks 16а–16б; the columns land now so the view schema is one piece.
  `board_x` is a share of the width (0..1), `board_y` pt at the 360 pt reference width.
- `screen_items.done_at`: the tick of a row in a checklist view («Своя страница» and every page
  shown as `checklist`); synced with the row, so every phone sees it. «Дела» / «Покупки» keep
  their ticks on `tasks.done_at`.
- `item_facets`: values of a page's own fields (≤5 per page, `screens.custom_fields`), one row per
  (page, record). Removing a field never deletes its values (they come back with «Отменить»).
  Synced (`sync_seq_bump`); no hard delete in the app path (the item purge cascades and leaves
  the item tombstone).
- Layouts: + `builtin:notes_board` (notes: rows / board), `builtin:planner` (tasks),
  `builtin:shopping` (shopping). New catalogue versions allow `list` («Простой список», Ф-30) on
  every template and the new tool layouts; pages follow the new versions (they keep their layout).
- `screens.view_state.set_by` and `field_prefs[].set_by` are inside existing JSONB: no column.

Frozen SQL, no create_all.

Revision ID: 0016
Revises: 0015
"""

import json

from alembic import op

revision = "0016"
down_revision = "0015"
branch_labels = None
depends_on = None

_OLD = ("'list', 'checklist', 'table', 'stacks', 'builtin:today', 'builtin:tasks', "
        "'builtin:kp', 'builtin:expenses'")  # fmt: skip
_NEW = _OLD + ", 'builtin:notes_board', 'builtin:planner', 'builtin:shopping'"
_COLORS = "'yellow', 'pink', 'green', 'blue', 'peach', 'white'"

# key -> (version now, layouts of the new version)
BUMPS = {
    "notes": (2, ["stacks", "list", "builtin:notes_board"]),
    "tasks": (1, ["builtin:tasks", "builtin:planner", "list"]),
    "shopping": (1, ["checklist", "list", "builtin:shopping"]),
    "expenses": (1, ["builtin:expenses", "list"]),
}


def _bump_up(key: str, old: int, layouts: list[str]) -> list[str]:
    new = old + 1
    return [
        f"""
INSERT INTO screen_templates (key, version, owner, status, catalog_visible, catalog_order, title,
    description, default_title, icon, preview_ref, singleton, facet, fields, layouts,
    default_layout, default_view, aggregates, auto_rule, ai_hints_ref, min_app_version,
    migrate_from)
SELECT key, {new}, owner, status, catalog_visible, catalog_order, title, description,
    default_title, icon, preview_ref, singleton, facet, fields, CAST('{json.dumps(layouts)}' AS JSONB),
    default_layout, default_view, aggregates, auto_rule, ai_hints_ref, min_app_version, {old}
FROM screen_templates WHERE key = '{key}' AND version = {old}
""",
        f"UPDATE screens SET template_version = {new} "
        f"WHERE template_key = '{key}' AND template_version = {old}",
    ]


def _bump_down(key: str, old: int) -> list[str]:
    new = old + 1
    return [
        f"UPDATE screens SET layout = t.default_layout FROM screen_templates t "
        f"WHERE screens.template_key = '{key}' AND screens.template_version = {new} "
        f"AND t.key = '{key}' AND t.version = {old} "
        f"AND NOT (t.layouts ? screens.layout)",
        f"UPDATE screens SET template_version = {old} "
        f"WHERE template_key = '{key}' AND template_version = {new}",
        f"DELETE FROM screen_templates WHERE key = '{key}' AND version = {new}",
    ]


UP = [
    "ALTER TABLE screen_items ADD COLUMN appearance JSONB DEFAULT '{}' NOT NULL",
    "ALTER TABLE screen_items ADD COLUMN board_x REAL",
    "ALTER TABLE screen_items ADD COLUMN board_y REAL",
    "ALTER TABLE screen_items ADD COLUMN board_z INTEGER",
    "ALTER TABLE screen_items ADD COLUMN board_manual BOOLEAN DEFAULT false NOT NULL",
    "ALTER TABLE screen_items ADD COLUMN done_at TIMESTAMP WITH TIME ZONE",
    f"""
ALTER TABLE screen_items ADD CONSTRAINT ck_screen_items_appearance CHECK (
    jsonb_typeof(appearance) = 'object'
    AND (appearance ->> 'color' IS NULL OR appearance ->> 'color' IN ({_COLORS})))
""",
    """
ALTER TABLE screen_items ADD CONSTRAINT ck_screen_items_board CHECK (
    (board_x IS NULL OR (board_x >= 0 AND board_x <= 1)) AND (board_y IS NULL OR board_y >= 0))
""",
    """
CREATE TABLE item_facets (
	id BIGSERIAL NOT NULL,
	public_id UUID DEFAULT gen_random_uuid() NOT NULL,
	user_id BIGINT NOT NULL,
	item_id BIGINT NOT NULL,
	screen_id BIGINT NOT NULL,
	data JSONB DEFAULT '{}' NOT NULL,
	review_fields JSONB DEFAULT '[]' NOT NULL,
	updated_by TEXT DEFAULT 'user' NOT NULL,
	seq BIGINT NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	PRIMARY KEY (id),
	CONSTRAINT uq_item_facets_public_id UNIQUE (public_id),
	CONSTRAINT uq_item_facets_screen_item UNIQUE (screen_id, item_id),
	CONSTRAINT fk_item_facets_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
	CONSTRAINT fk_item_facets_item FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE CASCADE,
	CONSTRAINT fk_item_facets_screen FOREIGN KEY (screen_id) REFERENCES screens (id)
		ON DELETE CASCADE,
	CONSTRAINT ck_item_facets_data CHECK (jsonb_typeof(data) = 'object'),
	CONSTRAINT ck_item_facets_review CHECK (jsonb_typeof(review_fields) = 'array'),
	CONSTRAINT ck_item_facets_updated_by CHECK (updated_by IN ('user', 'agent'))
)
""",
    "CREATE INDEX ix_item_facets_user_seq ON item_facets (user_id, seq)",
    "CREATE INDEX ix_item_facets_item ON item_facets (item_id)",
    """
CREATE TRIGGER item_facets_sync_seq BEFORE INSERT OR UPDATE ON item_facets
FOR EACH ROW EXECUTE FUNCTION sync_seq_bump()
""",
    "ALTER TABLE screens DROP CONSTRAINT ck_screens_layout",
    f"ALTER TABLE screens ADD CONSTRAINT ck_screens_layout CHECK (layout IN ({_NEW}))",
    "ALTER TABLE screen_templates DROP CONSTRAINT ck_screen_templates_default_layout",
    "ALTER TABLE screen_templates ADD CONSTRAINT ck_screen_templates_default_layout "
    f"CHECK (default_layout IN ({_NEW}))",
]
for _key, (_old, _layouts) in BUMPS.items():
    UP += _bump_up(_key, _old, _layouts)

DOWN: list[str] = []
for _key, (_old, _layouts) in BUMPS.items():
    DOWN += _bump_down(_key, _old)
DOWN += [
    "UPDATE screens SET layout = 'stacks' WHERE layout = 'builtin:notes_board'",
    "UPDATE screens SET layout = 'builtin:tasks' WHERE layout = 'builtin:planner'",
    "UPDATE screens SET layout = 'checklist' WHERE layout = 'builtin:shopping'",
    "ALTER TABLE screen_templates DROP CONSTRAINT ck_screen_templates_default_layout",
    "ALTER TABLE screen_templates ADD CONSTRAINT ck_screen_templates_default_layout "
    f"CHECK (default_layout IN ({_OLD}))",
    "ALTER TABLE screens DROP CONSTRAINT ck_screens_layout",
    f"ALTER TABLE screens ADD CONSTRAINT ck_screens_layout CHECK (layout IN ({_OLD}))",
    "DROP TRIGGER IF EXISTS item_facets_sync_seq ON item_facets",
    "DROP TABLE IF EXISTS item_facets",
    "ALTER TABLE screen_items DROP CONSTRAINT IF EXISTS ck_screen_items_board",
    "ALTER TABLE screen_items DROP CONSTRAINT IF EXISTS ck_screen_items_appearance",
    "ALTER TABLE screen_items DROP COLUMN IF EXISTS done_at",
    "ALTER TABLE screen_items DROP COLUMN IF EXISTS board_manual",
    "ALTER TABLE screen_items DROP COLUMN IF EXISTS board_z",
    "ALTER TABLE screen_items DROP COLUMN IF EXISTS board_y",
    "ALTER TABLE screen_items DROP COLUMN IF EXISTS board_x",
    "ALTER TABLE screen_items DROP COLUMN IF EXISTS appearance",
]


def upgrade() -> None:
    for stmt in UP:  # one statement per execute(): asyncpg rejects batches
        op.execute(stmt)


def downgrade() -> None:
    for stmt in DOWN:
        op.execute(stmt)
