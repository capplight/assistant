"""«Сегодня», tasks and shopping, suggestions, pending «Да» (week 9; spec 3.x `tasks`, 3.4, 3.7,
4.5, 4.6, 6.5).

- `tasks` (spec 3.x): one line of «Дела» (`todo`) or «Покупки» (`shopping`). Spec fields plus
  (additive): `public_id`, `client_id` (outbox-safe create), `qty`, `where_text` (the shopping
  template's «Сколько», «Где купить»), `source_item_id` (the record a proposal came from),
  `version`, `created_at`, `updated_at`. `item_id` is the task's own record (one per task, UNIQUE):
  pages show records, so a task is on «Покупки» through that record's `screen_items` row. `seq` by
  the `sync_seq_bump` trigger; a hard delete (the record purged after 30 days in the trash, or the
  account) leaves a `task` tombstone.
- `suggestions`, `suggestion_counters` (spec 3.4): tips and data proposals, and the «Не сейчас»
  counters. Additive: `client_id` (idempotent accept), `action_id` (what an accepted proposal
  did), `updated_at`, `seq` (suggestions travel in `/v1/sync`). One proposal per record and key.
- `pending_actions` (spec 3.7): what waits for the person's «Да» (S25). Additive: `client_id`,
  `payload` (the plan our code made; never sent to the phone), `message_id`, `action_id` (the
  action the confirmed change wrote), `updated_at`.
- `sync_tombstones.entity` + `task`.

Frozen SQL, no create_all.

Revision ID: 0014
Revises: 0013
"""

from alembic import op

revision = "0014"
down_revision = "0013"
branch_labels = None
depends_on = None

PENDING_KINDS = (
    "'send_whatsapp_file', 'send_whatsapp_text', 'send_email', 'share_file', "
    "'delete_permanently', 'change_reminder', 'start_import', 'cleanup_batch', 'merge_group'"
)
PENDING_STATUSES = (
    "'proposed', 'confirmed', 'rejected', 'expired', 'executed', 'failed', 'cancelled_by_user'"
)

