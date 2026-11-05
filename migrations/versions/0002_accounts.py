"""App accounts: users extension, auth_identities, devices, auth_sessions, otp_challenges.

Expand-only on users: existing columns and rows stay (telegram bot keeps working);
telegram_id becomes nullable so anonymous app users can exist. New enums are text + CHECK
(spec 3-engineering, 3). Frozen SQL, no create_all.

Note: spec 3.9 calls the big generalization "0002_core_generalize"; it is split here into
0002 (accounts) and 0003 (consents, uploads, files). Items/jobs generalization comes next.

Revision ID: 0002
Revises: 0001
"""
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

USERS = """
ALTER TABLE users ALTER COLUMN telegram_id DROP NOT NULL;

ALTER TABLE users
	ADD COLUMN public_id UUID DEFAULT gen_random_uuid() NOT NULL,
	ADD COLUMN display_name TEXT,
	ADD COLUMN locale TEXT DEFAULT 'ru' NOT NULL,
	ADD COLUMN country TEXT,
	ADD COLUMN age_confirmed_at TIMESTAMP WITH TIME ZONE,
	ADD COLUMN profile TEXT DEFAULT 'regular' NOT NULL,
	ADD COLUMN autonomy_mode TEXT DEFAULT 'ask' NOT NULL,
	ADD COLUMN autonomy_offer_at TIMESTAMP WITH TIME ZONE,
	ADD COLUMN plan TEXT DEFAULT 'free' NOT NULL,
	ADD COLUMN alarm_device_policy TEXT DEFAULT 'last_active' NOT NULL,
	ADD COLUMN quiet_from TIME DEFAULT '22:00' NOT NULL,
	ADD COLUMN quiet_to TIME DEFAULT '08:00' NOT NULL,
	ADD COLUMN status TEXT DEFAULT 'active' NOT NULL,
	ADD COLUMN delete_requested_at TIMESTAMP WITH TIME ZONE,
	ADD COLUMN delete_after TIMESTAMP WITH TIME ZONE,
	ADD COLUMN last_active_at TIMESTAMP WITH TIME ZONE,
	ADD CONSTRAINT uq_users_public_id UNIQUE (public_id),
	ADD CONSTRAINT ck_users_locale CHECK (locale IN ('ru', 'kk')),
	ADD CONSTRAINT ck_users_profile CHECK (profile IN ('family_beta', 'regular', 'work')),
	ADD CONSTRAINT ck_users_autonomy_mode CHECK (autonomy_mode IN ('ask', 'do_small')),
	ADD CONSTRAINT ck_users_alarm_device_policy CHECK (
		alarm_device_policy IN ('last_active', 'all')),
	ADD CONSTRAINT ck_users_status CHECK (status IN ('active', 'deletion_pending', 'deleted'));

UPDATE users SET
	display_name = first_name,
	locale = CASE WHEN language = 'kk' THEN 'kk' ELSE 'ru' END,
	autonomy_offer_at = created_at + interval '7 days',
	last_active_at = created_at;
"""

