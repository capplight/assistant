"""AI layer: provider_usage (monthly partitions), budgets, usage_counters, ai_provider_state.

Frozen SQL, no create_all. Enums are text + CHECK. Spec 3-engineering 3.8 / 5.3 / 5.4.

Revision ID: 0005
Revises: 0004
"""
from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None

OUTCOMES = ("'ok', 'rate_limited', 'quota', 'server_error', 'timeout', 'invalid_output', "
            "'refused', 'circuit_open', 'budget_blocked', 'consent_blocked'")
CLASSES = "'background', 'answers', 'documents', 'import'"
COUNTERS = ("'items', 'questions', 'kp', 'kp_strong_today', 'voice_minutes', 'import_items', "
            "'storage_bytes', 'chat_turns', 'ai_reorders', 'statement_imports'")

TABLES = f"""
CREATE TABLE provider_usage (
	id BIGSERIAL NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	user_id BIGINT,
	task TEXT NOT NULL,
	budget_class TEXT NOT NULL,
	provider TEXT NOT NULL,
	model TEXT NOT NULL,
	request_id TEXT,
	tokens_in INTEGER DEFAULT 0 NOT NULL,
	tokens_out INTEGER DEFAULT 0 NOT NULL,
	cached_in INTEGER DEFAULT 0 NOT NULL,
	cache_write_in INTEGER DEFAULT 0 NOT NULL,
	audio_seconds NUMERIC(10, 2),
	images INTEGER DEFAULT 0 NOT NULL,
	cost_usd NUMERIC(12, 6) DEFAULT 0 NOT NULL,
	latency_ms INTEGER,
	outcome TEXT NOT NULL,
	fallback_from TEXT,
	attempt INTEGER DEFAULT 1 NOT NULL,
	job_id BIGINT,
	prompt_version TEXT,
	error_kind TEXT,
	PRIMARY KEY (id, created_at),
	CONSTRAINT ck_provider_usage_outcome CHECK (outcome IN ({OUTCOMES})),
	CONSTRAINT ck_provider_usage_budget_class CHECK (budget_class IN ({CLASSES})),
	CONSTRAINT ck_provider_usage_tokens CHECK (
		tokens_in >= 0 AND tokens_out >= 0 AND cached_in >= 0 AND cache_write_in >= 0),
	CONSTRAINT ck_provider_usage_cost CHECK (cost_usd >= 0)
) PARTITION BY RANGE (created_at);

CREATE TABLE provider_usage_default PARTITION OF provider_usage DEFAULT;

CREATE INDEX ix_provider_usage_user_created ON provider_usage (user_id, created_at);

CREATE INDEX ix_provider_usage_provider_created ON provider_usage (provider, created_at);

CREATE TABLE budgets (
	scope TEXT NOT NULL,
	key TEXT NOT NULL,
	class TEXT NOT NULL,
	period TEXT NOT NULL,
	period_start TIMESTAMP WITH TIME ZONE NOT NULL,
	limit_usd NUMERIC(12, 6),
	spent_usd NUMERIC(12, 6) DEFAULT 0 NOT NULL,
	state TEXT DEFAULT 'ok' NOT NULL,
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	PRIMARY KEY (scope, key, class, period, period_start),
	CONSTRAINT ck_budgets_scope CHECK (
		scope IN ('user', 'provider', 'fallback_provider', 'global')),
	CONSTRAINT ck_budgets_class CHECK (class IN ({CLASSES}, 'all')),
	CONSTRAINT ck_budgets_period CHECK (period IN ('day', 'month', 'once')),
	CONSTRAINT ck_budgets_state CHECK (state IN ('ok', 'warn', 'off')),
	CONSTRAINT ck_budgets_spent CHECK (spent_usd >= 0)
);

CREATE TABLE usage_counters (
	user_id BIGINT NOT NULL,
	period_start TIMESTAMP WITH TIME ZONE NOT NULL,
	counter TEXT NOT NULL,
	value BIGINT DEFAULT 0 NOT NULL,
	PRIMARY KEY (user_id, period_start, counter),
	CONSTRAINT ck_usage_counters_counter CHECK (counter IN ({COUNTERS})),
	CONSTRAINT ck_usage_counters_value CHECK (value >= 0),
	FOREIGN KEY(user_id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE ai_provider_state (
	provider TEXT NOT NULL,
	state TEXT DEFAULT 'ok' NOT NULL,
	reason TEXT,
	changed_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	PRIMARY KEY (provider),
	CONSTRAINT ck_ai_provider_state_state CHECK (state IN ('ok', 'off'))
)
"""


def _month_partitions() -> list[str]:
    """2026-11 .. 2027-12 (UTC bounds). Later months: ai.store.ensure_usage_partitions."""
    out = []
    y, m = 2026, 11
    while (y, m) <= (2027, 12):
        ny, nm = (y + 1, 1) if m == 12 else (y, m + 1)
        out.append(
            f"CREATE TABLE provider_usage_{y}_{m:02d} PARTITION OF provider_usage "
            f"FOR VALUES FROM ('{y}-{m:02d}-01 00:00:00+00') TO ('{ny}-{nm:02d}-01 00:00:00+00')"
        )
        y, m = ny, nm
    return out


def upgrade() -> None:
    for stmt in TABLES.split(";\n\n"):
        if stmt.strip():
            op.execute(stmt.strip().rstrip(";"))
    for stmt in _month_partitions():
        op.execute(stmt)


def downgrade() -> None:
    for table in ["ai_provider_state", "usage_counters", "budgets", "provider_usage"]:
        op.execute(f"DROP TABLE IF EXISTS {table} CASCADE")
