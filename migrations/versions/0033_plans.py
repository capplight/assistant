"""«Составь план» (step 8, docs/api/plans.md): `items.kind` may be 'plan'.

A plan is a record the assistant made (`ai_generated`, source `system`): its structure (days and
points of a trip, or steps of an action plan, with the records it was made from) lives in
`items.source_meta -> 'plan'`, its readable text in `items.text` (search, export). Tasks made from
its steps point back with `tasks.source_item_id`. Nothing else changes in the schema.

Downgrade keeps the plans as plain notes (`note`): nothing is lost.

Frozen SQL, no create_all.

Revision ID: 0033
Revises: 0032
"""

from alembic import op

revision = "0033"
down_revision = "0032"
branch_labels = None
depends_on = None

# 0031: KINDS (+ ai_chat)
_KINDS = ("'note', 'voice', 'image', 'screenshot', 'pdf', 'docx', 'xlsx', 'link', 'email', "
          "'tg_message', 'kp', 'file_other', 'text', 'photo', 'video', 'document', 'ai_chat'")


def _check(kinds: str) -> list[str]:
    return ["ALTER TABLE items DROP CONSTRAINT ck_items_kind",
            f"ALTER TABLE items ADD CONSTRAINT ck_items_kind CHECK (kind IN ({kinds}))"]


UPGRADE = _check(_KINDS + ", 'plan'")
DOWNGRADE = ["UPDATE items SET kind = 'note' WHERE kind = 'plan'", *_check(_KINDS)]


def upgrade() -> None:
    for sql in UPGRADE:
        op.execute(sql)


def downgrade() -> None:
    for sql in DOWNGRADE:
        op.execute(sql)
