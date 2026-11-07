"""Actions with undo, chat proposals, chat and actions in sync (week 6; spec 3.7, 4.12, 5.10,
6.11, 6.12).

- `actions` («Что я сделал»): spec 3.7 fields (`kind` lists every kind of the spec, so week 9 adds
  no CHECK change), plus (additive): `client_id` (idempotent repeat of an undo),
  `screen_id` (the page it happened on), `message_id` (the chat answer that made it),
  `updated_at`. `inverse` is the ordered list of white-listed undo ops (assistant.actions).
  `payload.changes` is the «Что изменилось» list. `seq` by the `sync_seq_bump` trigger.
- `conversation_messages`: `proposal` (a question waiting for the person's tap: which record,
  «Да» with a number, «Оставить мои»; holds the plan our code made, never sent as is),
  `choice` (on the person's message: the option tapped), `seq` + tombstones: the newest messages
  travel in `/v1/sync` («Переписка» offline). Existing rows get a seq here.
- `sync_tombstones.entity` + `conversation_message`, `action`.

Frozen SQL, no create_all.

Revision ID: 0011
Revises: 0010
"""

from alembic import op

revision = "0011"
down_revision = "0010"
branch_labels = None
depends_on = None

KINDS = (
    "'save_item', 'auto_merge_exact', 'merge_group', 'cleanup_batch', 'create_reminder', "
    "'edit_reminder', 'create_stack', 'stack_add', 'stack_remove', 'delete_stack', 'create_kp', "
    "'edit_kp', 'delete_item', 'restore_item', 'user_edit', 'send_external', 'import_batch', "
    "'habit_change', 'create_screen', 'hide_screen', 'delete_screen', 'reorder_screens', "
    "'screen_customize', 'screen_reset', 'screen_view_change', 'screen_reorder_items', "
    "'screen_move_items', 'screen_add_item', 'screen_remove_item', 'facet_edit', "
    "'create_expense', 'edit_expense', 'bulk_create_expenses'"
)

UP = [
    f"""
CREATE TABLE actions (
	id BIGSERIAL PRIMARY KEY,
	public_id UUID DEFAULT gen_random_uuid() NOT NULL,
	client_id UUID,
	user_id BIGINT NOT NULL,
	kind TEXT NOT NULL,
	scope TEXT DEFAULT 'internal' NOT NULL,
	initiated_by TEXT NOT NULL,
	summary JSONB DEFAULT '{{}}'::jsonb NOT NULL,
	payload JSONB DEFAULT '{{}}'::jsonb NOT NULL,
	inverse JSONB DEFAULT '[]'::jsonb NOT NULL,
	undoable_until TIMESTAMP WITH TIME ZONE,
	undone_at TIMESTAMP WITH TIME ZONE,
	undo_of_action_id BIGINT,
	source_item_ids BIGINT[] DEFAULT '{{}}' NOT NULL,
	screen_id BIGINT,
	message_id BIGINT,
	seq BIGINT DEFAULT 0 NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	CONSTRAINT uq_actions_public_id UNIQUE (public_id),
	CONSTRAINT uq_actions_user_client UNIQUE (user_id, client_id),
	CONSTRAINT fk_actions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
	CONSTRAINT fk_actions_undo_of FOREIGN KEY (undo_of_action_id)
		REFERENCES actions (id) ON DELETE SET NULL,
	CONSTRAINT fk_actions_screen FOREIGN KEY (screen_id) REFERENCES screens (id) ON DELETE SET NULL,
	CONSTRAINT fk_actions_message FOREIGN KEY (message_id)
		REFERENCES conversation_messages (id) ON DELETE SET NULL,
	CONSTRAINT ck_actions_kind CHECK (kind IN ({KINDS})),
	CONSTRAINT ck_actions_scope CHECK (scope IN ('internal', 'external')),
	CONSTRAINT ck_actions_initiated_by CHECK (initiated_by IN ('user', 'agent'))
)
""",
    "CREATE INDEX ix_actions_user_id ON actions (user_id, id)",
    "CREATE INDEX ix_actions_user_seq ON actions (user_id, seq)",
    "CREATE INDEX ix_actions_undo_of ON actions (undo_of_action_id)",
    """
CREATE TRIGGER actions_sync_seq BEFORE INSERT OR UPDATE ON actions
FOR EACH ROW EXECUTE FUNCTION sync_seq_bump()
""",
    """
CREATE TRIGGER actions_sync_tombstone AFTER DELETE ON actions
FOR EACH ROW EXECUTE FUNCTION sync_tombstone_row('action')
""",
    "ALTER TABLE conversation_messages ADD COLUMN proposal JSONB",
    "ALTER TABLE conversation_messages ADD COLUMN choice JSONB",
    "ALTER TABLE conversation_messages ADD COLUMN seq BIGINT DEFAULT 0 NOT NULL",
    """
CREATE TRIGGER conversation_messages_sync_seq BEFORE INSERT OR UPDATE ON conversation_messages
FOR EACH ROW EXECUTE FUNCTION sync_seq_bump()
""",
    # Existing rows get a seq (the trigger above sets it).
    "UPDATE conversation_messages SET seq = 0",
    "CREATE INDEX ix_conversation_messages_user_seq ON conversation_messages (user_id, seq)",
    """
CREATE TRIGGER conversation_messages_sync_tombstone AFTER DELETE ON conversation_messages
FOR EACH ROW EXECUTE FUNCTION sync_tombstone_row('conversation_message')
""",
    "ALTER TABLE sync_tombstones DROP CONSTRAINT ck_sync_tombstones_entity",
    """
ALTER TABLE sync_tombstones ADD CONSTRAINT ck_sync_tombstones_entity
	CHECK (entity IN ('item', 'screen', 'screen_item', 'conversation_message', 'action'))
""",
]

DOWN = [
    "DELETE FROM sync_tombstones WHERE entity IN ('conversation_message', 'action')",
    "ALTER TABLE sync_tombstones DROP CONSTRAINT ck_sync_tombstones_entity",
    """
ALTER TABLE sync_tombstones ADD CONSTRAINT ck_sync_tombstones_entity
	CHECK (entity IN ('item', 'screen', 'screen_item'))
""",
    "DROP TRIGGER IF EXISTS conversation_messages_sync_tombstone ON conversation_messages",
    "DROP TRIGGER IF EXISTS conversation_messages_sync_seq ON conversation_messages",
    "DROP INDEX IF EXISTS ix_conversation_messages_user_seq",
    "ALTER TABLE conversation_messages DROP COLUMN IF EXISTS seq",
    "ALTER TABLE conversation_messages DROP COLUMN IF EXISTS choice",
    "ALTER TABLE conversation_messages DROP COLUMN IF EXISTS proposal",
    "DROP TABLE IF EXISTS actions",
]


def upgrade() -> None:
    for stmt in UP:
        op.execute(stmt)


def downgrade() -> None:
    for stmt in DOWN:
        op.execute(stmt)
