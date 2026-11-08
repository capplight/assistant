"""Reminders for the app: alarms, fires, phone events (week 8; spec 3-engineering 3.x
`0003_reminders_generalize`, 6.6; R-09…R-14).

Expand-only on the legacy `reminders` table (spec: «reminders: новые колонки, level из kind (всё
→ notification), FK на trips/bookings → nullable»), so the Telegram bot keeps working:

- `status`: Postgres enum `reminderstatus` → `text + CHECK` holding the bot values
  (`scheduled|sent|cancelled|failed`) and the app values
  (`scheduled|fired|acked|snoozed|done|cancelled|missed`), as 0004 did for `items`.
- App rows are the ones with `kind IN ('normal', 'test')`; bot rows keep their own kinds
  (`booking_*`, `trip_*`). CHECKs keep the two apart: an app row has `title` + `tz`, no trip or
  booking, an app status; a bot row has `text` and a bot status. The bot's sender reads only bot
  kinds (assistant.scheduler.service). `text` becomes nullable (app rows use `title`/`body`).
- New columns (spec 3.x): `public_id`, `client_id` (+ UNIQUE per user), `item_id`, `title`,
  `body`, `tz`, `rrule`, `offsets int[]`, `level` (alarm|notification; bot rows → notification by
  default), `created_via`, `parse_source`, `sensitivity`, `snooze_until`, `version`, `seq`
  (`sync_seq_bump`), `updated_at`, `deleted_at`. Additive: `expanded_until` (repeating reminders
  have fires up to here; the worker tops up).
- `reminder_fires` (spec fields) + additive: `public_id`, `user_id` (sync filter), `snooze_n`
  (one fire per «Отложить»; part of the unique key), `fired_at`, `acked_at`, state `cancelled`
  (reminder changed/deleted: the phone drops the local alarm), `seq`, `updated_at`.
- `reminder_events` (spec fields) + additive: `user_id`, `client_id` (idempotent retries from
  the phone's outbox), `received_at`.

No hard deletes in the app path, so no tombstone triggers. Frozen SQL, no create_all.

Revision ID: 0013
Revises: 0012
"""

from alembic import op

revision = "0013"
down_revision = "0012"
branch_labels = None
depends_on = None

APP_KINDS = "'normal', 'test'"
BOT_STATUSES = "'scheduled', 'sent', 'cancelled', 'failed'"
APP_STATUSES = "'scheduled', 'fired', 'acked', 'snoozed', 'done', 'cancelled', 'missed'"
EVENTS = (
    "'scheduled_local', 'schedule_failed', 'fired_local', 'shown', 'acked', 'snoozed', "
    "'dismissed', 'push_sent', 'push_failed', 'missed'"
)

