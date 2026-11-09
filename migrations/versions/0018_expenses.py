"""«Расходы 1»: expenses, the 8 categories and their order, the keypad expression (week 12; spec
3-engineering 3.12, 4.11, 6.13; proposal template-screens §2.2, §4; contract docs/api/expenses.md).

- `expense_categories`: the system catalogue (`user_id` NULL: the 8 founder-approved categories +
  the hidden service «Переводы»; the 12 of 3-engineering §3.12 are merged into these 8) and the
  person's own rows. Each person gets a copy of the catalogue on first use (`created_by =
  'system'`), so order (`position`, LexoRank), `manual_at` (the person ordered by hand), `pinned`,
  names and hiding are theirs. Own categories: `created_by = 'user'`.
- `expense_entries`: one expense = exact `amount numeric(14,2)` (> 0), currency, the day on the
  person's clock, category, direction; its own record (`item_id`, the trash goes through it).
  `expression` = what was typed on the keys («1200+350»); code computes `amount` from it.
  `statement_import_id` has no FK yet: `statement_imports` comes in week 13 («Расходы 2»).
- `sync_tombstones.entity` + `expense` (a record purged after 30 days in the trash takes its
  expense with it).

Frozen SQL, no create_all.

Revision ID: 0018
Revises: 0017
"""

from alembic import op

revision = "0018"
down_revision = "0017"
branch_labels = None
depends_on = None

# key, title, title_kk, icon, position (frozen copy of lexorank.sequence(9)), service
CATEGORIES = [
    ("groceries", "Продукты", "Азық-түлік", "cart", "6C", False),
    ("home", "Дом и ремонт", "Үй және жөндеу", "home", "CO", False),
    ("transport", "Транспорт", "Көлік", "car", "Ia", False),
    ("health", "Здоровье", "Денсаулық", "health", "Om", False),
    ("family", "Дети и семья", "Балалар және отбасы", "family", "Uy", False),
    ("cafe_gifts", "Кафе и подарки", "Кафе және сыйлықтар", "gift", "bA", False),
    ("utilities", "Коммуналка и связь", "Коммуналдық және байланыс", "bolt", "hM", False),
    ("other", "Другое", "Басқа", "dots", "nY", False),
    ("transfers", "Переводы", "Аударымдар", "transfer", "tk", True),
]

_TOMBS_OLD = "'item', 'screen', 'screen_item', 'conversation_message', 'action', 'task'"
_TOMBS_NEW = _TOMBS_OLD + ", 'expense'"


def _seed() -> str:
    rows = ",\n".join(
        f"\t('{k}', '{t}', '{kk}', '{icon}', '{pos}', {'TRUE' if svc else 'FALSE'})"
        for k, t, kk, icon, pos, svc in CATEGORIES
    )
    return f"""
INSERT INTO expense_categories (key, title, title_kk, icon, position, service, created_by)
SELECT v.key, v.title, v.title_kk, v.icon, v.position, v.service, 'system' FROM (VALUES
{rows}
) AS v (key, title, title_kk, icon, position, service)
"""


