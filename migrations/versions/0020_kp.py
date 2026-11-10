"""КП: company profile, «Мой прайс», documents and versions (week 14; spec 3-engineering 3.6, 4.7,
6.7; F-13, F-14, F-34; contract docs/api/kp.md). Also closes two gaps of week 13.

- `doc_templates`: immutable versions of the КП layout (`engine` html now, docx in week 15), with
  the hashes of the packaged template and fonts, so a render is reproducible. One system row.
- `company_profiles`: one per person. БИН/ИИН and bank details are AES-GCM ciphertext
  (`*_enc`, kp/secret.py). Logo, signature and stamp are `files` rows (kept always, Ф-5).
- `price_lists` / `price_list_items`: «Мой прайс» (upload, «Ввести цены подряд», voice).
  `name_norm` is searched by pg_trgm and full text.
- `kp_price_history`: prices of past КП (one set per document: its current version's lines).
- `documents` / `document_versions`: a КП (`kind=kp`) has its own record (`items.kind = 'kp'`) on
  «Документы и КП»; `data` holds the model's data without sums, `totals` what `kp/calc.py` made.
  `documents.draft` keeps the parts KP_EXTRACT already read, so a retried job goes on.
- `actions.kind` + `company_profile_edit`, `price_list_edit`, `dismiss_expenses` (week 13 «Это
  разные» becomes an action with «Отменить»).
- week 13: `statement_imports` and `expense_duplicates` get `seq` (+ trigger) for `/v1/sync`;
  `sync_tombstones.entity` + `document`, `expense_duplicate`.

Frozen SQL, no create_all.

Revision ID: 0020
Revises: 0019
"""

from alembic import op

revision = "0020"
down_revision = "0019"
branch_labels = None
depends_on = None

_ACTION_KINDS_OLD = (
    "'save_item', 'auto_merge_exact', 'merge_group', 'cleanup_batch', 'create_reminder', "
    "'edit_reminder', 'create_stack', 'stack_add', 'stack_remove', 'delete_stack', 'create_kp', "
    "'edit_kp', 'delete_item', 'restore_item', 'user_edit', 'send_external', 'import_batch', "
    "'habit_change', 'create_screen', 'hide_screen', 'delete_screen', 'reorder_screens', "
    "'screen_customize', 'screen_reset', 'screen_view_change', 'screen_reorder_items', "
    "'screen_move_items', 'screen_add_item', 'screen_remove_item', 'facet_edit', "
    "'create_expense', 'edit_expense', 'bulk_create_expenses', 'dismiss_group', 'merge_expenses'"
)
_ACTION_KINDS_NEW = (_ACTION_KINDS_OLD
                     + ", 'company_profile_edit', 'price_list_edit', 'dismiss_expenses'")
_TOMBS_OLD = "'item', 'screen', 'screen_item', 'conversation_message', 'action', 'task', 'expense'"
_TOMBS_NEW = _TOMBS_OLD + ", 'document', 'expense_duplicate'"

# The packaged КП layout v1 (src/assistant/kp/templates/kp_v1.html.j2) and its fonts
# (src/assistant/kp/fonts/DejaVuSans*.ttf). tests/kp checks that the files still hash to these.
TEMPLATE_KEY = "builtin:kp_v1"
TEMPLATE_SHA256 = "a4d3eb5d164802b93d3972cc2d4f396b7cf38a3a4c4ca8e847f5b9c68512460a"
FONTS_SHA256 = "2684fdec09a72f5976c780ae9ef49f58b92cd5835e9fc2f34ed0644c1da5ef3f"

