"""Simplified scope (Ф-33...Ф-44) and per-person message limits (week 18-19).

- `consents.screen` may be `welcome`: the consents are given by «Начать» on the welcome screen
  with the privacy-policy line (Ф-34); no separate S05 screen. Texts, versions and hashes are
  recorded exactly as before.
- `users.pages_first_use`: template keys of the pages the server made on first use
  («Покупки» on the first thing to buy, «Расходы» on the first expense, «Документы и КП» on the
  first КП; Ф-35, Ф-36). Each key is made once: a page the person removed is not made again.
- `ix_conversation_messages_user_sent`: the message rate limit counts the phrases a person sent
  in the last minute / today.

Frozen SQL, no create_all.

Revision ID: 0025
Revises: 0024
"""

from alembic import op

revision = "0025"
down_revision = "0024"
branch_labels = None
depends_on = None

UPGRADE = [
    "ALTER TABLE consents DROP CONSTRAINT ck_consents_screen",
    """
    ALTER TABLE consents ADD CONSTRAINT ck_consents_screen
        CHECK (screen IN ('S05', 'settings', 'import', 'legacy_bot', 'welcome'))
    """,
    "ALTER TABLE users ADD COLUMN pages_first_use TEXT[] DEFAULT '{}' NOT NULL",
    """
    CREATE INDEX ix_conversation_messages_user_sent ON conversation_messages (user_id, created_at)
        WHERE role = 'user'
    """,
]


def upgrade() -> None:
    for stmt in UPGRADE:
        op.execute(stmt)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_conversation_messages_user_sent")
    op.execute("ALTER TABLE users DROP COLUMN IF EXISTS pages_first_use")
    op.execute("ALTER TABLE consents DROP CONSTRAINT ck_consents_screen")
    # the old check has no `welcome`: those grants were shown the same texts in place of S05
    op.execute("UPDATE consents SET screen = 'S05' WHERE screen = 'welcome'")
    op.execute("""
        ALTER TABLE consents ADD CONSTRAINT ck_consents_screen
            CHECK (screen IN ('S05', 'settings', 'import', 'legacy_bot'))
    """)
