"""Items become the app's record entity; sync_seq + tombstones; job idempotency keys.

Expand-only (spec 3-engineering 3.3, 3.9): legacy travel columns and tables stay, so the
Telegram bot keeps working until the 0007-style contract migration. Changes:

- items.kind/source/status: Postgres ENUM -> text + CHECK. The CHECK allows the new values
  (spec 3.3) *and* the legacy ones the bot still writes (photo, done, instagram, ...); the API
  maps legacy values on output. Legacy rows are not rewritten.
- items.telegram_chat_id/message_id -> nullable (copied into source_meta for legacy rows).
- New item columns: public_id (UUIDv7 from the app, v4 backfill), client_id + UNIQUE(user_id,
  client_id), text, text_lang, envelope(+version), review_fields, merged_fragments, source_meta,
  occurred_at, content_hash, original_sha256, simhash, canonical_item_id, hidden_reason,
  ai_generated, seq, updated_at, deleted_at, purge_after.
- Shared sequence `sync_seq`; trigger `sync_seq_bump()` sets NEW.seq on every insert/update.
  It first takes a per-user transaction advisory lock, so for one user seq order == commit
  order and `GET /sync?since=` can never skip a row committed late with a lower seq.
- `sync_tombstones`: hard deletes (trash purge after 30 days) leave a tombstone with its own seq.
- items_tsv also indexes the new canonical `text`.
- jobs.idempotency_key (nullable, UNIQUE): `item:<id>:ingest:v<n>` (spec 6.1).

Frozen SQL, no create_all.

Revision ID: 0004
Revises: 0003
"""

from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None

LEGACY_KINDS = ["text", "link", "photo", "video", "document", "voice"]
LEGACY_SOURCES = ["instagram", "tiktok", "telegram", "whatsapp", "youtube", "web", "user"]
LEGACY_STATUSES = ["pending", "processing", "done", "needs_input", "failed"]

KINDS = [
    "note",
    "voice",
    "image",
    "screenshot",
    "pdf",
    "docx",
    "xlsx",
    "link",
    "email",
    "tg_message",
    "kp",
    "file_other",
]
SOURCES = ["typed", "mic", "share", "camera", "files", "import_telegram", "bot_forward", "system"]
STATUSES = ["pending", "processing", "ready", "needs_review", "needs_consent", "failed"]


def _in(values: list[str]) -> str:
    return ", ".join(f"'{v}'" for v in dict.fromkeys(values))


