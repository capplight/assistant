"""«Расходы 2»: receipts, fiscal QR, bank statements, expense repeats (week 13; spec 3-engineering
3.12, 4.11, 6.13; contract docs/api/expenses.md).

- `statement_imports`: one bank statement PDF read into a plan (one «Да», one «Отменить»). The rows
  wait in `rows` (JSONB) until the decision; nothing is an expense before «Да». `check` holds code's
  sums against the bank's own summary. `status` adds `rejected` and `expired` to the spec's list.
- `expense_entries.statement_import_id` gets its FK (week 12 left it without one);
  `source_ref` = a statement row's key (`<bank>|<day>|<amount>|<description>|<ordinal>`) or a fiscal
  receipt's key (`ofd:<register>:<sign>`), so a statement read twice or a QR scanned twice does not
  make a second expense.
- `expense_duplicates`: «Похоже, эта трата уже есть [Объединить?]» pairs (code, never merged
  without the person).
- `pending_actions.kind` + `import_statement`; `actions.kind` + `merge_expenses`.

Frozen SQL, no create_all.

Revision ID: 0019
Revises: 0018
"""

from alembic import op

revision = "0019"
down_revision = "0018"
branch_labels = None
depends_on = None

_ACTION_KINDS_OLD = (
    "'save_item', 'auto_merge_exact', 'merge_group', 'cleanup_batch', 'create_reminder', "
    "'edit_reminder', 'create_stack', 'stack_add', 'stack_remove', 'delete_stack', 'create_kp', "
    "'edit_kp', 'delete_item', 'restore_item', 'user_edit', 'send_external', 'import_batch', "
    "'habit_change', 'create_screen', 'hide_screen', 'delete_screen', 'reorder_screens', "
    "'screen_customize', 'screen_reset', 'screen_view_change', 'screen_reorder_items', "
    "'screen_move_items', 'screen_add_item', 'screen_remove_item', 'facet_edit', "
    "'create_expense', 'edit_expense', 'bulk_create_expenses', 'dismiss_group'"
)
_ACTION_KINDS_NEW = _ACTION_KINDS_OLD + ", 'merge_expenses'"
_PENDING_OLD = (
    "'send_whatsapp_file', 'send_whatsapp_text', 'send_email', 'share_file', "
    "'delete_permanently', 'change_reminder', 'start_import', 'cleanup_batch', 'merge_group'"
)
_PENDING_NEW = _PENDING_OLD + ", 'import_statement'"

