"""Consents (versions + text hash + revocation), files, uploads. Backfill legacy bot consent.

Frozen SQL, no create_all. Enums are text + CHECK.

Revision ID: 0003
Revises: 0002
"""
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None

TABLES = """
CREATE TABLE consents (
	id BIGSERIAL NOT NULL,
	public_id UUID NOT NULL,
	user_id BIGINT NOT NULL,
	kind TEXT NOT NULL,
	version TEXT NOT NULL,
	providers TEXT[] DEFAULT '{}' NOT NULL,
	text_hash TEXT,
	locale TEXT,
	granted_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	revoked_at TIMESTAMP WITH TIME ZONE,
	device_id BIGINT,
	ip_hash TEXT,
	screen TEXT,
	PRIMARY KEY (id),
	CONSTRAINT uq_consents_public_id UNIQUE (public_id),
	CONSTRAINT ck_consents_kind CHECK (
		kind IN ('pd_processing', 'ai_cross_border', 'terms',
		'push_content', 'analytics', 'telegram_import', 'human_review')),
	CONSTRAINT ck_consents_locale CHECK (locale IN ('ru', 'kk')),
	CONSTRAINT ck_consents_screen CHECK (screen IN ('S05', 'settings', 'import', 'legacy_bot')),
	CONSTRAINT ck_consents_revoked_after_granted CHECK (
		revoked_at IS NULL OR revoked_at >= granted_at),
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE,
	FOREIGN KEY(device_id) REFERENCES devices (id) ON DELETE SET NULL
);

CREATE INDEX ix_consents_user_kind ON consents (user_id, kind, granted_at DESC);

CREATE TABLE files (
	id BIGSERIAL NOT NULL,
	public_id UUID NOT NULL,
	user_id BIGINT NOT NULL,
	item_id BIGINT,
	role TEXT NOT NULL,
	storage_key TEXT NOT NULL,
	mime TEXT NOT NULL,
	bytes BIGINT NOT NULL,
	sha256 TEXT NOT NULL,
	state TEXT DEFAULT 'active' NOT NULL,
	pinned_by TEXT,
	keep_reason TEXT,
	trash_until TIMESTAMP WITH TIME ZONE,
	purged_at TIMESTAMP WITH TIME ZONE,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	PRIMARY KEY (id),
	CONSTRAINT uq_files_public_id UNIQUE (public_id),
	CONSTRAINT uq_files_storage_key UNIQUE (storage_key),
	CONSTRAINT ck_files_role CHECK (
		role IN ('original', 'company_logo', 'company_template', 'signature',
		'stamp', 'kp_render', 'price_list', 'export')),
	CONSTRAINT ck_files_state CHECK (state IN ('active', 'trash', 'pinned', 'purged')),
	CONSTRAINT ck_files_pinned_by CHECK (pinned_by IN ('user', 'auto_rule', 'policy')),
	CONSTRAINT ck_files_keep_reason CHECK (
		keep_reason IN ('low_confidence', 'size_rule', 'deal_active',
		'template', 'signature', 'user_pin', 'sent_kp')),
	CONSTRAINT ck_files_sha256 CHECK (sha256 ~ '^[0-9a-f]{64}$'),
	CONSTRAINT ck_files_bytes CHECK (bytes >= 0),
	CONSTRAINT ck_files_trash_until CHECK (state <> 'trash' OR trash_until IS NOT NULL),
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE,
	FOREIGN KEY(item_id) REFERENCES items (id) ON DELETE SET NULL
);

CREATE INDEX ix_files_user_id ON files (user_id);

CREATE INDEX ix_files_user_sha256 ON files (user_id, sha256);

CREATE INDEX ix_files_trash_due ON files (trash_until) WHERE state = 'trash';

CREATE TABLE uploads (
	id BIGSERIAL NOT NULL,
	public_id UUID NOT NULL,
	client_id UUID,
	user_id BIGINT NOT NULL,
	role TEXT DEFAULT 'original' NOT NULL,
	storage_key TEXT NOT NULL,
	mime TEXT NOT NULL,
	bytes BIGINT NOT NULL,
	sha256 TEXT NOT NULL,
	state TEXT DEFAULT 'pending' NOT NULL,
	expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
	completed_at TIMESTAMP WITH TIME ZONE,
	file_id BIGINT,
	error TEXT,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	PRIMARY KEY (id),
	CONSTRAINT uq_uploads_public_id UNIQUE (public_id),
	CONSTRAINT uq_uploads_storage_key UNIQUE (storage_key),
	CONSTRAINT uq_uploads_user_client UNIQUE (user_id, client_id),
	CONSTRAINT ck_uploads_role CHECK (
		role IN ('original', 'company_logo', 'company_template', 'signature',
		'stamp', 'kp_render', 'price_list', 'export')),
	CONSTRAINT ck_uploads_state CHECK (state IN ('pending', 'completed', 'failed', 'expired')),
	CONSTRAINT ck_uploads_sha256 CHECK (sha256 ~ '^[0-9a-f]{64}$'),
	CONSTRAINT ck_uploads_bytes CHECK (bytes > 0),
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE,
	FOREIGN KEY(file_id) REFERENCES files (id) ON DELETE SET NULL
);

CREATE INDEX ix_uploads_user_id ON uploads (user_id)
"""

# Spec 3.9: legacy users.consent_at -> ai_cross_border/legacy-bot. pd_processing and terms do not
# exist for legacy users: the app asks for them on first sign-in. Idempotent (re-runnable).
BACKFILL_CONSENTS = """
INSERT INTO consents (public_id, user_id, kind, version, providers, granted_at, screen)
SELECT gen_random_uuid(), u.id, 'ai_cross_border', 'legacy-bot', '{}', u.consent_at, 'legacy_bot'
FROM users u
WHERE u.consent_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM consents c
    WHERE c.user_id = u.id AND c.kind = 'ai_cross_border' AND c.version = 'legacy-bot'
  )
"""


def upgrade() -> None:
    for stmt in TABLES.split(";\n\n"):
        if stmt.strip():
            op.execute(stmt.strip().rstrip(";"))
    op.execute(BACKFILL_CONSENTS)


def downgrade() -> None:
    for table in ["uploads", "files", "consents"]:
        op.execute(f"DROP TABLE IF EXISTS {table} CASCADE")
