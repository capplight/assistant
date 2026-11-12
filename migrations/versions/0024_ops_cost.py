"""Week 17: chat cost dashboards and alerts (spec 3-engineering 5.3, 5.4, 5.10 rule 9, 8, 12).

- `ops_alerts`: one row per alert occurrence key (`dedup_key` unique), so the same alert is
  stored and sent once; `hits` / `last_at` count repeats. Numbers only, never content.
  `user_id` (nullable) cascades with the account.
- `ix_provider_usage_task_created`: the cost report and alert checks read `provider_usage` by
  task and time (chat steps per day).

Frozen SQL, no create_all.

Revision ID: 0024
Revises: 0023
"""

from alembic import op

revision = "0024"
down_revision = "0023"
branch_labels = None
depends_on = None

KINDS = ("'fallback_in_use', 'family_daily', 'chat_steps', 'chat_step_cost', 'provider_off', "
         "'chat_median'")  # fmt: skip

UPGRADE = [
    f"""
    CREATE TABLE ops_alerts (
        id BIGSERIAL PRIMARY KEY,
        kind TEXT NOT NULL,
        dedup_key TEXT NOT NULL,
        user_id BIGINT REFERENCES users (id) ON DELETE CASCADE,
        details JSONB DEFAULT '{{}}'::jsonb NOT NULL,
        hits INTEGER DEFAULT 1 NOT NULL,
        first_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
        last_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
        sent_at TIMESTAMP WITH TIME ZONE,
        CONSTRAINT uq_ops_alerts_dedup_key UNIQUE (dedup_key),
        CONSTRAINT ck_ops_alerts_kind CHECK (kind IN ({KINDS})),
        CONSTRAINT ck_ops_alerts_hits CHECK (hits >= 1)
    )
    """,
    "CREATE INDEX ix_ops_alerts_unsent ON ops_alerts (first_at) WHERE sent_at IS NULL",
    "CREATE INDEX ix_ops_alerts_user ON ops_alerts (user_id) WHERE user_id IS NOT NULL",
    "CREATE INDEX ix_provider_usage_task_created ON provider_usage (task, created_at)",
]


def upgrade() -> None:
    for stmt in UPGRADE:
        op.execute(stmt)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_provider_usage_task_created")
    op.execute("DROP TABLE IF EXISTS ops_alerts")
