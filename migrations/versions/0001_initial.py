"""Initial schema: extensions, all tables, full-text trigger.

The DDL is frozen SQL (generated once from the models), not create_all(): later migrations
must apply on top of exactly this schema.

Revision ID: 0001
Revises:
"""
from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

SCHEMA = """
CREATE TYPE itemkind AS ENUM ('text', 'link', 'photo', 'video', 'document', 'voice');

CREATE TYPE itemsource AS ENUM ('instagram', 'tiktok', 'telegram', 'whatsapp', 'youtube', 'web', 'user');

CREATE TYPE itemstatus AS ENUM ('pending', 'processing', 'done', 'needs_input', 'failed');

CREATE TYPE category AS ENUM ('food', 'beach', 'sight', 'stay', 'transport', 'booking', 'tip', 'shopping', 'other');

CREATE TYPE bookingtype AS ENUM ('flight', 'hotel', 'transfer', 'tour', 'other');

CREATE TYPE reminderstatus AS ENUM ('scheduled', 'sent', 'cancelled', 'failed');

CREATE TYPE jobstatus AS ENUM ('queued', 'running', 'done', 'failed');

CREATE TABLE users (
	id BIGSERIAL NOT NULL, 
	telegram_id BIGINT NOT NULL, 
	first_name VARCHAR(255), 
	language VARCHAR(8) NOT NULL, 
	tz VARCHAR(64) NOT NULL, 
	consent_at TIMESTAMP WITH TIME ZONE, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (id), 
	UNIQUE (telegram_id)
);

CREATE TABLE places (
	id BIGSERIAL NOT NULL, 
	provider VARCHAR(32) NOT NULL, 
	provider_place_id VARCHAR(255) NOT NULL, 
	name VARCHAR(500) NOT NULL, 
	address TEXT, 
	city VARCHAR(255), 
	country VARCHAR(2), 
	tz VARCHAR(64), 
	geom geography(POINT,4326), 
	raw JSONB, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_places_provider UNIQUE (provider, provider_place_id)
);

CREATE INDEX idx_places_geom ON places USING gist (geom);

CREATE TABLE jobs (
	id BIGSERIAL NOT NULL, 
	kind VARCHAR(64) NOT NULL, 
	payload JSONB NOT NULL, 
	status jobstatus NOT NULL, 
	attempts INTEGER NOT NULL, 
	max_attempts INTEGER NOT NULL, 
	run_after TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	locked_at TIMESTAMP WITH TIME ZONE, 
	last_error TEXT, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (id)
);

CREATE INDEX ix_jobs_ready ON jobs (status, run_after);

CREATE TABLE processed_updates (
	update_id BIGSERIAL NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (update_id)
);

CREATE TABLE trips (
	id BIGSERIAL NOT NULL, 
	user_id BIGINT NOT NULL, 
	title VARCHAR(255) NOT NULL, 
	destination VARCHAR(255), 
	starts_on DATE, 
	ends_on DATE, 
	tz VARCHAR(64), 
	is_active BOOLEAN NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE INDEX ix_trips_user_id ON trips (user_id);

CREATE TABLE place_queries (
	query_hash VARCHAR(64) NOT NULL, 
	query TEXT NOT NULL, 
	place_id BIGINT, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (query_hash), 
	FOREIGN KEY(place_id) REFERENCES places (id) ON DELETE CASCADE
);

CREATE TABLE items (
	id BIGSERIAL NOT NULL, 
	user_id BIGINT NOT NULL, 
	trip_id BIGINT, 
	kind itemkind NOT NULL, 
	source itemsource NOT NULL, 
	status itemstatus NOT NULL, 
	raw_text TEXT, 
	url TEXT, 
	url_hash VARCHAR(64), 
	telegram_file_id VARCHAR(255), 
	telegram_chat_id BIGINT NOT NULL, 
	telegram_message_id BIGINT NOT NULL, 
	title VARCHAR(500), 
	summary TEXT, 
	category category, 
	city VARCHAR(255), 
	country VARCHAR(2), 
	extracted JSONB, 
	confidence FLOAT, 
	error TEXT, 
	embedding VECTOR(1024), 
	tsv TSVECTOR, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	processed_at TIMESTAMP WITH TIME ZONE, 
	PRIMARY KEY (id), 
	CONSTRAINT uq_items_user_url UNIQUE (user_id, url_hash), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE, 
	FOREIGN KEY(trip_id) REFERENCES trips (id) ON DELETE SET NULL
);

CREATE INDEX ix_items_tsv ON items USING gin (tsv);

CREATE INDEX ix_items_user_id ON items (user_id);

CREATE INDEX ix_items_trip_id ON items (trip_id);

CREATE INDEX ix_items_embedding ON items USING hnsw (embedding vector_cosine_ops);

CREATE TABLE item_places (
	item_id BIGINT NOT NULL, 
	place_id BIGINT NOT NULL, 
	PRIMARY KEY (item_id, place_id), 
	FOREIGN KEY(item_id) REFERENCES items (id) ON DELETE CASCADE, 
	FOREIGN KEY(place_id) REFERENCES places (id) ON DELETE CASCADE
);

CREATE TABLE bookings (
	id BIGSERIAL NOT NULL, 
	user_id BIGINT NOT NULL, 
	trip_id BIGINT, 
	item_id BIGINT, 
	type bookingtype NOT NULL, 
	title VARCHAR(500) NOT NULL, 
	confirmation_code VARCHAR(64), 
	starts_at TIMESTAMP WITH TIME ZONE, 
	ends_at TIMESTAMP WITH TIME ZONE, 
	tz VARCHAR(64), 
	details JSONB, 
	confirmed_at TIMESTAMP WITH TIME ZONE, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE, 
	FOREIGN KEY(trip_id) REFERENCES trips (id) ON DELETE SET NULL, 
	FOREIGN KEY(item_id) REFERENCES items (id) ON DELETE SET NULL
);

CREATE INDEX ix_bookings_user_id ON bookings (user_id);

CREATE TABLE reminders (
	id BIGSERIAL NOT NULL, 
	user_id BIGINT NOT NULL, 
	trip_id BIGINT, 
	booking_id BIGINT, 
	kind VARCHAR(64) NOT NULL, 
	due_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	text TEXT NOT NULL, 
	payload JSONB, 
	status reminderstatus NOT NULL, 
	attempts INTEGER NOT NULL, 
	sent_at TIMESTAMP WITH TIME ZONE, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (id), 
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE, 
	FOREIGN KEY(trip_id) REFERENCES trips (id) ON DELETE CASCADE, 
	FOREIGN KEY(booking_id) REFERENCES bookings (id) ON DELETE CASCADE
);

CREATE INDEX ix_reminders_booking_id ON reminders (booking_id);

CREATE INDEX ix_reminders_user_id ON reminders (user_id);

CREATE INDEX ix_reminders_due ON reminders (status, due_at);
"""