UP = [
    """
CREATE TABLE expense_categories (
	id BIGSERIAL PRIMARY KEY,
	public_id UUID DEFAULT gen_random_uuid() NOT NULL,
	client_id UUID,
	user_id BIGINT,
	key TEXT NOT NULL,
	title TEXT NOT NULL,
	title_kk TEXT,
	icon TEXT,
	parent_id BIGINT,
	created_by TEXT NOT NULL,
	service BOOLEAN DEFAULT FALSE NOT NULL,
	position TEXT NOT NULL,
	manual_at TIMESTAMP WITH TIME ZONE,
	pinned BOOLEAN DEFAULT FALSE NOT NULL,
	hidden_at TIMESTAMP WITH TIME ZONE,
	version INTEGER DEFAULT 1 NOT NULL,
	seq BIGINT NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	CONSTRAINT uq_expense_categories_public_id UNIQUE (public_id),
	CONSTRAINT uq_expense_categories_user_client UNIQUE (user_id, client_id),
	CONSTRAINT fk_expense_categories_user FOREIGN KEY (user_id)
		REFERENCES users (id) ON DELETE CASCADE,
	CONSTRAINT fk_expense_categories_parent FOREIGN KEY (parent_id)
		REFERENCES expense_categories (id) ON DELETE SET NULL,
	CONSTRAINT ck_expense_categories_created_by CHECK (created_by IN ('system', 'user', 'agent')),
	CONSTRAINT ck_expense_categories_title CHECK (char_length(title) BETWEEN 1 AND 40),
	CONSTRAINT ck_expense_categories_key CHECK (char_length(key) BETWEEN 1 AND 60),
	CONSTRAINT ck_expense_categories_position CHECK (position ~ '^[0-9A-Za-z]{1,64}$'),
	CONSTRAINT ck_expense_categories_version CHECK (version >= 1)
)
""",
    # One catalogue row per key, one row per key for each person.
    "CREATE UNIQUE INDEX uq_expense_categories_system_key ON expense_categories (key) "
    "WHERE user_id IS NULL",
    "CREATE UNIQUE INDEX uq_expense_categories_user_key ON expense_categories (user_id, key) "
    "WHERE user_id IS NOT NULL",
    "CREATE INDEX ix_expense_categories_user_seq ON expense_categories (user_id, seq)",
    """
CREATE TRIGGER expense_categories_sync_seq BEFORE INSERT OR UPDATE ON expense_categories
FOR EACH ROW EXECUTE FUNCTION sync_seq_bump()
""",
    """
CREATE TABLE expense_entries (
	id BIGSERIAL PRIMARY KEY,
	public_id UUID DEFAULT gen_random_uuid() NOT NULL,
	client_id UUID,
	user_id BIGINT NOT NULL,
	item_id BIGINT NOT NULL,
	amount NUMERIC(14, 2) NOT NULL,
	currency CHAR(3) DEFAULT 'KZT' NOT NULL,
	expression TEXT,
	spent_on DATE NOT NULL,
	spent_at TIMESTAMP WITH TIME ZONE,
	category_id BIGINT,
	payee TEXT,
	payee_norm TEXT,
	method TEXT,
	direction TEXT DEFAULT 'expense' NOT NULL,
	note TEXT,
	source TEXT NOT NULL,
	parse_source TEXT,
	review_fields JSONB DEFAULT '[]' NOT NULL,
	statement_import_id BIGINT,
	dedup_key TEXT,
	line_items JSONB,
	ai_generated BOOLEAN DEFAULT FALSE NOT NULL,
	version INTEGER DEFAULT 1 NOT NULL,
	seq BIGINT NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	deleted_at TIMESTAMP WITH TIME ZONE,
	CONSTRAINT uq_expense_entries_public_id UNIQUE (public_id),
	CONSTRAINT uq_expense_entries_user_client UNIQUE (user_id, client_id),
	CONSTRAINT uq_expense_entries_item UNIQUE (item_id),
	CONSTRAINT fk_expense_entries_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
	CONSTRAINT fk_expense_entries_item FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE CASCADE,
	CONSTRAINT fk_expense_entries_category FOREIGN KEY (category_id)
		REFERENCES expense_categories (id) ON DELETE SET NULL,
	CONSTRAINT ck_expense_entries_amount CHECK (amount > 0),
	CONSTRAINT ck_expense_entries_currency CHECK (currency ~ '^[A-Z]{3}$'),
	CONSTRAINT ck_expense_entries_expression CHECK (
		expression IS NULL OR char_length(expression) BETWEEN 1 AND 200),
	CONSTRAINT ck_expense_entries_method CHECK (
		method IS NULL OR method IN ('cash', 'card', 'kaspi', 'transfer', 'other')),
	CONSTRAINT ck_expense_entries_direction CHECK (
		direction IN ('expense', 'income', 'refund', 'transfer_own')),
	CONSTRAINT ck_expense_entries_source CHECK (source IN ('typed', 'voice', 'form', 'receipt_ocr',
		'receipt_qr', 'shared_receipt', 'statement_pdf', 'pasted_text')),
	CONSTRAINT ck_expense_entries_parse_source CHECK (
		parse_source IS NULL OR parse_source IN ('rules', 'llm', 'user_edit')),
	CONSTRAINT ck_expense_entries_review CHECK (jsonb_typeof(review_fields) = 'array'),
	CONSTRAINT ck_expense_entries_note CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 200),
	CONSTRAINT ck_expense_entries_payee CHECK (
		payee IS NULL OR char_length(payee) BETWEEN 1 AND 120),
	CONSTRAINT ck_expense_entries_version CHECK (version >= 1)
)
""",
    "CREATE INDEX ix_expense_entries_user_day ON expense_entries (user_id, spent_on) "
    "WHERE deleted_at IS NULL",
    "CREATE INDEX ix_expense_entries_user_category_day ON expense_entries "
    "(user_id, category_id, spent_on) WHERE deleted_at IS NULL",
    "CREATE INDEX ix_expense_entries_user_dedup ON expense_entries (user_id, dedup_key) "
    "WHERE dedup_key IS NOT NULL",
    "CREATE INDEX ix_expense_entries_user_seq ON expense_entries (user_id, seq)",
    "CREATE INDEX ix_expense_entries_category ON expense_entries (category_id) "
    "WHERE category_id IS NOT NULL",
    """
CREATE TRIGGER expense_entries_sync_seq BEFORE INSERT OR UPDATE ON expense_entries
FOR EACH ROW EXECUTE FUNCTION sync_seq_bump()
""",
    "ALTER TABLE sync_tombstones DROP CONSTRAINT ck_sync_tombstones_entity",
    f"""
ALTER TABLE sync_tombstones ADD CONSTRAINT ck_sync_tombstones_entity
	CHECK (entity IN ({_TOMBS_NEW}))
""",
    """
CREATE TRIGGER expense_entries_sync_tombstone AFTER DELETE ON expense_entries
FOR EACH ROW EXECUTE FUNCTION sync_tombstone_row('expense')
""",
    _seed(),
]

DOWN = [
    "DROP TRIGGER IF EXISTS expense_entries_sync_tombstone ON expense_entries",
    "DROP TRIGGER IF EXISTS expense_entries_sync_seq ON expense_entries",
    "DROP TABLE IF EXISTS expense_entries",
    "DROP TRIGGER IF EXISTS expense_categories_sync_seq ON expense_categories",
    "DROP TABLE IF EXISTS expense_categories",
    "DELETE FROM sync_tombstones WHERE entity = 'expense'",
    "ALTER TABLE sync_tombstones DROP CONSTRAINT ck_sync_tombstones_entity",
    f"""
ALTER TABLE sync_tombstones ADD CONSTRAINT ck_sync_tombstones_entity
	CHECK (entity IN ({_TOMBS_OLD}))
""",
]


def upgrade() -> None:
    for stmt in UP:  # one statement per execute(): asyncpg rejects batches
        op.execute(stmt)


def downgrade() -> None:
    for stmt in DOWN:
        op.execute(stmt)
