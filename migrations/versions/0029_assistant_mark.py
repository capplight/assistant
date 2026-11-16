"""«Изменил помощник» on a record for 24 hours (Ф-73, step 3 of vision-2026-11-review §5.4).

`items.assistant_changed_at`: when the assistant last created or changed the record (its task or
expense rides on the record); `items.assistant_action_id`: the public id of that action (tap on
the mark → «Что изменилось» / «Отменить»). Cleared when the person edits the record or undoes
the action; shown for 24 hours (the API hides older marks). No backfill: old changes get no mark.
`seq` moves with every update (`items_sync_seq` trigger), so /v1/sync carries the mark.

Frozen SQL, no create_all.

Revision ID: 0029
Revises: 0028
"""

from alembic import op

revision = "0029"
down_revision = "0028"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("ALTER TABLE items ADD COLUMN assistant_changed_at timestamptz")
    op.execute("ALTER TABLE items ADD COLUMN assistant_action_id uuid")


def downgrade() -> None:
    op.execute("ALTER TABLE items DROP COLUMN assistant_action_id")
    op.execute("ALTER TABLE items DROP COLUMN assistant_changed_at")
