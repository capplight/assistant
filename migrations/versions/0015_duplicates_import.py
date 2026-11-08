"""Similar duplicates, stacks, Telegram import, product events (week 10; spec 3.3, 3.7, 3.8, 4.6,
4.9, 6.3, 6.4, 6.10).

- `duplicate_candidates` (spec 3.3): internal pairs. Additive: `signals` (hamming / trgm / cosine
  numbers that made the pair), `verdict` (DUP_JUDGE answer: same|different|newer_version),
  `created_at`. UNIQUE(user_id, item_a, item_b), `item_a < item_b`.
- `duplicate_groups` (spec 3.3, what the person sees): spec fields, plus (additive) `import_id`
  (origin=import), `seq` (sync) and `updated_at`.
- `duplicate_group_members` (spec 3.3).
- `collections` / `collection_items` (stacks, spec 3.3, F-09 changed: `screen_id` = the page the
  stack shows on as a group). Additive: `key` (the envelope key that made it, e.g.
  `topic:ремонт`; one stack per key, a removed stack is not made again), `action_id`,
  `created_at`; on members `created_at`.
- `imports` / `import_seen` (spec 3.7). Additive on imports: `public_id`, `client_id`, `file_id`
  (the uploaded export; trashed after reading), `created_count`, `summary` (the final numbers),
  `action_id` (the `import_batch` action), `error` (a short code), `created_at`, `updated_at`,
  `seq`. On import_seen: `import_id`, `created_at`.
- `analytics.events` (spec 3.8, R-40): own schema in the same database. Additive: `client_id`
  (a resent batch is not counted twice), UNIQUE(user_pseudo, client_id).
- `screen_templates` notes v2 (data): «Заметки» shows notes, not tasks / shopping / receipts
  another page takes; pages of v1 move to v2.
- `actions.kind` + `dismiss_group` («Это разные» with «Отменить»).
- `users.sync_floor_seq` + an index on `sync_tombstones.deleted_at`: tombstone retention
  (founder 2026-11-09, 90 days by default).

Frozen SQL, no create_all.

Revision ID: 0015
Revises: 0014
"""

from alembic import op

revision = "0015"
down_revision = "0014"
branch_labels = None
depends_on = None

KINDS_0011 = (
    "'save_item', 'auto_merge_exact', 'merge_group', 'cleanup_batch', 'create_reminder', "
    "'edit_reminder', 'create_stack', 'stack_add', 'stack_remove', 'delete_stack', 'create_kp', "
    "'edit_kp', 'delete_item', 'restore_item', 'user_edit', 'send_external', 'import_batch', "
    "'habit_change', 'create_screen', 'hide_screen', 'delete_screen', 'reorder_screens', "
    "'screen_customize', 'screen_reset', 'screen_view_change', 'screen_reorder_items', "
    "'screen_move_items', 'screen_add_item', 'screen_remove_item', 'facet_edit', "
    "'create_expense', 'edit_expense', 'bulk_create_expenses'"
)

NOTES_V2 = ('{"any": [{"always": true}], "none": [{"task_record": true}, '
            '{"envelope_types": ["task", "reminder_request", "shopping_list", "receipt"]}]}')

