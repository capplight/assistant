"""Search and retention (week 4; spec 3-engineering 3.3, 3.10, 6.9, 7.2).

- pg_trgm. `search_fold()`: case, ё and Kazakh letters typed as Russian ones become the same letter,
  by an explicit table: no dependence on the database locale. `search_translit()`: the same, in
  ASCII, for trigrams, with confusable vowels as one letter. pg_trgm sees no letters outside ASCII
  when the database's LC_CTYPE is C (the dev database is), and Latin and Cyrillic spellings of a word
  come close as a bonus.
- items: `tsv_simple`, `tsv_ru` (spec names) and `tsv_spelled` (additive: the words as
  `search_translit` writes them, for typos), generated columns. Generated, so adding them fires no
  trigger and does not bump `seq`: phones don't download everything again. Legacy `tsv` and its
  trigger stay for the bot's Q&A. GIN trgm on the title, per spec.
- `chunks`: spec fields, plus `source_sha` (additive: what text they were made from, so a repeated
  job does nothing without touching items, which would bump `seq`). Partial HNSW per spec.
- `screen_summaries`: spec fields, plus `user_id` and `seq` (additive: the sync stream needs them).
  Triggers recompute count and titles in the transaction that changes a page. `user_id` has no FK,
  like sync_tombstones: rows are written while an account cascade deletes things; the row goes with
  its screen. `aggregates` belongs to code (nightly) and the triggers leave it alone.

Frozen SQL, no create_all. pg_trgm stays installed on downgrade (it may have been there before).

Revision ID: 0009
Revises: 0008
"""

from alembic import op

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None

_UPPER_LAT = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
_LOWER_LAT = "abcdefghijklmnopqrstuvwxyz"
_UPPER_CYR = "АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ"
_LOWER_CYR = "абвгдеежзийклмнопрстуфхцчшщъыьэюя"
_KK_FROM = "ӘҒҚҢӨҰҮҺІәғқңөұүһіё"
_KK_TO = "агкноуухиагкноуухие"
_FOLD_FROM = _UPPER_LAT + _UPPER_CYR + _KK_FROM
_FOLD_TO = _LOWER_LAT + _LOWER_CYR + _KK_TO
# Spelling, not sound: the commonest misspelling in Russian is a vowel (молако, симинар), so а/о/я
# and е/и/й/ы/э are one letter here, Latin too. ъ, ь last, with no pair: translate() deletes them.
_TRANSLIT_FROM = "абвгдежзийклмнопрстуфхцчшщыэюяoeyъь"
_TRANSLIT_TO = "abvgdijziiklmnaprstufhccwwiiuaaii"

_BODY = "coalesce(text, raw_text, '') || ' ' || coalesce(source_meta->>'caption', '')"

FUNCTIONS = [
    f"""
CREATE FUNCTION search_fold(t TEXT) RETURNS TEXT AS $$
  SELECT translate(t, '{_FOLD_FROM}', '{_FOLD_TO}')
$$ LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
""",
    f"""
CREATE FUNCTION search_translit(t TEXT) RETURNS TEXT AS $$
  SELECT translate(translate(t, '{_FOLD_FROM}', '{_FOLD_TO}'),
                   '{_TRANSLIT_FROM}', '{_TRANSLIT_TO}')
$$ LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
""",
]


def _tsv(config: str, letters: str = "search_fold") -> str:
    return f"""
	setweight(to_tsvector('{config}'::regconfig,
		{letters}(left(coalesce(title, ''), 500))), 'A')
	|| setweight(to_tsvector('{config}'::regconfig,
		{letters}(left(coalesce(summary, ''), 10000))), 'B')
	|| setweight(to_tsvector('{config}'::regconfig,
		{letters}(left({_BODY}, 200000))), 'C')"""


ITEMS = [
    f"""
ALTER TABLE items
	ADD COLUMN tsv_simple TSVECTOR GENERATED ALWAYS AS ({_tsv("simple")}) STORED,
	ADD COLUMN tsv_ru TSVECTOR GENERATED ALWAYS AS ({_tsv("russian")}) STORED,
	ADD COLUMN tsv_spelled TSVECTOR GENERATED ALWAYS AS ({_tsv("simple", "search_translit")}) STORED
""",
    "CREATE INDEX ix_items_tsv_simple ON items USING gin (tsv_simple)",
    "CREATE INDEX ix_items_tsv_ru ON items USING gin (tsv_ru)",
    "CREATE INDEX ix_items_tsv_spelled ON items USING gin (tsv_spelled)",
    """
CREATE INDEX ix_items_title_trgm ON items
	USING gin (search_translit(coalesce(title, '')) gin_trgm_ops)
""",
]

