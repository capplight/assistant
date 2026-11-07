"""Enrichment (sprint 3, spec 3-engineering 3.3, 5.2, 6.1, 6.2).

- items: enrich_state + enriched_at (enrichment never holds a record back: `status` stays the
  ingest result), ai_fields (which fields the assistant wrote, for the R-06 label),
  recording_id + fragment_no (voice fragments of one recording).
- hidden_reason gains `voice_fragment`: a fragment is stored but shown only through its recording.
- ai_batches / ai_batch_requests: provider batches. No prompt text and no answer is stored here.
- provider_usage.batch: discounted calls are visible in cost reports.
"""

from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
ALTER TABLE items
	ADD COLUMN enrich_state TEXT,
	ADD COLUMN enriched_at TIMESTAMP WITH TIME ZONE,
	ADD COLUMN ai_fields JSONB DEFAULT '[]' NOT NULL,
	ADD COLUMN recording_id UUID,
	ADD COLUMN fragment_no INTEGER,
	ADD CONSTRAINT ck_items_enrich_state CHECK (enrich_state IN (
		'pending', 'queued_batch', 'done', 'no_consent', 'deferred_budget', 'failed', 'skipped')),
	ADD CONSTRAINT ck_items_fragment_no CHECK (fragment_no >= 0)
""")
    op.execute("ALTER TABLE items DROP CONSTRAINT ck_items_hidden_reason")
    op.execute("""
ALTER TABLE items ADD CONSTRAINT ck_items_hidden_reason CHECK (
	hidden_reason IN ('duplicate_merged', 'trashed', 'voice_fragment'))
""")
    op.execute("""
CREATE INDEX ix_items_recording ON items (user_id, recording_id, fragment_no)
	WHERE recording_id IS NOT NULL
""")
    op.execute("""
CREATE INDEX ix_items_enrich_state ON items (user_id, enrich_state)
	WHERE enrich_state IN ('no_consent', 'deferred_budget', 'queued_batch')
""")
    op.execute("""
CREATE TABLE ai_batches (
	id BIGSERIAL PRIMARY KEY,
	provider TEXT NOT NULL,
	model TEXT NOT NULL,
	task TEXT NOT NULL,
	provider_batch_id TEXT UNIQUE,
	status TEXT DEFAULT 'submitting' NOT NULL,
	request_count INTEGER DEFAULT 0 NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	deadline_at TIMESTAMP WITH TIME ZONE NOT NULL,
	next_poll_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	ended_at TIMESTAMP WITH TIME ZONE,
	error_kind TEXT,
	CONSTRAINT ck_ai_batches_status CHECK (status IN (
		'submitting', 'in_progress', 'canceling', 'ended', 'failed'))
)
""")
    op.execute("""
CREATE INDEX ix_ai_batches_open ON ai_batches (next_poll_at)
	WHERE status IN ('submitting', 'in_progress', 'canceling')
""")
    op.execute("""
CREATE TABLE ai_batch_requests (
	id BIGSERIAL PRIMARY KEY,
	batch_id BIGINT REFERENCES ai_batches (id) ON DELETE SET NULL,
	task TEXT NOT NULL,
	item_id BIGINT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
	user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	state TEXT DEFAULT 'queued' NOT NULL,
	payload_sha256 TEXT,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	done_at TIMESTAMP WITH TIME ZONE,
	CONSTRAINT ck_ai_batch_requests_state CHECK (state IN (
		'queued', 'submitted', 'done', 'failed', 'superseded'))
)
""")
    op.execute("""
CREATE UNIQUE INDEX uq_ai_batch_requests_open ON ai_batch_requests (item_id, task)
	WHERE state IN ('queued', 'submitted')
""")
    op.execute("""
CREATE INDEX ix_ai_batch_requests_queued ON ai_batch_requests (created_at)
	WHERE state = 'queued'
""")
    op.execute("CREATE INDEX ix_ai_batch_requests_batch ON ai_batch_requests (batch_id)")
    op.execute("ALTER TABLE provider_usage ADD COLUMN batch BOOLEAN DEFAULT false NOT NULL")


def downgrade() -> None:
    op.execute("ALTER TABLE provider_usage DROP COLUMN batch")
    op.execute("DROP TABLE ai_batch_requests")
    op.execute("DROP TABLE ai_batches")
    op.execute("DROP INDEX ix_items_enrich_state")
    op.execute("DROP INDEX ix_items_recording")
    op.execute("ALTER TABLE items DROP CONSTRAINT ck_items_hidden_reason")
    # Fragments have no place in the old schema: keep the rows hidden.
    op.execute("UPDATE items SET hidden_reason = 'trashed' WHERE hidden_reason = 'voice_fragment'")
    op.execute("""
ALTER TABLE items ADD CONSTRAINT ck_items_hidden_reason CHECK (
	hidden_reason IN ('duplicate_merged', 'trashed'))
""")
    op.execute("""
ALTER TABLE items
	DROP CONSTRAINT ck_items_fragment_no,
	DROP CONSTRAINT ck_items_enrich_state,
	DROP COLUMN fragment_no,
	DROP COLUMN recording_id,
	DROP COLUMN ai_fields,
	DROP COLUMN enriched_at,
	DROP COLUMN enrich_state
""")