UP = [
    """
CREATE TABLE duplicate_groups (
	id BIGSERIAL PRIMARY KEY,
	public_id UUID DEFAULT gen_random_uuid() NOT NULL,
	user_id BIGINT NOT NULL,
	kind TEXT NOT NULL,
	status TEXT NOT NULL,
	keep_item_id BIGINT,
	keep_rule TEXT DEFAULT 'most_complete' NOT NULL,
	member_count INTEGER DEFAULT 0 NOT NULL,
	origin TEXT NOT NULL,
	import_id BIGINT,
	action_id BIGINT,
	seq BIGINT NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	decided_at TIMESTAMP WITH TIME ZONE,
	CONSTRAINT uq_duplicate_groups_public_id UNIQUE (public_id),
	CONSTRAINT fk_duplicate_groups_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
	CONSTRAINT fk_duplicate_groups_keep FOREIGN KEY (keep_item_id)
		REFERENCES items (id) ON DELETE SET NULL,
	CONSTRAINT fk_duplicate_groups_action FOREIGN KEY (action_id)
		REFERENCES actions (id) ON DELETE SET NULL,
	CONSTRAINT ck_duplicate_groups_kind CHECK (kind IN ('exact', 'near')),
	CONSTRAINT ck_duplicate_groups_status CHECK (
		status IN ('auto_merged', 'suggested', 'merged', 'dismissed', 'undone')),
	CONSTRAINT ck_duplicate_groups_keep_rule CHECK (keep_rule IN ('most_complete', 'newest')),
	CONSTRAINT ck_duplicate_groups_origin CHECK (origin IN ('on_save', 'cleanup', 'import')),
	CONSTRAINT ck_duplicate_groups_count CHECK (member_count >= 0)
)
""",
    "CREATE INDEX ix_duplicate_groups_user_status ON duplicate_groups (user_id, status, kind)",
    "CREATE INDEX ix_duplicate_groups_user_seq ON duplicate_groups (user_id, seq)",
    """
CREATE TRIGGER duplicate_groups_sync_seq BEFORE INSERT OR UPDATE ON duplicate_groups
FOR EACH ROW EXECUTE FUNCTION sync_seq_bump()
""",
    """
CREATE TABLE duplicate_group_members (
	group_id BIGINT NOT NULL,
	item_id BIGINT NOT NULL,
	role TEXT NOT NULL,
	score REAL,
	PRIMARY KEY (group_id, item_id),
	CONSTRAINT fk_duplicate_group_members_group FOREIGN KEY (group_id)
		REFERENCES duplicate_groups (id) ON DELETE CASCADE,
	CONSTRAINT fk_duplicate_group_members_item FOREIGN KEY (item_id)
		REFERENCES items (id) ON DELETE CASCADE,
	CONSTRAINT ck_duplicate_group_members_role CHECK (role IN ('keep', 'merge'))
)
""",
    "CREATE INDEX ix_duplicate_group_members_item ON duplicate_group_members (item_id)",
    """
CREATE TABLE duplicate_candidates (
	id BIGSERIAL PRIMARY KEY,
	user_id BIGINT NOT NULL,
	item_a BIGINT NOT NULL,
	item_b BIGINT NOT NULL,
	kind TEXT NOT NULL,
	score REAL NOT NULL,
	method TEXT NOT NULL,
	signals JSONB DEFAULT '{}' NOT NULL,
	verdict TEXT,
	group_id BIGINT,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	CONSTRAINT uq_duplicate_candidates_pair UNIQUE (user_id, item_a, item_b),
	CONSTRAINT fk_duplicate_candidates_user FOREIGN KEY (user_id)
		REFERENCES users (id) ON DELETE CASCADE,
	CONSTRAINT fk_duplicate_candidates_a FOREIGN KEY (item_a) REFERENCES items (id) ON DELETE CASCADE,
	CONSTRAINT fk_duplicate_candidates_b FOREIGN KEY (item_b) REFERENCES items (id) ON DELETE CASCADE,
	CONSTRAINT fk_duplicate_candidates_group FOREIGN KEY (group_id)
		REFERENCES duplicate_groups (id) ON DELETE SET NULL,
	CONSTRAINT ck_duplicate_candidates_order CHECK (item_a < item_b),
	CONSTRAINT ck_duplicate_candidates_kind CHECK (kind IN ('exact', 'near')),
	CONSTRAINT ck_duplicate_candidates_method CHECK (
		method IN ('hash', 'simhash', 'trgm', 'embedding', 'llm_judge')),
	CONSTRAINT ck_duplicate_candidates_verdict CHECK (
		verdict IS NULL OR verdict IN ('same', 'different', 'newer_version')),
	CONSTRAINT ck_duplicate_candidates_signals CHECK (jsonb_typeof(signals) = 'object')
)
""",
    "CREATE INDEX ix_duplicate_candidates_b ON duplicate_candidates (item_b)",
    """
CREATE TABLE collections (
	id BIGSERIAL PRIMARY KEY,
	public_id UUID DEFAULT gen_random_uuid() NOT NULL,
	user_id BIGINT NOT NULL,
	kind TEXT NOT NULL,
	key TEXT,
	title TEXT NOT NULL,
	title_kk TEXT,
	icon TEXT NOT NULL,
	rule JSONB DEFAULT '{}' NOT NULL,
	item_count INTEGER DEFAULT 0 NOT NULL,
	before_after JSONB DEFAULT '{}' NOT NULL,
	created_by TEXT NOT NULL,
	screen_id BIGINT,
	action_id BIGINT,
	last_opened_at TIMESTAMP WITH TIME ZONE,
	hidden_at TIMESTAMP WITH TIME ZONE,
	seq BIGINT NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	deleted_at TIMESTAMP WITH TIME ZONE,
	CONSTRAINT uq_collections_public_id UNIQUE (public_id),
	CONSTRAINT fk_collections_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
	CONSTRAINT fk_collections_screen FOREIGN KEY (screen_id)
		REFERENCES screens (id) ON DELETE SET NULL,
	CONSTRAINT fk_collections_action FOREIGN KEY (action_id)
		REFERENCES actions (id) ON DELETE SET NULL,
	CONSTRAINT ck_collections_kind CHECK (kind IN ('smart', 'duplicates', 'deal', 'manual')),
	CONSTRAINT ck_collections_created_by CHECK (created_by IN ('agent', 'user')),
	CONSTRAINT ck_collections_title CHECK (char_length(title) BETWEEN 1 AND 40),
	CONSTRAINT ck_collections_count CHECK (item_count >= 0),
	CONSTRAINT ck_collections_rule CHECK (jsonb_typeof(rule) = 'object')
)
""",
    "CREATE UNIQUE INDEX uq_collections_user_key ON collections (user_id, key) WHERE key IS NOT NULL",
    "CREATE INDEX ix_collections_user_seq ON collections (user_id, seq)",
    "CREATE INDEX ix_collections_screen ON collections (screen_id) WHERE deleted_at IS NULL",
    """
CREATE TRIGGER collections_sync_seq BEFORE INSERT OR UPDATE ON collections
FOR EACH ROW EXECUTE FUNCTION sync_seq_bump()
""",
    """
CREATE TABLE collection_items (
	collection_id BIGINT NOT NULL,
	item_id BIGINT NOT NULL,
	score REAL,
	added_by TEXT NOT NULL,
	removed_by_user_at TIMESTAMP WITH TIME ZONE,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	PRIMARY KEY (collection_id, item_id),
	CONSTRAINT fk_collection_items_collection FOREIGN KEY (collection_id)
		REFERENCES collections (id) ON DELETE CASCADE,
	CONSTRAINT fk_collection_items_item FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE CASCADE,
	CONSTRAINT ck_collection_items_added_by CHECK (added_by IN ('agent', 'user'))
)
""",
    "CREATE INDEX ix_collection_items_item ON collection_items (item_id)",
    """
CREATE TABLE imports (
	id BIGSERIAL PRIMARY KEY,
	public_id UUID DEFAULT gen_random_uuid() NOT NULL,
	client_id UUID,
	user_id BIGINT NOT NULL,
	source TEXT NOT NULL,
	status TEXT DEFAULT 'created' NOT NULL,
	consent_id BIGINT,
	file_id BIGINT,
	total INTEGER DEFAULT 0 NOT NULL,
	processed INTEGER DEFAULT 0 NOT NULL,
	created_count INTEGER DEFAULT 0 NOT NULL,
	skipped_dups INTEGER DEFAULT 0 NOT NULL,
	skipped_media JSONB DEFAULT '{}' NOT NULL,
	failed INTEGER DEFAULT 0 NOT NULL,
	cursor JSONB DEFAULT '{}' NOT NULL,
	session_enc BYTEA,
	session_expires_at TIMESTAMP WITH TIME ZONE,
	budget_usd NUMERIC(12, 6) DEFAULT 1.0 NOT NULL,
	cost_usd NUMERIC(12, 6) DEFAULT 0 NOT NULL,
	summary JSONB DEFAULT '{}' NOT NULL,
	action_id BIGINT,
	error TEXT,
	started_at TIMESTAMP WITH TIME ZONE,
	finished_at TIMESTAMP WITH TIME ZONE,
	seq BIGINT NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	CONSTRAINT uq_imports_public_id UNIQUE (public_id),
	CONSTRAINT uq_imports_user_client UNIQUE (user_id, client_id),
	CONSTRAINT fk_imports_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
	CONSTRAINT fk_imports_consent FOREIGN KEY (consent_id) REFERENCES consents (id) ON DELETE SET NULL,
	CONSTRAINT fk_imports_file FOREIGN KEY (file_id) REFERENCES files (id) ON DELETE SET NULL,
	CONSTRAINT fk_imports_action FOREIGN KEY (action_id) REFERENCES actions (id) ON DELETE SET NULL,
	CONSTRAINT ck_imports_source CHECK (
		source IN ('telegram_export_file', 'telegram_bot_forward', 'telegram_takeout', 'files_bulk')),
	CONSTRAINT ck_imports_status CHECK (
		status IN ('created', 'awaiting_code', 'running', 'paused_budget', 'done', 'failed',
		           'cancelled')),
	CONSTRAINT ck_imports_counts CHECK (total >= 0 AND processed >= 0 AND created_count >= 0
		AND skipped_dups >= 0 AND failed >= 0),
	CONSTRAINT ck_imports_skipped_media CHECK (jsonb_typeof(skipped_media) = 'object'),
	CONSTRAINT ck_imports_cursor CHECK (jsonb_typeof(cursor) = 'object'),
	CONSTRAINT ck_imports_summary CHECK (jsonb_typeof(summary) = 'object')
)
""",
    "CREATE INDEX ix_imports_user_seq ON imports (user_id, seq)",
    """
CREATE TRIGGER imports_sync_seq BEFORE INSERT OR UPDATE ON imports
FOR EACH ROW EXECUTE FUNCTION sync_seq_bump()
""",
    """
ALTER TABLE duplicate_groups ADD CONSTRAINT fk_duplicate_groups_import FOREIGN KEY (import_id)
	REFERENCES imports (id) ON DELETE SET NULL
""",
    """
CREATE TABLE import_seen (
	id BIGSERIAL PRIMARY KEY,
	user_id BIGINT NOT NULL,
	source_family TEXT NOT NULL,
	external_id TEXT NOT NULL,
	item_id BIGINT,
	import_id BIGINT,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	CONSTRAINT uq_import_seen UNIQUE (user_id, source_family, external_id),
	CONSTRAINT fk_import_seen_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
	CONSTRAINT fk_import_seen_item FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE SET NULL,
	CONSTRAINT fk_import_seen_import FOREIGN KEY (import_id) REFERENCES imports (id) ON DELETE SET NULL,
	CONSTRAINT ck_import_seen_family CHECK (source_family IN ('telegram')),
	CONSTRAINT ck_import_seen_external CHECK (char_length(external_id) BETWEEN 1 AND 200)
)
""",
    "CREATE INDEX ix_import_seen_import ON import_seen (import_id)",
    "CREATE SCHEMA IF NOT EXISTS analytics",
    """
CREATE TABLE analytics.events (
	id BIGSERIAL PRIMARY KEY,
	client_id UUID NOT NULL,
	user_pseudo TEXT NOT NULL,
	device_pseudo TEXT,
	name TEXT NOT NULL,
	props JSONB DEFAULT '{}' NOT NULL,
	platform TEXT,
	app_version TEXT,
	client_ts TIMESTAMP WITH TIME ZONE,
	received_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	CONSTRAINT uq_events_user_client UNIQUE (user_pseudo, client_id),
	CONSTRAINT ck_events_name CHECK (name ~ '^[a-z][a-z0-9_]{1,63}$'),
	CONSTRAINT ck_events_props CHECK (jsonb_typeof(props) = 'object'),
	CONSTRAINT ck_events_platform CHECK (platform IS NULL OR platform IN ('ios', 'android', 'web'))
)
""",
    "CREATE INDEX ix_events_received ON analytics.events (received_at)",
    "CREATE INDEX ix_events_user ON analytics.events (user_pseudo)",
    # Tombstone retention (founder 2026-11-09): tombstones older than `sync_tombstone_days` are
    # deleted; the highest seq deleted is kept here, and a phone whose `since` is below it is
    # told to sync from scratch (`full_resync`).
    "ALTER TABLE users ADD COLUMN sync_floor_seq BIGINT DEFAULT 0 NOT NULL",
    "CREATE INDEX ix_sync_tombstones_deleted_at ON sync_tombstones (deleted_at)",
    # «Заметки» v2 (founder 2026-11-09): notes only, not tasks, shopping or receipts, when another
    # page takes those (rules.py `none`). Data, not schema: a new catalogue version, and the
    # pages made from v1 follow it (they have no rule of their own).
    f"""
INSERT INTO screen_templates (key, version, owner, status, catalog_visible, catalog_order, title,
    description, default_title, icon, preview_ref, singleton, facet, fields, layouts,
    default_layout, default_view, aggregates, auto_rule, ai_hints_ref, min_app_version,
    migrate_from)
SELECT key, 2, owner, status, catalog_visible, catalog_order, title, description, default_title,
    icon, preview_ref, singleton, facet, fields, layouts, default_layout, default_view, aggregates,
    CAST('{NOTES_V2}' AS JSONB), ai_hints_ref, min_app_version, 1
FROM screen_templates WHERE key = 'notes' AND version = 1
""",
    "UPDATE screens SET template_version = 2 WHERE template_key = 'notes' AND template_version = 1",
    # «Это разные» is an action with «Отменить» (additive kind).
    "ALTER TABLE actions DROP CONSTRAINT ck_actions_kind",
    f"ALTER TABLE actions ADD CONSTRAINT ck_actions_kind CHECK (kind IN ({KINDS_0011}, "
    "'dismiss_group'))",
]