UP = [
    """
CREATE TABLE tasks (
	id BIGSERIAL PRIMARY KEY,
	public_id UUID DEFAULT gen_random_uuid() NOT NULL,
	client_id UUID,
	user_id BIGINT NOT NULL,
	item_id BIGINT NOT NULL,
	list_key TEXT NOT NULL,
	title TEXT NOT NULL,
	qty TEXT,
	where_text TEXT,
	due_date DATE,
	done_at TIMESTAMP WITH TIME ZONE,
	source_item_id BIGINT,
	version INTEGER DEFAULT 1 NOT NULL,
	seq BIGINT NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	deleted_at TIMESTAMP WITH TIME ZONE,
	CONSTRAINT uq_tasks_public_id UNIQUE (public_id),
	CONSTRAINT uq_tasks_user_client UNIQUE (user_id, client_id),
	CONSTRAINT uq_tasks_item UNIQUE (item_id),
	CONSTRAINT fk_tasks_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
	CONSTRAINT fk_tasks_item FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE CASCADE,
	CONSTRAINT fk_tasks_source_item FOREIGN KEY (source_item_id)
		REFERENCES items (id) ON DELETE SET NULL,
	CONSTRAINT ck_tasks_list_key CHECK (list_key IN ('todo', 'shopping')),
	CONSTRAINT ck_tasks_title CHECK (char_length(title) BETWEEN 1 AND 200),
	CONSTRAINT ck_tasks_qty CHECK (qty IS NULL OR char_length(qty) BETWEEN 1 AND 60),
	CONSTRAINT ck_tasks_where CHECK (where_text IS NULL OR char_length(where_text) BETWEEN 1 AND 60),
	CONSTRAINT ck_tasks_version CHECK (version >= 1)
)
""",
    "CREATE INDEX ix_tasks_user_seq ON tasks (user_id, seq)",
    "CREATE INDEX ix_tasks_user_list ON tasks (user_id, list_key) WHERE deleted_at IS NULL",
    "CREATE INDEX ix_tasks_source_item ON tasks (source_item_id) WHERE source_item_id IS NOT NULL",
    """
CREATE TRIGGER tasks_sync_seq BEFORE INSERT OR UPDATE ON tasks
FOR EACH ROW EXECUTE FUNCTION sync_seq_bump()
""",
    "ALTER TABLE sync_tombstones DROP CONSTRAINT ck_sync_tombstones_entity",
    """
ALTER TABLE sync_tombstones ADD CONSTRAINT ck_sync_tombstones_entity
	CHECK (entity IN ('item', 'screen', 'screen_item', 'conversation_message', 'action', 'task'))
""",
    """
CREATE TRIGGER tasks_sync_tombstone AFTER DELETE ON tasks
FOR EACH ROW EXECUTE FUNCTION sync_tombstone_row('task')
""",
    """
CREATE TABLE suggestions (
	id BIGSERIAL PRIMARY KEY,
	public_id UUID DEFAULT gen_random_uuid() NOT NULL,
	client_id UUID,
	user_id BIGINT NOT NULL,
	kind TEXT NOT NULL,
	key TEXT NOT NULL,
	payload JSONB DEFAULT '{}' NOT NULL,
	source_item_id BIGINT,
	status TEXT DEFAULT 'pending' NOT NULL,
	shown_at TIMESTAMP WITH TIME ZONE,
	decided_at TIMESTAMP WITH TIME ZONE,
	expires_at TIMESTAMP WITH TIME ZONE,
	action_id BIGINT,
	seq BIGINT NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	CONSTRAINT uq_suggestions_public_id UNIQUE (public_id),
	CONSTRAINT uq_suggestions_user_client UNIQUE (user_id, client_id),
	CONSTRAINT fk_suggestions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
	CONSTRAINT fk_suggestions_item FOREIGN KEY (source_item_id)
		REFERENCES items (id) ON DELETE CASCADE,
	CONSTRAINT fk_suggestions_action FOREIGN KEY (action_id)
		REFERENCES actions (id) ON DELETE SET NULL,
	CONSTRAINT ck_suggestions_kind CHECK (kind IN ('tip', 'data_proposal')),
	CONSTRAINT ck_suggestions_key CHECK (key ~ '^[a-z_]{1,40}$'),
	CONSTRAINT ck_suggestions_payload CHECK (jsonb_typeof(payload) = 'object'),
	CONSTRAINT ck_suggestions_status CHECK (
		status IN ('pending', 'shown', 'accepted', 'dismissed', 'expired'))
)
""",
    "CREATE INDEX ix_suggestions_user_seq ON suggestions (user_id, seq)",
    "CREATE INDEX ix_suggestions_user_status ON suggestions (user_id, status, kind)",
    """
CREATE UNIQUE INDEX uq_suggestions_item_key ON suggestions (user_id, key, source_item_id)
	WHERE source_item_id IS NOT NULL
""",
    """
CREATE TRIGGER suggestions_sync_seq BEFORE INSERT OR UPDATE ON suggestions
FOR EACH ROW EXECUTE FUNCTION sync_seq_bump()
""",
    """
CREATE TABLE suggestion_counters (
	user_id BIGINT NOT NULL,
	key TEXT NOT NULL,
	dismiss_count INTEGER DEFAULT 0 NOT NULL,
	cooldown_until TIMESTAMP WITH TIME ZONE,
	last_shown_at TIMESTAMP WITH TIME ZONE,
	shown_total INTEGER DEFAULT 0 NOT NULL,
	PRIMARY KEY (user_id, key),
	CONSTRAINT fk_suggestion_counters_user FOREIGN KEY (user_id)
		REFERENCES users (id) ON DELETE CASCADE,
	CONSTRAINT ck_suggestion_counters_counts CHECK (dismiss_count >= 0 AND shown_total >= 0)
)
""",
    f"""
CREATE TABLE pending_actions (
	id BIGSERIAL PRIMARY KEY,
	public_id UUID DEFAULT gen_random_uuid() NOT NULL,
	client_id UUID,
	user_id BIGINT NOT NULL,
	kind TEXT NOT NULL,
	preview JSONB DEFAULT '{{}}' NOT NULL,
	payload JSONB DEFAULT '{{}}' NOT NULL,
	confirm_token_hash TEXT NOT NULL,
	status TEXT DEFAULT 'proposed' NOT NULL,
	expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
	origin_action_id BIGINT,
	message_id BIGINT,
	action_id BIGINT,
	decided_at TIMESTAMP WITH TIME ZONE,
	executed_at TIMESTAMP WITH TIME ZONE,
	result JSONB,
	seq BIGINT NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	CONSTRAINT uq_pending_actions_public_id UNIQUE (public_id),
	CONSTRAINT uq_pending_actions_user_client UNIQUE (user_id, client_id),
	CONSTRAINT fk_pending_actions_user FOREIGN KEY (user_id)
		REFERENCES users (id) ON DELETE CASCADE,
	CONSTRAINT fk_pending_actions_origin FOREIGN KEY (origin_action_id)
		REFERENCES actions (id) ON DELETE SET NULL,
	CONSTRAINT fk_pending_actions_message FOREIGN KEY (message_id)
		REFERENCES conversation_messages (id) ON DELETE SET NULL,
	CONSTRAINT fk_pending_actions_action FOREIGN KEY (action_id)
		REFERENCES actions (id) ON DELETE SET NULL,
	CONSTRAINT ck_pending_actions_kind CHECK (kind IN ({PENDING_KINDS})),
	CONSTRAINT ck_pending_actions_status CHECK (status IN ({PENDING_STATUSES})),
	CONSTRAINT ck_pending_actions_preview CHECK (jsonb_typeof(preview) = 'object'),
	CONSTRAINT ck_pending_actions_payload CHECK (jsonb_typeof(payload) = 'object')
)
""",
    "CREATE INDEX ix_pending_actions_user_seq ON pending_actions (user_id, seq)",
    "CREATE INDEX ix_pending_actions_open ON pending_actions (expires_at) WHERE status = 'proposed'",
    """
CREATE TRIGGER pending_actions_sync_seq BEFORE INSERT OR UPDATE ON pending_actions
FOR EACH ROW EXECUTE FUNCTION sync_seq_bump()
""",
]

DOWN = [
    "DROP TRIGGER IF EXISTS pending_actions_sync_seq ON pending_actions",
    "DROP TABLE IF EXISTS pending_actions",
    "DROP TABLE IF EXISTS suggestion_counters",
    "DROP TRIGGER IF EXISTS suggestions_sync_seq ON suggestions",
    "DROP TABLE IF EXISTS suggestions",
    "DROP TRIGGER IF EXISTS tasks_sync_tombstone ON tasks",
    "DROP TRIGGER IF EXISTS tasks_sync_seq ON tasks",
    "DROP TABLE IF EXISTS tasks",
    "DELETE FROM sync_tombstones WHERE entity = 'task'",
    "ALTER TABLE sync_tombstones DROP CONSTRAINT ck_sync_tombstones_entity",
    """
ALTER TABLE sync_tombstones ADD CONSTRAINT ck_sync_tombstones_entity
	CHECK (entity IN ('item', 'screen', 'screen_item', 'conversation_message', 'action'))
""",
]


def upgrade() -> None:
    for stmt in UP:  # one statement per execute(): asyncpg rejects batches
        op.execute(stmt)


def downgrade() -> None:
    for stmt in DOWN:
        op.execute(stmt)
