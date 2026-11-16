"""Compact memory about the person (Ф-59…Ф-61, Ф-70) and search over the whole conversation.

- `memory_facts`: short facts (people, places, preferences, routines, ongoing projects,
  agreements), one line each, from the person's phrases (`source = 'said'`) or their saved
  materials (`'material'`, «из материала»). Deduped by `fact_key` per person; `valid_until`
  ends a project («поездка 10–15 дек.»); «забудь …» deletes the row for real. An embedding when
  the embedder is on. Cascades with the account (deletion, R-…), exported with the data.
- `usage_counters.counter` may be `memory_runs` (the daily cap of background reads).
- `conversations.memory_upto_msg_id` / `memory_upto_item_id`: how far the background extraction
  (`chat:memory`) has read the phrases and the saved materials.
- `conversation_messages.tsv` (generated, 'russian' config) + GIN, and `message_embeddings`
  (bge-m3 when on, HNSW; a table of its own so an embedding never bumps the message's sync
  `seq`): past turns found by words now and by meaning when embeddings are on.

Frozen SQL, no create_all.

Revision ID: 0030
Revises: 0029
"""

from alembic import op

revision = "0030"
down_revision = "0029"
branch_labels = None
depends_on = None

_COUNTERS = ("'items', 'questions', 'kp', 'kp_strong_today', 'voice_minutes', 'import_items', "
             "'storage_bytes', 'chat_turns', 'ai_reorders', 'statement_imports'")


def _counters(extra: str = "") -> str:
    return ("ALTER TABLE usage_counters ADD CONSTRAINT ck_usage_counters_counter "
            f"CHECK (counter IN ({_COUNTERS}{extra}))")


UPGRADE = [
    # the daily cap of background memory reads (chat/memory.py MEMORY_RUNS_PER_DAY)
    "ALTER TABLE usage_counters DROP CONSTRAINT ck_usage_counters_counter",
    _counters(", 'memory_runs'"),
    """
CREATE TABLE memory_facts (
    id bigserial PRIMARY KEY,
    public_id uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind text NOT NULL,
    text text NOT NULL,
    fact_key text NOT NULL,
    source text NOT NULL DEFAULT 'said',
    source_message_id bigint REFERENCES conversation_messages(id) ON DELETE SET NULL,
    source_item_id bigint REFERENCES items(id) ON DELETE SET NULL,
    mentions integer NOT NULL DEFAULT 1,
    valid_until date,
    embedding vector(1024),
    embedding_model text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_memory_facts_kind CHECK (kind IN ('person', 'place', 'preference', 'routine',
                                                    'project', 'agreement', 'other')),
    CONSTRAINT ck_memory_facts_source CHECK (source IN ('said', 'material')),
    CONSTRAINT ck_memory_facts_text CHECK (char_length(text) BETWEEN 1 AND 200),
    CONSTRAINT uq_memory_facts_key UNIQUE (user_id, fact_key)
)""",
    "CREATE INDEX ix_memory_facts_user ON memory_facts (user_id, last_seen_at DESC)",
    "ALTER TABLE conversations ADD COLUMN memory_upto_msg_id bigint",
    "ALTER TABLE conversations ADD COLUMN memory_upto_item_id bigint",
    """ALTER TABLE conversation_messages ADD COLUMN tsv tsvector
       GENERATED ALWAYS AS (to_tsvector('russian', coalesce(content, ''))) STORED""",
    "CREATE INDEX ix_conversation_messages_tsv ON conversation_messages USING gin (tsv)",
    """
CREATE TABLE message_embeddings (
    message_id bigint PRIMARY KEY REFERENCES conversation_messages(id) ON DELETE CASCADE,
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    embedding vector(1024) NOT NULL,
    embedding_model text NOT NULL,
    embedded_at timestamptz NOT NULL DEFAULT now()
)""",
    "CREATE INDEX ix_message_embeddings_user ON message_embeddings (user_id)",
    """CREATE INDEX ix_message_embeddings_vec ON message_embeddings
       USING hnsw (embedding vector_cosine_ops)""",
]

DOWNGRADE = [
    "DROP TABLE message_embeddings",
    "DROP INDEX IF EXISTS ix_conversation_messages_tsv",
    "ALTER TABLE conversation_messages DROP COLUMN tsv",
    "ALTER TABLE conversations DROP COLUMN memory_upto_item_id",
    "ALTER TABLE conversations DROP COLUMN memory_upto_msg_id",
    "DROP TABLE memory_facts",
    "DELETE FROM usage_counters WHERE counter = 'memory_runs'",
    "ALTER TABLE usage_counters DROP CONSTRAINT ck_usage_counters_counter",
    _counters(),
]


def upgrade() -> None:
    for sql in UPGRADE:
        op.execute(sql)


def downgrade() -> None:
    for sql in DOWNGRADE:
        op.execute(sql)
