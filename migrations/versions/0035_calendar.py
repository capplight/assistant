"""Calendar data (Ф-89, direction A; contract docs/api/calendar.md).

- `tasks`: `start_at` (a to-do with a time), `duration_min` (5…1440, null = a point), `tz`,
  `rrule` (a repeat, counted from `start_at` on the `tz` clock), `created_by` (`user` |
  `assistant`: the «помощник» label of the calendar). `due_date` stays the day (all-day when
  `start_at` is null).
- `task_occurrences`: one occurrence of a repeating task that differs — moved / resized
  (`start_at`, `duration_min`), done (`done_at`), deleted «только это» (`skipped`). Synced like
  tasks (`sync_seq_bump`, tombstone `task_occurrence`).
- `reminders.duration_min`: optional length of a reminder on the grid.

Frozen SQL, no create_all.

Revision ID: 0035
Revises: 0034
"""

from alembic import op

revision = "0035"
down_revision = "0034"
branch_labels = None
depends_on = None

_TOMBS_OLD = ("'item', 'screen', 'screen_item', 'conversation_message', 'action', 'task', "
              "'expense', 'document', 'expense_duplicate', 'company_profile', 'price_list', "
              "'price_list_item', 'draft'")  # fmt: skip
_TOMBS_NEW = _TOMBS_OLD + ", 'task_occurrence'"

UPGRADE = [
    "ALTER TABLE tasks ADD COLUMN start_at TIMESTAMP WITH TIME ZONE",
    "ALTER TABLE tasks ADD COLUMN duration_min INTEGER",
    "ALTER TABLE tasks ADD COLUMN tz TEXT",
    "ALTER TABLE tasks ADD COLUMN rrule TEXT",
    "ALTER TABLE tasks ADD COLUMN created_by TEXT DEFAULT 'user' NOT NULL",
    "ALTER TABLE tasks ADD CONSTRAINT ck_tasks_duration "
    "CHECK (duration_min IS NULL OR duration_min BETWEEN 5 AND 1440)",
    "ALTER TABLE tasks ADD CONSTRAINT ck_tasks_rrule_start CHECK (rrule IS NULL OR start_at IS NOT NULL)",
    "ALTER TABLE tasks ADD CONSTRAINT ck_tasks_created_by CHECK (created_by IN ('user', 'assistant'))",
    "CREATE INDEX ix_tasks_user_start ON tasks (user_id, start_at) "
    "WHERE deleted_at IS NULL AND start_at IS NOT NULL",
    "ALTER TABLE reminders ADD COLUMN duration_min INTEGER",
    "ALTER TABLE reminders ADD CONSTRAINT ck_reminders_duration "
    "CHECK (duration_min IS NULL OR duration_min BETWEEN 5 AND 1440)",
    """
CREATE TABLE task_occurrences (
	id BIGSERIAL PRIMARY KEY,
	public_id UUID DEFAULT gen_random_uuid() NOT NULL,
	user_id BIGINT NOT NULL,
	task_id BIGINT NOT NULL,
	occurrence_at TIMESTAMP WITH TIME ZONE NOT NULL,
	start_at TIMESTAMP WITH TIME ZONE,
	duration_min INTEGER,
	done_at TIMESTAMP WITH TIME ZONE,
	skipped BOOLEAN DEFAULT false NOT NULL,
	version INTEGER DEFAULT 1 NOT NULL,
	seq BIGINT NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	CONSTRAINT uq_task_occurrences_public_id UNIQUE (public_id),
	CONSTRAINT uq_task_occurrences_key UNIQUE (task_id, occurrence_at),
	CONSTRAINT fk_task_occurrences_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
	CONSTRAINT fk_task_occurrences_task FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE CASCADE,
	CONSTRAINT ck_task_occurrences_duration
		CHECK (duration_min IS NULL OR duration_min BETWEEN 5 AND 1440),
	CONSTRAINT ck_task_occurrences_version CHECK (version >= 1)
)
""",
    "CREATE INDEX ix_task_occurrences_user_seq ON task_occurrences (user_id, seq)",
    """
CREATE TRIGGER task_occurrences_sync_seq BEFORE INSERT OR UPDATE ON task_occurrences
FOR EACH ROW EXECUTE FUNCTION sync_seq_bump()
""",
    "ALTER TABLE sync_tombstones DROP CONSTRAINT ck_sync_tombstones_entity",
    f"""
ALTER TABLE sync_tombstones ADD CONSTRAINT ck_sync_tombstones_entity
	CHECK (entity IN ({_TOMBS_NEW}))
""",
    """
CREATE TRIGGER task_occurrences_sync_tombstone AFTER DELETE ON task_occurrences
FOR EACH ROW EXECUTE FUNCTION sync_tombstone_row('task_occurrence')
""",
]

DOWNGRADE = [
    "DROP TRIGGER IF EXISTS task_occurrences_sync_tombstone ON task_occurrences",
    "DROP TRIGGER IF EXISTS task_occurrences_sync_seq ON task_occurrences",
    "DROP TABLE IF EXISTS task_occurrences",
    "DELETE FROM sync_tombstones WHERE entity = 'task_occurrence'",
    "ALTER TABLE sync_tombstones DROP CONSTRAINT ck_sync_tombstones_entity",
    f"""
ALTER TABLE sync_tombstones ADD CONSTRAINT ck_sync_tombstones_entity
	CHECK (entity IN ({_TOMBS_OLD}))
""",
    "ALTER TABLE reminders DROP CONSTRAINT IF EXISTS ck_reminders_duration",
    "ALTER TABLE reminders DROP COLUMN IF EXISTS duration_min",
    "DROP INDEX IF EXISTS ix_tasks_user_start",
    "ALTER TABLE tasks DROP CONSTRAINT IF EXISTS ck_tasks_created_by",
    "ALTER TABLE tasks DROP CONSTRAINT IF EXISTS ck_tasks_rrule_start",
    "ALTER TABLE tasks DROP CONSTRAINT IF EXISTS ck_tasks_duration",
    "ALTER TABLE tasks DROP COLUMN IF EXISTS created_by",
    "ALTER TABLE tasks DROP COLUMN IF EXISTS rrule",
    "ALTER TABLE tasks DROP COLUMN IF EXISTS tz",
    "ALTER TABLE tasks DROP COLUMN IF EXISTS duration_min",
    "ALTER TABLE tasks DROP COLUMN IF EXISTS start_at",
]


def upgrade() -> None:
    for sql in UPGRADE:
        op.execute(sql)


def downgrade() -> None:
    for sql in DOWNGRADE:
        op.execute(sql)
