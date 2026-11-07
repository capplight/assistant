"""Manual order by hand, offline conflicts, learned placement (week 7; spec 3.4, 3.10, 6.12; F-41,
R-54, US-27, US-28).

- `screen_items` (additive):
  `moved_ts`, `moved_client_id`: the winning manual move of the row, the clock of
  last-writer-wins between two phones (`client_ts`, ties by `client_id`). Only manual moves
  write them; an undo does not turn them back, so the clock never goes backwards.
  `moved_from_screen_id`: on a row the person moved here from another page (`move-to-page`):
  if this page is removed and the record is on no other live page, it goes back there.
- `screens` (additive): `moved_ts`, `moved_client_id` (the same clock for the tab order),
  `rekeyed_seq`: the `sync_seq` value taken when the page's rows were last re-keyed; a key the
  phone computed against an older `base_seq` is not trusted after that.
- `user_habits` (spec 3.4, the whole table, so week 9 adds only the API): `kind` lists every kind of
  the spec; week 7 writes `placement_rule` (learned from manual moves, F-29). `status` adds
  `candidate` to the spec's `active|disabled`: a rule seen once is kept, not used, until a second
  move confirms it. `seq` by the `sync_seq_bump` trigger (habits join `/v1/sync` in week 9).
  `screen_exclusion` is not written as a habit row: the hidden `screen_items` row
  (`removed_by_user_at`) is the exclusion itself, one source of truth that undo already handles.

Frozen SQL, no create_all.

Revision ID: 0012
Revises: 0011
"""

from alembic import op

revision = "0012"
down_revision = "0011"
branch_labels = None
depends_on = None

HABIT_KINDS = (
    "'alias', 'default_time', 'stack_exclusion', 'screen_exclusion', 'placement_rule', "
    "'payee_category', 'ask_before_reorder', 'never_do', 'reminder_level', 'answer_lang'"
)

UP = [
    """
ALTER TABLE screen_items
	ADD COLUMN moved_ts TIMESTAMP WITH TIME ZONE,
	ADD COLUMN moved_client_id UUID,
	ADD COLUMN moved_from_screen_id BIGINT,
	ADD CONSTRAINT fk_screen_items_moved_from FOREIGN KEY (moved_from_screen_id)
		REFERENCES screens (id) ON DELETE SET NULL,
	ADD CONSTRAINT ck_screen_items_moved CHECK ((moved_ts IS NULL) = (moved_client_id IS NULL))
""",
    """
ALTER TABLE screens
	ADD COLUMN moved_ts TIMESTAMP WITH TIME ZONE,
	ADD COLUMN moved_client_id UUID,
	ADD COLUMN rekeyed_seq BIGINT,
	ADD CONSTRAINT ck_screens_moved CHECK ((moved_ts IS NULL) = (moved_client_id IS NULL))
""",
    f"""
CREATE TABLE user_habits (
	id BIGSERIAL PRIMARY KEY,
	public_id UUID DEFAULT gen_random_uuid() NOT NULL,
	user_id BIGINT NOT NULL,
	kind TEXT NOT NULL,
	key TEXT NOT NULL,
	value JSONB DEFAULT '{{}}' NOT NULL,
	source TEXT NOT NULL,
	evidence_count INTEGER DEFAULT 0 NOT NULL,
	status TEXT DEFAULT 'active' NOT NULL,
	seq BIGINT NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	last_used_at TIMESTAMP WITH TIME ZONE,
	CONSTRAINT uq_user_habits_public_id UNIQUE (public_id),
	CONSTRAINT uq_user_habits_key UNIQUE (user_id, kind, key),
	CONSTRAINT fk_user_habits_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
	CONSTRAINT ck_user_habits_kind CHECK (kind IN ({HABIT_KINDS})),
	CONSTRAINT ck_user_habits_source CHECK (
		source IN ('user_explicit', 'learned_undo', 'learned_edit')),
	CONSTRAINT ck_user_habits_status CHECK (status IN ('candidate', 'active', 'disabled')),
	CONSTRAINT ck_user_habits_value CHECK (jsonb_typeof(value) = 'object'),
	CONSTRAINT ck_user_habits_evidence CHECK (evidence_count >= 0),
	CONSTRAINT ck_user_habits_key_len CHECK (char_length(key) BETWEEN 1 AND 200)
)
""",
    "CREATE INDEX ix_user_habits_user_seq ON user_habits (user_id, seq)",
    """
CREATE TRIGGER user_habits_sync_seq BEFORE INSERT OR UPDATE ON user_habits
FOR EACH ROW EXECUTE FUNCTION sync_seq_bump()
""",
]

DOWN = [
    "DROP TRIGGER IF EXISTS user_habits_sync_seq ON user_habits",
    "DROP TABLE IF EXISTS user_habits",
    """
ALTER TABLE screens
	DROP CONSTRAINT IF EXISTS ck_screens_moved,
	DROP COLUMN IF EXISTS rekeyed_seq,
	DROP COLUMN IF EXISTS moved_client_id,
	DROP COLUMN IF EXISTS moved_ts
""",
    """
ALTER TABLE screen_items
	DROP CONSTRAINT IF EXISTS ck_screen_items_moved,
	DROP CONSTRAINT IF EXISTS fk_screen_items_moved_from,
	DROP COLUMN IF EXISTS moved_from_screen_id,
	DROP COLUMN IF EXISTS moved_client_id,
	DROP COLUMN IF EXISTS moved_ts
""",
]


def upgrade() -> None:
    for stmt in UP:  # one statement per execute(): asyncpg rejects batches
        op.execute(stmt)


def downgrade() -> None:
    for stmt in DOWN:
        op.execute(stmt)