DOWN = [
    "DELETE FROM actions WHERE kind = 'dismiss_group'",
    "ALTER TABLE actions DROP CONSTRAINT ck_actions_kind",
    f"ALTER TABLE actions ADD CONSTRAINT ck_actions_kind CHECK (kind IN ({KINDS_0011}))",
    "UPDATE screens SET template_version = 1 WHERE template_key = 'notes' AND template_version = 2",
    "DELETE FROM screen_templates WHERE key = 'notes' AND version = 2",
    "DROP INDEX IF EXISTS ix_sync_tombstones_deleted_at",
    "ALTER TABLE users DROP COLUMN IF EXISTS sync_floor_seq",
    "DROP TABLE IF EXISTS analytics.events",
    "DROP SCHEMA IF EXISTS analytics",
    "DROP TABLE IF EXISTS import_seen",
    "ALTER TABLE duplicate_groups DROP CONSTRAINT IF EXISTS fk_duplicate_groups_import",
    "DROP TRIGGER IF EXISTS imports_sync_seq ON imports",
    "DROP TABLE IF EXISTS imports",
    "DROP TABLE IF EXISTS collection_items",
    "DROP TRIGGER IF EXISTS collections_sync_seq ON collections",
    "DROP TABLE IF EXISTS collections",
    "DROP TABLE IF EXISTS duplicate_candidates",
    "DROP TABLE IF EXISTS duplicate_group_members",
    "DROP TRIGGER IF EXISTS duplicate_groups_sync_seq ON duplicate_groups",
    "DROP TABLE IF EXISTS duplicate_groups",
]


def upgrade() -> None:
    for stmt in UP:  # one statement per execute(): asyncpg rejects batches
        op.execute(stmt)


def downgrade() -> None:
    for stmt in DOWN:
        op.execute(stmt)