ITEMS = f"""
ALTER TABLE items
	ALTER COLUMN kind TYPE TEXT USING kind::text,
	ALTER COLUMN source TYPE TEXT USING source::text,
	ALTER COLUMN status TYPE TEXT USING status::text,
	ALTER COLUMN status SET DEFAULT 'pending',
	ALTER COLUMN telegram_chat_id DROP NOT NULL,
	ALTER COLUMN telegram_message_id DROP NOT NULL;

ALTER TABLE items
	ADD COLUMN public_id UUID DEFAULT gen_random_uuid() NOT NULL,
	ADD COLUMN client_id UUID,
	ADD COLUMN text TEXT,
	ADD COLUMN text_lang TEXT,
	ADD COLUMN envelope JSONB,
	ADD COLUMN envelope_version INTEGER,
	ADD COLUMN review_fields JSONB DEFAULT '{{}}' NOT NULL,
	ADD COLUMN merged_fragments JSONB DEFAULT '[]' NOT NULL,
	ADD COLUMN source_meta JSONB DEFAULT '{{}}' NOT NULL,
	ADD COLUMN occurred_at TIMESTAMP WITH TIME ZONE,
	ADD COLUMN content_hash TEXT,
	ADD COLUMN original_sha256 TEXT,
	ADD COLUMN simhash BIGINT,
	ADD COLUMN canonical_item_id BIGINT,
	ADD COLUMN hidden_reason TEXT,
	ADD COLUMN ai_generated BOOLEAN DEFAULT false NOT NULL,
	ADD COLUMN seq BIGINT,
	ADD COLUMN updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	ADD COLUMN deleted_at TIMESTAMP WITH TIME ZONE,
	ADD COLUMN purge_after TIMESTAMP WITH TIME ZONE,
	ADD CONSTRAINT uq_items_public_id UNIQUE (public_id),
	ADD CONSTRAINT uq_items_user_client UNIQUE (user_id, client_id),
	ADD CONSTRAINT fk_items_canonical FOREIGN KEY (canonical_item_id)
		REFERENCES items (id) ON DELETE SET NULL,
	ADD CONSTRAINT ck_items_kind CHECK (kind IN ({_in(KINDS + LEGACY_KINDS)})),
	ADD CONSTRAINT ck_items_source CHECK (source IN ({_in(SOURCES + LEGACY_SOURCES)})),
	ADD CONSTRAINT ck_items_status CHECK (status IN ({_in(STATUSES + LEGACY_STATUSES)})),
	ADD CONSTRAINT ck_items_hidden_reason CHECK (
		hidden_reason IN ('duplicate_merged', 'trashed')),
	ADD CONSTRAINT ck_items_text_lang CHECK (text_lang IN ('ru', 'kk', 'en', 'other')),
	ADD CONSTRAINT ck_items_content_hash CHECK (content_hash ~ '^[0-9a-f]{{64}}$'),
	ADD CONSTRAINT ck_items_original_sha256 CHECK (original_sha256 ~ '^[0-9a-f]{{64}}$'),
	ADD CONSTRAINT ck_items_trash CHECK (deleted_at IS NULL OR purge_after IS NOT NULL),
	ADD CONSTRAINT ck_items_canonical_not_self CHECK (canonical_item_id <> id);

UPDATE items SET
	source_meta = jsonb_strip_nulls(jsonb_build_object(
		'telegram_chat_id', telegram_chat_id,
		'telegram_message_id', telegram_message_id,
		'url', url)),
	occurred_at = created_at,
	updated_at = coalesce(processed_at, created_at);

CREATE SEQUENCE sync_seq AS BIGINT;

UPDATE items i SET seq = o.n
FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM items) o
WHERE i.id = o.id;

SELECT setval('sync_seq', greatest((SELECT max(seq) FROM items), 1));

ALTER TABLE items ALTER COLUMN seq SET NOT NULL;

CREATE INDEX ix_items_user_seq ON items (user_id, seq);

CREATE INDEX ix_items_user_content_hash ON items (user_id, content_hash);

CREATE INDEX ix_items_user_original_sha256 ON items (user_id, original_sha256);

CREATE INDEX ix_items_user_occurred_at ON items (user_id, occurred_at);

CREATE INDEX ix_items_canonical ON items (canonical_item_id);

CREATE INDEX ix_items_purge_due ON items (purge_after) WHERE deleted_at IS NOT NULL;

CREATE TABLE sync_tombstones (
	id BIGSERIAL NOT NULL,
	user_id BIGINT NOT NULL,
	entity TEXT NOT NULL,
	public_id UUID NOT NULL,
	seq BIGINT NOT NULL,
	deleted_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	PRIMARY KEY (id),
	CONSTRAINT ck_sync_tombstones_entity CHECK (entity IN ('item'))
);

CREATE INDEX ix_sync_tombstones_user_seq ON sync_tombstones (user_id, seq);

ALTER TABLE jobs ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX uq_jobs_idempotency_key ON jobs (idempotency_key)
	WHERE idempotency_key IS NOT NULL
"""

# One statement per execute(): asyncpg prepares each one and rejects batches.
# No FK from sync_tombstones to users: rows are written while an account cascade deletes items.
FUNCTIONS = [
    """
CREATE FUNCTION sync_lock_user(uid BIGINT) RETURNS void AS $$
BEGIN
  -- Per-user, per-transaction: writers of one user's synced rows commit in seq order.
  PERFORM pg_advisory_xact_lock(1937337, (uid % 2147483647)::int);
END $$ LANGUAGE plpgsql
""",
    """
CREATE FUNCTION sync_seq_bump() RETURNS trigger AS $$
BEGIN
  PERFORM sync_lock_user(NEW.user_id);
  NEW.seq := nextval('sync_seq');
  RETURN NEW;
END $$ LANGUAGE plpgsql
""",
    """
CREATE TRIGGER items_sync_seq BEFORE INSERT OR UPDATE ON items
FOR EACH ROW EXECUTE FUNCTION sync_seq_bump()
""",
    """
CREATE FUNCTION sync_tombstone_item() RETURNS trigger AS $$
BEGIN
  PERFORM sync_lock_user(OLD.user_id);
  INSERT INTO sync_tombstones (user_id, entity, public_id, seq)
  VALUES (OLD.user_id, 'item', OLD.public_id, nextval('sync_seq'));
  RETURN OLD;
END $$ LANGUAGE plpgsql
""",
    """
CREATE TRIGGER items_sync_tombstone AFTER DELETE ON items
FOR EACH ROW EXECUTE FUNCTION sync_tombstone_item()
""",
    """
CREATE OR REPLACE FUNCTION items_tsv_update() RETURNS trigger AS $$
BEGIN
  NEW.tsv := setweight(to_tsvector('simple', coalesce(NEW.title, '')), 'A')
          || setweight(to_tsvector('simple', coalesce(NEW.summary, '')), 'B')
          || setweight(to_tsvector('simple', coalesce(NEW.raw_text, '')), 'C')
          || setweight(to_tsvector('simple', CASE WHEN NEW.text IS DISTINCT FROM NEW.raw_text
                                                 THEN coalesce(NEW.text, '') ELSE '' END), 'C');
  RETURN NEW;
END $$ LANGUAGE plpgsql
""",
    "DROP TRIGGER items_tsv ON items",
    """
CREATE TRIGGER items_tsv BEFORE INSERT OR UPDATE OF title, summary, raw_text, text ON items
FOR EACH ROW EXECUTE FUNCTION items_tsv_update()
""",
]