TSV_TRIGGER = """
CREATE FUNCTION items_tsv_update() RETURNS trigger AS $$
BEGIN
  NEW.tsv := setweight(to_tsvector('simple', coalesce(NEW.title, '')), 'A')
          || setweight(to_tsvector('simple', coalesce(NEW.summary, '')), 'B')
          || setweight(to_tsvector('simple', coalesce(NEW.raw_text, '')), 'C');
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER items_tsv BEFORE INSERT OR UPDATE OF title, summary, raw_text ON items
FOR EACH ROW EXECUTE FUNCTION items_tsv_update();
"""


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")
    op.execute("CREATE EXTENSION IF NOT EXISTS postgis")
    for stmt in SCHEMA.split(";\n\n"):
        if stmt.strip():
            op.execute(stmt.strip().rstrip(";"))
    op.execute(TSV_TRIGGER)


TABLES = ["processed_updates", "jobs", "reminders", "bookings", "place_queries", "item_places",
          "places", "items", "trips", "users"]
ENUMS = ["itemkind", "itemsource", "itemstatus", "category", "bookingtype", "jobstatus",
         "reminderstatus"]


def downgrade() -> None:
    for table in TABLES:
        op.execute(f"DROP TABLE IF EXISTS {table} CASCADE")
    for enum in ENUMS:
        op.execute(f"DROP TYPE IF EXISTS {enum}")
    op.execute("DROP FUNCTION IF EXISTS items_tsv_update")
