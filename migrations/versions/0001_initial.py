"""Initial schema: extensions, all tables, full-text trigger.

Revision ID: 0001
Revises:
"""
from alembic import op

from assistant.db.models import Base

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

TSV_TRIGGER = """
CREATE FUNCTION items_tsv_update() RETURNS trigger AS $$
BEGIN
  NEW.tsv := setweight(to_tsvector('simple', coalesce(NEW.title, '')), 'A')
          || setweight(to_tsvector('simple', coalesce(NEW.summary, '')), 'B')
          || setweight(to_tsvector('simple', coalesce(NEW.raw_text, '')), 'C');
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER items_tsv BEFORE INSERT OR UPDATE OF title, summary, raw_text ON items
FOR EACH ROW EXECUTE FUNCTION items_tsv_update();
"""


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")
    op.execute("CREATE EXTENSION IF NOT EXISTS postgis")
    Base.metadata.create_all(op.get_bind())
    op.execute(TSV_TRIGGER)


def downgrade() -> None:
    Base.metadata.drop_all(op.get_bind())
    op.execute("DROP FUNCTION IF EXISTS items_tsv_update")
