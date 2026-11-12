"""Free sticky-note board (weeks 16а–16б, Ф-28, proposal template-screens §2.1, §4).

0016 added `screen_items.board_x / board_y / board_z / board_manual`. They are not enough for
two phones offline and for exact undo, so this revision:

- `board_x`, `board_y` REAL -> DOUBLE PRECISION: the server rounds a place to whole board points
  and stores `x_pt / 360`; a float4 would not give back the same number, and undo compares the
  stored place with the one it left (`expect`).
- `board_z` INTEGER -> BIGINT: the stacking order is the Unix time in ms of the winning place
  (`pages.board.z_of`), the same number on every phone whatever order the calls arrive in.
- `board_ts timestamptz`, `board_client_id uuid`: the last-writer-wins clock of the sticker's
  place on the board (`pages.order.Stamp`, as `moved_ts / moved_client_id` of week 7 for the row
  order). A separate clock: a move in «Ряды» and a place on «Доска» never cancel each other, and
  switching modes never loses either layout. Undo leaves the clock (it never goes back).
- CHECK: `board_y <= 100000` (the server clamps; contract docs/api/views.md «Доска»).

Downgrade turns `board_z` back into a small rank per page (same stacking order) before the type
goes back to INTEGER. Frozen SQL, no create_all.

Revision ID: 0023
Revises: 0022
"""

from alembic import op

revision = "0023"
down_revision = "0022"
branch_labels = None
depends_on = None

UP = [
    "ALTER TABLE screen_items ALTER COLUMN board_x TYPE DOUBLE PRECISION",
    "ALTER TABLE screen_items ALTER COLUMN board_y TYPE DOUBLE PRECISION",
    "ALTER TABLE screen_items ALTER COLUMN board_z TYPE BIGINT",
    "ALTER TABLE screen_items ADD COLUMN board_ts TIMESTAMP WITH TIME ZONE",
    "ALTER TABLE screen_items ADD COLUMN board_client_id UUID",
    "ALTER TABLE screen_items DROP CONSTRAINT ck_screen_items_board",
    """
ALTER TABLE screen_items ADD CONSTRAINT ck_screen_items_board CHECK (
    (board_x IS NULL OR (board_x >= 0 AND board_x <= 1))
    AND (board_y IS NULL OR (board_y >= 0 AND board_y <= 100000)))
""",
]

DOWN = [
    "ALTER TABLE screen_items DROP CONSTRAINT ck_screen_items_board",
    """
ALTER TABLE screen_items ADD CONSTRAINT ck_screen_items_board CHECK (
    (board_x IS NULL OR (board_x >= 0 AND board_x <= 1)) AND (board_y IS NULL OR board_y >= 0))
""",
    """
UPDATE screen_items SET board_z = r.rank FROM (
    SELECT screen_id, item_id, dense_rank() OVER (PARTITION BY screen_id ORDER BY board_z) AS rank
    FROM screen_items WHERE board_z IS NOT NULL) r
WHERE screen_items.screen_id = r.screen_id AND screen_items.item_id = r.item_id
""",
    "ALTER TABLE screen_items DROP COLUMN IF EXISTS board_client_id",
    "ALTER TABLE screen_items DROP COLUMN IF EXISTS board_ts",
    "ALTER TABLE screen_items ALTER COLUMN board_z TYPE INTEGER",
    "ALTER TABLE screen_items ALTER COLUMN board_y TYPE REAL",
    "ALTER TABLE screen_items ALTER COLUMN board_x TYPE REAL",
]


def upgrade() -> None:
    for stmt in UP:  # one statement per execute(): asyncpg rejects batches
        op.execute(stmt)


def downgrade() -> None:
    for stmt in DOWN:
        op.execute(stmt)