CHUNKS = [
    """
CREATE TABLE chunks (
	id BIGSERIAL PRIMARY KEY,
	item_id BIGINT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
	user_id BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	ord INTEGER NOT NULL,
	text TEXT NOT NULL,
	token_count INTEGER NOT NULL,
	embedding VECTOR(1024) NOT NULL,
	embedding_model TEXT NOT NULL,
	embedded_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	source_sha TEXT NOT NULL,
	CONSTRAINT uq_chunks_item_ord UNIQUE (item_id, ord),
	CONSTRAINT ck_chunks_ord CHECK (ord >= 0),
	CONSTRAINT ck_chunks_token_count CHECK (token_count >= 0)
)
""",
    "CREATE INDEX ix_chunks_user_model ON chunks (user_id, embedding_model)",
    """
CREATE INDEX ix_chunks_embedding_bge_m3 ON chunks
	USING hnsw (embedding vector_cosine_ops) WHERE embedding_model = 'BAAI/bge-m3'
""",
]

SUMMARIES = [
    """
CREATE TABLE screen_summaries (
	screen_id BIGINT PRIMARY KEY REFERENCES screens (id) ON DELETE CASCADE,
	user_id BIGINT NOT NULL,
	item_count INTEGER DEFAULT 0 NOT NULL,
	last_titles TEXT[] DEFAULT '{}' NOT NULL,
	aggregates JSONB DEFAULT '{}' NOT NULL,
	seq BIGINT NOT NULL,
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL,
	CONSTRAINT ck_screen_summaries_item_count CHECK (item_count >= 0),
	CONSTRAINT ck_screen_summaries_last_titles CHECK (cardinality(last_titles) <= 5),
	CONSTRAINT ck_screen_summaries_aggregates CHECK (jsonb_typeof(aggregates) = 'object')
)
""",
    "CREATE INDEX ix_screen_summaries_user_seq ON screen_summaries (user_id, seq)",
    """
CREATE TRIGGER screen_summaries_sync_seq BEFORE INSERT OR UPDATE ON screen_summaries
FOR EACH ROW EXECUTE FUNCTION sync_seq_bump()
""",
    # A screen going away with its account simply isn't selected here. No change, no new seq.
    """
CREATE FUNCTION screen_summaries_refresh(ids BIGINT[]) RETURNS void AS $$
BEGIN
  INSERT INTO screen_summaries AS t (screen_id, user_id, item_count, last_titles, seq)
  SELECT s.id, s.user_id, coalesce(a.n, 0), coalesce(a.titles, '{}'), 0
  FROM screens s
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS n,
           (array_agg(x.title ORDER BY x.at DESC, x.id DESC)
              FILTER (WHERE x.title <> ''))[1:5] AS titles
    FROM (
      SELECT i.id, coalesce(i.occurred_at, i.created_at) AS at,
             coalesce(nullif(i.title, ''), left(coalesce(i.text, i.raw_text, ''), 80)) AS title
      FROM screen_items si
      JOIN items i ON i.id = si.item_id
      WHERE si.screen_id = s.id AND si.removed_by_user_at IS NULL
        AND i.deleted_at IS NULL AND i.hidden_reason IS NULL
    ) x
  ) a ON true
  WHERE s.id = ANY(ids)
  ON CONFLICT (screen_id) DO UPDATE
    SET item_count = EXCLUDED.item_count, last_titles = EXCLUDED.last_titles, updated_at = now()
    WHERE (t.item_count, t.last_titles) IS DISTINCT FROM (EXCLUDED.item_count, EXCLUDED.last_titles);
END $$ LANGUAGE plpgsql
""",
    """
CREATE FUNCTION screen_summaries_on_links() RETURNS trigger AS $$
BEGIN
  PERFORM screen_summaries_refresh(ARRAY(SELECT DISTINCT screen_id FROM changed_links));
  RETURN NULL;
END $$ LANGUAGE plpgsql
""",
    """
CREATE TRIGGER screen_items_summary_insert AFTER INSERT ON screen_items
REFERENCING NEW TABLE AS changed_links
FOR EACH STATEMENT EXECUTE FUNCTION screen_summaries_on_links()
""",
    """
CREATE TRIGGER screen_items_summary_delete AFTER DELETE ON screen_items
REFERENCING OLD TABLE AS changed_links
FOR EACH STATEMENT EXECUTE FUNCTION screen_summaries_on_links()
""",
    """
CREATE FUNCTION screen_summaries_on_link_update() RETURNS trigger AS $$
BEGIN
  PERFORM screen_summaries_refresh(ARRAY[NEW.screen_id]);
  RETURN NULL;
END $$ LANGUAGE plpgsql
""",
    """
CREATE TRIGGER screen_items_summary_update AFTER UPDATE OF removed_by_user_at ON screen_items
FOR EACH ROW WHEN (OLD.removed_by_user_at IS DISTINCT FROM NEW.removed_by_user_at)
EXECUTE FUNCTION screen_summaries_on_link_update()
""",
    """
CREATE FUNCTION screen_summaries_on_item() RETURNS trigger AS $$
BEGIN
  PERFORM screen_summaries_refresh(
    ARRAY(SELECT screen_id FROM screen_items WHERE item_id = NEW.id));
  RETURN NULL;
END $$ LANGUAGE plpgsql
""",
    """
CREATE TRIGGER items_summary AFTER UPDATE OF deleted_at, hidden_reason, title, occurred_at, text
ON items FOR EACH ROW WHEN (
	OLD.deleted_at IS DISTINCT FROM NEW.deleted_at
	OR OLD.hidden_reason IS DISTINCT FROM NEW.hidden_reason
	OR OLD.title IS DISTINCT FROM NEW.title
	OR OLD.occurred_at IS DISTINCT FROM NEW.occurred_at
	OR (coalesce(NEW.title, '') = '' AND OLD.text IS DISTINCT FROM NEW.text))
EXECUTE FUNCTION screen_summaries_on_item()
""",
    """
CREATE FUNCTION screen_summaries_on_screen() RETURNS trigger AS $$
BEGIN
  PERFORM screen_summaries_refresh(ARRAY[NEW.id]);
  RETURN NULL;
END $$ LANGUAGE plpgsql
""",
    """
CREATE TRIGGER screens_summary AFTER INSERT ON screens
FOR EACH ROW EXECUTE FUNCTION screen_summaries_on_screen()
""",
    "SELECT screen_summaries_refresh(ARRAY(SELECT id FROM screens))",
]

