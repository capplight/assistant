"""Conversation and feedback (week 5; spec 3-engineering 3.7, 3.13, 6.11).

- `conversations`: one `main` conversation per person (UNIQUE(user_id, kind)). `summary` is the
  folded history (week 6, CHAT_SUMMARIZE): only the person's phrases and the answers, never
  `untrusted_data`.
- `conversation_messages`: spec fields, plus (additive):
  `state` (pending|done|deferred|failed: the answer is written in the background and a dropped
  stream resumes from it), `reply_to_id` (answer -> the person's message), `checked` (number/date
  verification result, R-36), `error_code`, `updated_at`. `client_id` is unique per conversation:
  a repeated send does not ask twice.
  `screen_id` is ON DELETE SET NULL: removing a page keeps the conversation.
  Hard delete («Очистить переписку»), so no `seq`/tombstones yet: sync of messages is not in week 5.
- `feedback` («Сообщить о проблеме», R-41): spec fields, plus `public_id` and `client_id`
  (idempotent repeat). `target_ref` is the target's public id; no FK: the targets live in several
  tables, some not built yet (kp, reminders).

Frozen SQL, no create_all.

Revision ID: 0010
Revises: 0009
"""

from alembic import op

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None

UP = [
    """
CREATE TABLE conversations (
	id BIGSERIAL PRIMARY KEY,
	public_id UUID DEFAULT gen_random_uuid() NOT NULL,
	user_id BIGINT NOT NULL,
	kind TEXT DEFAULT 'main' NOT NULL,
	summary TEXT,
	summary_upto_msg_id BIGINT,
	summary_version INTEGER,
	msg_count INTEGER DEFAULT 0 NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	CONSTRAINT uq_conversations_public_id UNIQUE (public_id),
	CONSTRAINT uq_conversations_user_kind UNIQUE (user_id, kind),
	CONSTRAINT fk_conversations_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
	CONSTRAINT ck_conversations_kind CHECK (kind IN ('main')),
	CONSTRAINT ck_conversations_msg_count CHECK (msg_count >= 0)
)
""",
    """
CREATE TABLE conversation_messages (
	id BIGSERIAL PRIMARY KEY,
	public_id UUID DEFAULT gen_random_uuid() NOT NULL,
	client_id UUID,
	conversation_id BIGINT NOT NULL,
	user_id BIGINT NOT NULL,
	role TEXT NOT NULL,
	reply_to_id BIGINT,
	screen_id BIGINT,
	input_kind TEXT,
	content TEXT DEFAULT '' NOT NULL,
	answer_kind TEXT,
	state TEXT DEFAULT 'done' NOT NULL,
	tool_calls JSONB DEFAULT '[]'::jsonb NOT NULL,
	tool_results_ref JSONB DEFAULT '[]'::jsonb NOT NULL,
	citations JSONB DEFAULT '[]'::jsonb NOT NULL,
	checked JSONB,
	action_ids BIGINT[] DEFAULT '{}' NOT NULL,
	pending_action_ids BIGINT[] DEFAULT '{}' NOT NULL,
	delivery TEXT,
	push_sent_at TIMESTAMP WITH TIME ZONE,
	ai_generated BOOLEAN DEFAULT false NOT NULL,
	prompt_version TEXT,
	cost_usd NUMERIC(12, 6) DEFAULT 0 NOT NULL,
	error_code TEXT,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	deleted_at TIMESTAMP WITH TIME ZONE,
	CONSTRAINT uq_conversation_messages_public_id UNIQUE (public_id),
	CONSTRAINT uq_conversation_messages_client UNIQUE (conversation_id, client_id),
	CONSTRAINT fk_conversation_messages_conversation FOREIGN KEY (conversation_id)
		REFERENCES conversations (id) ON DELETE CASCADE,
	CONSTRAINT fk_conversation_messages_user FOREIGN KEY (user_id)
		REFERENCES users (id) ON DELETE CASCADE,
	CONSTRAINT fk_conversation_messages_reply_to FOREIGN KEY (reply_to_id)
		REFERENCES conversation_messages (id) ON DELETE SET NULL,
	CONSTRAINT fk_conversation_messages_screen FOREIGN KEY (screen_id)
		REFERENCES screens (id) ON DELETE SET NULL,
	CONSTRAINT ck_conversation_messages_role CHECK (role IN ('user', 'assistant', 'tool')),
	CONSTRAINT ck_conversation_messages_input_kind CHECK (
		input_kind IS NULL OR input_kind IN ('typed', 'voice', 'share')),
	CONSTRAINT ck_conversation_messages_answer_kind CHECK (
		answer_kind IS NULL OR answer_kind IN ('action', 'text', 'choice', 'deferred')),
	CONSTRAINT ck_conversation_messages_state CHECK (
		state IN ('pending', 'done', 'deferred', 'failed')),
	CONSTRAINT ck_conversation_messages_delivery CHECK (delivery IS NULL OR delivery IN (
		'streamed', 'banner_pending', 'banner_shown', 'opened', 'dismissed')),
	CONSTRAINT ck_conversation_messages_cost CHECK (cost_usd >= 0)
)
""",
    "CREATE INDEX ix_conversation_messages_conv_id ON conversation_messages (conversation_id, id)",
    """
CREATE INDEX ix_conversation_messages_banner ON conversation_messages (user_id, id)
WHERE delivery = 'banner_pending'
""",
    """
CREATE INDEX ix_conversation_messages_pending ON conversation_messages (created_at)
WHERE state = 'pending'
""",
    """
CREATE TABLE feedback (
	id BIGSERIAL PRIMARY KEY,
	public_id UUID DEFAULT gen_random_uuid() NOT NULL,
	client_id UUID,
	user_id BIGINT NOT NULL,
	target TEXT NOT NULL,
	target_ref UUID NOT NULL,
	reason TEXT NOT NULL,
	comment TEXT,
	allow_anonymized_example BOOLEAN DEFAULT false NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	CONSTRAINT uq_feedback_public_id UNIQUE (public_id),
	CONSTRAINT uq_feedback_user_client UNIQUE (user_id, client_id),
	CONSTRAINT fk_feedback_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
	CONSTRAINT ck_feedback_target CHECK (target IN ('answer', 'kp', 'item', 'reminder')),
	CONSTRAINT ck_feedback_reason CHECK (reason IN ('wrong', 'offensive', 'other')),
	CONSTRAINT ck_feedback_comment CHECK (comment IS NULL OR char_length(comment) <= 1000)
)
""",
    "CREATE INDEX ix_feedback_user ON feedback (user_id, created_at)",
]

DOWN = [
    "DROP TABLE IF EXISTS feedback",
    "DROP TABLE IF EXISTS conversation_messages",
    "DROP TABLE IF EXISTS conversations",
]


def upgrade() -> None:
    for stmt in UP:
        op.execute(stmt)


def downgrade() -> None:
    for stmt in DOWN:
        op.execute(stmt)
