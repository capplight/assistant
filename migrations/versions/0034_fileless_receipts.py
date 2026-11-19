"""A typed / spoken expense is not a «Чек» (data fix, 2026-11-20).

Background enrichment marked some file-less expense records (`kind` note / voice, no photo, file or
OFD link; e.g. «сегодня я потратил 5000 тенге на донер») as `envelope.type = 'receipt'`, and the
«Документы» rule took them under «Чеки». A receipt is only a record with a photo / file behind it
(`assistant.pages.rules.file_backed`); code now keeps such records off «Документы» and enrichment
stores them as notes. This migration repairs what is already there, idempotently:

1. the envelope type of a file-less 'receipt' becomes 'note' (the old value goes to
   `envelope.rejected.type`, like every other value code refused);
2. their rule-made rows on «Документы» go, if the record stays on another live page (its
   «Расходы» row, «Заметки»): a row the person placed, moved, pinned or removed is never touched
   (R-54), and a record is never left on no page. The delete fires the sync tombstone trigger.

Downgrade: nothing to undo (the old type was wrong); rows are not brought back.

Frozen SQL, no create_all.

Revision ID: 0034
Revises: 0033
"""

from alembic import op

revision = "0034"
down_revision = "0033"
branch_labels = None
depends_on = None

# assistant.pages.rules.FILE_KINDS, frozen here
FILE_KINDS = ("'image', 'screenshot', 'pdf', 'docx', 'xlsx', 'file_other', 'link', 'photo', "
              "'document'")
FILELESS = (f"i.kind NOT IN ({FILE_KINDS}) "
            "AND COALESCE(i.source_meta ->> 'fiscal_url', '') = '' "
            "AND COALESCE(i.source_meta ->> 'file_name', '') = ''")

UPGRADE = [
    f"""
UPDATE items AS i
SET envelope = jsonb_set(
        jsonb_set(i.envelope, '{{type}}', '"note"'),
        '{{rejected}}',
        COALESCE(CASE WHEN jsonb_typeof(i.envelope -> 'rejected') = 'object'
                      THEN i.envelope -> 'rejected' END, '{{}}'::jsonb)
            || '{{"type": ["receipt"]}}'::jsonb)
WHERE i.envelope ->> 'type' = 'receipt' AND {FILELESS}
""",
    f"""
DELETE FROM screen_items AS si
USING screens AS s, items AS i
WHERE si.screen_id = s.id AND si.item_id = i.id
  AND s.template_key = 'documents'
  AND si.added_by = 'rule' AND si.updated_by = 'agent' AND si.manual_order IS FALSE
  AND si.pinned IS FALSE AND si.removed_by_user_at IS NULL AND si.moved_ts IS NULL
  AND i.envelope -> 'rejected' -> 'type' @> '["receipt"]'::jsonb
  AND COALESCE(i.envelope ->> 'type', '') <> 'receipt'
  AND {FILELESS}
  AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.item_id = i.id)
  AND EXISTS (SELECT 1 FROM screen_items o JOIN screens os ON os.id = o.screen_id
              WHERE o.item_id = i.id AND o.screen_id <> s.id AND o.removed_by_user_at IS NULL
                AND os.deleted_at IS NULL AND os.kind <> 'system_today')
""",
]


def upgrade() -> None:
    for sql in UPGRADE:
        op.execute(sql)


def downgrade() -> None:
    pass