UP = [
    """
CREATE TABLE doc_templates (
	id BIGSERIAL PRIMARY KEY,
	public_id UUID DEFAULT gen_random_uuid() NOT NULL,
	owner TEXT NOT NULL,
	user_id BIGINT,
	kind TEXT NOT NULL,
	engine TEXT NOT NULL,
	version INTEGER NOT NULL,
	storage_key TEXT NOT NULL,
	template_hash TEXT NOT NULL,
	fonts_hash TEXT NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	CONSTRAINT uq_doc_templates_public_id UNIQUE (public_id),
	CONSTRAINT fk_doc_templates_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
	CONSTRAINT ck_doc_templates_owner CHECK (owner IN ('system', 'user')),
	CONSTRAINT ck_doc_templates_owner_user CHECK ((owner = 'system') = (user_id IS NULL)),
	CONSTRAINT ck_doc_templates_kind CHECK (kind IN ('kp')),
	CONSTRAINT ck_doc_templates_engine CHECK (engine IN ('html', 'docx')),
	CONSTRAINT ck_doc_templates_version CHECK (version >= 1)
)
""",
    "CREATE UNIQUE INDEX uq_doc_templates_system ON doc_templates (kind, engine, version) "
    "WHERE user_id IS NULL",
    f"""
INSERT INTO doc_templates (owner, kind, engine, version, storage_key, template_hash, fonts_hash)
VALUES ('system', 'kp', 'html', 1, '{TEMPLATE_KEY}', '{TEMPLATE_SHA256}', '{FONTS_SHA256}')
""",
    """
CREATE TABLE company_profiles (
	id BIGSERIAL PRIMARY KEY,
	public_id UUID DEFAULT gen_random_uuid() NOT NULL,
	user_id BIGINT NOT NULL,
	name TEXT,
	legal_form TEXT,
	bin_iin_enc BYTEA,
	address TEXT,
	bank_enc BYTEA,
	contacts JSONB DEFAULT '{}' NOT NULL,
	signer JSONB DEFAULT '{}' NOT NULL,
	vat_payer BOOLEAN,
	logo_file_id BIGINT,
	signature_file_id BIGINT,
	stamp_file_id BIGINT,
	template_id BIGINT,
	default_terms JSONB DEFAULT '{}' NOT NULL,
	review_fields TEXT[] DEFAULT '{}' NOT NULL,
	source TEXT DEFAULT 'typed' NOT NULL,
	version INTEGER DEFAULT 1 NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	CONSTRAINT uq_company_profiles_public_id UNIQUE (public_id),
	CONSTRAINT uq_company_profiles_user UNIQUE (user_id),
	CONSTRAINT fk_company_profiles_user FOREIGN KEY (user_id)
		REFERENCES users (id) ON DELETE CASCADE,
	CONSTRAINT fk_company_profiles_logo FOREIGN KEY (logo_file_id)
		REFERENCES files (id) ON DELETE SET NULL,
	CONSTRAINT fk_company_profiles_signature FOREIGN KEY (signature_file_id)
		REFERENCES files (id) ON DELETE SET NULL,
	CONSTRAINT fk_company_profiles_stamp FOREIGN KEY (stamp_file_id)
		REFERENCES files (id) ON DELETE SET NULL,
	CONSTRAINT fk_company_profiles_template FOREIGN KEY (template_id)
		REFERENCES doc_templates (id) ON DELETE SET NULL,
	CONSTRAINT ck_company_profiles_legal_form CHECK (
		legal_form IS NULL OR legal_form IN ('ip', 'too', 'ao', 'other')),
	CONSTRAINT ck_company_profiles_name CHECK (name IS NULL OR char_length(name) BETWEEN 1 AND 200),
	CONSTRAINT ck_company_profiles_source CHECK (source IN ('typed', 'extracted', 'voice')),
	CONSTRAINT ck_company_profiles_version CHECK (version >= 1)
)
""",
    """
CREATE TABLE price_lists (
	id BIGSERIAL PRIMARY KEY,
	public_id UUID DEFAULT gen_random_uuid() NOT NULL,
	client_id UUID,
	user_id BIGINT NOT NULL,
	item_id BIGINT,
	file_id BIGINT,
	source TEXT NOT NULL,
	title TEXT NOT NULL,
	reader TEXT,
	active BOOLEAN DEFAULT TRUE NOT NULL,
	uploaded_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	deleted_at TIMESTAMP WITH TIME ZONE,
	CONSTRAINT uq_price_lists_public_id UNIQUE (public_id),
	CONSTRAINT uq_price_lists_user_client UNIQUE (user_id, client_id),
	CONSTRAINT fk_price_lists_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
	CONSTRAINT fk_price_lists_item FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE SET NULL,
	CONSTRAINT fk_price_lists_file FOREIGN KEY (file_id) REFERENCES files (id) ON DELETE SET NULL,
	CONSTRAINT ck_price_lists_source CHECK (source IN ('upload', 'typed_sequence', 'voice')),
	CONSTRAINT ck_price_lists_reader CHECK (reader IS NULL OR reader IN ('table', 'model')),
	CONSTRAINT ck_price_lists_title CHECK (char_length(title) BETWEEN 1 AND 200)
)
""",
    "CREATE INDEX ix_price_lists_user ON price_lists (user_id, id)",
    """
CREATE TABLE price_list_items (
	id BIGSERIAL PRIMARY KEY,
	public_id UUID DEFAULT gen_random_uuid() NOT NULL,
	client_id UUID,
	price_list_id BIGINT NOT NULL,
	user_id BIGINT NOT NULL,
	sku TEXT,
	name TEXT NOT NULL,
	name_norm TEXT NOT NULL,
	unit TEXT,
	price NUMERIC(14, 2) NOT NULL,
	currency CHAR(3) DEFAULT 'KZT' NOT NULL,
	review_fields TEXT[] DEFAULT '{}' NOT NULL,
	source_ref TEXT,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	deleted_at TIMESTAMP WITH TIME ZONE,
	CONSTRAINT uq_price_list_items_public_id UNIQUE (public_id),
	CONSTRAINT uq_price_list_items_user_client UNIQUE (user_id, client_id),
	CONSTRAINT fk_price_list_items_list FOREIGN KEY (price_list_id)
		REFERENCES price_lists (id) ON DELETE CASCADE,
	CONSTRAINT fk_price_list_items_user FOREIGN KEY (user_id)
		REFERENCES users (id) ON DELETE CASCADE,
	CONSTRAINT ck_price_list_items_name CHECK (char_length(name) BETWEEN 1 AND 300),
	CONSTRAINT ck_price_list_items_unit CHECK (unit IS NULL OR char_length(unit) BETWEEN 1 AND 20),
	CONSTRAINT ck_price_list_items_price CHECK (price >= 0),
	CONSTRAINT ck_price_list_items_currency CHECK (currency ~ '^[A-Z]{3}$')
)
""",
    "CREATE INDEX ix_price_list_items_list ON price_list_items (price_list_id)",
    "CREATE INDEX ix_price_list_items_user_norm ON price_list_items (user_id, name_norm) "
    "WHERE deleted_at IS NULL",
    "CREATE INDEX ix_price_list_items_trgm ON price_list_items USING gin (name_norm gin_trgm_ops)",
    "CREATE INDEX ix_price_list_items_fts ON price_list_items "
    "USING gin (to_tsvector('simple', name_norm))",
    """
CREATE TABLE documents (
	id BIGSERIAL PRIMARY KEY,
	public_id UUID DEFAULT gen_random_uuid() NOT NULL,
	client_id UUID,
	user_id BIGINT NOT NULL,
	item_id BIGINT NOT NULL,
	kind TEXT DEFAULT 'kp' NOT NULL,
	title TEXT NOT NULL,
	number TEXT,
	year INTEGER,
	seq_no INTEGER,
	client JSONB DEFAULT '{}' NOT NULL,
	status TEXT NOT NULL,
	deal_status TEXT DEFAULT 'draft' NOT NULL,
	current_version_n INTEGER,
	sent_version_n INTEGER,
	source_item_ids BIGINT[] DEFAULT '{}' NOT NULL,
	request_text TEXT,
	deal_active BOOLEAN DEFAULT TRUE NOT NULL,
	ai_generated BOOLEAN DEFAULT TRUE NOT NULL,
	progress JSONB DEFAULT '{}' NOT NULL,
	draft JSONB DEFAULT '{}' NOT NULL,
	error TEXT,
	version INTEGER DEFAULT 1 NOT NULL,
	seq BIGINT NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	deleted_at TIMESTAMP WITH TIME ZONE,
	CONSTRAINT uq_documents_public_id UNIQUE (public_id),
	CONSTRAINT uq_documents_user_client UNIQUE (user_id, client_id),
	CONSTRAINT uq_documents_item UNIQUE (item_id),
	CONSTRAINT fk_documents_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
	CONSTRAINT fk_documents_item FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE CASCADE,
	CONSTRAINT ck_documents_kind CHECK (kind IN ('kp', 'letter')),
	CONSTRAINT ck_documents_status CHECK (status IN ('extracting', 'draft', 'ready', 'sent',
		'archived', 'failed')),
	CONSTRAINT ck_documents_deal_status CHECK (deal_status IN ('draft', 'sent', 'seen',
		'accepted', 'declined')),
	CONSTRAINT ck_documents_title CHECK (char_length(title) BETWEEN 1 AND 200),
	CONSTRAINT ck_documents_version CHECK (version >= 1)
)
""",
    "CREATE INDEX ix_documents_user_seq ON documents (user_id, seq)",
    "CREATE INDEX ix_documents_user_id ON documents (user_id, id)",
    "CREATE UNIQUE INDEX uq_documents_number ON documents (user_id, kind, year, seq_no) "
    "WHERE seq_no IS NOT NULL",
    """
CREATE TRIGGER documents_sync_seq BEFORE INSERT OR UPDATE ON documents
FOR EACH ROW EXECUTE FUNCTION sync_seq_bump()
""",
    """
CREATE TRIGGER documents_sync_tombstone AFTER DELETE ON documents
FOR EACH ROW EXECUTE FUNCTION sync_tombstone_row('document')
""",
    """
CREATE TABLE document_versions (
	id BIGSERIAL PRIMARY KEY,
	public_id UUID DEFAULT gen_random_uuid() NOT NULL,
	document_id BIGINT NOT NULL,
	user_id BIGINT NOT NULL,
	n INTEGER NOT NULL,
	data JSONB NOT NULL,
	totals JSONB NOT NULL,
	calc_version TEXT NOT NULL,
	vat_rate NUMERIC(5, 2),
	vat_mode TEXT NOT NULL,
	template_id BIGINT,
	patch JSONB DEFAULT '[]' NOT NULL,
	changed_paths TEXT[] DEFAULT '{}' NOT NULL,
	author TEXT NOT NULL,
	request_text TEXT,
	render_file_id BIGINT,
	sent_at TIMESTAMP WITH TIME ZONE,
	sent_channel TEXT,
	ai_generated BOOLEAN DEFAULT TRUE NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	CONSTRAINT uq_document_versions_public_id UNIQUE (public_id),
	CONSTRAINT uq_document_versions_n UNIQUE (document_id, n),
	CONSTRAINT fk_document_versions_document FOREIGN KEY (document_id)
		REFERENCES documents (id) ON DELETE CASCADE,
	CONSTRAINT fk_document_versions_user FOREIGN KEY (user_id)
		REFERENCES users (id) ON DELETE CASCADE,
	CONSTRAINT fk_document_versions_template FOREIGN KEY (template_id)
		REFERENCES doc_templates (id) ON DELETE SET NULL,
	CONSTRAINT fk_document_versions_render FOREIGN KEY (render_file_id)
		REFERENCES files (id) ON DELETE SET NULL,
	CONSTRAINT ck_document_versions_n CHECK (n >= 1),
	CONSTRAINT ck_document_versions_vat_mode CHECK (vat_mode IN ('included', 'on_top', 'none')),
	CONSTRAINT ck_document_versions_author CHECK (author IN ('initial', 'tap_edit',
		'agent_request', 'revert')),
	CONSTRAINT ck_document_versions_channel CHECK (sent_channel IS NULL OR sent_channel IN (
		'whatsapp_share', 'whatsapp_text', 'email', 'share_other')),
	CONSTRAINT ck_document_versions_data CHECK (jsonb_typeof(data) = 'object')
)
""",
    """
CREATE TABLE kp_price_history (
	id BIGSERIAL PRIMARY KEY,
	user_id BIGINT NOT NULL,
	name TEXT NOT NULL,
	name_norm TEXT NOT NULL,
	unit TEXT,
	unit_price NUMERIC(14, 2) NOT NULL,
	currency CHAR(3) DEFAULT 'KZT' NOT NULL,
	document_id BIGINT NOT NULL,
	version_n INTEGER NOT NULL,
	client_name TEXT,
	client_key TEXT,
	sent_at TIMESTAMP WITH TIME ZONE,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	CONSTRAINT fk_kp_price_history_user FOREIGN KEY (user_id)
		REFERENCES users (id) ON DELETE CASCADE,
	CONSTRAINT fk_kp_price_history_document FOREIGN KEY (document_id)
		REFERENCES documents (id) ON DELETE CASCADE,
	CONSTRAINT ck_kp_price_history_price CHECK (unit_price >= 0)
)
""",
    "CREATE INDEX ix_kp_price_history_lookup ON kp_price_history (user_id, name_norm, id)",
    "CREATE INDEX ix_kp_price_history_document ON kp_price_history (document_id)",
    "ALTER TABLE actions DROP CONSTRAINT ck_actions_kind",
    f"ALTER TABLE actions ADD CONSTRAINT ck_actions_kind CHECK (kind IN ({_ACTION_KINDS_NEW}))",
    # week 13 «Расходы 2»: plans and repeats reach the phone through /v1/sync
    "ALTER TABLE statement_imports ADD COLUMN seq BIGINT",
    "UPDATE statement_imports SET seq = nextval('sync_seq')",
    "ALTER TABLE statement_imports ALTER COLUMN seq SET NOT NULL",
    "CREATE INDEX ix_statement_imports_user_seq ON statement_imports (user_id, seq)",
    """
CREATE TRIGGER statement_imports_sync_seq BEFORE INSERT OR UPDATE ON statement_imports
FOR EACH ROW EXECUTE FUNCTION sync_seq_bump()
""",
    "ALTER TABLE expense_duplicates ADD COLUMN seq BIGINT",
    "UPDATE expense_duplicates SET seq = nextval('sync_seq')",
    "ALTER TABLE expense_duplicates ALTER COLUMN seq SET NOT NULL",
    "CREATE INDEX ix_expense_duplicates_user_seq ON expense_duplicates (user_id, seq)",
    """
CREATE TRIGGER expense_duplicates_sync_seq BEFORE INSERT OR UPDATE ON expense_duplicates
FOR EACH ROW EXECUTE FUNCTION sync_seq_bump()
""",
    "ALTER TABLE sync_tombstones DROP CONSTRAINT ck_sync_tombstones_entity",
    f"""
ALTER TABLE sync_tombstones ADD CONSTRAINT ck_sync_tombstones_entity
	CHECK (entity IN ({_TOMBS_NEW}))
""",
    """
CREATE TRIGGER expense_duplicates_sync_tombstone AFTER DELETE ON expense_duplicates
FOR EACH ROW EXECUTE FUNCTION sync_tombstone_row('expense_duplicate')
""",
    # «Документы и КП» v2 (template-screens §2.5 картотека): folders by «Клиент», the status strip
    # «Черновик · Отправлено · Видел · Принято» (+ «Не принято»). Pages follow the new version.
    """
INSERT INTO screen_templates (key, version, owner, status, catalog_visible, catalog_order, title,
    description, default_title, icon, preview_ref, singleton, facet, fields, layouts,
    default_layout, default_view, aggregates, auto_rule, ai_hints_ref, min_app_version,
    migrate_from)
SELECT key, 2, owner, status, catalog_visible, catalog_order, title, description,
    default_title, icon, preview_ref, singleton, facet,
    (SELECT jsonb_agg(CASE WHEN f ->> 'id' = 'kp_status'
                           THEN jsonb_set(f, '{options}',
                                '["draft", "sent", "seen", "accepted", "declined"]')
                           ELSE f END ORDER BY ord)
     FROM jsonb_array_elements(fields) WITH ORDINALITY AS t (f, ord)),
    layouts, default_layout,
    CAST('{"sort": "position", "group_by": "client"}' AS JSONB), aggregates, auto_rule,
    ai_hints_ref, min_app_version, 1
FROM screen_templates WHERE key = 'documents' AND version = 1
""",
    "UPDATE screens SET template_version = 2 WHERE template_key = 'documents' "
    "AND template_version = 1",
]

