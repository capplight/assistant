"""КП week 15: phrase edits, versions, DOCX, sending, drafts; profile and price list in sync
(spec 3-engineering 3.6, 4.7, 6.7 steps 5–7, 6.8; F-13, F-15; contract docs/api/kp.md).

- `document_versions.docx_file_id`: the Word file of a version («Ещё → Сделать в Word»), like
  `render_file_id` for the PDF. A sent version keeps both (files `keep_reason = sent_kp`).
- `documents.sent_at`: when the last «Отправили? — Да» was (the card's «Отправлено 3 ноя»).
- `doc_templates`: the system DOCX layout v1 (`engine = docx`), hashes of the packaged builder
  (src/assistant/kp/docx_render.py) and of the font name it uses; the HTML layout v2
  (`kp_v2.html.j2`: the letterhead, «Исх. №», lump-sum lines and «Условия» of the founder's
  father's real КП). v1 stays for reproducing old files.
- `company_profiles.license` ({number, date, category}: the state construction licence line) and
  `company_profiles.outgoing` ({year, next}: the outgoing number «Исх. № 2026-118-1», per
  company and year).
- `drafts` (spec 3.x `ai_generated`, F-15): a message or letter the assistant wrote and the person
  sends from the phone. `seq` + tombstone trigger: in `/v1/sync`.
- `company_profiles`, `price_lists`, `price_list_items` get `seq` (+ trigger, index) and tombstone
  triggers: «Моя компания» and «Мой прайс» travel in `/v1/sync` (the profile without its secrets,
  decided in code, not here).
- `sync_tombstones.entity` + `company_profile`, `price_list`, `price_list_item`, `draft`.

Frozen SQL, no create_all.

Revision ID: 0021
Revises: 0020
"""

from alembic import op

revision = "0021"
down_revision = "0020"
branch_labels = None
depends_on = None

_TOMBS_OLD = ("'item', 'screen', 'screen_item', 'conversation_message', 'action', 'task', "
              "'expense', 'document', 'expense_duplicate'")  # fmt: skip
_TOMBS_NEW = _TOMBS_OLD + ", 'company_profile', 'price_list', 'price_list_item', 'draft'"

# The packaged DOCX layout v1 (src/assistant/kp/docx_render.py) and its font name.
# tests/kp checks that the builder still hashes to this: a changed layout is a new version.
HTML_V2_TEMPLATE_KEY = "builtin:kp_v2"
HTML_V2_TEMPLATE_SHA256 = "4325b613251ed8a094af23a9ed7c2dda237a530db2674d92bdf97dd7aaba07ae"
HTML_FONTS_SHA256 = "2684fdec09a72f5976c780ae9ef49f58b92cd5835e9fc2f34ed0644c1da5ef3f"  # 0020's
DOCX_TEMPLATE_KEY = "builtin:kp_docx_v1"
DOCX_TEMPLATE_SHA256 = "a8f693eb9e162f2b8d60fe8d49dfc5e49e998a50ed712ba3f6c2af466245c75b"
DOCX_FONTS_SHA256 = "aac910161f16402c8108e8df6d7dc5941b65103b4deec7830cb141e563c68ee7"

_SYNCED = (("company_profiles", "company_profile"), ("price_lists", "price_list"),
           ("price_list_items", "price_list_item"))  # fmt: skip

