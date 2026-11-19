"""Sticker colour «aqua» (бирюза, Ф-85 / QA v5-device-2 A3): the 8-colour sticker palette.

The phone shows 8 stickers (lemon, sky, rose, mint, lilac, apricot, aqua, paper); 7 of them map to
the stored keys of 0016/0027 (yellow, blue, pink, green, lilac, peach, white). `aqua` is the one
that had no stored key, so it could not be picked by hand. Widens ck_screen_items_appearance; the
old keys stay valid. Downgrade turns aqua stickers back to no colour before restoring the old
check. Frozen SQL, no create_all.

Revision ID: 0032
Revises: 0031
"""

from alembic import op

revision = "0032"
down_revision = "0031"
branch_labels = None
depends_on = None

_OLD = "'yellow', 'pink', 'green', 'blue', 'peach', 'white', 'lilac'"
_NEW = _OLD + ", 'aqua'"


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
               "WHERE appearance ->> 'color' = 'aqua'")
    op.execute("ALTER TABLE screen_items DROP CONSTRAINT ck_screen_items_appearance")
    op.execute(_check(_OLD))