UP = [
    "ALTER TABLE reminders ALTER COLUMN status TYPE TEXT USING status::text",
    "DROP TYPE reminderstatus",
    "ALTER TABLE reminders ALTER COLUMN text DROP NOT NULL",
    f"""
ALTER TABLE reminders
	ADD COLUMN public_id UUID DEFAULT gen_random_uuid() NOT NULL,
	ADD COLUMN client_id UUID,
	ADD COLUMN item_id BIGINT,
	ADD COLUMN title TEXT,
	ADD COLUMN body TEXT,
	ADD COLUMN tz TEXT,
	ADD COLUMN rrule TEXT,
	ADD COLUMN offsets INTEGER[] DEFAULT '{{}}' NOT NULL,
	ADD COLUMN level TEXT DEFAULT 'notification' NOT NULL,
	ADD COLUMN created_via TEXT,
	ADD COLUMN parse_source TEXT,
	ADD COLUMN sensitivity TEXT,
	ADD COLUMN snooze_until TIMESTAMP WITH TIME ZONE,
	ADD COLUMN expanded_until TIMESTAMP WITH TIME ZONE,
	ADD COLUMN version INTEGER DEFAULT 1 NOT NULL,
	ADD COLUMN seq BIGINT DEFAULT 0 NOT NULL,
	ADD COLUMN updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	ADD COLUMN deleted_at TIMESTAMP WITH TIME ZONE,
	ADD CONSTRAINT uq_reminders_public_id UNIQUE (public_id),
	ADD CONSTRAINT uq_reminders_user_client UNIQUE (user_id, client_id),
	ADD CONSTRAINT fk_reminders_item FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE SET NULL,
	ADD CONSTRAINT ck_reminders_status CHECK (status IN ({BOT_STATUSES}, {APP_STATUSES})),
	ADD CONSTRAINT ck_reminders_level CHECK (level IN ('alarm', 'notification')),
	ADD CONSTRAINT ck_reminders_created_via CHECK (
		created_via IN ('voice', 'typed', 'agent_suggestion', 'manual_form')),
	ADD CONSTRAINT ck_reminders_parse_source CHECK (parse_source IN ('rules', 'llm', 'user_edit')),
	ADD CONSTRAINT ck_reminders_sensitivity CHECK (sensitivity IN ('health')),
	ADD CONSTRAINT ck_reminders_offsets CHECK (
		cardinality(offsets) <= 3 AND 1 <= ALL (offsets) AND 10080 >= ALL (offsets)),
	ADD CONSTRAINT ck_reminders_version CHECK (version >= 1),
	ADD CONSTRAINT ck_reminders_app_row CHECK (
		kind NOT IN ({APP_KINDS}) OR (
			title IS NOT NULL AND char_length(title) BETWEEN 1 AND 200 AND tz IS NOT NULL
			AND trip_id IS NULL AND booking_id IS NULL AND status IN ({APP_STATUSES}))),
	ADD CONSTRAINT ck_reminders_bot_row CHECK (
		kind IN ({APP_KINDS}) OR (text IS NOT NULL AND status IN ({BOT_STATUSES})))
""",
    "CREATE INDEX ix_reminders_user_seq ON reminders (user_id, seq)",
    f"""
CREATE INDEX ix_reminders_app_topup ON reminders (expanded_until)
	WHERE rrule IS NOT NULL AND deleted_at IS NULL AND kind IN ({APP_KINDS})
""",
    """
CREATE TRIGGER reminders_sync_seq BEFORE INSERT OR UPDATE ON reminders
FOR EACH ROW EXECUTE FUNCTION sync_seq_bump()
""",
    """
CREATE TABLE reminder_fires (
	id BIGSERIAL PRIMARY KEY,
	public_id UUID DEFAULT gen_random_uuid() NOT NULL,
	user_id BIGINT NOT NULL,
	reminder_id BIGINT NOT NULL,
	occurrence_at TIMESTAMP WITH TIME ZONE NOT NULL,
	fire_at TIMESTAMP WITH TIME ZONE NOT NULL,
	offset_min INTEGER DEFAULT 0 NOT NULL,
	repeat_n INTEGER DEFAULT 0 NOT NULL,
	snooze_n INTEGER DEFAULT 0 NOT NULL,
	state TEXT DEFAULT 'planned' NOT NULL,
	push_fallback_at TIMESTAMP WITH TIME ZONE NOT NULL,
	push_sent_at TIMESTAMP WITH TIME ZONE,
	missed_at TIMESTAMP WITH TIME ZONE NOT NULL,
	fired_at TIMESTAMP WITH TIME ZONE,
	acked_at TIMESTAMP WITH TIME ZONE,
	target_device_id BIGINT,
	seq BIGINT DEFAULT 0 NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	CONSTRAINT uq_reminder_fires_public_id UNIQUE (public_id),
	CONSTRAINT uq_reminder_fires_key UNIQUE (reminder_id, occurrence_at, offset_min, snooze_n),
	CONSTRAINT fk_reminder_fires_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
	CONSTRAINT fk_reminder_fires_reminder FOREIGN KEY (reminder_id)
		REFERENCES reminders (id) ON DELETE CASCADE,
	CONSTRAINT fk_reminder_fires_device FOREIGN KEY (target_device_id)
		REFERENCES devices (id) ON DELETE SET NULL,
	CONSTRAINT ck_reminder_fires_state CHECK (
		state IN ('planned', 'fired', 'acked', 'snoozed', 'missed', 'cancelled')),
	CONSTRAINT ck_reminder_fires_offset CHECK (offset_min BETWEEN 0 AND 10080),
	CONSTRAINT ck_reminder_fires_repeat CHECK (repeat_n BETWEEN 0 AND 3),
	CONSTRAINT ck_reminder_fires_snooze CHECK (snooze_n >= 0),
	CONSTRAINT ck_reminder_fires_times CHECK (
		push_fallback_at > fire_at AND missed_at > push_fallback_at)
)
""",
    "CREATE INDEX ix_reminder_fires_user_seq ON reminder_fires (user_id, seq)",
    "CREATE INDEX ix_reminder_fires_user_fire_at ON reminder_fires (user_id, fire_at)",
    "CREATE INDEX ix_reminder_fires_reminder ON reminder_fires (reminder_id, occurrence_at)",
    """
CREATE INDEX ix_reminder_fires_backup ON reminder_fires (push_fallback_at)
	WHERE state = 'planned' AND push_sent_at IS NULL
""",
    """
CREATE INDEX ix_reminder_fires_missed ON reminder_fires (missed_at)
	WHERE state IN ('planned', 'fired')
""",
    """
CREATE TRIGGER reminder_fires_sync_seq BEFORE INSERT OR UPDATE ON reminder_fires
FOR EACH ROW EXECUTE FUNCTION sync_seq_bump()
""",
    f"""
CREATE TABLE reminder_events (
	id BIGSERIAL PRIMARY KEY,
	fire_id BIGINT NOT NULL,
	user_id BIGINT NOT NULL,
	device_id BIGINT,
	client_id UUID,
	event TEXT NOT NULL,
	at TIMESTAMP WITH TIME ZONE NOT NULL,
	received_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	meta JSONB DEFAULT '{{}}'::jsonb NOT NULL,
	CONSTRAINT uq_reminder_events_client UNIQUE (fire_id, client_id),
	CONSTRAINT fk_reminder_events_fire FOREIGN KEY (fire_id)
		REFERENCES reminder_fires (id) ON DELETE CASCADE,
	CONSTRAINT fk_reminder_events_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
	CONSTRAINT fk_reminder_events_device FOREIGN KEY (device_id)
		REFERENCES devices (id) ON DELETE SET NULL,
	CONSTRAINT ck_reminder_events_event CHECK (event IN ({EVENTS})),
	CONSTRAINT ck_reminder_events_meta CHECK (jsonb_typeof(meta) = 'object')
)
""",
    "CREATE INDEX ix_reminder_events_fire ON reminder_events (fire_id, at)",
    "CREATE INDEX ix_reminder_events_at ON reminder_events (at)",
]