UP = [
    """
CREATE TABLE statement_imports (
	id BIGSERIAL PRIMARY KEY,
	public_id UUID DEFAULT gen_random_uuid() NOT NULL,
	client_id UUID,
	user_id BIGINT NOT NULL,
	item_id BIGINT,
	bank_hint TEXT NOT NULL,
	parser TEXT NOT NULL,
	currency CHAR(3) DEFAULT 'KZT' NOT NULL,
	period_from DATE,
	period_to DATE,
	rows_found INTEGER DEFAULT 0 NOT NULL,
	rows_new INTEGER DEFAULT 0 NOT NULL,
	rows_duplicate INTEGER DEFAULT 0 NOT NULL,
	rows_similar INTEGER DEFAULT 0 NOT NULL,
	rows JSONB DEFAULT '[]' NOT NULL,
	"check" JSONB,
	adds JSONB DEFAULT '{}' NOT NULL,
	status TEXT NOT NULL,
	error TEXT,
	pending_action_id BIGINT,
	action_id BIGINT,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	decided_at TIMESTAMP WITH TIME ZONE,
	CONSTRAINT uq_statement_imports_public_id UNIQUE (public_id),
	CONSTRAINT uq_statement_imports_user_client UNIQUE (user_id, client_id),
	CONSTRAINT fk_statement_imports_user FOREIGN KEY (user_id)
		REFERENCES users (id) ON DELETE CASCADE,
	CONSTRAINT fk_statement_imports_item FOREIGN KEY (item_id)
		REFERENCES items (id) ON DELETE SET NULL,
	CONSTRAINT fk_statement_imports_pending FOREIGN KEY (pending_action_id)
		REFERENCES pending_actions (id) ON DELETE SET NULL,
	CONSTRAINT fk_statement_imports_action FOREIGN KEY (action_id)
		REFERENCES actions (id) ON DELETE SET NULL,
	CONSTRAINT ck_statement_imports_bank CHECK (
		bank_hint IN ('kaspi_gold', 'halyk', 'freedom', 'other')),
	CONSTRAINT ck_statement_imports_parser CHECK (parser IN ('template', 'model')),
	CONSTRAINT ck_statement_imports_currency CHECK (currency ~ '^[A-Z]{3}$'),
	CONSTRAINT ck_statement_imports_status CHECK (status IN ('parsed', 'proposed', 'confirmed',
		'undone', 'rejected', 'expired', 'failed')),
	CONSTRAINT ck_statement_imports_rows CHECK (jsonb_typeof(rows) = 'array'),
	CONSTRAINT ck_statement_imports_counts CHECK (rows_found >= 0 AND rows_new >= 0
		AND rows_duplicate >= 0 AND rows_similar >= 0)
)
""",
    "CREATE INDEX ix_statement_imports_user ON statement_imports (user_id, id)",
    "CREATE INDEX ix_statement_imports_item ON statement_imports (item_id) "
    "WHERE item_id IS NOT NULL",
    "ALTER TABLE expense_entries ADD COLUMN source_ref TEXT",
    "ALTER TABLE expense_entries ADD CONSTRAINT ck_expense_entries_source_ref CHECK ("
    "source_ref IS NULL OR char_length(source_ref) BETWEEN 1 AND 400)",
    "ALTER TABLE expense_entries ADD CONSTRAINT fk_expense_entries_statement "
    "FOREIGN KEY (statement_import_id) REFERENCES statement_imports (id) ON DELETE SET NULL",
    "CREATE INDEX ix_expense_entries_statement ON expense_entries (statement_import_id) "
    "WHERE statement_import_id IS NOT NULL",
    "CREATE INDEX ix_expense_entries_user_source_ref ON expense_entries (user_id, source_ref) "
    "WHERE source_ref IS NOT NULL",
    """
CREATE TABLE expense_duplicates (
	id BIGSERIAL PRIMARY KEY,
	public_id UUID DEFAULT gen_random_uuid() NOT NULL,
	user_id BIGINT NOT NULL,
	keep_id BIGINT NOT NULL,
	other_id BIGINT NOT NULL,
	status TEXT DEFAULT 'suggested' NOT NULL,
	reason TEXT NOT NULL,
	action_id BIGINT,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	decided_at TIMESTAMP WITH TIME ZONE,
	CONSTRAINT uq_expense_duplicates_public_id UNIQUE (public_id),
	CONSTRAINT uq_expense_duplicates_pair UNIQUE (user_id, keep_id, other_id),
	CONSTRAINT fk_expense_duplicates_user FOREIGN KEY (user_id)
		REFERENCES users (id) ON DELETE CASCADE,
	CONSTRAINT fk_expense_duplicates_keep FOREIGN KEY (keep_id)
		REFERENCES expense_entries (id) ON DELETE CASCADE,
	CONSTRAINT fk_expense_duplicates_other FOREIGN KEY (other_id)
		REFERENCES expense_entries (id) ON DELETE CASCADE,
	CONSTRAINT fk_expense_duplicates_action FOREIGN KEY (action_id)
		REFERENCES actions (id) ON DELETE SET NULL,
	CONSTRAINT ck_expense_duplicates_status CHECK (
		status IN ('suggested', 'merged', 'dismissed')),
	CONSTRAINT ck_expense_duplicates_reason CHECK (reason IN ('statement', 'receipt', 'same_day')),
	CONSTRAINT ck_expense_duplicates_distinct CHECK (keep_id <> other_id)
)
""",
    "CREATE INDEX ix_expense_duplicates_user ON expense_duplicates (user_id, status, id)",
    "CREATE INDEX ix_expense_duplicates_other ON expense_duplicates (other_id)",
    "ALTER TABLE pending_actions DROP CONSTRAINT ck_pending_actions_kind",
    f"ALTER TABLE pending_actions ADD CONSTRAINT ck_pending_actions_kind CHECK (kind IN "
    f"({_PENDING_NEW}))",
    "ALTER TABLE actions DROP CONSTRAINT ck_actions_kind",
    f"ALTER TABLE actions ADD CONSTRAINT ck_actions_kind CHECK (kind IN ({_ACTION_KINDS_NEW}))",
]

DOWN = [
    "DELETE FROM actions WHERE kind = 'merge_expenses'",
    "ALTER TABLE actions DROP CONSTRAINT ck_actions_kind",
    f"ALTER TABLE actions ADD CONSTRAINT ck_actions_kind CHECK (kind IN ({_ACTION_KINDS_OLD}))",
    "DELETE FROM pending_actions WHERE kind = 'import_statement'",
    "ALTER TABLE pending_actions DROP CONSTRAINT ck_pending_actions_kind",
    f"ALTER TABLE pending_actions ADD CONSTRAINT ck_pending_actions_kind CHECK (kind IN "
    f"({_PENDING_OLD}))",
    "DROP TABLE IF EXISTS expense_duplicates",
    "DROP INDEX IF EXISTS ix_expense_entries_user_source_ref",
    "DROP INDEX IF EXISTS ix_expense_entries_statement",
    "ALTER TABLE expense_entries DROP CONSTRAINT IF EXISTS fk_expense_entries_statement",
    "UPDATE expense_entries SET statement_import_id = NULL WHERE statement_import_id IS NOT NULL",
    "ALTER TABLE expense_entries DROP CONSTRAINT IF EXISTS ck_expense_entries_source_ref",
    "ALTER TABLE expense_entries DROP COLUMN IF EXISTS source_ref",
    "DROP TABLE IF EXISTS statement_imports",
]


def upgrade() -> None:
    for stmt in UP:  # one statement per execute(): asyncpg rejects batches
        op.execute(stmt)


def downgrade() -> None:
    for stmt in DOWN:
        op.execute(stmt)
