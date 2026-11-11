"""First launch, data export and account deletion (week 16; spec 3-engineering 3.1, 3.7, 3.11,
4.9, 6.14, 7.2; contracts docs/api/onboarding.md, docs/api/account.md).

- `users.onboarding_path` (`gallery | blank | phrase_first | skipped`), `onboarding_done_at`,
  `welcome_seen_at` (spec 3.11).
- `screens.created_by` += `onboarding_skipped` (S35 «Пропустить» / nothing chosen: the default
  set, US-33).
- `account_deletions` (spec 3.7): one request to delete an account and what came of it. No
  foreign key to `users`: the row outlives the account as proof of deletion, with `user_id`
  cleared by the purge (`report` holds counts only). `restore_hash` / `restore_expires_at`: the
  short-lived token a sign-in during the grace days gets for «Восстановить».
- `data_exports` (F-26): one «Скачать мои данные» archive; the ZIP lives in object storage under
  the person's prefix for 24 h.

Frozen SQL, no create_all.

Revision ID: 0022
Revises: 0021
"""

from alembic import op

revision = "0022"
down_revision = "0021"
branch_labels = None
depends_on = None

_CREATED_BY_OLD = ("'system', 'onboarding_gallery', 'onboarding_blank', 'onboarding_phrase', "
                   "'user', 'agent'")  # fmt: skip
_CREATED_BY_NEW = _CREATED_BY_OLD + ", 'onboarding_skipped'"

# One statement per execute(): asyncpg prepares each one and rejects batches.
UPGRADE = [
    "ALTER TABLE users ADD COLUMN onboarding_path TEXT",
    "ALTER TABLE users ADD COLUMN onboarding_done_at TIMESTAMPTZ",
    "ALTER TABLE users ADD COLUMN welcome_seen_at TIMESTAMPTZ",
    """
ALTER TABLE users ADD CONSTRAINT ck_users_onboarding_path CHECK (
	onboarding_path IS NULL OR onboarding_path IN ('gallery', 'blank', 'phrase_first', 'skipped'))
""",
    "ALTER TABLE screens DROP CONSTRAINT ck_screens_created_by",
    f"ALTER TABLE screens ADD CONSTRAINT ck_screens_created_by CHECK (created_by IN ({_CREATED_BY_NEW}))",
    """
CREATE TABLE account_deletions (
	id BIGSERIAL PRIMARY KEY,
	public_id UUID DEFAULT gen_random_uuid() NOT NULL,
	user_id BIGINT,
	via TEXT NOT NULL,
	requested_at TIMESTAMPTZ DEFAULT now() NOT NULL,
	cancel_until TIMESTAMPTZ NOT NULL,
	cancelled_at TIMESTAMPTZ,
	executed_at TIMESTAMPTZ,
	report JSONB DEFAULT '{}'::jsonb NOT NULL,
	restore_hash TEXT,
	restore_expires_at TIMESTAMPTZ,
	CONSTRAINT uq_account_deletions_public_id UNIQUE (public_id),
	CONSTRAINT ck_account_deletions_via CHECK (via IN ('app', 'web')),
	CONSTRAINT ck_account_deletions_report CHECK (jsonb_typeof(report) = 'object')
)
""",
    "CREATE INDEX ix_account_deletions_user ON account_deletions (user_id) WHERE user_id IS NOT NULL",
    """
CREATE UNIQUE INDEX uq_account_deletions_restore ON account_deletions (restore_hash)
	WHERE restore_hash IS NOT NULL
""",
    """
CREATE TABLE data_exports (
	id BIGSERIAL PRIMARY KEY,
	public_id UUID DEFAULT gen_random_uuid() NOT NULL,
	client_id UUID,
	user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	status TEXT DEFAULT 'queued' NOT NULL,
	storage_key TEXT,
	bytes BIGINT,
	counts JSONB DEFAULT '{}'::jsonb NOT NULL,
	error TEXT,
	requested_at TIMESTAMPTZ DEFAULT now() NOT NULL,
	ready_at TIMESTAMPTZ,
	expires_at TIMESTAMPTZ,
	CONSTRAINT uq_data_exports_public_id UNIQUE (public_id),
	CONSTRAINT uq_data_exports_user_client UNIQUE (user_id, client_id),
	CONSTRAINT ck_data_exports_status CHECK (
		status IN ('queued', 'running', 'ready', 'failed', 'expired')),
	CONSTRAINT ck_data_exports_counts CHECK (jsonb_typeof(counts) = 'object')
)
""",
    "CREATE INDEX ix_data_exports_user ON data_exports (user_id, id)",
    "CREATE INDEX ix_data_exports_expiry ON data_exports (expires_at) WHERE status = 'ready'",
]

DOWNGRADE = [
    "DELETE FROM jobs WHERE kind IN ('account:purge', 'account:export')",
    "DROP TABLE IF EXISTS data_exports",
    "DROP TABLE IF EXISTS account_deletions",
    "UPDATE screens SET created_by = 'onboarding_phrase' WHERE created_by = 'onboarding_skipped'",
    "ALTER TABLE screens DROP CONSTRAINT ck_screens_created_by",
    f"ALTER TABLE screens ADD CONSTRAINT ck_screens_created_by CHECK (created_by IN ({_CREATED_BY_OLD}))",
    "ALTER TABLE users DROP CONSTRAINT IF EXISTS ck_users_onboarding_path",
    "ALTER TABLE users DROP COLUMN IF EXISTS welcome_seen_at",
    "ALTER TABLE users DROP COLUMN IF EXISTS onboarding_done_at",
    "ALTER TABLE users DROP COLUMN IF EXISTS onboarding_path",
]


def upgrade() -> None:
    for sql in UPGRADE:
        op.execute(sql)


def downgrade() -> None:
    for sql in DOWNGRADE:
        op.execute(sql)