UP = [
    "ALTER TABLE document_versions ADD COLUMN docx_file_id BIGINT",
    """
ALTER TABLE document_versions ADD CONSTRAINT fk_document_versions_docx FOREIGN KEY (docx_file_id)
	REFERENCES files (id) ON DELETE SET NULL
""",
    "ALTER TABLE documents ADD COLUMN sent_at TIMESTAMP WITH TIME ZONE",
    "ALTER TABLE company_profiles ADD COLUMN license JSONB DEFAULT '{}' NOT NULL",
    "ALTER TABLE company_profiles ADD COLUMN outgoing JSONB DEFAULT '{}' NOT NULL",
    """
ALTER TABLE company_profiles ADD CONSTRAINT ck_company_profiles_json CHECK (
	jsonb_typeof(license) = 'object' AND jsonb_typeof(outgoing) = 'object')
""",
    f"""
INSERT INTO doc_templates (owner, kind, engine, version, storage_key, template_hash, fonts_hash)
VALUES ('system', 'kp', 'html', 2, '{HTML_V2_TEMPLATE_KEY}', '{HTML_V2_TEMPLATE_SHA256}',
        '{HTML_FONTS_SHA256}')
""",
    f"""
INSERT INTO doc_templates (owner, kind, engine, version, storage_key, template_hash, fonts_hash)
VALUES ('system', 'kp', 'docx', 1, '{DOCX_TEMPLATE_KEY}', '{DOCX_TEMPLATE_SHA256}',
        '{DOCX_FONTS_SHA256}')
""",
    """
CREATE TABLE drafts (
	id BIGSERIAL PRIMARY KEY,
	public_id UUID DEFAULT gen_random_uuid() NOT NULL,
	client_id UUID,
	user_id BIGINT NOT NULL,
	document_id BIGINT,
	channel TEXT NOT NULL,
	recipient_name TEXT,
	subject TEXT,
	text TEXT NOT NULL,
	request_text TEXT,
	status TEXT DEFAULT 'draft' NOT NULL,
	review_fields TEXT[] DEFAULT '{}' NOT NULL,
	pending_action_id BIGINT,
	ai_generated BOOLEAN DEFAULT true NOT NULL,
	sent_at TIMESTAMP WITH TIME ZONE,
	version INTEGER DEFAULT 1 NOT NULL,
	seq BIGINT NOT NULL,
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	deleted_at TIMESTAMP WITH TIME ZONE,
	CONSTRAINT uq_drafts_public_id UNIQUE (public_id),
	CONSTRAINT uq_drafts_user_client UNIQUE (user_id, client_id),
	CONSTRAINT fk_drafts_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
	CONSTRAINT fk_drafts_document FOREIGN KEY (document_id)
		REFERENCES documents (id) ON DELETE SET NULL,
	CONSTRAINT fk_drafts_pending FOREIGN KEY (pending_action_id)
		REFERENCES pending_actions (id) ON DELETE SET NULL,
	CONSTRAINT ck_drafts_channel CHECK (channel IN ('whatsapp', 'email')),
	CONSTRAINT ck_drafts_status CHECK (status IN ('draft', 'sent', 'discarded')),
	CONSTRAINT ck_drafts_text CHECK (char_length(text) BETWEEN 1 AND 4000),
	CONSTRAINT ck_drafts_recipient CHECK (recipient_name IS NULL
		OR char_length(recipient_name) BETWEEN 1 AND 120),
	CONSTRAINT ck_drafts_subject CHECK (subject IS NULL OR char_length(subject) BETWEEN 1 AND 200),
	CONSTRAINT ck_drafts_version CHECK (version >= 1)
)
""",
    "CREATE INDEX ix_drafts_user_seq ON drafts (user_id, seq)",
    "CREATE INDEX ix_drafts_user_status ON drafts (user_id, status, id)",
    """
CREATE TRIGGER drafts_sync_seq BEFORE INSERT OR UPDATE ON drafts
FOR EACH ROW EXECUTE FUNCTION sync_seq_bump()
""",
    "ALTER TABLE sync_tombstones DROP CONSTRAINT ck_sync_tombstones_entity",
    f"""
ALTER TABLE sync_tombstones ADD CONSTRAINT ck_sync_tombstones_entity
	CHECK (entity IN ({_TOMBS_NEW}))
""",
    """
CREATE TRIGGER drafts_sync_tombstone AFTER DELETE ON drafts
FOR EACH ROW EXECUTE FUNCTION sync_tombstone_row('draft')
""",
]
for _table, _entity in _SYNCED:
    UP += [
        f"ALTER TABLE {_table} ADD COLUMN seq BIGINT",
        f"UPDATE {_table} SET seq = nextval('sync_seq')",
        f"ALTER TABLE {_table} ALTER COLUMN seq SET NOT NULL",
        f"CREATE INDEX ix_{_table}_user_seq ON {_table} (user_id, seq)",
        f"""
CREATE TRIGGER {_table}_sync_seq BEFORE INSERT OR UPDATE ON {_table}
FOR EACH ROW EXECUTE FUNCTION sync_seq_bump()
""",
        f"""
CREATE TRIGGER {_table}_sync_tombstone AFTER DELETE ON {_table}
FOR EACH ROW EXECUTE FUNCTION sync_tombstone_row('{_entity}')
""",
    ]

DOWN: list[str] = []
for _table, _entity in reversed(_SYNCED):
    DOWN += [
        f"DROP TRIGGER IF EXISTS {_table}_sync_tombstone ON {_table}",
        f"DROP TRIGGER IF EXISTS {_table}_sync_seq ON {_table}",
        f"DROP INDEX IF EXISTS ix_{_table}_user_seq",
        f"ALTER TABLE {_table} DROP COLUMN IF EXISTS seq",
    ]
DOWN += [
    "DROP TRIGGER IF EXISTS drafts_sync_tombstone ON drafts",
    "DROP TRIGGER IF EXISTS drafts_sync_seq ON drafts",
    "DROP TABLE IF EXISTS drafts",
    "DELETE FROM sync_tombstones WHERE entity IN ('company_profile', 'price_list', "
    "'price_list_item', 'draft')",
    "ALTER TABLE sync_tombstones DROP CONSTRAINT ck_sync_tombstones_entity",
    f"""
ALTER TABLE sync_tombstones ADD CONSTRAINT ck_sync_tombstones_entity
	CHECK (entity IN ({_TOMBS_OLD}))
""",
    f"DELETE FROM doc_templates WHERE owner = 'system' AND storage_key = '{DOCX_TEMPLATE_KEY}'",
    f"DELETE FROM doc_templates WHERE owner = 'system' AND storage_key = '{HTML_V2_TEMPLATE_KEY}'",
    "ALTER TABLE company_profiles DROP CONSTRAINT IF EXISTS ck_company_profiles_json",
    "ALTER TABLE company_profiles DROP COLUMN IF EXISTS outgoing",
    "ALTER TABLE company_profiles DROP COLUMN IF EXISTS license",
    "ALTER TABLE documents DROP COLUMN IF EXISTS sent_at",
    "ALTER TABLE document_versions DROP CONSTRAINT IF EXISTS fk_document_versions_docx",
    "ALTER TABLE document_versions DROP COLUMN IF EXISTS docx_file_id",
]


def upgrade() -> None:
    for stmt in UP:  # one statement per execute(): asyncpg rejects batches
        op.execute(stmt)


def downgrade() -> None:
    for stmt in DOWN:
        op.execute(stmt)