DOWN = [
    "DROP TRIGGER screens_summary ON screens",
    "DROP FUNCTION screen_summaries_on_screen",
    "DROP TRIGGER items_summary ON items",
    "DROP FUNCTION screen_summaries_on_item",
    "DROP TRIGGER screen_items_summary_update ON screen_items",
    "DROP FUNCTION screen_summaries_on_link_update",
    "DROP TRIGGER screen_items_summary_delete ON screen_items",
    "DROP TRIGGER screen_items_summary_insert ON screen_items",
    "DROP FUNCTION screen_summaries_on_links",
    "DROP FUNCTION screen_summaries_refresh",
    "DROP TABLE screen_summaries",
    "DROP TABLE chunks",
    "DROP INDEX ix_items_title_trgm",
    "DROP INDEX ix_items_tsv_spelled",
    "DROP INDEX ix_items_tsv_ru",
    "DROP INDEX ix_items_tsv_simple",
    "ALTER TABLE items DROP COLUMN tsv_spelled, DROP COLUMN tsv_ru, DROP COLUMN tsv_simple",
    "DROP FUNCTION search_translit",
    "DROP FUNCTION search_fold",
    "DELETE FROM jobs WHERE kind = 'embed:item'",
]


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    for stmt in [*FUNCTIONS, *ITEMS, *CHUNKS, *SUMMARIES]:
        op.execute(stmt)


def downgrade() -> None:
    for stmt in DOWN:
        op.execute(stmt)