TABLES = """
CREATE TABLE auth_identities (
	id BIGSERIAL NOT NULL,
	user_id BIGINT NOT NULL,
	provider TEXT NOT NULL,
	subject_hash TEXT NOT NULL,
	subject_enc BYTEA,
	verified_at TIMESTAMP WITH TIME ZONE,
	last_used_at TIMESTAMP WITH TIME ZONE,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	PRIMARY KEY (id),
	CONSTRAINT uq_auth_identities_subject UNIQUE (provider, subject_hash),
	CONSTRAINT ck_auth_identities_provider CHECK (
		provider IN ('anon_device', 'phone', 'apple', 'google')),
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX ix_auth_identities_user_id ON auth_identities (user_id);

CREATE TABLE devices (
	id BIGSERIAL NOT NULL,
	public_id UUID NOT NULL,
	client_id UUID,
	user_id BIGINT NOT NULL,
	platform TEXT NOT NULL,
	os_version TEXT,
	manufacturer TEXT,
	model TEXT,
	app_version TEXT,
	push_provider TEXT,
	push_token TEXT,
	capabilities JSONB DEFAULT '{}' NOT NULL,
	last_active_at TIMESTAMP WITH TIME ZONE,
	last_sync_seq BIGINT DEFAULT 0 NOT NULL,
	revoked_at TIMESTAMP WITH TIME ZONE,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	PRIMARY KEY (id),
	CONSTRAINT uq_devices_public_id UNIQUE (public_id),
	CONSTRAINT uq_devices_user_client UNIQUE (user_id, client_id),
	CONSTRAINT ck_devices_platform CHECK (platform IN ('ios', 'android', 'web')),
	CONSTRAINT ck_devices_push_provider CHECK (push_provider IN ('fcm', 'apns')),
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX ix_devices_user_id ON devices (user_id);

CREATE TABLE auth_sessions (
	id BIGSERIAL NOT NULL,
	public_id UUID NOT NULL,
	user_id BIGINT NOT NULL,
	device_id BIGINT,
	refresh_hash TEXT NOT NULL,
	expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
	rotated_from BIGINT,
	revoked_at TIMESTAMP WITH TIME ZONE,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	PRIMARY KEY (id),
	CONSTRAINT uq_auth_sessions_public_id UNIQUE (public_id),
	CONSTRAINT uq_auth_sessions_refresh_hash UNIQUE (refresh_hash),
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE,
	FOREIGN KEY(device_id) REFERENCES devices (id) ON DELETE SET NULL,
	FOREIGN KEY(rotated_from) REFERENCES auth_sessions (id) ON DELETE SET NULL
);

CREATE INDEX ix_auth_sessions_user_id ON auth_sessions (user_id);

CREATE TABLE otp_challenges (
	id BIGSERIAL NOT NULL,
	public_id UUID NOT NULL,
	phone_hash TEXT NOT NULL,
	purpose TEXT NOT NULL,
	code_hash TEXT NOT NULL,
	attempts INTEGER DEFAULT 0 NOT NULL,
	expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
	consumed_at TIMESTAMP WITH TIME ZONE,
	user_id BIGINT,
	device_id BIGINT,
	ip_hash TEXT,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	PRIMARY KEY (id),
	CONSTRAINT uq_otp_challenges_public_id UNIQUE (public_id),
	CONSTRAINT ck_otp_challenges_purpose CHECK (
		purpose IN ('link', 'login', 'delete_confirm', 'web_delete')),
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE,
	FOREIGN KEY(device_id) REFERENCES devices (id) ON DELETE SET NULL
);

CREATE INDEX ix_otp_challenges_phone ON otp_challenges (phone_hash, created_at);

CREATE INDEX ix_otp_challenges_device ON otp_challenges (device_id, created_at)
"""


def _run(sql: str) -> None:
    for stmt in sql.split(";\n\n"):
        if stmt.strip():
            op.execute(stmt.strip().rstrip(";"))


def upgrade() -> None:
    _run(USERS)
    _run(TABLES)


NEW_TABLES = ["otp_challenges", "auth_sessions", "devices", "auth_identities"]
USER_COLUMNS = ["public_id", "display_name", "locale", "country", "age_confirmed_at", "profile",
                "autonomy_mode", "autonomy_offer_at", "plan", "alarm_device_policy", "quiet_from",
                "quiet_to", "status", "delete_requested_at", "delete_after", "last_active_at"]


def downgrade() -> None:
    for table in NEW_TABLES:
        op.execute(f"DROP TABLE IF EXISTS {table} CASCADE")
    # Constraints on dropped columns go with them.
    op.execute("ALTER TABLE users " + ", ".join(f"DROP COLUMN {c}" for c in USER_COLUMNS))
    # App-only users cannot exist under 0001 (telegram_id NOT NULL); they are dropped.
    op.execute("DELETE FROM users WHERE telegram_id IS NULL")
    op.execute("ALTER TABLE users ALTER COLUMN telegram_id SET NOT NULL")
