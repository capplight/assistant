"""Import of AI-chat exports (ChatGPT / Claude / Gemini, step 7).

- `items.kind` may be 'ai_chat' (one conversation, or one part of a long one) and `items.source`
  'import_ai_chat';
- `imports.source` may be 'ai_chat_export_file';
- `import_seen.source_family` may be 'ai_chat' (the same export again brings nothing).

Downgrade keeps the brought records as plain notes from files (`note` / `files`) and the imports
as `files_bulk`: nothing the person brought is lost (only the re-import memory goes).

Frozen SQL, no create_all.

Revision ID: 0031
Revises: 0030
"""

from alembic import op

revision = "0031"
down_revision = "0030"
branch_labels = None
depends_on = None

# 0004: KINDS + LEGACY_KINDS, SOURCES + LEGACY_SOURCES; 0015: imports, import_seen (unchanged since)
_KINDS = ("'note', 'voice', 'image', 'screenshot', 'pdf', 'docx', 'xlsx', 'link', 'email', "
          "'tg_message', 'kp', 'file_other', 'text', 'photo', 'video', 'document'")
_SOURCES = ("'typed', 'mic', 'share', 'camera', 'files', 'import_telegram', 'bot_forward', "
            "'system', 'instagram', 'tiktok', 'telegram', 'whatsapp', 'youtube', 'web', 'user'")
_IMPORT_SOURCES = "'telegram_export_file', 'telegram_bot_forward', 'telegram_takeout', 'files_bulk'"


def _checks(kinds: str, sources: str, import_sources: str, families: str) -> list[str]:
    return [
        "ALTER TABLE items DROP CONSTRAINT ck_items_kind, DROP CONSTRAINT ck_items_source",
        f"ALTER TABLE items ADD CONSTRAINT ck_items_kind CHECK (kind IN ({kinds})), "
        f"ADD CONSTRAINT ck_items_source CHECK (source IN ({sources}))",
        "ALTER TABLE imports DROP CONSTRAINT ck_imports_source",
        "ALTER TABLE imports ADD CONSTRAINT ck_imports_source "
        f"CHECK (source IN ({import_sources}))",
        "ALTER TABLE import_seen DROP CONSTRAINT ck_import_seen_family",
        "ALTER TABLE import_seen ADD CONSTRAINT ck_import_seen_family "
        f"CHECK (source_family IN ({families}))",
    ]


UPGRADE = _checks(_KINDS + ", 'ai_chat'", _SOURCES + ", 'import_ai_chat'",
                  _IMPORT_SOURCES + ", 'ai_chat_export_file'", "'telegram', 'ai_chat'")
DOWNGRADE = [
    "UPDATE items SET kind = 'note' WHERE kind = 'ai_chat'",
    "UPDATE items SET source = 'files' WHERE source = 'import_ai_chat'",
    "UPDATE imports SET source = 'files_bulk' WHERE source = 'ai_chat_export_file'",
    "DELETE FROM import_seen WHERE source_family = 'ai_chat'",
    *_checks(_KINDS, _SOURCES, _IMPORT_SOURCES, "'telegram'"),
]


def upgrade() -> None:
    for sql in UPGRADE:
        op.execute(sql)


def downgrade() -> None:
    for sql in DOWNGRADE:
        op.execute(sql)
