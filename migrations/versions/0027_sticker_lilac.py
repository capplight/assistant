"""Sticker colour «lilac» (design v2, F-54/F-55): the 7-colour sticker palette.

Widens ck_screen_items_appearance (0016). Downgrade turns lilac stickers back to no colour
before restoring the old check. Frozen SQL, no create_all.

Revision ID: 0027
Revises: 0026
"""

from alembic import op

revision = "0027"
down_revision = "0026"
branch_labels = None
depends_on = None

_OLD = "'yellow', 'pink', 'green', 'blue', 'peach', 'white'"
_NEW = _OLD + ", 'lilac'"


def _check(colors: str) -> str:
    return f"""
ALTER TABLE screen_items ADD CONSTRAINT ck_screen_items_appearance CHECK (
    jsonb_typeof(appearance) = 'object'
    AND (appearance ->> 'color' IS NULL OR appearance ->> 'color' IN ({colors})))
"""


def upgrade() -> None:
    op.execute("ALTER TABLE screen_items DROP CONSTRAINT ck_screen_items_appearance")
    op.execute(_check(_NEW))


def downgrade() -> None:
    op.execute("UPDATE screen_items SET appearance = appearance - 'color' "
               "WHERE appearance ->> 'color' = 'lilac'")
    op.execute("ALTER TABLE screen_items DROP CONSTRAINT ck_screen_items_appearance")
    op.execute(_check(_OLD))