DOWN = [
    "DROP TABLE IF EXISTS reminder_events",
    "DROP TABLE IF EXISTS reminder_fires",
    "DROP TRIGGER IF EXISTS reminders_sync_seq ON reminders",
    # App reminders do not exist before 0013; bot rows are kept.
    f"DELETE FROM reminders WHERE kind IN ({APP_KINDS})",
    "DROP INDEX IF EXISTS ix_reminders_app_topup",
    "DROP INDEX IF EXISTS ix_reminders_user_seq",
    """
ALTER TABLE reminders
	DROP CONSTRAINT IF EXISTS ck_reminders_bot_row,
	DROP CONSTRAINT IF EXISTS ck_reminders_app_row,
	DROP CONSTRAINT IF EXISTS ck_reminders_version,
	DROP CONSTRAINT IF EXISTS ck_reminders_offsets,
	DROP CONSTRAINT IF EXISTS ck_reminders_sensitivity,
	DROP CONSTRAINT IF EXISTS ck_reminders_parse_source,
	DROP CONSTRAINT IF EXISTS ck_reminders_created_via,
	DROP CONSTRAINT IF EXISTS ck_reminders_level,
	DROP CONSTRAINT IF EXISTS ck_reminders_status,
	DROP CONSTRAINT IF EXISTS fk_reminders_item,
	DROP CONSTRAINT IF EXISTS uq_reminders_user_client,
	DROP CONSTRAINT IF EXISTS uq_reminders_public_id,
	DROP COLUMN IF EXISTS deleted_at,
	DROP COLUMN IF EXISTS updated_at,
	DROP COLUMN IF EXISTS seq,
	DROP COLUMN IF EXISTS version,
	DROP COLUMN IF EXISTS expanded_until,
	DROP COLUMN IF EXISTS snooze_until,
	DROP COLUMN IF EXISTS sensitivity,
	DROP COLUMN IF EXISTS parse_source,
	DROP COLUMN IF EXISTS created_via,
	DROP COLUMN IF EXISTS level,
	DROP COLUMN IF EXISTS offsets,
	DROP COLUMN IF EXISTS rrule,
	DROP COLUMN IF EXISTS tz,
	DROP COLUMN IF EXISTS body,
	DROP COLUMN IF EXISTS title,
	DROP COLUMN IF EXISTS item_id,
	DROP COLUMN IF EXISTS client_id,
	DROP COLUMN IF EXISTS public_id
""",
    "ALTER TABLE reminders ALTER COLUMN text SET NOT NULL",
    f"CREATE TYPE reminderstatus AS ENUM ({BOT_STATUSES})",
    "ALTER TABLE reminders ALTER COLUMN status TYPE reminderstatus USING status::reminderstatus",
]


def upgrade() -> None:
    for stmt in UP:  # one statement per execute(): asyncpg rejects batches
        op.execute(stmt)


def downgrade() -> None:
    for stmt in DOWN:
        op.execute(stmt)