OLD_TSV = [
    """
CREATE OR REPLACE FUNCTION items_tsv_update() RETURNS trigger AS $$
BEGIN
  NEW.tsv := setweight(to_tsvector('simple', coalesce(NEW.title, '')), 'A')
          || setweight(to_tsvector('simple', coalesce(NEW.summary, '')), 'B')
          || setweight(to_tsvector('simple', coalesce(NEW.raw_text, '')), 'C');
  RETURN NEW;
END $$ LANGUAGE plpgsql
""",
    "DROP TRIGGER items_tsv ON items",
    """
CREATE TRIGGER items_tsv BEFORE INSERT OR UPDATE OF title, summary, raw_text ON items
FOR EACH ROW EXECUTE FUNCTION items_tsv_update()
""",
]

NEW_COLUMNS = [
    "public_id",
    "client_id",
    "text",
    "text_lang",
    "envelope",
    "envelope_version",
    "review_fields",
    "merged_fragments",
    "source_meta",
    "occurred_at",
    "content_hash",
    "original_sha256",
    "simhash",
    "canonical_item_id",
    "hidden_reason",
    "ai_generated",
    "seq",
    "updated_at",
    "deleted_at",
    "purge_after",
]


def upgrade() -> None:
    for stmt in ITEMS.split(";\n\n"):
        if stmt.strip():
            op.execute(stmt.strip().rstrip(";"))
    for stmt in FUNCTIONS:
        op.execute(stmt)


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS items_sync_tombstone ON items")
    op.execute("DROP TRIGGER IF EXISTS items_sync_seq ON items")
    op.execute("DROP FUNCTION IF EXISTS sync_tombstone_item")
    op.execute("DROP FUNCTION IF EXISTS sync_seq_bump")
    op.execute("DROP FUNCTION IF EXISTS sync_lock_user")
    for stmt in OLD_TSV:
        op.execute(stmt)
    op.execute("DROP TABLE IF EXISTS sync_tombstones")
    op.execute("DROP INDEX IF EXISTS uq_jobs_idempotency_key")
    op.execute("ALTER TABLE jobs DROP COLUMN IF EXISTS idempotency_key")
    # App-only rows cannot exist under 0003 (legacy enums, telegram ids NOT NULL).
    op.execute(
        f"DELETE FROM items WHERE telegram_chat_id IS NULL OR telegram_message_id IS NULL "
        f"OR kind NOT IN ({_in(LEGACY_KINDS)}) OR source NOT IN ({_in(LEGACY_SOURCES)}) "
        f"OR status NOT IN ({_in(LEGACY_STATUSES)})"
    )
    op.execute("ALTER TABLE items " + ", ".join(f"DROP COLUMN {c}" for c in NEW_COLUMNS))
    op.execute("DROP SEQUENCE IF EXISTS sync_seq")
    op.execute(
        "ALTER TABLE items "
        "DROP CONSTRAINT IF EXISTS ck_items_kind, DROP CONSTRAINT IF EXISTS ck_items_source, "
        "DROP CONSTRAINT IF EXISTS ck_items_status, "
        "ALTER COLUMN status DROP DEFAULT, "
        "ALTER COLUMN kind TYPE itemkind USING kind::itemkind, "
        "ALTER COLUMN source TYPE itemsource USING source::itemsource, "
        "ALTER COLUMN status TYPE itemstatus USING status::itemstatus, "
        "ALTER COLUMN telegram_chat_id SET NOT NULL, "
        "ALTER COLUMN telegram_message_id SET NOT NULL"
    )
