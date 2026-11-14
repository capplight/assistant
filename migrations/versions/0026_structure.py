"""Structure after UX review 2 and mocks v2 (Ф-48...Ф-51, Ф-55; week 20).

- `users.expense_budget`, `users.expense_budget_currency`: a simple monthly budget for «Расходы»
  (null = none); «осталось» = budget − the month's spent, computed by code on request.
- Ф-51: the template «Документы и КП» is called «Документы» (ru) / «Құжаттар» (kk) in every
  version, so new pages get the new name. A page still called by the old default name (the
  person never renamed it) is renamed too; a page the person named themselves keeps its name.
  The update bumps `seq` by the screens trigger, so phones get the new title by sync.

Downgrade: the old template names come back; pages called «Документы» on that template are
called «Документы и КП» again; the budget columns go.

Frozen SQL, no create_all.

Revision ID: 0026
Revises: 0025
"""

from alembic import op

revision = "0026"
down_revision = "0025"
branch_labels = None
depends_on = None

_NEW = """'{"ru": "Документы", "kk": "Құжаттар"}'"""
_OLD = """'{"ru": "Документы и КП", "kk": "Құжаттар мен КҰ"}'"""

UPGRADE = [
    "ALTER TABLE users ADD COLUMN expense_budget NUMERIC(14, 2)",
    "ALTER TABLE users ADD COLUMN expense_budget_currency TEXT DEFAULT 'KZT' NOT NULL",
    "ALTER TABLE users ADD CONSTRAINT ck_users_expense_budget "
    "CHECK (expense_budget IS NULL OR expense_budget > 0)",
    f"""
    UPDATE screen_templates SET title = CAST({_NEW} AS JSONB),
        default_title = CAST({_NEW} AS JSONB)
    WHERE key = 'documents'
    """,
    """
    UPDATE screens SET title = 'Документы',
        title_kk = CASE WHEN title_kk IS NULL OR title_kk = 'Құжаттар мен КҰ' THEN 'Құжаттар'
                        ELSE title_kk END,
        updated_at = now()
    WHERE template_key = 'documents' AND title = 'Документы и КП'
    """,
]

DOWNGRADE = [
    """
    UPDATE screens SET title = 'Документы и КП',
        title_kk = CASE WHEN title_kk = 'Құжаттар' THEN 'Құжаттар мен КҰ' ELSE title_kk END,
        updated_at = now()
    WHERE template_key = 'documents' AND title = 'Документы'
    """,
    f"""
    UPDATE screen_templates SET title = CAST({_OLD} AS JSONB),
        default_title = CAST({_OLD} AS JSONB)
    WHERE key = 'documents'
    """,
    "ALTER TABLE users DROP CONSTRAINT IF EXISTS ck_users_expense_budget",
    "ALTER TABLE users DROP COLUMN IF EXISTS expense_budget_currency",
    "ALTER TABLE users DROP COLUMN IF EXISTS expense_budget",
]


def upgrade() -> None:
    for stmt in UPGRADE:  # one statement per execute(): asyncpg rejects batches
        op.execute(stmt)


def downgrade() -> None:
    for stmt in DOWNGRADE:
        op.execute(stmt)