DOWN = [
    "UPDATE screens SET template_version = 1 WHERE template_key = 'documents' "
    "AND template_version = 2",
    "DELETE FROM screen_templates WHERE key = 'documents' AND version = 2",
    "DROP TRIGGER IF EXISTS expense_duplicates_sync_tombstone ON expense_duplicates",
    "DROP TRIGGER IF EXISTS documents_sync_tombstone ON documents",
    "DELETE FROM sync_tombstones WHERE entity IN ('document', 'expense_duplicate')",
    "ALTER TABLE sync_tombstones DROP CONSTRAINT ck_sync_tombstones_entity",
    f"""
ALTER TABLE sync_tombstones ADD CONSTRAINT ck_sync_tombstones_entity
	CHECK (entity IN ({_TOMBS_OLD}))
""",
    "DROP TRIGGER IF EXISTS expense_duplicates_sync_seq ON expense_duplicates",
    "DROP INDEX IF EXISTS ix_expense_duplicates_user_seq",
    "ALTER TABLE expense_duplicates DROP COLUMN IF EXISTS seq",
    "DROP TRIGGER IF EXISTS statement_imports_sync_seq ON statement_imports",
    "DROP INDEX IF EXISTS ix_statement_imports_user_seq",
    "ALTER TABLE statement_imports DROP COLUMN IF EXISTS seq",
    "DELETE FROM actions WHERE kind IN ('company_profile_edit', 'price_list_edit', "
    "'dismiss_expenses')",
    "ALTER TABLE actions DROP CONSTRAINT ck_actions_kind",
    f"ALTER TABLE actions ADD CONSTRAINT ck_actions_kind CHECK (kind IN ({_ACTION_KINDS_OLD}))",
    "DROP TABLE IF EXISTS kp_price_history",
    "DROP TABLE IF EXISTS document_versions",
    "DROP TRIGGER IF EXISTS documents_sync_seq ON documents",
    "DROP TABLE IF EXISTS documents",
    "DROP TABLE IF EXISTS price_list_items",
    "DROP TABLE IF EXISTS price_lists",
    "DROP TABLE IF EXISTS company_profiles",
    "DROP TABLE IF EXISTS doc_templates",
]


def upgrade() -> None:
    for stmt in UP:  # one statement per execute(): asyncpg rejects batches
        op.execute(stmt)


def downgrade() -> None:
    for stmt in DOWN:
        op.execute(stmt)
