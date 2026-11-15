"""The person's own records are not AI content (phone QA 1, 2026-11-15; R-06).

Records made from the person's own phrase — a task or an expense from the line, a note the line
saved by code, a КП's ТЗ — were stored with `ai_generated = true`, so every such note showed
«Подготовил помощник (ИИ) — проверьте». Only the title / summary may have been made
(`ai_fields`), which is not a reason for the label. Here: `ai_generated = false` on records whose
text is the person's words: `source_meta` says `task_list`, `expense` or `kp_request`, or the
text is exactly a phrase the person sent in the line. КП records (`kind = kp`) keep the label.
Each changed row gets `source_meta.ai_label_fixed = true`, so the downgrade puts back exactly those.

Frozen SQL, no create_all.

Revision ID: 0028
Revises: 0027
"""

from alembic import op

revision = "0028"
down_revision = "0027"
branch_labels = None
depends_on = None

UPGRADE = """
UPDATE items i SET ai_generated = false,
    source_meta = COALESCE(i.source_meta, '{}'::jsonb) || '{"ai_label_fixed": true}'::jsonb
WHERE i.ai_generated AND i.kind <> 'kp' AND i.source IN ('typed', 'mic')
  AND (i.source_meta ? 'task_list' OR i.source_meta ? 'expense' OR i.source_meta ? 'kp_request'
       OR EXISTS (SELECT 1 FROM conversation_messages m
                  WHERE m.user_id = i.user_id AND m.role = 'user' AND m.content = i.text))
"""

DOWNGRADE = """
UPDATE items SET ai_generated = true, source_meta = source_meta - 'ai_label_fixed'
WHERE source_meta ? 'ai_label_fixed'
"""


def upgrade() -> None:
    op.execute(UPGRADE)


def downgrade() -> None:
    op.execute(DOWNGRADE)
