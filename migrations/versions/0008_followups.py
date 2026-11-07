"""Sprint 3 follow-ups: no schema changes.

Everything in this round fits the existing schema: a person's correction lives in
items.review_fields (JSONB), the name in users.display_name, and a re-added singleton page revives
its old `screens` row. The revision stays so that 0009 has a stable parent.
"""

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
